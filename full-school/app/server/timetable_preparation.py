"""Read-only preparation of a school grid, including slots without bell times.

Only source facts are returned. No storage, teacher identity resolution, event
merging, or publishable timetable is created by this module.
"""
from datetime import date
import hashlib
import re

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from . import timetable as tt


class Bell(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    slot: int = Field(ge=1, le=20)
    start: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    end: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')

    @model_validator(mode='after')
    def positive_interval(self):
        if self.start >= self.end:
            raise ValueError('Invalid bell interval')
        return self


def _bell_schedule(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 20:
        tt._invalid('Звонки задаются списком до 20 интервалов')
    try:
        bells = sorted((Bell.model_validate(row).model_dump() for row in value), key=lambda row: row['slot'])
    except ValidationError:
        tt._invalid('Укажите уникальные номера уроков от 1 до 20 и время ЧЧ:ММ без дополнительных полей')
    if len({row['slot'] for row in bells}) != len(bells):
        tt._invalid('Номера уроков в звонках не должны повторяться')
    if any(previous['end'] > following['start'] for previous, following in zip(bells, bells[1:])):
        tt._invalid('Звонки должны следовать по номерам уроков без пересечений времени')
    return bells


def _sheet_rows(payload):
    # Established hostile-input limits apply to the entire OOXML package.
    roots = tt._archive(payload)
    workbook = roots.get('xl/workbook.xml')
    relationships = roots.get('xl/_rels/workbook.xml.rels')
    if (workbook is None or workbook.tag != f'{{{tt.MAIN}}}workbook'
            or relationships is None or '[Content_Types].xml' not in roots):
        tt._invalid('Отсутствует структура книги XLSX')
    sheets = workbook.findall('m:sheets/m:sheet', tt.NS)
    if not sheets or len(sheets) > 32:
        tt._invalid('Некорректное число листов XLSX')
    names, identifiers = set(), set()
    for sheet in sheets:
        name, identifier = sheet.get('name', ''), sheet.get(f'{{{tt.DOC_REL}}}id', '')
        if (not name or len(name) > 100 or tt.canonical(name) in names
                or not identifier or identifier in identifiers):
            tt._invalid('Повторяющиеся или некорректные листы XLSX')
        names.add(tt.canonical(name))
        identifiers.add(identifier)
    selected = [sheet for sheet in sheets if tt.canonical(sheet.get('name', '')) == tt.canonical('Расписание')]
    if not selected:
        if len(sheets) != 1:
            tt._invalid('Выберите книгу с листом «Расписание» или единственным совместимым листом')
        selected = sheets
    chosen = selected[0]
    links = {item.get('Id'): item for item in relationships}
    link = links.get(chosen.get(f'{{{tt.DOC_REL}}}id'))
    if link is None or link.get('Type') != f'{tt.DOC_REL}/worksheet':
        tt._invalid('Неверная связь листа расписания')
    root = roots.get(tt._relationship_target('xl/workbook.xml', link.get('Target', '')))
    if root is None:
        tt._invalid('Лист расписания отсутствует в архиве')
    if root.find('m:mergeCells', tt.NS) is not None:
        tt._invalid('Для подготовки выберите сетку без объединённых ячеек')
    shared = []
    shared_links = [item for item in relationships if item.get('Type') == f'{tt.DOC_REL}/sharedStrings']
    if len(shared_links) > 1:
        tt._invalid('Неоднозначный словарь строк XLSX')
    if shared_links:
        shared_root = roots.get(tt._relationship_target('xl/workbook.xml', shared_links[0].get('Target', '')))
        if shared_root is None or shared_root.tag != f'{{{tt.MAIN}}}sst':
            tt._invalid('Отсутствует словарь строк XLSX')
        for item in shared_root:
            if item.tag != f'{{{tt.MAIN}}}si' or len(shared) >= tt.MAX_SHARED_STRINGS:
                tt._invalid('Превышен лимит или повреждён словарь строк XLSX')
            text = ''.join(node.text or '' for node in item.findall('.//m:t', tt.NS))
            if len(text) > tt.MAX_CELL_TEXT:
                tt._invalid('Слишком длинная общая строка XLSX')
            shared.append(text)
    return chosen.get('name'), tt._worksheet_rows(root, shared)


def _slot(value):
    if re.fullmatch(r'[1-9][0-9]?', value.strip()):
        slot = int(value)
        if not 1 <= slot <= 20:
            tt._invalid('Номер урока должен быть от 1 до 20')
        return slot, None, None
    return tt._parse_slot(value)


def _effective_date(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError
        return date.fromisoformat(value).isoformat()
    except ValueError:
        tt._invalid('Укажите существующую дату начала действия в формате ГГГГ-ММ-ДД')


def preview_timetable(payload: bytes, filename: str, effective_date: str | None = None,
                      bell_schedule: list[dict] | None = None) -> dict:
    """Parse bounded XLSX facts. An explicit date never supplies missing bells."""
    effective_date = _effective_date(effective_date)
    bells = _bell_schedule(bell_schedule)
    bells_by_slot = {row['slot']: row for row in bells}
    source_name = tt._source_name(filename)
    sheet_name, rows = _sheet_rows(payload)
    source_hash = hashlib.sha256(payload).hexdigest()
    classes, lessons, intervals, day = None, [], [], None
    day_lookup = {tt.canonical(name): index for index, name in enumerate(tt.DAY_NAMES)}
    day_lookup.update({name: index for index, name in enumerate(('пн', 'вт', 'ср', 'чт', 'пт', 'сб'))})
    for number, cells in rows:
        nonempty = {column: value for column, (_, value) in cells.items() if value.strip()}
        if not nonempty:
            continue
        a, b = nonempty.get(1, '').strip(), nonempty.get(2, '').strip()
        if tt.canonical(a) == 'дни' or tt.canonical(b) == 'уроки':
            if tt.canonical(a) != 'дни' or tt.canonical(b) != 'уроки' or max(nonempty) < 3:
                tt._invalid('Повреждена строка заголовков расписания')
            header = [nonempty.get(column, '').strip() for column in range(3, max(nonempty) + 1)]
            if (any(not name or len(name) > 80 for name in header)
                    or len({tt.canonical(name) for name in header}) != len(header)):
                tt._invalid('Пустые, повторяющиеся или слишком длинные классы в заголовке')
            try:
                for name in header:
                    tt._single_line(name)
            except ValueError:
                tt._invalid('Некорректное имя класса')
            if classes is not None and header != classes:
                tt._invalid('Повторный заголовок должен содержать те же классы в том же порядке')
            classes = header
            continue
        if classes is None:
            if number > 10 or any(column != 1 for column in nonempty):
                tt._invalid('Неподдерживаемая структура: ожидаются «Дни», «Уроки» и классы начиная с C')
            continue
        if max(nonempty) > len(classes) + 2:
            tt._invalid('Данные выходят за столбцы классов')
        if a:
            if tt.canonical(a) not in day_lookup:
                tt._invalid('Неизвестный день недели в расписании')
            day = day_lookup[tt.canonical(a)]
        if not b:
            if any(column >= 3 for column in nonempty):
                tt._invalid('Урок указан без номера')
            continue
        slot, start, end = _slot(b)
        time_source = 'source' if start is not None else 'missing'
        supplied = bells_by_slot.get(slot)
        if supplied:
            if start is None:
                start, end, time_source = supplied['start'], supplied['end'], 'provided'
            elif (start, end) != (supplied['start'], supplied['end']):
                tt._invalid('Введённые звонки противоречат явному времени урока в XLSX')
        if day is None:
            tt._invalid('До первого урока требуется день недели')
        intervals.append({'day': day, 'slot': slot, 'start': start, 'end': end,
                          'sourceCell': f'{sheet_name}!B{number}', 'timeSource': time_source})
        for column, class_name in enumerate(classes, 3):
            coordinate, raw = cells.get(column, ('', ''))
            if not raw.strip():
                continue
            subject, teachers, rooms, warnings = tt._parse_lesson(raw)
            if len(lessons) >= tt.MAX_LESSONS:
                tt._invalid('Превышен лимит уроков')
            lessons.append({'id': f'prep_{source_hash[:16]}_{coordinate}',
                'sourceCell': f'{sheet_name}!{coordinate}', 'raw': raw,
                'className': class_name, 'day': day, 'slot': slot, 'start': start, 'end': end, 'timeSource': time_source,
                'subject': subject, 'teachers': teachers, 'rooms': rooms, 'warnings': warnings})
    if classes is None or not lessons:
        tt._invalid('Совместимое расписание с уроками не найдено')

    missing_bells = [row for row in intervals if row['start'] is None]
    missing_rooms = [row for row in lessons if not row['rooms']]
    missing_teachers = [row for row in lessons if not row['teachers']]
    ambiguous_groups = [row for row in lessons if len(row['teachers']) > 1 or len(row['rooms']) > 1]
    unresolved = []
    if effective_date is None:
        unresolved.append({'code': 'effective_date_required', 'message': 'Не указана дата начала действия сетки. Имя файла не подтверждает период.', 'sourceCells': []})
    unresolved.extend([
        {'code': 'groups_unconfirmed', 'message': 'Группы и совместные занятия не подтверждены. Каждая заполненная ячейка класса показана отдельно.', 'sourceCells': [row['sourceCell'] for row in ambiguous_groups]},
        {'code': 'teacher_bindings_unconfirmed', 'message': 'Имена педагогов прочитаны из файла. Привязки к сотрудникам школы не установлены.', 'sourceCells': []},
        {'code': 'teaching_dates_unconfirmed', 'message': 'Учебные даты и исключения школьного календаря не подтверждены.', 'sourceCells': []},
    ])
    for code, message, affected in (
            ('bell_times_required', 'Для уроков с одним номером не заданы время начала и окончания.', missing_bells),
            ('rooms_missing', 'В исходных ячейках не указан кабинет.', missing_rooms),
            ('teachers_missing', 'В исходных ячейках не указан преподаватель.', missing_teachers)):
        if affected:
            unresolved.append({'code': code, 'message': message, 'sourceCells': [row['sourceCell'] for row in affected]})
    days = [{'day': value, 'name': tt.DAY_NAMES[value],
             'lessonCount': sum(row['day'] == value for row in lessons),
             'slots': sorted({row['slot'] for row in intervals if row['day'] == value})}
            for value in sorted({row['day'] for row in intervals})]
    slots = sorted({row['slot'] for row in intervals})
    return {'version': 1, 'sourceName': source_name, 'sourceHash': source_hash, 'sheetName': sheet_name,
        'classes': classes, 'days': days, 'slots': slots, 'intervals': intervals, 'bellSchedule': bells,
        'counts': {'lessons': len(lessons), 'classes': len(classes), 'days': len(days), 'slots': len(slots),
                   'missingRooms': len(missing_rooms), 'missingTeachers': len(missing_teachers),
                   'ambiguousGroups': len(ambiguous_groups),
                   'missingBellSlots': len({(row['day'], row['slot']) for row in missing_bells})},
        'lessons': lessons, 'effectiveDate': effective_date, 'unresolved': unresolved, 'readyToPublish': False}
