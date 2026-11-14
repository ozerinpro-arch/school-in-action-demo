"""Isolated working-assumption candidates; never a normative/publication input.

The existing CP-SAT solver and independent validator compute an explicitly
authorised experiment. Its complete provenance, assumptions and projection live
in a separate namespace; no timetable/config/calendar/publication is activated.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading

from fastapi import APIRouter, Depends, HTTPException, Path as APIPath
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Literal

from . import db
from .auth import require_roles
from .school_ops import _snapshot
from .school_plan_imports import _actor
from .school_plan_sources import load_source_package
from .school_source_registry import _bounded_draft
from .scheduling_solver import solve_plan, validate_solution

NAMESPACE = '_schoolExperimentalDrafts'
MAX_RUNS = 8
MAX_BYTES = 12 * 1024 * 1024
PROCESS = secrets.token_hex(16)
ACTIVE = {'queued', 'running'}
RESULTS = {'optimal', 'feasible'}
_lock = threading.RLock()
_executors = {}
_futures = {}
LEASE_SECONDS = 120
SEED_PATH = Path(__file__).resolve().parent / 'assets' / 'school-experiment-seed-2026-10-26.json'


def _process_start(pid):
    """Linux start ticks prevent PID reuse; portable fallback is a short lease."""
    from pathlib import Path
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[19]
    except (OSError, IndexError):
        return None


def _live_owner(item):
    try:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(item['public']['updatedAt'].replace('Z','+00:00'))).total_seconds()
        if elapsed < 0 or elapsed > LEASE_SECONDS:
            return False
        pid = item.get('processPid')
        if type(pid) is not int or pid < 1:
            return item.get('process') == PROCESS
        if pid == os.getpid():
            return item.get('process') == PROCESS
        os.kill(pid, 0)
        birth = _process_start(pid)
        return not item.get('processStart') or birth == item['processStart']
    except (OSError, TypeError, ValueError, KeyError):
        return False


def _active(item):
    if item['public']['status'] not in ACTIVE or not _live_owner(item):
        return False
    future = _futures.get((str(db.database_path()), item['public']['id']))
    return not (item.get('process') == PROCESS and future is not None and future.done())


def _utc():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class ExperimentalInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    periodStart: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    expectedDraftRevision: int = Field(ge=0, le=2**31-1)
    expectedPackageHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    requestId: str = Field(min_length=16, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    useWorkingAssumptions: Literal[True]

    @field_validator('periodStart')
    @classmethod
    def monday(cls, value):
        target = date.fromisoformat(value)
        if target.weekday() != 0:
            raise ValueError('Укажите понедельник экспериментальной недели.')
        try:
            target + timedelta(days=5)
        except OverflowError:
            raise ValueError('Учебная неделя выходит за допустимый диапазон дат.') from None
        return value

    @field_validator('useWorkingAssumptions', mode='before')
    @classmethod
    def explicit_mode(cls, value):
        if type(value) is not bool or value is not True:
            raise ValueError('Эксперимент требует явного режима рабочих предположений.')
        return value


def _stored(state, school_id):
    value = state.get(NAMESPACE)
    if value is None:
        return {'version': 1, 'schoolId': school_id, 'candidates': []}
    if (not isinstance(value, dict) or value.get('version') != 1 or value.get('schoolId') != school_id
            or not isinstance(value.get('candidates'), list) or len(value['candidates']) > MAX_RUNS):
        raise HTTPException(503, 'Реестр экспериментальных черновиков требует проверки.')
    ids = []
    for item in value['candidates']:
        if (not isinstance(item, dict) or not isinstance(item.get('public'), dict)
                or item['public'].get('mode') != 'working_assumptions'
                or item['public'].get('schoolId') != school_id
                or not isinstance(item.get('commandHash'), str)
                or not isinstance(item.get('receipt'), dict)
                or not isinstance(item.get('input'), dict)
                or not isinstance(item['public'].get('sourceBinding'), dict)
                or item['public'].get('status') not in ACTIVE | RESULTS | {'unknown','infeasible','failed','stale'}
                or not re.fullmatch(r'exp_[a-f0-9]{32}', item['public'].get('id',''))):
            raise HTTPException(503, 'Экспериментальный черновик требует проверки.')
        ids.append(item['public'].get('id'))
    if any(not isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
        raise HTTPException(503, 'Повреждены идентификаторы экспериментальных черновиков.')
    return deepcopy(value)


def _current(draft, package):
    bounded = _bounded_draft(draft)
    return {'draftRevision': bounded['revision'], 'draftHash': _hash(bounded), 'packageHash': _hash(package)}


def _build(package, draft, period_start):
    from .school_experiment_builder import build_experimental_plan
    return build_experimental_plan(package, draft, period_start)


def _seeded_input(plan, binding):
    """A previous computation is only a hint, bound to this exact entire model.

    No source fact is inferred from the witness. We independently check every
    assignment before it becomes a computational baseline for the same solver.
    Changed documents, dates, assumptions or school grid never reuse it.
    """
    untouched = {'warmStartUsed':False}
    try:
        if SEED_PATH.stat().st_size > 1024 * 1024:
            return plan, untouched
        seed = json.loads(SEED_PATH.read_text())
        if (not isinstance(seed, dict) or seed.get('kind') != 'computed_experimental_warmstart' or seed.get('notSourceFact') is not True
                or seed.get('normativeActivation') is not False or seed.get('publicationAllowed') is not False
                or seed.get('periodStart') != plan['periodStart'] or seed.get('inputHash') != _hash(plan)
                or seed.get('packageHash') != binding['packageHash'] or seed.get('draftHash') != binding['draftHash']
                or not isinstance(seed.get('assignments'),list)
                or len(seed['assignments']) != sum(demand['weeklyCount'] for demand in plan['demands'])
                or seed.get('assignmentHash') != _hash(seed['assignments'])):
            return plan, untouched
        if not validate_solution(plan, seed['assignments'])['valid']:
            return plan, untouched
        result = deepcopy(plan)
        result['baseline'] = deepcopy(seed['assignments'])
        return result, {'warmStartUsed':True,'inputHash':seed['inputHash'],
            'assignmentHash':seed['assignmentHash'],'notSourceFact':True,'independentlyValidated':True}
    except (OSError, ValueError, TypeError, KeyError):
        return plan, untouched


def _public(item, current):
    value = deepcopy(item['public'])
    if value['status'] in ACTIVE and not _live_owner(item):
        value.update(status='stale', message='Процесс расчёта прерван. Автоматический повтор не выполнялся; создайте новый экспериментальный черновик.')
    elif (value['status'] in ACTIVE and (future := _futures.get((str(db.database_path()), value['id']))) is not None
          and future.done() and (future.cancelled() or future.exception() is not None)):
        value.update(status='failed', message='Расчёт прерван до сохранения результата. Автоматический повтор не выполнялся; исходная сетка сохранена.')
    elif value['sourceBinding'] != current:
        value.update(computedStatus=value['status'], status='stale', message='Исходная сетка или документы изменились. Этот эксперимент относится к прежней версии источников.')
    value['canPublish'] = False
    value['normativeActivation'] = False
    return value


def collection(profile):
    _actor(profile)
    state, draft = _snapshot(raw_draft=True)
    package = load_source_package()
    binding = _current(draft, package)
    stored = _stored(state, profile['schoolId'])
    values = [_public(item, binding) for item in reversed(stored['candidates'])]
    summaries = [{k: value[k] for k in ('id', 'periodStart', 'status', 'message', 'createdAt', 'updatedAt', 'mode')} for value in values]
    return {'schoolId': profile['schoolId'], 'draftRevision': binding['draftRevision'],
            'packageHash': binding['packageHash'], 'latest': values[0] if values else None, 'candidates': summaries}


def read_experiment(experiment_id, profile):
    _actor(profile)
    state, draft = _snapshot(raw_draft=True)
    stored = _stored(state, profile['schoolId'])
    item = next((i for i in stored['candidates'] if i['public']['id'] == experiment_id), None)
    if item is None:
        raise HTTPException(404, 'Экспериментальный черновик не найден.')
    return _public(item, _current(draft, load_source_package()))


def _save(state, stored):
    if len(json.dumps(stored, ensure_ascii=False).encode()) > MAX_BYTES:
        raise HTTPException(429, 'Достигнут предел хранения экспериментальных черновиков.')
    state[NAMESPACE] = stored


@contextmanager
def _edit_bound(database):
    """A worker keeps its admitted DB even if a test/operator changes env later."""
    from pathlib import Path
    from .workspace import verify_school_state
    with closing(sqlite3.connect(Path(database).as_uri() + '?mode=rw', uri=True, timeout=15)) as connection:
        connection.execute('BEGIN IMMEDIATE')
        try:
            state = json.loads(connection.execute('SELECT payload FROM demo_state WHERE id=1').fetchone()[0])
            verify_school_state(state)
            yield state
            connection.execute('UPDATE demo_state SET payload=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
            connection.commit()
        except BaseException:
            connection.rollback()
            raise


def _projection(plan, assignments, provenance, period_start):
    groups = {i['id']: i for i in plan['groups']}
    teachers = {i['id']: i['name'] for i in plan['teachers']}
    rooms = {i['id']: i['name'] for i in plan['rooms']}
    slots = {i['id']: i for i in plan['slots']}
    demand_by_event = {f"{d['id']}_{n}": d for d in plan['demands'] for n in range(d['weeklyCount'])}
    source_by_demand = {p['demandId']: p.get('sourceCells', []) for p in provenance}
    lessons = []
    for assignment in assignments:
        demand = demand_by_event[assignment['eventId']]
        slot = slots[assignment['slotId']]
        participants = [groups[g] for g in demand['groupIds']]
        for class_name in sorted({g['className'] for g in participants}):
            lessons.append({'id': 'exp_l_' + _hash([assignment['eventId'], class_name])[:32],
                'eventId': assignment['eventId'], 'className': class_name,
                'date': (date.fromisoformat(period_start) + timedelta(days=slot['day'])).isoformat(),
                'day': slot['day'], 'slot': slot['slot'], 'start': slot['start'], 'end': slot['end'],
                'subject': demand['subject'], 'teachers': [teachers[t] for t in demand['teacherIds']],
                'rooms': [rooms[assignment['roomId']]], 'groupLabels': [g['name'] for g in participants if g['className'] == class_name],
                'sourceCells': source_by_demand.get(demand['id'], []), 'assumed': True})
    classes = sorted({g['className'] for g in groups.values()}, key=lambda s: (int(''.join(c for c in s if c.isdigit()) or 0), s))
    return {'lessons': lessons, 'issues': [], 'classNames': classes, 'weekDays': sorted({s['day'] for s in slots.values()}),
        'weekLabel': f'{period_start} — {(date.fromisoformat(period_start) + timedelta(days=5)).isoformat()}',
        'eventCount': len(assignments), 'classParticipationCount': len(lessons)}


def _run_bound(experiment_id, profile, expected_process, database):
    # All input snapshots are private to this namespace; no active plan reads or writes.
    with _edit_bound(database) as state:
        stored = _stored(state, profile['schoolId'])
        item = next(i for i in stored['candidates'] if i['public']['id'] == experiment_id)
        if item['public']['status'] != 'queued' or item['process'] != expected_process:
            return
        item['public'].update(status='running', message='Размещаю всю исходную нагрузку по рабочим предположениям. Это не опубликованное расписание.', updatedAt=_utc())
        plan, provenance = deepcopy(item['input']), deepcopy(item['public']['provenance'])
        binding = deepcopy(item['public']['sourceBinding'])
        _save(state, stored)
    try:
        computed_input, computation = _seeded_input(plan, binding)
        result = solve_plan(computed_input, mode='generate', time_limit=30)
        valid = validate_solution(plan, result['assignments']) if result['status'] in RESULTS else result.get('validation')
        if result['status'] in RESULTS and (not valid or not valid.get('valid')):
            raise ValueError('Independent experiment validation rejected candidate')
        projection = _projection(plan, result['assignments'], provenance, plan['periodStart']) if result['status'] in RESULTS else None
        status = result['status'] if result['status'] in RESULTS | {'unknown','infeasible'} else 'failed'
        message = (f"Экспериментальный черновик готов: {len(result['assignments'])} занятий для всех классов. Проверьте предположения; публикация недоступна."
                   if status in RESULTS else 'При выбранных предположениях полный кандидат не получен. Посмотрите причины расчёта и измените предположения.')
        update = {'status': status, 'message': message, 'projection': projection, 'validation': valid,
                  'diagnostics': result.get('diagnostics', []), 'metrics': result.get('metrics', {}),
                  'computation':computation, 'updatedAt': _utc()}
    except Exception:
        update = {'status': 'failed', 'message': 'Экспериментальный расчёт остановлен. Исходная сетка и опубликованные версии сохранены.', 'updatedAt': _utc()}
    with _edit_bound(database) as state:
        stored = _stored(state, profile['schoolId'])
        item = next(i for i in stored['candidates'] if i['public']['id'] == experiment_id)
        if item['process'] == expected_process and item['public']['status'] == 'running':
            item['public'].update(update)
            _save(state, stored)


def _run(experiment_id, profile, expected_process, database):
    from .school_requests import bound_school
    with bound_school(profile['schoolId']):
        _run_bound(experiment_id, profile, expected_process, database)


def create_experiment(body, profile):
    _actor(profile)
    if not isinstance(body, ExperimentalInput):
        body = ExperimentalInput.model_validate(body)
    actor = [profile['schoolId'], profile['userId'], profile['role']]
    experiment_id = 'exp_' + _hash([*actor, body.requestId])[:32]
    fingerprint = _hash(body.model_dump())
    with db.edit_state() as state:
        _actor(profile)
        stored = _stored(state, profile['schoolId'])
        existing = next((i for i in stored['candidates'] if i['public']['id'] == experiment_id), None)
        if existing:
            if existing['commandHash'] != fingerprint:
                raise HTTPException(409, 'Идентификатор черновика уже использован с другими параметрами.')
            return deepcopy(existing['receipt'])
        from .dated_timetable import guard_saved_calendar
        guard_saved_calendar(state, profile['schoolId'], body.periodStart)
        if len(stored['candidates']) >= MAX_RUNS:
            raise HTTPException(429, 'Достигнут предел восьми экспериментальных черновиков. Существующие версии сохранены.')
        if any(_active(i) for i in stored['candidates']):
            raise HTTPException(409, 'Экспериментальный расчёт уже выполняется. Откройте его текущий статус.')
        _, draft = _snapshot(raw_draft=True)
        package = load_source_package()
        binding = _current(draft, package)
        if body.expectedDraftRevision != binding['draftRevision'] or body.expectedPackageHash != binding['packageHash']:
            raise HTTPException(409, 'Документы или исходная сетка изменились. Обновите их перед расчётом.')
        try:
            built = _build(package, _bounded_draft(draft), body.periodStart)
        except (ValueError, OverflowError):
            raise HTTPException(422, 'Не удалось подготовить эксперимент по этим исходным данным. Проверьте выбранную неделю и источники.') from None
        represented = {cell for entry in built['provenance'] + built.get('deferredLoads', []) for cell in entry.get('sourceCells', [])}
        source_cells = {cell['sourceCell'] for cell in package['cells']}
        if (built['coverage']['sourceCells'] != len(package['cells']) or built['coverage']['coveredCells'] != len(package['cells'])
                or represented != source_cells):
            raise HTTPException(422, 'Эксперимент не охватил всю исходную нагрузку; результат не сохранён.')
        stamp = _utc()
        public = {'id': experiment_id, 'schoolId': profile['schoolId'], 'mode': 'working_assumptions',
            'periodStart': body.periodStart, 'status': 'queued', 'message': 'Экспериментальный расчёт поставлен в очередь. Предположения не считаются подтверждёнными школой.',
            'assumptions': built['assumptions'], 'coverage': built['coverage'], 'provenance': built['provenance'],
            'warnings': built.get('warnings', []), 'projection': None, 'validation': None, 'diagnostics': [],
            'deferredLoads': built.get('deferredLoads', []), 'metadata': built.get('metadata', {}),
            'sourceBinding': binding, 'createdAt': stamp, 'updatedAt': stamp, 'canPublish': False, 'normativeActivation': False}
        item = {'public': public, 'input': built['input'], 'commandHash': fingerprint,
                'receipt': deepcopy(public), 'process': PROCESS, 'processPid':os.getpid(),
                'processStart':_process_start(os.getpid()), 'actor': actor}
        stored['candidates'].append(item)
        _save(state, stored)
    database = str(db.database_path().resolve())
    with _lock:
        executor = _executors.get(database)
        if executor is None:
            executor = _executors[database] = ThreadPoolExecutor(max_workers=1, thread_name_prefix='school-experiment')
        try:
            _futures[(database, experiment_id)] = executor.submit(_run, experiment_id, deepcopy(profile), PROCESS, database)
        except Exception:
            with _edit_bound(database) as state:
                stored = _stored(state, profile['schoolId'])
                item = next(i for i in stored['candidates'] if i['public']['id'] == experiment_id)
                item['public'].update(status='failed', message='Не удалось запустить фоновый расчёт. Создайте новый экспериментальный запрос.', updatedAt=_utc())
                _save(state, stored)
            raise HTTPException(503, 'Не удалось запустить фоновый расчёт; исходная сетка сохранена.') from None
    return deepcopy(public)


class SafeExperimentalRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def safe(request):
            try:
                return await original(request)
            except RequestValidationError:
                raise HTTPException(422, 'Некорректные параметры экспериментального черновика.') from None
        return safe


router = APIRouter(prefix='/experimental-school', tags=['experimental-school'], route_class=SafeExperimentalRoute)


@router.get('')
def http_collection(profile=Depends(require_roles('admin', 'director'))):
    return collection(profile)


@router.get('/{experiment_id}')
def http_read(experiment_id: str = APIPath(pattern=r'^exp_[a-f0-9]{32}$'), profile=Depends(require_roles('admin', 'director'))):
    return read_experiment(experiment_id, profile)


@router.post('')
def http_create(body: ExperimentalInput, profile=Depends(require_roles('admin', 'director'))):
    return create_experiment(body, profile)
