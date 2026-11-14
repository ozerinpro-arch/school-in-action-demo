"""Date-bound operator call reviews over the existing local planning pipeline.

All domain I/O uses the caller's connection. The caller owns its transaction,
session check and commit. Reading or preflight never initializes storage.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta
import hashlib
import json
import sqlite3
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import Field, ValidationError, field_validator, model_validator

from . import db, school_calendar, timetable
from .calendar_models import StrictInput, iso_date
from .request_planning import canonical_manager
from .school_requests import require_bound_school
from .scheduling_models import PlanningInput, StrictModel, planning_readiness
from .scheduling_solver import validate_solution
from .workspace import empty_school_state, verify_school_state

KEY = '_dailyBriefs'
MAX_REVISION = 2**31 - 1
MAX_BRIEFS = 366
MAX_RECEIPTS = 1000
MAX_BYTES = 16 * 1024 * 1024
HASH = r'^[a-f0-9]{64}$'
TIME = r'^([01][0-9]|2[0-3]):[0-5][0-9]$'
NOTICE = 'Бриф сохраняет сведения на выбранную дату. Он не утверждает нормативы, не меняет календарь или сетку и не запускает расчёт.'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def today():
    return datetime.now(ZoneInfo('Europe/Moscow')).date()


class Window(StrictInput):
    start: str = Field(pattern=TIME)
    end: str = Field(pattern=TIME)

    @model_validator(mode='after')
    def positive(self):
        if self.start >= self.end:
            raise ValueError('Окончание окна должно быть позже начала')
        return self


class TeacherOverride(StrictInput):
    teacherId: str = Field(min_length=1, max_length=160)
    status: Literal['unknown', 'available', 'unavailable']
    windows: list[Window] = Field(default_factory=list, max_length=20)
    contacted: bool
    comment: str = Field(default='', max_length=2000)

    @field_validator('teacherId')
    @classmethod
    def identifier(cls, value):
        return timetable._single_line(value)

    @model_validator(mode='after')
    def windows_match_status(self):
        self.windows = sorted(self.windows, key=lambda row: (row.start, row.end))
        if (self.status == 'available') != bool(self.windows):
            raise ValueError('Доступность требует явных окон; остальные статусы задаются без окон')
        if any(a.end > b.start for a, b in zip(self.windows, self.windows[1:])):
            raise ValueError('Окна доступности не должны пересекаться')
        return self


class BriefContent(StrictInput):
    targetDate: str
    callReview: Literal['none', 'recorded', 'pending'] = 'none'
    teacherOverrides: list[TeacherOverride] = Field(default_factory=list, max_length=200)
    confirmedLessonIds: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=2000)

    @field_validator('targetDate')
    @classmethod
    def exact_date(cls, value):
        iso_date(value)
        return value

    @model_validator(mode='after')
    def unique(self):
        ids = [row.teacherId for row in self.teacherOverrides]
        if len(ids) != len(set(ids)) or len(self.confirmedLessonIds) != len(set(self.confirmedLessonIds)):
            raise ValueError('Педагоги и закреплённые занятия не должны повторяться')
        for value in self.confirmedLessonIds:
            timetable._single_line(value)
        self.teacherOverrides = sorted(self.teacherOverrides, key=lambda row: row.teacherId)
        self.confirmedLessonIds = sorted(self.confirmedLessonIds)
        return self


class PreviewInput(BriefContent):
    expectedRevision: int = Field(ge=0, le=MAX_REVISION)
    expectedSourceBindingHash: str = Field(pattern=HASH)


class SaveInput(PreviewInput):
    previewHash: str = Field(pattern=HASH)
    requestId: str = Field(pattern=r'^[A-Za-z0-9_-]{16,80}$')


class PreflightInput(StrictInput):
    targetDate: str
    expectedRevision: int = Field(ge=0, le=MAX_REVISION)
    expectedSourceBindingHash: str = Field(pattern=HASH)

    @field_validator('targetDate')
    @classmethod
    def exact_date(cls, value):
        iso_date(value)
        return value


class DailyRunBinding(StrictModel):
    targetDate: str
    revision: int = Field(ge=1, le=MAX_REVISION)
    sourceBindingHash: str = Field(pattern=HASH)
    briefHash: str = Field(pattern=HASH)

    @field_validator('targetDate')
    @classmethod
    def exact_date(cls, value):
        iso_date(value)
        return value


def _body(model, value):
    try:
        return model.model_validate(value.model_dump() if isinstance(value, model) else value)
    except (ValueError, TypeError, ValidationError):
        raise HTTPException(422, 'Проверьте дату, статусы, окна, ревизии и поля брифа') from None


def _operator(profile):
    actor = canonical_manager(profile)
    if actor.get('staffRole', actor.get('role')) not in {'director', 'planner'} or 'launch.manage' not in actor.get('permissions', []):
        raise HTTPException(403, 'Бриф составляет директор или завуч')
    require_bound_school(actor['schoolId'])
    return actor


def _actor_binding(actor):
    return {key: deepcopy(actor[key]) for key in ('schoolId', 'userId', 'membershipId', 'membershipRevision')}


def _block(code, message, ids=()):
    return {'code': code, 'message': message, 'entityIds': sorted(set(ids))}


def _conflict(message, code='daily_source_changed'):
    raise HTTPException(409, {'code': code, 'message': message})


def _item(row, key, index):
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return row[index]


def _empty(school):
    return {'version': 1, 'schoolId': school, 'records': {}, 'receipts': {}, 'applications': {}}


def _record_hash(content, binding, revision):
    return digest({'content': content, 'sourceBinding': binding, 'revision': revision})


def _ledger(state, school):
    value = state.get(KEY)
    if value is None:
        return _empty(school)
    try:
        if (not isinstance(value, dict) or value.get('version') != 1 or value.get('schoolId') != school
                or not isinstance(value.get('records'), dict) or len(value['records']) > MAX_BRIEFS
                or not isinstance(value.get('receipts'), dict) or len(value['receipts']) > MAX_RECEIPTS):
            raise ValueError()
        for target, row in value['records'].items():
            content = BriefContent.model_validate(row['content']).model_dump()
            if (target != content['targetDate'] or type(row['revision']) is not int or not 1 <= row['revision'] <= MAX_REVISION
                    or row['sourceBinding']['schoolId'] != school or row['sourceBinding']['targetDate'] != target
                    or row['actor']['schoolId'] != school
                    or row['briefHash'] != _record_hash(content, row['sourceBinding'], row['revision'])):
                raise ValueError()
        for receipt in value['receipts'].values():
            if (not isinstance(receipt, dict) or receipt['actor']['schoolId'] != school
                    or not isinstance(receipt['fingerprint'], str) or not isinstance(receipt['result'], dict)):
                raise ValueError()
        applications = value.get('applications', {})
        if not isinstance(applications, dict) or len(applications) > MAX_RECEIPTS:
            raise ValueError()
        for run_id, marker in applications.items():
            if (marker['runId'] != run_id or marker['schoolId'] != school
                    or marker['hash'] != digest({k: v for k, v in marker.items() if k != 'hash'})):
                raise ValueError()
        if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_BYTES:
            raise ValueError()
    except (KeyError, ValueError, TypeError, AttributeError, sqlite3.Error):
        raise HTTPException(503, 'Сохранённые брифы требуют проверки') from None
    result = deepcopy(value)
    result.setdefault('applications', {})
    return result


def _context(connection, actor, target):
    if connection is None:
        raise HTTPException(503, 'Источник школы недоступен')
    chosen = iso_date(target)
    monday = (chosen - timedelta(days=chosen.weekday())).isoformat()
    row = connection.execute('SELECT payload FROM demo_state WHERE id=1').fetchone() if db.table_exists(connection, 'demo_state') else None
    try:
        state = json.loads(row[0]) if row else empty_school_state()
        verify_school_state(state)
        draft = timetable._load(connection) if db.table_exists(connection, 'timetable_draft') else timetable._empty()
        public = timetable._public(draft)
        effective_date = draft.get('_sourcePreparation', {}).get('effectiveDate')
        source_effective = iso_date(effective_date) if effective_date is not None else None
        config_row = connection.execute('SELECT revision,input_json,base_draft_revision FROM planning_config WHERE id=1').fetchone() if db.table_exists(connection, 'planning_config') else None
        config_revision = _item(config_row, 'revision', 0) if config_row else 0
        config_text = _item(config_row, 'input_json', 1) if config_row else None
        base_revision = _item(config_row, 'base_draft_revision', 2) if config_row else None
        calendar = school_calendar._calendar(state, actor['schoolId'])
    except (KeyError, ValueError, TypeError, AttributeError, sqlite3.Error):
        raise HTTPException(503, 'Исходные сведения школы требуют проверки') from None
    binding = {'schoolId': actor['schoolId'], 'targetDate': target, 'draftRevision': public['revision'],
        'draftHash': digest(draft), 'configRevision': config_revision,
        'configHash': digest({'input': config_text, 'baseDraftRevision': base_revision}) if config_row else None,
        'calendarRevision': calendar['revision'], 'calendarHash': digest(calendar)}
    plan, blockers, missing = None, [], []
    try:
        if config_text is not None:
            raw = json.loads(config_text)
            raw['periodStart'] = monday
            plan = PlanningInput.model_validate(raw).model_dump()
    except (ValueError, TypeError, KeyError):
        pass
    if plan is None or not plan['confirmed']:
        blockers.append(_block('missing_normative_plan', 'Заполните и подтвердите нормативную модель: состав групп, вместимость кабинетов, связи и нагрузку.'))
        missing.append('normativePlan')
    if plan is not None and base_revision != public['revision']:
        rebase = None
        if db.table_exists(connection, 'planning_runs'):
            # Reuse only the existing verified exact-apply proof, not a name/time
            # match or a source-package loader. No PlanningService is constructed.
            from .planning import PlanningService
            previous_factory = connection.row_factory
            try:
                # The shared proof expects named rows; timetable's apply guard
                # supplies the same transaction with its default tuple factory.
                connection.row_factory = sqlite3.Row
                rebase = PlanningService._trusted_rebase(connection, {'input': plan,
                    'revision': config_revision, 'baseDraftRevision': base_revision})
            finally:
                connection.row_factory = previous_factory
            if rebase is not None:
                plan['baseline'] = PlanningService._rebase_assignments(rebase, plan)
        if rebase is None:
            blockers.append(_block('daily_config_draft_changed', 'Модель не привязана к текущей ревизии исходной сетки.'))
    if not calendar['config'] or not calendar['config']['confirmed']:
        blockers.append(_block('missing_calendar', 'Заполните и подтвердите школьный календарь выбранной недели.'))
        missing.append('calendar')
    effect = None
    if plan is not None:
        ready = planning_readiness(plan)
        blockers.extend(_block(b['code'], b['message'], b.get('entityIds', [])) for b in ready['blockers'] if b['code'] != 'unconfirmed')
        effect = school_calendar.calendar_effect_for_plan(state, plan, school_id=actor['schoolId'], require_configured=True)
        blockers.extend(_block(b['code'], b['message'], b.get('entityIds', [])) for b in effect['blockers'])
    if chosen < today():
        blockers.append(_block('daily_date_expired', 'Дата брифа прошла. Для нового расчёта выберите актуальную дату.'))
    if source_effective is not None and chosen < source_effective:
        blockers.append(_block('daily_source_not_effective', 'Исходная сетка ещё не действует на выбранную дату.'))
    if not any(l['day'] == chosen.weekday() for l in public['lessons']):
        blockers.append(_block('daily_source_day_empty', 'В исходной сетке нет занятий выбранного дня.'))
    if plan is not None:
        teachers = [{'id': t['id'], 'name': t['name'], 'sourceKind': 'planning_id'} for t in plan['teachers']]
    else:
        names = sorted({name for lesson in public['lessons'] for name in lesson['teachers']})
        teachers = [{'id': name, 'name': name, 'sourceKind': 'source_label'} for name in names]
    lessons = [{key: deepcopy(l[key]) for key in ('id', 'className', 'day', 'slot', 'start', 'end', 'subject', 'teachers', 'rooms')}
               for l in public['lessons'] if l['day'] == chosen.weekday()]
    return {'connection': connection, 'state': state, 'storedState': row is not None,
        'sourceBinding': binding, 'sourceBindingHash': digest(binding), 'weekStart': monday,
        'targetDate': target, 'weekday': chosen.weekday(), 'draft': draft, 'plan': plan,
        'effectiveInput': effect['effectiveInput'] if effect and effect['ready'] else plan,
        'blockers': blockers, 'missingForms': missing, 'teachers': teachers, 'lessons': lessons}


def _content(body):
    return BriefContent.model_validate({key: getattr(body, key) for key in BriefContent.model_fields}).model_dump()


def _validate_references(context, content):
    teachers = {row['id'] for row in context['teachers']}
    lessons = {row['id'] for row in context['lessons']}
    if any(row['teacherId'] not in teachers for row in content['teacherOverrides']):
        raise HTTPException(422, 'Выберите точного педагога из текущего источника брифа')
    if not set(content['confirmedLessonIds']) <= lessons:
        raise HTTPException(422, 'Закреплять можно только исходные занятия выбранного дня')


def _overlay(context, content, plan):
    model = PlanningInput.model_validate(deepcopy(plan)).model_dump()
    blockers, diagnostics = [], []
    slots = {row['id']: row for row in model['slots']}
    target_slots = {key for key, row in slots.items() if row['day'] == context['weekday']}
    events = {f"{d['id']}_{n}": d for d in model['demands'] for n in range(d['weeklyCount'])}
    baseline = {row['eventId']: row for row in model['baseline']}
    if set(baseline) != set(events):
        return model, [_block('daily_baseline_required', 'Нужна полная проверенная основа всей недели; бриф не создаёт недостающие занятия.')], diagnostics
    validation = validate_solution(model, model['baseline'])
    if not validation['valid']:
        return model, [_block('daily_baseline_invalid', 'Основа недели не прошла независимую проверку исходных ограничений.')], diagnostics
    # The existing repair guard verifies complete source identity and projects
    # the baseline through the real materializer. A time-only match could pin
    # another room, teacher or subject and silently change a different day.
    from .request_planning import _assert_baseline
    try:
        _assert_baseline(model, context['draft'])
    except HTTPException as error:
        if error.status_code != 409:
            raise
        code = error.detail.get('code') if isinstance(error.detail, dict) else None
        if code == 'request_source_mapping_required':
            issue = _block('daily_source_mapping_required', 'Нужно полное однозначное сопоставление занятий модели с текущей исходной сеткой.')
        else:
            issue = _block('daily_baseline_source_mismatch', 'Основа не совпадает с точными классами, предметами, педагогами, кабинетами и временем исходной сетки.')
        return model, [issue], diagnostics
    if not target_slots:
        blockers.append(_block('daily_target_slots_required', 'В модели нет интервалов выбранной даты.'))
    source_events = {}
    for demand in model['demands']:
        for occurrence, lesson_id in enumerate(demand['sourceLessonIds']):
            source_events.setdefault(lesson_id, []).append(f"{demand['id']}_{occurrence}")
    fixed_events = set()
    for lesson_id in content['confirmedLessonIds']:
        mapped = source_events.get(lesson_id, [])
        if len(mapped) != 1 or mapped[0] not in baseline or slots[baseline[mapped[0]]['slotId']]['day'] != context['weekday']:
            blockers.append(_block('daily_lesson_mapping_required', 'Не подтверждена точная связь закреплённого исходного занятия с событием модели.', [lesson_id]))
        else:
            fixed_events.add(mapped[0])
    pins = {row['eventId']: row for row in model['pins']}
    for event_id, assignment in baseline.items():
        if slots[assignment['slotId']]['day'] != context['weekday'] or event_id in fixed_events:
            if event_id in pins and pins[event_id] != assignment:
                blockers.append(_block('daily_pin_conflict', 'Жёсткое закрепление противоречит сохраняемой основе.', [event_id]))
            else:
                pins[event_id] = deepcopy(assignment)
    for demand in model['demands']:
        days = {slots[baseline[f"{demand['id']}_{n}"]['slotId']]['day'] for n in range(demand['weeklyCount'])}
        if context['weekday'] not in days:
            continue
        if days != {context['weekday']}:
            blockers.append(_block('daily_event_scope_required', 'Нагрузке на разные дни нужна явная связь отдельных событий; бриф не переносит её между датами.', [demand['id']]))
        else:
            allowed = set(demand['allowedSlotIds']) if demand['allowedSlotIds'] else set(slots)
            demand['allowedSlotIds'] = sorted(allowed & target_slots)
            if not demand['allowedSlotIds']:
                blockers.append(_block('daily_no_allowed_slots', 'У выбранных занятий нет допустимых интервалов целевой даты.', [demand['id']]))
    roster = {row['id']: row for row in model['teachers']}
    for override in content['teacherOverrides']:
        teacher = roster.get(override['teacherId'])
        if teacher is None:
            blockers.append(_block('daily_teacher_mapping_required', 'Педагог брифа не связан с текущей нормативной моделью.', [override['teacherId']]))
            continue
        if override['status'] == 'available':
            blocked = {key for key in target_slots if not any(w['start'] <= slots[key]['start'] and slots[key]['end'] <= w['end'] for w in override['windows'])}
        else:
            blocked = target_slots
        teacher['unavailableSlotIds'] = sorted(set(teacher['unavailableSlotIds']) | blocked)
        diagnostics.append({'code': 'daily_availability_applied', 'teacherId': teacher['id'], 'date': context['targetDate'], 'blockedSlotIds': sorted(blocked)})
    model['pins'] = sorted(pins.values(), key=lambda row: row['eventId'])
    for pin in model['pins']:
        demand = events[pin['eventId']]
        if any(pin['slotId'] in roster[identifier]['unavailableSlotIds'] for identifier in demand['teacherIds']):
            blockers.append(_block('daily_confirmed_lesson_conflict', 'Подтверждённое закрепление пересекает недоступность. Уточните звонок или закрепление.', [pin['eventId']]))
    return model, blockers, diagnostics


def _readiness(context, content, record=None):
    blockers = deepcopy(context['blockers'])
    if content['callReview'] == 'pending':
        blockers.append(_block('daily_call_review_pending', 'Сначала завершите проверку результатов звонков.'))
    unknown = [row['teacherId'] for row in content['teacherOverrides'] if row['status'] == 'unknown']
    if unknown:
        blockers.append(_block('daily_teacher_unknown', 'Для указанных педагогов доступность ещё не подтверждена.', unknown))
    if record and digest(record['sourceBinding']) != context['sourceBindingHash']:
        blockers.append(_block('daily_source_changed', 'Источники брифа изменились. Сведения сохранены; проверьте и сохраните новую версию.'))
    if context['effectiveInput'] is not None and not context['blockers']:
        _, issues, _ = _overlay(context, content, context['effectiveInput'])
        blockers.extend(issues)
    unique = []
    for blocker in blockers:
        if blocker not in unique:
            unique.append(blocker)
    return {'ready': not unique, 'blockers': unique, 'missingForms': context['missingForms']}


def _response(context, content, record=None, *, revision=0, preview_hash=None, preflight=False):
    readiness = _readiness(context, content, record)
    if preflight and record is None:
        readiness['ready'] = False
        readiness['blockers'].append(_block('daily_brief_not_saved', 'Сначала сохраните проверенный бриф.'))
    binding = None
    run_input = None
    if preflight and record and readiness['ready']:
        binding = {'targetDate': context['targetDate'], 'revision': revision,
            'sourceBindingHash': context['sourceBindingHash'], 'briefHash': record['briefHash']}
        run_input = {'expectedConfigRevision': context['sourceBinding']['configRevision'],
            'expectedDraftRevision': context['sourceBinding']['draftRevision'], 'periodStart': context['weekStart'],
            'mode': 'repair', 'dailyBrief': binding}
    return {'version': 1, 'targetDate': context['targetDate'], 'weekStart': context['weekStart'],
        'sourceName': context['draft'].get('sourceName') or None,
        'timezone': 'Europe/Moscow', 'revision': revision, 'saved': record is not None,
        'content': deepcopy(content), 'sourceBinding': context['sourceBinding'],
        'sourceBindingHash': context['sourceBindingHash'], 'briefHash': record['briefHash'] if record else None,
        'previewHash': preview_hash, 'teachers': context['teachers'], 'lessons': context['lessons'],
        'readiness': readiness, 'dailyBriefBinding': binding, 'runInput': run_input,
        'receipt': None, 'notice': NOTICE}


def _current(connection, profile, target):
    actor = _operator(profile)
    try:
        iso_date(target)
    except (ValueError, TypeError):
        raise HTTPException(422, 'Укажите существующую дату YYYY-MM-DD') from None
    context = _context(connection, actor, target)
    data = _ledger(context['state'], actor['schoolId'])
    record = data['records'].get(target)
    return actor, context, data, record


def _cas(context, record, revision, source_hash):
    if (record['revision'] if record else 0) != revision:
        _conflict('Бриф изменился. Обновите его перед сохранением или расчётом.', 'daily_brief_changed')
    if context['sourceBindingHash'] != source_hash:
        _conflict('Исходные сведения изменились. Обновите предпросмотр брифа.')


def read(connection, profile, target_date):
    actor, context, _, record = _current(connection, profile, target_date)
    content = record['content'] if record else BriefContent(targetDate=target_date).model_dump()
    result = _response(context, content, record, revision=record['revision'] if record else 0)
    _operator(actor)
    return result


def _preview_hash(body, actor, context):
    return digest({'content': _content(body), 'revision': body.expectedRevision,
        'sourceBindingHash': context['sourceBindingHash'], 'actor': _actor_binding(actor)})


def preview(connection, profile, body):
    actor = _operator(profile)
    body = _body(PreviewInput, body)
    _, context, _, record = _current(connection, actor, body.targetDate)
    _cas(context, record, body.expectedRevision, body.expectedSourceBindingHash)
    content = _content(body)
    _validate_references(context, content)
    result = _response(context, content, revision=body.expectedRevision,
        preview_hash=_preview_hash(body, actor, context))
    _operator(actor)
    return result


def save(connection, profile, body):
    actor = _operator(profile)
    body = _body(SaveInput, body)
    _, context, data, record = _current(connection, actor, body.targetDate)
    fingerprint = digest(body.model_dump())
    receipt = data['receipts'].get(body.requestId)
    if receipt is not None:
        if receipt['actor'] != _actor_binding(actor) or receipt['fingerprint'] != fingerprint:
            _conflict('Этот requestId уже использован для другой команды или участника.', 'daily_request_id_conflict')
        _operator(actor)
        return deepcopy(receipt['result'])
    _cas(context, record, body.expectedRevision, body.expectedSourceBindingHash)
    if body.previewHash != _preview_hash(body, actor, context):
        _conflict('Предпросмотр не совпадает с участником, источником или содержимым брифа.', 'daily_preview_changed')
    content = _content(body)
    _validate_references(context, content)
    if not context['storedState']:
        _conflict('Сначала подготовьте доменное состояние школы.', 'daily_school_state_required')
    revision = body.expectedRevision + 1
    if revision > MAX_REVISION or len(data['receipts']) >= MAX_RECEIPTS or (record is None and len(data['records']) >= MAX_BRIEFS):
        raise HTTPException(429, 'Достигнут предел истории брифов; прежние записи сохранены')
    stamp = datetime.now(ZoneInfo('UTC')).isoformat()
    row = {'revision': revision, 'content': content, 'sourceBinding': context['sourceBinding'],
        'briefHash': _record_hash(content, context['sourceBinding'], revision),
        'actor': _actor_binding(actor), 'createdAt': record['createdAt'] if record else stamp, 'updatedAt': stamp}
    data['records'][body.targetDate] = row
    result = _response(context, content, row, revision=revision)
    result['receipt'] = {'requestId': body.requestId, 'revision': revision, 'briefHash': row['briefHash']}
    data['receipts'][body.requestId] = {'actor': _actor_binding(actor), 'fingerprint': fingerprint, 'result': deepcopy(result)}
    if len(json.dumps(data, ensure_ascii=False).encode()) > MAX_BYTES:
        raise HTTPException(429, 'Достигнут предел размера истории брифов; прежние записи сохранены')
    _operator(actor)
    state = deepcopy(context['state'])
    state[KEY] = data
    connection.execute('UPDATE demo_state SET payload=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
    return result


def preflight(connection, profile, body):
    actor = _operator(profile)
    body = _body(PreflightInput, body)
    _, context, _, record = _current(connection, actor, body.targetDate)
    _cas(context, record, body.expectedRevision, body.expectedSourceBindingHash)
    content = record['content'] if record else BriefContent(targetDate=body.targetDate).model_dump()
    result = _response(context, content, record, revision=body.expectedRevision, preflight=True)
    _operator(actor)
    return result


def _grid_hash(lessons, revision):
    fields = ('id', *timetable.EditableLessonInput.model_fields)
    rows = sorted([{key: row[key] for key in fields} for row in lessons], key=lambda row: row['id'])
    return digest({'revision': revision, 'lessons': rows})


def _approved_run(connection, binding, run_id):
    from .planning import PlanningService
    if not run_id or not db.table_exists(connection, 'planning_runs'):
        _conflict('Нет точного применённого расчёта брифа.', 'daily_application_required')
    cursor = connection.execute('SELECT * FROM planning_runs WHERE id=?', (run_id,))
    fetched = cursor.fetchone()
    if fetched is None:
        _conflict('Применённый расчёт не найден.', 'daily_application_required')
    row = dict(zip((column[0] for column in cursor.description), fetched))
    base = json.loads(row['base_snapshot_json'])
    if (row['status'] != 'approved' or row['cancel_requested'] or not row['applied_task_id']
            or row['applied_task_id'] != row['proposal_task_id'] or base.get('dailyBriefBinding') != binding
            or PlanningService._run_hash(row) != row['proposal_hash']):
        _conflict('Расчёт не подтверждает применение точного брифа.', 'daily_application_mismatch')
    lessons = PlanningService._verified_materialization(row)
    return row, base, lessons


def _applied_context(context, data, record, binding, run_id, applied_draft_revision):
    row, base, lessons = _approved_run(context['connection'], binding, run_id)
    marker = data['applications'].get(run_id)
    revision = row['draft_revision'] + 1
    grid_hash = _grid_hash(lessons, revision)
    if (marker is None or marker['binding'] != binding or marker['appliedRevision'] != revision
            or marker['gridHash'] != grid_hash or marker['baseSnapshotHash'] != row['base_snapshot_hash']
            or marker['appliedTaskId'] != row['applied_task_id']
            or context['draft']['revision'] != revision
            or _grid_hash(context['draft']['lessons'], revision) != grid_hash
            or applied_draft_revision is not None and applied_draft_revision != revision):
        _conflict('Текущая сетка или маркер не совпадает с применённым расчётом.', 'daily_application_mismatch')
    if not db.table_exists(context['connection'], 'timetable_command_receipts'):
        _conflict('Нет доменной квитанции применения брифа.', 'daily_application_required')
    receipt = context['connection'].execute('SELECT command_hash,actor_id,actor_role,result FROM timetable_command_receipts WHERE command_key=?',
        (row['applied_task_id'],)).fetchone()
    if receipt is None:
        _conflict('Нет доменной квитанции применения брифа.', 'daily_application_required')
    domain_role = base.get('actorBinding', {}).get('domainRole', row['owner_role'])
    expected_command = timetable.batch_hash(lessons, row['draft_revision'], 'Автоматический расчёт')
    saved = json.loads(_item(receipt, 'result', 3))
    if ((_item(receipt, 'command_hash', 0), _item(receipt, 'actor_id', 1), _item(receipt, 'actor_role', 2))
            != (expected_command, row['owner_id'], domain_role)
            or domain_role != row['owner_role'] or saved['revision'] != revision
            or _grid_hash(saved['lessons'], revision) != grid_hash):
        _conflict('Квитанция не подтверждает точное применение брифа.', 'daily_application_mismatch')
    old = record['sourceBinding']
    if any(context['sourceBinding'][key] != value for key, value in old.items() if key not in {'draftRevision', 'draftHash'}):
        _conflict('Нормативы, календарь или привязка источника изменились после применения.')
    source = {'revision': base['revision'], 'lessons': deepcopy(base['lessons'])}
    if source['revision'] != old['draftRevision'] or row['draft_revision'] != old['draftRevision']:
        _conflict('Исходная ревизия расчёта не совпадает с брифом.', 'daily_application_mismatch')
    original_baseline = json.loads(row['input_json'])['baseline']
    original_plan = {**context['plan'], 'baseline': deepcopy(original_baseline)}
    original_effective = {**context['effectiveInput'], 'baseline': deepcopy(original_baseline)}
    historical = {**context, 'draft': source, 'plan': original_plan, 'effectiveInput': original_effective,
        'sourceBinding': old, 'sourceBindingHash': digest(old),
        'blockers': [b for b in context['blockers'] if b['code'] != 'daily_config_draft_changed']}
    return historical


def assert_binding_current(connection, profile, binding, *, run_id=None, allow_applied=False, applied_draft_revision=None):
    actor = _operator(profile)
    binding = _body(DailyRunBinding, binding)
    _, context, data, record = _current(connection, actor, binding.targetDate)
    if record is None or record['revision'] != binding.revision:
        _conflict('Бриф изменился; нужен новый расчёт.', 'daily_brief_changed')
    if record is None or record['briefHash'] != binding.briefHash:
        _conflict('Содержимое брифа изменилось; нужен новый расчёт.', 'daily_brief_changed')
    if digest(record['sourceBinding']) != binding.sourceBindingHash:
        _conflict('Привязка сохранённого брифа изменилась.')
    if allow_applied:
        context = _applied_context(context, data, record, binding.model_dump(), run_id, applied_draft_revision)
    else:
        _cas(context, record, binding.revision, binding.sourceBindingHash)
    ready = _readiness(context, record['content'], record)
    if not ready['ready']:
        raise HTTPException(409, {'code': 'daily_brief_not_ready', 'message': 'Бриф пока не допускает расчёт.', 'issues': ready['blockers']})
    _operator(actor)
    return binding.model_dump()


def build_run_overlay(connection, profile, binding, plan, draft=None):
    current = assert_binding_current(connection, profile, binding)
    actor, context, _, record = _current(connection, profile, current['targetDate'])
    value = PlanningInput.model_validate(plan).model_dump()
    if value['periodStart'] != context['weekStart']:
        _conflict('Неделя расчёта не совпадает с датой брифа.', 'daily_week_mismatch')
    if draft is not None:
        fields = ('id', *timetable.EditableLessonInput.model_fields)
        source_view = lambda rows: sorted([{key: row[key] for key in fields} for row in rows], key=lambda row: row['id'])
        if draft.get('revision') != context['sourceBinding']['draftRevision'] or source_view(draft.get('lessons', [])) != source_view(context['draft']['lessons']):
            _conflict('Черновик расчёта не совпадает с источником брифа.')
    effective, blockers, diagnostics = _overlay(context, record['content'], value)
    if blockers:
        raise HTTPException(409, {'code': 'daily_brief_not_ready', 'message': 'Ограничения брифа требуют уточнения.', 'issues': blockers})
    _operator(actor)
    return {'effectiveInput': effective, 'dailyBriefBinding': current, 'diagnostics': diagnostics}


def mark_applied(connection, profile, binding, run_id, applied_revision, lessons):
    """Called in the existing apply guard; later grid/receipt failure rolls back."""
    actor = _operator(profile)
    current = assert_binding_current(connection, actor, binding)
    _, context, data, _ = _current(connection, actor, current['targetDate'])
    row, base, verified = _approved_run(connection, current, run_id)
    if (type(applied_revision) is not int or applied_revision != row['draft_revision'] + 1
            or row['owner_id'] != actor['userId']
            or row['owner_role'] != base.get('actorBinding', {}).get('domainRole', profile.get('role'))
            or _grid_hash(lessons, applied_revision) != _grid_hash(verified, applied_revision)):
        _conflict('Нельзя подтвердить применение другой сетки или другого расчёта.', 'daily_application_mismatch')
    marker = {'schoolId': actor['schoolId'], 'runId': run_id, 'binding': current,
        'appliedRevision': applied_revision, 'gridHash': _grid_hash(verified, applied_revision),
        'baseSnapshotHash': row['base_snapshot_hash'], 'appliedTaskId': row['applied_task_id'],
        'actor': _actor_binding(actor)}
    marker['hash'] = digest(marker)
    old = data['applications'].get(run_id)
    if old is not None and old != marker:
        _conflict('Маркер применения уже связан с другим результатом.', 'daily_application_mismatch')
    if old is None and len(data['applications']) >= MAX_RECEIPTS:
        raise HTTPException(429, 'Достигнут предел квитанций применения брифов')
    data['applications'][run_id] = marker
    if len(json.dumps(data, ensure_ascii=False).encode()) > MAX_BYTES:
        raise HTTPException(429, 'Достигнут предел истории брифов')
    _operator(actor)
    state = deepcopy(context['state']); state[KEY] = data
    connection.execute('UPDATE demo_state SET payload=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
    return marker


def reapply_effect(connection, profile, binding, base_effective, *, run_id=None, allow_applied=False, applied_draft_revision=None):
    current = assert_binding_current(connection, profile, binding, run_id=run_id,
        allow_applied=allow_applied, applied_draft_revision=applied_draft_revision)
    actor, context, data, record = _current(connection, profile, current['targetDate'])
    if allow_applied:
        context = _applied_context(context, data, record, current, run_id, applied_draft_revision)
    model = PlanningInput.model_validate(base_effective).model_dump()
    if allow_applied:
        model['baseline'] = deepcopy(context['effectiveInput']['baseline'])
    if model['periodStart'] != context['weekStart']:
        _conflict('Неделя не совпадает с датой брифа.', 'daily_week_mismatch')
    effective, blockers, diagnostics = _overlay(context, record['content'], model)
    if blockers:
        raise HTTPException(409, {'code': 'daily_brief_not_ready', 'message': 'Бриф больше не подтверждает этот расчёт.', 'issues': blockers})
    _operator(actor)
    return {'effectiveInput': effective, 'dailyBriefBinding': current, 'diagnostics': diagnostics}
