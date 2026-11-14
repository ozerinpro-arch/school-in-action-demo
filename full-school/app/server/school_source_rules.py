"""Curated, hash-bound HARD fragments of the supplied school conditions.

Pure: no persistence, text execution, name guessing, invented load or rooms.
A partial fragment never certifies the rest of its source condition.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date
from hashlib import sha256

from .scheduling_models import PlanningInput, canonical
from .subject_names import class_grade

# Exact UTF-8 text hashes from the reviewed 2026-10-24 source package. A changed
# text (even with the same numerical condition ID) needs a new review.
REVIEWED_TEXT_HASHES = {
    'general-01': '0f522982465d9d68a016e9408eab5ad6372f51304590789f8e9e9da1491c57b3',
    'general-02': '00b8bbcc43e865f037d21cb2a6a177f27f2a6e3cee402be18126ea0b62c547ef',
    'general-07': '632f55e8f088e895556c60353ffc05a6e02daeb033dc0f8ad237c9294f805887',
    'general-08': '711e2fc26e6d97d4c5b8fa92b5f1f5e36e4c194d5ab6cd82d60282f92d6daf47',
    'general-09': '1b38ff6eff723fad9ef18cfd776028eb6cf33324c6249ccc26477e9ca0a11717',
    'general-11': '29a86d9e4a06cb8c93bbfefe87db5ebb1aa1399ce71e4542be248696f9b6f7ae',
    'general-12': '863ce5ff068b540a1548e0404b7e8af196efb78034bfb51f8077bcbf287423c6',
    'general-13': 'e580b4dde04c878eae733c812fcfce99f0a54982ddaa0e678b84956713999eeb',
    'general-14': '1ea584be98b307babef69cd75532582cedf7f92f5888b8010dbd74ca5540ac69',
    'general-16': '8274284a1ea9668d49fc35889fe5ce18516582b044775e39abdaf4464e2941c2',
    'general-17': '84eb645558a0ee37846a28e8d15e1914b1b6a044239531153ada8b4556fe4dc2',
    'general-18': '4a22038a5744ca9f0d41efbfcfc487330fd7d5ecec0621bf2f71a80f3e1c03d2',
    'DO2026-p5': '67cfc8cb5dcffc41d98232facb5ad52de26164988b0ce79f6815fe1d9dd5add5',
    'DO2026-p8': 'd99c84b40000a1f71e2ff66ae0d0df70678b06d423ab4e987ac456386d84a2b2',
    'DO2026-p10': 'df81ede2021ff7f17cf74a6f894d1e4245e58003b51f8a0da7c81c11bb8443c4',
    'DO2026-p11': '87484cb3715f8a8712c6c6e64e78732ac98f7d4486f3b8ebecfa936c1e21dd1c',
    'DO2026-p12': '38f5fcd72be16da76b6d7a7484a77bd914fb37c3f682fae4c4223cafc92b204e',
    'DO2026-p13': 'fc1cf89c6d66712b417b159ca757373d22c238e0c95e4a4589a159d4301da8c0',
    'DO2026-p17': 'b82107cf90967d5d3f58264df9dc1131b9e9608a8439cd997af07e09060856ce',
    'DO2026-p18': 'fdfe30113b1632b793894d5ba52e13a0c5b57b19db8034da16ef2c05b27011d8',
    'DO2026-p20': '2024b8aa91755ac4e05fb1e11514a5fac7c6fe867e1fd3b6908855fbf7a97a71',
    'DO2026-p21': 'c819b0f136e5548bd07ab92d58d50a875e3494ec291337031241de206c51c943',
    'DO2026-p23': '8a51b9fa4cdc41e9883ffea6d56ef815a88de55932204c1858af8b2ba925dd5e',
}
SPEC_INFORMATICS = {'спец.информатика', 'спец. информатика', 'специальная информатика', 'специальный курс по информатике'}
SPEC_RUSSIAN = {'спец.русский', 'спец. русский', 'специальный курс по русскому языку'}
UNITY = {'unity', 'программирование unity'}


def _observed_weekly_counts(demands):
    """Positive applicability slices only; no school-year limits are inferred.

    Sweep explicit inclusive date bounds as ordinal boundaries, and explicit
    week types plus the default category for untyped demands. This avoids
    adding two disjoint two-hour modules into a false four-hour load.
    """
    kinds = {None, *(canonical(kind) for demand in demands for kind in demand['weekTypes'])}
    counts = set()
    for kind in kinds:
        # Bound the model's representable ISO domain, never the school year.
        # The default category must not create a slice before year 1 or after
        # year 9999 when an explicit bound is at that exact legal endpoint.
        current, changes = 0, {date.min.toordinal(): 0}
        for demand in demands:
            if demand['weekTypes'] and kind not in {canonical(value) for value in demand['weekTypes']}:
                continue
            count = demand['weeklyCount']
            if demand['activeFrom']:
                begin = date.fromisoformat(demand['activeFrom']).toordinal()
                changes[begin] = changes.get(begin, 0) + count
            else:
                current += count
            if demand['activeUntil']:
                finish = date.fromisoformat(demand['activeUntil']).toordinal() + 1
                changes[finish] = changes.get(finish, 0) - count
        for boundary in sorted(changes):
            if boundary > date.max.toordinal():
                break
            current += changes[boundary]
            if current:
                counts.add(current)
    return counts


def _text_hash(text):
    return sha256(text.encode('utf-8')).hexdigest()


class _Context:
    def __init__(self, condition, resolutions, plan):
        self.condition, self.resolutions, self.plan = condition, resolutions, plan
        self.teacher_ids, self.demand_ids, self.steps, self.issues = set(), set(), [], []
        self.slots = {s['id']: s for s in plan['slots']}
        self.teachers = {t['id']: t for t in plan['teachers']}
        self.groups = {g['id']: g for g in plan['groups']}

    def issue(self, code, message, **details):
        self.issues.append({'conditionId': self.condition['id'], 'textHash': _text_hash(self.condition['text']),
                            'code': code, 'message': message, 'sourceCells': [], **details})

    def teacher(self, name):
        mapping = self.resolutions.get('teacherMap', {})
        if name in mapping:
            teacher_id = mapping[name]
            if teacher_id not in self.teachers:
                self.issue('source_rule_reference_required', f'Сопоставление {name} не ссылается на существующего педагога.')
                return None
        else:
            exact = [t['id'] for t in self.teachers.values() if canonical(t['name']) == canonical(name)]
            if len(exact) != 1:
                self.issue('source_rule_reference_required', f'Нужно точное сопоставление педагога {name}; похожие имена не используются.')
                return None
            teacher_id = exact[0]
        self.teacher_ids.add(teacher_id)
        return teacher_id

    def class_names(self, *, label=None, grades=None):
        mapping = self.resolutions.get('classMap', {})
        names = {target for raw, target in mapping.items()
                 if (label is not None and canonical(raw) == canonical(label))
                 or (grades is not None and class_grade(raw) in grades)}
        if not names:
            self.issue('source_rule_reference_required', 'Нужна явная карта классов для условия: ' + (label or ', '.join(map(str, sorted(grades)))))
        return names

    def demands(self, teacher_id, *, subjects=None, classes=None):
        selected = [d for d in self.plan['demands'] if teacher_id in d['teacherIds']
                    and (subjects is None or canonical(d['subject']) in {canonical(s) for s in subjects})
                    and (classes is None or any(self.groups[g]['className'] in classes for g in d['groupIds']))]
        if not selected:
            self.issue('source_rule_reference_required', 'Не найдена явно заданная нагрузка нужного предмета и классов.', teacherIds=[teacher_id])
        return selected

    def restrict(self, demand, predicate, message):
        if not self.slots:
            self.issue('source_rule_reference_required', 'Сначала задайте подтверждённые учебные слоты.')
            return
        original = demand['allowedSlotIds']
        eligible = original or list(self.slots)
        remaining = [key for key in eligible if predicate(self.slots[key])]
        if not remaining:
            # [] means ANY in PlanningInput, so never store an empty intersection.
            self.issue('source_rule_empty_domain', 'Условие несовместимо с разрешёнными слотами нагрузки; прежний список сохранён.', demandIds=[demand['id']])
            return
        if len(remaining) != len(eligible):
            demand['allowedSlotIds'] = remaining
        self.demand_ids.add(demand['id'])
        self.steps.append(message)

    def availability(self, teacher_id, predicate, message):
        if teacher_id is None:
            return
        if not self.slots:
            self.issue('source_rule_reference_required', 'Сначала задайте подтверждённые учебные слоты.')
            return
        teacher = self.teachers[teacher_id]
        blocked = {key for key, slot in self.slots.items() if not predicate(slot)}
        previous = teacher['unavailableSlotIds']
        proposed = [*previous, *sorted(blocked - set(previous))]
        overlap = lambda a, b: a['day'] == b['day'] and a['start'] < b['end'] and b['start'] < a['end']
        def available(slot_id, unavailable):
            slot = self.slots[slot_id]
            windows = teacher['workWindows']
            return (not any(overlap(slot, self.slots[other]) for other in unavailable)
                    and (not windows or any(w['day'] == slot['day'] and w['start'] <= slot['start'] and slot['end'] <= w['end'] for w in windows)))
        for demand in self.plan['demands']:
            if teacher_id not in demand['teacherIds']:
                continue
            eligible = demand['allowedSlotIds'] or list(self.slots)
            if any(available(s, previous) for s in eligible) and not any(available(s, proposed) for s in eligible):
                self.issue('source_rule_empty_domain', 'Недоступность педагога исключает все разрешённые слоты нагрузки; прежние запреты сохранены.', teacherIds=[teacher_id], demandIds=[demand['id']])
                return
        teacher['unavailableSlotIds'] = proposed
        self.steps.append(message)

    def teacher_rule(self, name, predicate, message):
        self.availability(self.teacher(name), predicate, message)

    def demand_rule(self, name, predicate, message, *, subjects=None, classes=None):
        teacher_id = self.teacher(name)
        if teacher_id is None:
            return []
        demands = self.demands(teacher_id, subjects=subjects, classes=classes)
        for demand in demands:
            self.restrict(demand, predicate, message)
        return demands

    def required_course(self, subjects, *, teacher_id=None, classes=None, weekly_count=None):
        """Presence/count checks never create load, membership or calendar dates."""
        selected = [demand for demand in self.plan['demands']
                    if canonical(demand['subject']) in {canonical(subject) for subject in subjects}
                    and (teacher_id is None or teacher_id in demand['teacherIds'])]
        if not selected:
            self.issue('source_rule_required_load', 'В нормативной модели отсутствует явно названный обязательный курс: ' + ', '.join(sorted(subjects)) + '.')
            return []
        if classes is None:
            self.demand_ids.update(demand['id'] for demand in selected)
            self.steps.append('Наличие отдельной нагрузки названного курса проверено; часы и участники не добавлялись.')
            return selected
        if not classes:
            self.issue('source_rule_required_load', 'Для проверки обязательного курса нужны явные сопоставления его классов.')
            return []
        relevant = []
        for class_name in sorted(classes):
            group_demands = {}
            for demand in selected:
                for group_id in demand['groupIds']:
                    if self.groups[group_id]['className'] == class_name:
                        group_demands.setdefault(group_id, []).append(demand)
            if not group_demands:
                self.issue('source_rule_required_load', f'В классе {class_name} отсутствует обязательный курс с указанным педагогом.', teacherIds=[teacher_id])
                continue
            for group_id, demands in group_demands.items():
                observed = _observed_weekly_counts(demands)
                if weekly_count is not None and observed != {weekly_count}:
                    self.issue('source_rule_required_load', f'Группа {group_id}: в непустых срезах действия курса требуется {weekly_count} занятия в неделю; найдено {", ".join(map(str, sorted(observed))) or "0"}. Даты, типы недель и часы не менялись.', groupIds=[group_id], demandIds=[d['id'] for d in demands])
                else:
                    self.steps.append(f'Обязательная нагрузка группы {group_id}: {weekly_count} занятия в каждом непустом срезе действия.')
                    self.demand_ids.update(d['id'] for d in demands)
                relevant.extend(demands)
        return relevant


def _apply(context):
    c, key = context, context.condition['id']
    remaining = None
    if key == 'general-01':
        c.teacher_rule('Archive Teacher 08', lambda s: s['day'] in {0, 2}, 'Учебные дни педагога: понедельник и среда.')
        remaining = 'Вместимость кабинета2 и исключение9А/9В требуют уточнения; кабинеты не назначались.'
    elif key == 'general-02':
        c.teacher_rule('Archive Teacher 05', lambda s: s['day'] in {0, 2, 3}, 'Все уроки только в понедельник, среду и четверг.')
    elif key == 'general-07':
        c.teacher_rule('Archive Teacher 06', lambda s: not(s['day'] == 3 and s['slot'] == 1), 'Дежурство: четверг1 недоступен.')
        remaining = 'Границу до12:20 нужно уточнить; пожелание остальных дней до14:30 не стало жёстким запретом.'
    elif key == 'general-08':
        c.demand_rule('Archive Teacher 34', lambda s: s['day'] in {1, 3} and s['slot'] >= 2, 'Химия: вторник/четверг со2урока.', subjects={'Химия'})
        c.demand_rule('Archive Teacher 34', lambda s: s['day'] == 2 and s['slot'] >= 2, 'География: среда со2урока.', subjects={'География'})
    elif key == 'general-09':
        for name in ('Archive Teacher 06', 'Archive Teacher 12', 'Archive Teacher 09', 'Archive Teacher 20', 'Archive Teacher 16'):
            c.teacher_rule(name, lambda s: not(s['day'] == 0 and s['slot'] == 5), 'Планёрка: понедельник5 недоступен.')
    elif key == 'general-11':
        c.teacher_rule('Archive Teacher 07', lambda s: (s['day'] == 1 or s['slot'] >= 6) and not(s['day'] == 3 and s['slot'] == 10), 'Вторник без дополнительного ограничения; другие дни с6урока, четверг10 запрещён.')
    elif key == 'general-12':
        c.teacher_rule('Archive Teacher 12', lambda s: not(s['day'] == 2 and s['slot'] == 1), 'Дежурство: среда1 недоступна.')
    elif key == 'general-13':
        c.teacher_rule('Archive Teacher 09', lambda s: not(s['day'] == 4 and s['slot'] == 1) and not(s['day'] == 1 and s['slot'] in {6, 7, 8, 9, 10}), 'Дежурство/совещания: пятница1 и вторник6–10 недоступны.')
    elif key == 'general-14':
        c.teacher_rule('Archive Teacher 18', lambda s: s['day'] == 5 or s['slot'] in ({8, 9, 10} if s['day'] == 3 else {7, 8, 9, 10}), 'Будни: уроки 7–10; четверг: 8–10.')
        remaining = 'Время субботнего спецкурса не задано в отдельном условии; применены только точные окна будних дней.'
    elif key == 'general-16':
        names = c.class_names(label='10А')
        demands = c.demand_rule('Archive Teacher 20', lambda s: s['day'] == 4 and s['slot'] in {6, 7, 8, 9}, 'Информатика10А: пятница6–9.', subjects={'Информатика'}, classes=names) if names else []
        # Four teacher-bound occurrences in the only four explicit Friday
        # slots necessarily occupy6..9; teacher overlap remains a hard rule.
        ordinals = {s['slot'] for s in c.slots.values() if s['day'] == 4 and s['slot'] in {6, 7, 8, 9}}
        if sum(d['weeklyCount'] for d in demands) != 4 or ordinals != {6, 7, 8, 9}:
            remaining = 'Для полного блока6–9 нужны подтверждённые4занятия и все4звонка; часы не изменялись.'
    elif key == 'general-17':
        c.teacher_rule('Archive Teacher 15', lambda s: s['slot'] not in {9, 10}, 'Уроки9 и10 недоступны.')
    elif key == 'general-18':
        c.teacher_rule('Archive Teacher 33', lambda s: s['slot'] not in {9, 10}, 'Уроки9 и10 недоступны.')
    elif key == 'DO2026-p5':
        c.required_course(UNITY)
        remaining = 'Наличие курса не подтверждает второе полугодие и сдвоенный блок: нужны точные даты и явная связка занятий.'
    elif key == 'DO2026-p8':
        classes9 = c.class_names(grades={9})
        classes10_11 = c.class_names(grades={10}) | c.class_names(label='11А')
        teacher_id = c.teacher('Archive Teacher 18')
        if teacher_id is None:
            c.issue('source_rule_required_load', 'Не сопоставлен фактический педагог обязательного спецкурса русского языка: Archive Teacher 18')
        else:
            c.required_course(SPEC_RUSSIAN, teacher_id=teacher_id, classes=classes9 | classes10_11, weekly_count=2)
        if classes9 and teacher_id is not None:
            c.demand_rule('Archive Teacher 18', lambda s: s['day'] < 5 and s['slot'] >= 7, 'Спецрусский9классов: будни с7урока.', subjects=SPEC_RUSSIAN, classes=classes9)
        if classes10_11 and teacher_id is not None:
            c.demand_rule('Archive Teacher 18', lambda s: s['day'] == 5, 'Явные нагрузки спецрусского 10 классов и 11А: суббота.', subjects=SPEC_RUSSIAN, classes=classes10_11)
        remaining = 'Проверены только непустые явно заданные срезы нагрузки. Покрытие учебного года, пустые периоды и состав групп требуют подтверждения; даты и weeklyCount не менялись.'
    elif key == 'DO2026-p10':
        teacher_id = c.teacher('Archive Teacher 19')
        if teacher_id is None:
            c.issue('source_rule_required_load', 'Не сопоставлен фактический педагог обязательного курса «Школа дронов»: Archive Teacher 19')
        else:
            c.required_course({'Школа дронов'}, teacher_id=teacher_id)
        remaining = 'Для школы дронов нужны явные часы, группы и даты; из названия они не следуют.'
    elif key == 'DO2026-p11':
        names = c.class_names(grades={5})
        if names:
            c.demand_rule('Archive Teacher 29', lambda s: s['day'] == 1 and s['slot'] in {2, 3, 4, 5}, 'Science5классов: вторник, только уроки2–5.', subjects={'Science'}, classes=names)
        remaining = 'Выбор цельного блока2–4 или3–5, распределение классов и объём не угадывались.'
    elif key == 'DO2026-p12':
        for grade, day, floor in ((7, 4, 1), (8, 0, 2)):
            names = c.class_names(grades={grade})
            if names:
                c.demand_rule('Archive Teacher 21', lambda s, day=day, floor=floor: s['day'] == day and s['slot'] >= floor and (day != 4 or s['start'] >= '08:00'), f'Явные нагрузки{grade}классов: заданный день и начальный урок.', classes=names)
        remaining = 'Предмет, окончание «с утра» и число занятий не определялись автоматически.'
    elif key == 'DO2026-p13':
        names = c.class_names(grades={6})
        if names:
            c.demand_rule('Archive Teacher 32', lambda s: s['day'] == 0, 'Основы электроники6классов: понедельник.', subjects={'Основы электроники'}, classes=names)
        remaining = 'Подряд для трёх классов и число занятий должны быть явно представлены связкой событий.'
    elif key == 'DO2026-p17':
        c.teacher_rule('Archive Teacher 37', lambda s: s['end'] <= '11:25', 'Физическая доступность: урок заканчивается не позже11:25.')
        remaining = 'Предпочтение4урока не стало запретом остальных; формат пары и группы требуют подтверждения.'
    elif key == 'DO2026-p18':
        c.demand_rule('Archive Teacher 14', lambda s: s['day'] == 5, 'Только явно отдельная специнформатика: суббота.', subjects=SPEC_INFORMATICS)
    elif key == 'DO2026-p20':
        c.demand_rule('Archive Teacher 31', lambda s: s['day'] not in {0, 1} or s['start'] >= '13:45', 'Спецфизика: в понедельник/вторник не раньше13:45.', subjects={'Спец.физика', 'Спец. физика', 'Специальная физика'})
        remaining = 'Резервная среда для компенсаций не стала обычным учебным днём курса; формат компенсации и прочие дни требуют проверки.'
    elif key == 'DO2026-p21':
        c.teacher_rule('Archive Teacher 38', lambda s: not(s['day'] == 2 and s['start'] < '11:45') and not(s['day'] == 3 and s['end'] > '14:25'), 'Среда до11:45 и четверг после14:25 недоступны; запас на переход не выдумывался.')
    elif key == 'DO2026-p23':
        c.teacher_rule('Archive Teacher 23', lambda s: s['day'] in {0, 2, 3} and s['end'] <= '14:30', 'Точно сопоставленный Ластовец: понедельник/среда/четверг до14:30.')
        remaining = 'Год1октября, замена немецкого/IoT, часы и подгруппы8А требуют отдельных явных назначений.'
    return remaining


def apply_source_rules(package, resolutions, plan, provenance):
    """Apply only reviewed hard fragments; return a detached validated input.

    ``source_rule_empty_domain`` and normative ``source_rule_required_load``
    are never resolved by a manual attestation. Other residuals retain their exact conditionId for
    the compiler's existing planHash+packageHash manual-review lifecycle.
    ``provenance`` is accepted for the compiler contract, never used as authority
    to infer teachers, subjects, classes, dates or rooms.
    """
    value = PlanningInput.model_validate(plan).model_dump(mode='json')
    before = deepcopy(value)
    if not isinstance(resolutions, dict):
        raise ValueError('Требуется объект сопоставлений источников')
    applied, partial, unresolved = [], [], []
    for condition in package.get('conditions', []):
        if not isinstance(condition, dict) or not isinstance(condition.get('id'), str) or not isinstance(condition.get('text'), str):
            raise ValueError('Условие должно содержать id и точный текст')
        context = _Context(condition, resolutions, value)
        key, actual_hash = condition['id'], _text_hash(condition['text'])
        if key not in REVIEWED_TEXT_HASHES:
            context.issue('source_rule_manual_required', 'Условие не автоматизировано; мягкое пожелание или неоднозначные связи не повышаются до запрета.')
            unresolved.extend(context.issues)
            continue
        if REVIEWED_TEXT_HASHES[key] != actual_hash:
            context.issue('source_rule_text_changed', 'Текст условия изменился после проверки; прежняя автоматизация не применялась.')
            unresolved.extend(context.issues)
            continue
        remaining = _apply(context)
        report = {'conditionId': key, 'textHash': actual_hash, 'teacherIds': sorted(context.teacher_ids),
                  'demandIds': sorted(context.demand_ids), 'message': ' '.join(dict.fromkeys(context.steps))}
        if remaining:
            context.issue('source_rule_partial', remaining)
        if context.issues:
            if context.steps:
                partial.append({**report, 'remaining': remaining or 'Исправьте перечисленные привязки или противоречия.'})
            unresolved.extend(context.issues)
        else:
            applied.append(report)
    if value != before:
        value['confirmed'] = False
    return {'input': PlanningInput.model_validate(value).model_dump(mode='json'), 'appliedConditions': applied,
            'partialConditions': partial, 'unresolved': unresolved}
