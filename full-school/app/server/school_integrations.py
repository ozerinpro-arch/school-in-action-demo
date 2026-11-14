"""Host-scoped live connections. No environment activation from HTTP bodies."""
from contextlib import contextmanager, closing
from contextvars import ContextVar
from pathlib import Path
import os
import sqlite3
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from .auth import session_profile
from .integration_settings import IntegrationSettings
from . import launch_runtime, request_extraction, school_requests

_current = ContextVar('school_live_integrations', default=None)


def current_resources():
    return _current.get()


def _staff_authority(settings):
    if not settings.staff_db:
        return False
    from . import staff_access, launch_identity
    try:
        with staff_access.bound_configuration((Path(settings.staff_db), settings.school_id)):
            path, _ = staff_access.configuration()
            if not path.is_file():
                return False
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
                staff_access._validate_existing(connection, settings.school_id)
        staff_access.register_configuration((path, settings.school_id))
        launch_identity.install()
        return True
    except (ValueError, RuntimeError, OSError, sqlite3.Error):
        return False


class IntegrationResources:
    def __init__(self, settings: IntegrationSettings, *, extractor=None, transport=None, check_authority=True):
        self.settings = settings
        self.domain_binding = (os.environ.get('SHKOLA_DB_PATH', ''), os.environ.get('AGENT_DB_PATH', ''))
        self.extraction = self.max_runtime = self.identity = self.transport = None
        self.authority_ready = False
        self.initialization_blockers = []
        from .schedule_agent import ModelConfiguration
        manager_model = ModelConfiguration.from_environment()
        self.manager_ai_enabled = bool(manager_model.configured and manager_model.requests_enabled)
        if settings.ai_ready:
            if extractor is None:
                from .schedule_agent import ModelConfiguration
                from .request_intents import make_intent_extractor
                extractor = make_intent_extractor(ModelConfiguration(settings.ai_key, settings.ai_model, True))
            self.extraction = request_extraction.ExtractionService(settings.school_id, settings.ai_db, extractor,
                forbidden=tuple(p for p in (settings.max_db, settings.staff_db) if p))
        if settings.max_config_ready:
            self.authority_ready = _staff_authority(settings) if check_authority else True
            if self.authority_ready:
                from .max_identity import MaxIdentity
                from .max_runtime import MaxRuntime
                if not settings.max_send_requested:
                    transport = None
                if transport is None and settings.max_send_requested:
                    from .max_transport import MaxClient
                    try:
                        transport = MaxClient(settings.max_token, additional_ca_file=settings.max_ca_file or None)
                    except (ValueError, OSError):
                        self.initialization_blockers.append('Не удалось подготовить защищённое соединение с MAX')
                self.transport = transport
                self.identity = MaxIdentity(integration_id=settings.max_integration_id, school_id=settings.school_id,
                    db_path=settings.max_db, enabled=True)
                self.max_runtime = MaxRuntime(integration_id=settings.max_integration_id, school_id=settings.school_id,
                    db_path=settings.max_db, webhook_secret=settings.max_secret, transport=transport,
                    enabled=True, extraction_service=self.extraction)

    @contextmanager
    def bind(self):
        if self.domain_binding != (os.environ.get('SHKOLA_DB_PATH', ''), os.environ.get('AGENT_DB_PATH', '')):
            raise HTTPException(503, 'Настройка хранилища изменилась; нужен новый запуск')
        token = _current.set(self)
        try:
            with school_requests.bound_school(self.settings.school_id), request_extraction.bound_service(self.extraction):
                yield self
        finally:
            _current.reset(token)

    def status(self):
        result = self.settings.safe_status()
        result['ai']['enabled'] = self.extraction is not None
        result['ai']['managerEnabled'] = self.manager_ai_enabled
        result['max']['enabled'] = self.max_runtime is not None
        result['max']['sendEnabled'] = bool(self.max_runtime is not None and self.settings.max_send_requested and self.transport is not None)
        result['max']['personalAuthorityConfigured'] = self.authority_ready
        result['max']['blockers'].extend(self.initialization_blockers)
        if not self.authority_ready:
            result['max']['blockers'].append('Нужны действующие личные школьные учётные записи')
        if self.max_runtime is not None:
            result['max']['queue'] = self.max_runtime.status()
        return result

    def close(self):
        if self.transport is not None and hasattr(self.transport, 'close'):
            self.transport.close()


class IntegrationMiddleware:
    def __init__(self, app, resources):
        self.app, self.resources = app, resources

    async def __call__(self, scope, receive, send):
        from starlette.responses import JSONResponse
        try:
            with self.resources.bind():
                await self.app(scope, receive, send)
        except HTTPException as error:
            if scope['type'] != 'http':
                raise
            await JSONResponse({'detail': error.detail}, status_code=error.status_code)(scope, receive, send)


def _actor(profile, *, teacher=False):
    profile = launch_runtime.actor(profile, 'launch.status')
    school_requests.require_bound_school(profile['schoolId'])
    resources = current_resources()
    if resources is None or resources.settings.school_id != profile['schoolId']:
        raise HTTPException(503, 'Подключения для этой школы не настроены')
    if teacher and profile.get('staffRole') != 'teacher':
        raise HTTPException(403, 'Личную связь создаёт сотрудник в своём школьном кабинете')
    return profile, resources


class EmptyInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


router = APIRouter(prefix='/api/school/integrations', tags=['school connections'])


@router.get('/status')
def status(profile=Depends(session_profile)):
    _, resources = _actor(profile)
    return resources.status()


@router.get('/max/me')
def my_binding(profile=Depends(session_profile)):
    profile, resources = _actor(profile, teacher=True)
    if resources.identity is None:
        return {'linked': False, 'canLink': False, 'message': 'Личное подключение MAX пока не настроено'}
    return {**resources.identity.status(profile), 'canLink': True}


@router.post('/max/link')
def link(body: EmptyInput, profile=Depends(session_profile)):
    profile, resources = _actor(profile, teacher=True)
    if resources.identity is None:
        raise HTTPException(503, 'Личное подключение MAX пока не настроено')
    challenge = resources.identity.issue_challenge(profile)
    return {'url': 'https://max.ru/' + resources.settings.max_username + '?start=' + quote(challenge['token'], safe=''),
        'expiresAt': challenge['expiresAt'], 'message': 'Откройте ссылку и начните диалог с ботом для подтверждения личной связи'}


@router.post('/max/revoke')
def revoke(body: EmptyInput, profile=Depends(session_profile)):
    profile, resources = _actor(profile, teacher=True)
    if resources.identity is None:
        raise HTTPException(503, 'Личное подключение MAX пока не настроено')
    return resources.identity.revoke(profile)
