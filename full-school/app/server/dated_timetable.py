"""A dated review draft, isolated from the active timetable and publication.

This route deliberately does not turn historical class rows into a normative
solver model. Missing rooms, group membership and teacher phases remain open.
"""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import db
from .auth import require_roles
from .school_ops import _snapshot
from .school_plan_imports import _actor
from .workspace import verify_school_state

NAMESPACE = '_datedTimetableDrafts'
WEEK = '2026-10-26'
BASIS_PATH = Path(__file__).parent / 'assets' / 'short-week-basis-2026-10-26.json'
CALENDAR = {'periodStart': WEEK,
    'teachingDates': ['2026-10-26', '2026-10-27', '2026-10-28'],
    'closedDates': ['2026-10-29', '2026-10-30', '2026-10-31'],
    'holidayEnd': None, 'source': 'Указание пользователя: каникулы с четверга, 29 октября.'}


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


class CreateDatedDraft(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    weekStart: Literal['2026-10-26']
    expectedSourceRevision: int = Field(ge=0, le=2**31-1)
    requestId: str = Field(min_length=16, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')


def _stored(state, school_id):
    result = state.get(NAMESPACE)
    if result is None:
        return {'version': 1, 'schoolId': school_id, 'drafts': []}
    if (not isinstance(result, dict) or type(result.get('version')) is not int or result.get('version') != 1
            or result.get('schoolId') != school_id or not isinstance(result.get('drafts'), list)
            or len(result['drafts']) > 8):
        raise HTTPException(503, 'Реестр датированных черновиков требует проверки.')
    for item in result['drafts']:
        if not isinstance(item, dict) or not isinstance(item.get('draft'), dict):
            raise HTTPException(503, 'Датированный черновик требует проверки.')
        draft = item['draft']
        if (draft.get('scope') != 'historical_carryover' or draft.get('publicationBlocked') is not True
                or not isinstance(draft.get('lessons'), list) or draft.get('weekStart') != WEEK
                or draft.get('closedDates') != CALENDAR['closedDates']
                or draft.get('teachingDates') != CALENDAR['teachingDates']
                or draft.get('holidayEnd') is not None
                or not _matches(r'[a-f0-9]{64}', item.get('commandHash'))
                or not _matches(r'[a-f0-9]{64}', item.get('sourceHash'))
                or not _matches(r'dated_[a-f0-9]{24}', draft.get('id'))
                or not _matches(r'[A-Za-z0-9_-]{16,80}', item.get('requestId'))
                or not isinstance(item.get('actorId'), str)
                or type(item.get('sourceRevision')) is not int):
            raise HTTPException(503, 'Датированный черновик требует проверки.')
    if len({item['draft']['weekStart'] for item in result['drafts']}) != len(result['drafts']):
        raise HTTPException(503, 'Повторные версии датированной недели требуют проверки.')
    return deepcopy(result)


def _response(stored, source):
    item = next((i for i in stored['drafts'] if i['draft']['weekStart'] == WEEK), None)
    draft = deepcopy(item['draft']) if item else None
    if draft:
        draft['sourceChanged'] = item['sourceHash'] != _hash(source)
    return {'draft': draft, 'canCreate': item is None and bool(source['lessons']),
            'sourceRevision': source['revision']}


def read_dated_draft(profile):
    _actor(profile)
    state, source = _snapshot(raw_draft=True)
    return _response(_stored(state, profile['schoolId']), source)


def guard_saved_calendar(state, school_id, period_start, lessons=None):
    """The known holiday also gates the older full-week calculation path."""
    if NAMESPACE not in state:
        return
    stored = _stored(state, school_id)
    item = next((i for i in stored['drafts'] if i['draft']['weekStart'] == period_start), None)
    if item is None:
        return
    closed = set(item['draft']['closedDates'])
    if lessons is not None:
        first = date.fromisoformat(period_start)
        if not any((first + timedelta(days=row['day'])).isoformat() in closed for row in lessons):
            return
    raise HTTPException(409, 'На этой неделе с 29 октября каникулы. Прежний полный недельный расчёт нельзя согласовать или опубликовать. Откройте отдельный черновик на 26–28 октября.')


def create_dated_draft(body: CreateDatedDraft, profile):
    _actor(profile)
    from .short_week_draft import build_short_week_draft
    actor_id = str(profile['userId'])
    command_hash = _hash(body.model_dump())
    # One transaction protects source CAS, receipt and the separate namespace.
    with closing(sqlite3.connect(db.database_path(), timeout=15)) as connection:
        connection.execute('BEGIN IMMEDIATE')
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demo_state'").fetchone():
            raise HTTPException(409, 'Сначала откройте рабочий кабинет школы и загрузите исходную сетку.')
        row = connection.execute('SELECT payload FROM demo_state WHERE id=1').fetchone()
        if row is None:
            raise HTTPException(409, 'Сначала загрузите исходную школьную сетку.')
        state = json.loads(row[0]); verify_school_state(state)
        stored = _stored(state, profile['schoolId'])
        row = connection.execute('SELECT payload FROM timetable_draft WHERE id=1').fetchone()
        source = json.loads(row[0]) if row else {'revision': 0, 'lessons': []}
        receipt = next((i for i in stored['drafts'] if i['requestId'] == body.requestId), None)
        if receipt:
            if receipt['commandHash'] != command_hash or receipt['actorId'] != actor_id:
                raise HTTPException(409, 'Этот номер запроса уже использован для другого действия.')
            return {'draft': deepcopy(receipt['draft']), 'canCreate': False,
                    'sourceRevision': receipt['sourceRevision']}
        if source['revision'] != body.expectedSourceRevision:
            raise HTTPException(409, 'Исходная сетка изменилась. Обновите её перед расчётом.')
        if any(i['draft']['weekStart'] == WEEK for i in stored['drafts']):
            raise HTTPException(409, 'Черновик этой недели уже сохранён. Обновите страницу.')
        if not source['lessons']:
            raise HTTPException(409, 'Не найдены исходные школьные уроки.')
        try:
            basis = json.loads(BASIS_PATH.read_text())
        except (OSError, ValueError):
            raise HTTPException(503, 'Проверенные условия короткой недели временно недоступны.') from None
        # This source basis was audited against this historical file. Never
        # attach those assumptions to an unrelated or later imported timetable.
        if (source.get('sourceFilename') or source.get('sourceName')) != 'historical-example.xlsx':
            raise HTTPException(409, 'Для этой исходной сетки ещё не проверены даты и школьные условия.')
        try:
            result = build_short_week_draft(source, deepcopy(CALENDAR), source_basis=basis,
                rules=basis.get('rules'), repairs=basis.get('repairs'))
        except ValueError:
            raise HTTPException(409, 'Исходная сетка не совпадает с проверенной основой. Нужна повторная проверка условий.') from None
        stamp = datetime.now(timezone.utc).isoformat()
        draft = {**result, 'id': 'dated_' + _hash([profile['schoolId'], WEEK])[:24],
            'revision': 1, 'weekStart': WEEK, 'title': '26–28 октября · короткая учебная неделя',
            'teachingDates': CALENDAR['teachingDates'], 'closedDates': CALENDAR['closedDates'],
            'holidayEnd': None, 'sourceName': source.get('sourceName', ''),
            'sourcePeriod': '12–16 октября 2026', 'scope': 'historical_carryover',
            'publicationBlocked': True, 'sourceChanged': False, 'createdAt': stamp,
            'notes': [
                'Каникулы начинаются 29 октября. Уроки четверга и пятницы не перенесены на первые три дня.',
                'За основу взяты понедельник–среда из школьной сетки 12–16 октября. Это рабочий перенос с проверкой найденных ограничений, а не полный новый расчёт нагрузки.',
                'Звонки взяты из исходной сетки как рабочее предположение. Дата окончания каникул не задана.',
                'Состав подгрупп, вместимость и пригодность кабинетов, фаза смены преподавателей и часть новых назначений требуют проверки. Числа учащихся и случайные кабинеты не добавлялись.',
                'Подписи родного и государственного языка и новые назначения китайского в исторической сетке ещё требуют разнесения по подтверждённым подгруппам.',
                'Черновик не согласован и не опубликован. Личные расписания учителей не изменены.']}
        # The public repair list is explanatory; original detail remains in
        # repairsApplied/provenance for review, never in active lesson records.
        draft['repairs'] = result.get('repairsApplied', [])
        stored['drafts'].append({'draft': draft, 'sourceHash': _hash(source),
            'sourceRevision': source['revision'], 'requestId': body.requestId,
            'commandHash': command_hash, 'actorId': actor_id})
        payload = json.dumps(stored, ensure_ascii=False, allow_nan=False)
        if len(payload.encode()) > 3 * 1024 * 1024:
            raise HTTPException(429, 'Достигнут предел хранения датированного черновика.')
        state[NAMESPACE] = stored
        _actor(profile)
        connection.execute('UPDATE demo_state SET payload=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
        connection.commit()
        return _response(stored, source)


router = APIRouter(prefix='/api/timetable/dated-draft', tags=['dated draft'])


@router.get('')
def http_read(weekStart: Literal['2026-10-26'] = WEEK,
              profile=Depends(require_roles('admin', 'director'))):
    return read_dated_draft(profile)


@router.post('')
def http_create(body: CreateDatedDraft, profile=Depends(require_roles('admin', 'director'))):
    return create_dated_draft(body, profile)
