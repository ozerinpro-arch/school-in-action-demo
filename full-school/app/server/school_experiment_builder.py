"""Pure, visibly hypothetical full-school input; never normative activation.

Facts are reused from the reviewed source package and bounded legacy rows.
Every invented constraint lives in the external working-assumption ledger.
No storage, solver, accounts, network or publication calls occur here.
"""
from collections import defaultdict
from copy import deepcopy
from datetime import date, timedelta
from hashlib import sha256
import json

from .school_plan_sources import SourcePackage, SourceResolutions, _parts
from .school_source_rules import apply_source_rules
from .scheduling_models import PlanningInput, canonical
from .subject_names import class_grade, normalise_subject_name


ANCHOR = date(2026, 10, 26)
PHASE_TWO = date(2027, 1, 11)
WEEKDAY_BELLS = [('08:00','08:40'),('08:55','09:35'),('09:50','10:30'),
    ('10:45','11:25'),('11:45','12:25'),('12:45','13:25'),('13:45','14:25'),
    ('14:45','15:25'),('15:40','16:20'),('16:25','17:05')]
SATURDAY_BELLS = [('08:00','08:45'),('08:50','09:35'),('09:40','10:25'),
    ('10:30','11:15'),('11:20','12:05'),('12:10','12:55'),('13:00','13:45'),('13:50','14:35')]
LANGUAGES = {'Английский язык','Native English','Native English (extra)', 'Deutsch','Китайский',
    'Родной русский язык','Родная русская литература','Гос. язык РТ'}


def _hash(value):
    return sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _id(prefix, value):
    return prefix + _hash(value)[:18]


def _draft(value):
    if not isinstance(value,dict) or not isinstance(value.get('lessons'),list) or len(value['lessons']) > 10000:
        raise ValueError('Ожидается ограниченная копия школьной сетки.')
    rows = []
    for row in value['lessons']:
        if (not isinstance(row,dict) or any(not isinstance(row.get(k),str) for k in ('id','className','subject','start','end'))
            or type(row.get('day')) is not int or not 0 <= row['day'] <= 5
            or type(row.get('slot')) is not int or not 1 <= row['slot'] <= 20
            or any(not isinstance(row.get(k),list) or any(not isinstance(x,str) for x in row[k]) for k in ('teachers','rooms'))):
            raise ValueError('Некорректная строка ограниченной школьной сетки.')
        rows.append({k:deepcopy(row[k]) for k in ('id','className','subject','day','slot','start','end','teachers','rooms')})
    return rows


def build_experimental_plan(package, draft, period_start):
    """Build one dated week and explicit deferred module profiles, without I/O."""
    source = SourcePackage.model_validate(package)
    start = date.fromisoformat(period_start)
    if start.weekday() != 0:
        raise ValueError('Экспериментальная неделя должна начинаться в понедельник.')
    rows = _draft(draft)
    rooms_observed = sorted({room for row in rows for room in row['rooms'] if room})
    if not rooms_observed:
        raise ValueError('Для эксперимента нужны наблюдаемые названия кабинетов; новые кабинеты не выдумываются.')
    assumptions, warnings, provenance, deferred = [], [], [], []

    def assume(category,label,value,basis,cells=()):
        identifier = _id('hyp_', [category,label,sorted(cells)])
        assumptions.append({'id':identifier,'category':category,'label':label,'value':deepcopy(value),
            'basis':basis,'sourceCells':sorted(cells),'status':'working_assumption'})
        return identifier

    week_phase = ((start - ANCHOR).days // 7) % 2
    phase_id = assume('calendar','Календарь экспериментальной недели',
        {'periodStart':period_start,'periodEnd':(start+timedelta(days=5)).isoformat(),'teachingDays':[0,1,2,3,4,5],
         'weekType':'B' if week_phase else 'A','cycleAnchor':ANCHOR.isoformat(),'holidayExceptions':[]},
        'Пользователь разрешил рабочие предположения. Учебный календарь не подтверждён; 26.10.2026 принято началом фазы A, каникулы и исключения пока не заданы.')
    assume('bells','Рабочие звонки будней',WEEKDAY_BELLS,
        'Точные интервалы наблюдаются в ограниченной существующей сетке (40 минут); их действие на выбранную неделю предполагается, календарного подтверждения нет.')
    assume('bells','Рабочие звонки субботы',SATURDAY_BELLS,
        'Наблюдаемая субботняя сетка 24.10.2026 содержит 8 уроков по45минут; перенос тех же звонков на выбранную субботу — предположение.')
    slots = [{'id':f'exp_s{day}_{ordinal}','day':day,'slot':ordinal,'start':begin,'end':end}
        for day in range(6) for ordinal,(begin,end) in enumerate(SATURDAY_BELLS if day == 5 else WEEKDAY_BELLS,1)]
    observed_labels = {canonical(row['className']):row['className'] for row in rows}
    class_map = {}
    for label in sorted({cell.classLabel for cell in source.cells}):
        folded = canonical(label)
        target = observed_labels.get(folded)
        if target is None and folded.endswith('б'):
            target = observed_labels.get(folded[:-1]+'в')
            if target:
                assume('class_alias',f'Обозначение {label} → {target}',{'sourceClass':label,'targetClass':target},
                    'В исходнике литера «б», в существующей сетке той же параллели «В». Это временное соответствие, а не подтверждённое переименование.',
                    [cell.sourceCell for cell in source.cells if cell.classLabel == label])
        class_map[label] = target or label.upper()
    classes = sorted(set(class_map.values()))
    groups = []
    for name in classes:
        assume('group_membership',f'Размеры и подгруппы {name}',
            {'wholeSize':24,'subgroupSizes':[12,12],'stableDisjointPartition':True,'maxDaily':10},
            'Списков учеников нет. Для опыта предполагаются24ученика и две непересекающиеся постоянные когорты по12; языки/элективы распределены между ними. Реальный состав и пересечения требуют проверки.')
        for suffix,size,kind in [('whole',24,'whole'),('a',12,'subgroup'),('b',12,'subgroup')]:
            groups.append({'id':_id('exp_g_',[name,suffix]),'className':name,
                'name':'Весь класс (гипотеза)' if suffix=='whole' else f'Когорта {suffix.upper()} (гипотеза)',
                'size':size,'kind':kind,'partition':'working_cohorts' if kind=='subgroup' else '',
                'maxDaily':10,'unavailableSlotIds':[]})
    group_ids = {(g['className'], 'whole' if g['kind']=='whole' else ('a' if ' A ' in g['name'] else 'b')):g['id'] for g in groups}
    # Never select a newly invented physical room. Eligibility/capacity are
    # explicitly hypothetical; four candidates avoid a single-room bottleneck.
    rooms = []
    for name in rooms_observed:
        assume('room_capacity',f'Вместимость кабинета {name}',180,
            'Из сетки известно только название.180мест — вычислительное предположение для совместных потоков; это не паспорт вместимости.')
        rooms.append({'id':_id('exp_r_',name),'name':name,'capacity':180,'tags':[],'unavailableSlotIds':[]})
    room_id = {room['name']:room['id'] for room in rooms}
    teacher_names = sorted({cell.teacher for cell in source.cells} | {row['teacher'] for row in source.sourceRows})
    # These people are explicitly named by the latest DO document, not invented.
    for name in ('Archive Teacher 25','Archive Teacher 19'):
        if name not in teacher_names:
            teacher_names.append(name)
            assume('teacher_assignment',f'Педагог из дополнительного документа: {name}',name,
                'Имя прямо указано в условиях ДО. Связь с кадровым аккаунтом не устанавливается; состав и часы курса ниже являются отдельными гипотезами.')
    teacher_id = {name:_id('exp_t_',name) for name in teacher_names}
    teacher_subjects = defaultdict(set)
    units = []
    grouped_subjects = defaultdict(set)
    for cell in source.cells:
        grouped_subjects[(class_map[cell.classLabel],cell.rawSubject)].add(cell.teacher)
    for cell in source.cells:
        parts = _parts(cell,SourceResolutions(),source.confirmedCounts)
        if not parts:
            count = cell.rawCount if type(cell.rawCount) is int else int(cell.rawCount.split('/')[0])
            if type(cell.rawCount) is str and cell.sourceCell not in source.confirmedCounts:
                assume('weekly_count',f'Дробные часы {cell.sourceCell}',{'rawCount':cell.rawCount,'weeklyCount':count},
                    'Пользователь разрешил предположить недельный объём. Для этой ячейки принято первое число; подтверждённые24значения имеют приоритет.',[cell.sourceCell])
            if cell.rawSubject == 'Родной язык':
                subject = 'Родная русская литература' if week_phase else 'Родной русский язык'
                assume('subject_split',f'Одночасовой родной {cell.sourceCell}',{'subject':subject,'weeklyCount':count},
                    'Один час не превращается в два: в фазеA предполагается язык, в фазеB литература. Это временная интерпретация неполной ячейки.',[cell.sourceCell])
            elif cell.rawSubject == 'Deutsch/Китайский':
                subject = 'Китайский' if cell.teacher in {'Archive Teacher 10','Archive Teacher 23'} else 'Deutsch'
                assume('subject_split',f'Выбор языка {cell.sourceCell}',{'subject':subject,'weeklyCount':count},
                    'В комбинированной подписи язык выбран по явно наблюдаемой специализации названного педагога; индивидуальный выбор детей неизвестен.',[cell.sourceCell])
            else:
                subject = normalise_subject_name(cell.classLabel,cell.rawSubject)
            parts = [{'subject':subject,'weeklyCount':count}]
        actual_teacher = cell.teacher
        if cell.sourceCell in {'K6','L6'} and cell.rawSubject == 'Deutsch':
            parts = [{'subject':'Китайский','weeklyCount':sum(part['weeklyCount'] for part in parts)}]
            actual_teacher = 'Archive Teacher 10'
        if cell.rawSubject == 'Arduino':
            selected = cell.classLabel == '7а' if week_phase == 0 else cell.classLabel in {'7б','7с'}
            assume('module_phase',f'Двухнедельный Arduino {cell.sourceCell}',
                {'cycleAnchor':ANCHOR.isoformat(),'currentPhase':'B' if week_phase else 'A','sourceAverage':cell.rawCount,
                 'activeThisWeek':selected,'activeWeeklyCount':2},
                'УсловиеДО: одна неделя один класс сдвоенно, следующая два остальных. Якорь и порядок A=7А,B=7В/7С предполагаются;1час источника трактуется как средний объём цикла.',[cell.sourceCell])
            if not selected:
                deferred.append({'sourceCells':[cell.sourceCell],'subject':'Arduino','teacherNames':[actual_teacher],
                    'classNames':[class_map[cell.classLabel]],'weeklyCount':2,'reason':'alternate_module_phase',
                    'nextActivePeriodStart':(start+timedelta(days=7)).isoformat(),'phase':'A' if week_phase else 'B'})
                continue
            parts = [{'subject':'Arduino','weeklyCount':2}]
        if cell.sourceCell == 'P41':
            actual_teacher = 'Archive Teacher 25' if week_phase == 0 else 'Archive Teacher 13'
        if cell.sourceCell == 'O41':
            actual_teacher = 'Archive Teacher 13' if week_phase == 0 else 'Archive Teacher 25'
        for part in parts:
            subject = part['subject'];class_name = class_map[cell.classLabel]
            suffix = 'whole'
            if subject in LANGUAGES:
                if subject == 'Гос. язык РТ':suffix='b'
                elif subject in {'Родной русский язык','Родная русская литература'}:suffix='a'
                elif subject == 'Native English' and (class_grade(class_name)==7 or canonical(class_name)=='9в'):suffix='whole'
                else:
                    names = sorted(grouped_subjects[(class_name,cell.rawSubject)])
                    suffix = 'a' if (cell.teacher in names and names.index(cell.teacher)%2==0) else 'b'
            elif (subject.startswith(('Спец.','Доп.')) or subject in {'Science','Математика на английском','IoT','Интернет вещей','БПЛА'}):
                suffix = 'a' if int(_hash([class_name,subject])[:8],16)%2==0 else 'b'
            units.append({'sourceCells':[cell.sourceCell],'subject':subject,'weeklyCount':part['weeklyCount'],
                'classNames':[class_name],'teacherNames':[actual_teacher],'groupIds':[group_ids[(class_name,suffix)]],
                'basis':'source_cell','sourceRows':[]})
    # Exact reviewed structural links only. O82/P82 is deliberately absent.
    origins = {entry['id']:entry['sha256'] for entry in source.sources}
    confirmed_shared = []
    for raw in package.get('groupObservations',[]):
        evidence = raw.get('evidence',{})
        if (raw.get('status')=='visually_confirmed_structural_link' and raw.get('relation')=='horizontal_shared_annotation'
            and raw.get('verified_visually') is True and origins.get(evidence.get('sourceId'))==evidence.get('sourceSha256')):
            confirmed_shared.append(raw['sourceCells'])

    def merge(cells, *, reason, co_teachers=False):
        chosen = [unit for unit in units if set(unit['sourceCells']) & set(cells)]
        if len(chosen) < 2 or set(cells) != {cell for unit in chosen for cell in unit['sourceCells']}:
            raise ValueError('Нельзя незаметно частично объединить исходные занятия: '+','.join(cells))
        if len({(unit['subject'],unit['weeklyCount']) for unit in chosen}) != 1:
            raise ValueError('Несовместимые предметы или часы общего занятия.')
        if not co_teachers and len({tuple(unit['teacherNames']) for unit in chosen}) != 1:
            raise ValueError('Не совпадают педагоги общего занятия.')
        result=deepcopy(chosen[0]);result.update(sourceCells=sorted(cells),basis=reason,
            classNames=sorted({name for unit in chosen for name in unit['classNames']}),
            teacherNames=sorted({name for unit in chosen for name in unit['teacherNames']}),
            groupIds=sorted({name for unit in chosen for name in unit['groupIds']}))
        # A co-taught course in one class has one group, not two copies.
        if co_teachers:
            result['groupIds']=[group_ids[(result['classNames'][0],'whole')]]
        for unit in chosen:units.remove(unit)
        units.append(result)
    for cells in confirmed_shared:merge(cells,reason='confirmed_structural_shared_link')
    for cells in (['D9','D10'],['E9','E10'],['F9','F10']):merge(cells,reason='DO2026-p6_explicit_co_teaching',co_teachers=True)
    merge(['Q41','R41'],reason='DO2026-p7_explicit_shared_tech_group')
    merge(['O111','P111'],reason='DO2026-p24_explicit_shared_biology')
    assume('module_phase','Фактические педагоги модулей IoT9',
        {'phase':'B' if week_phase else 'A','9А':'Archive Teacher 25' if week_phase else 'Archive Teacher 13',
         '9В':'Archive Teacher 13' if week_phase else 'Archive Teacher 25','displayTeacher':'Archive Teacher 13'},
        'Чередование и реальные имена заданы вДО7. Начальная пара классов, якорь и применение к этой неделе предполагаются; в проверке занятости используется фактический педагог.',['O41','P41'])

    def add(subject,count,names,teacher,category,label,basis,source_rows=(),suffix='a'):
        hyp=assume(category,label,{'subject':subject,'weeklyCount':count,'classes':names,'teacher':teacher},basis)
        units.append({'sourceCells':[],'subject':subject,'weeklyCount':count,'classNames':names,'teacherNames':[teacher],
            'groupIds':[group_ids[(name,suffix)] for name in names],'basis':'working_assumption',
            'assumptionIds':[hyp],'sourceRows':list(source_rows)})
    # Additional rows have no allocation cells. Their 28 hours are explicitly
    # assumed ADDITIONAL, never silently counted as already-covered cell load.
    native_targets = [name for name in classes if class_grade(name) in {9,11}]
    for name in native_targets:
        for subject in ('Родной русский язык','Родная русская литература'):
            add(subject,1,[name],'Archive Teacher 36','unallocated_row',f'Распределение строки83: {name}, {subject}',
                'Строка83 содержит6часов безклассов. Предположено ДОПОЛНИТЕЛЬНО по1языка+1литературы в9А,9В,11А; возможное дублирование должно быть проверено.',[83])
    for name in [name for name in classes if class_grade(name) in {5,6,7,8}]:
        add(normalise_subject_name(name,'Спец.английский'),2,[name],'Archive Teacher 01','unallocated_row',f'Распределение строки95: {name}',
            'Строка95 содержит22часа безклассов. Предположено ДОПОЛНИТЕЛЬНО по2часа для11классов5–8; это не подтверждённое распределение и может дублировать иную нагрузку.',[95],suffix='b')
    for name in [name for name in classes if class_grade(name) in {10,11}]:
        add('Спец.русский',2,[name],'Archive Teacher 18','group_membership',f'Спецрусский субботы: {name}',
            'ДО8 прямо задаёт педагога, классы,2занятия и субботу. Участие предполагаемой когортыA и кабинет требуют подтверждения.')
    tenth = [name for name in classes if class_grade(name)==10]
    add('Спец.информатика',2,tenth,'Archive Teacher 14','weekly_count','Отдельная субботняя специнформатика',
        'ДО18 задаёт отдельный курс и субботу. Совместная группа двух10классов и2часа перенесены как гипотеза из наблюдаемой субботней сетки24октября; обычная информатика4часа остаётся отдельной.',suffix='a')
    add('Школа дронов',2,[name for name in classes if class_grade(name) in {5,6,7,8}],
        'Archive Teacher 19','weekly_count','Школа дронов: состав и часы',
        'ДО10 прямо называет курс и педагога.2часа,суббота и поток5–8классов — рабочий перенос наблюдения24октября; состав детей неизвестен.',suffix='b')
    unity = {'sourceCells':[],'subject':'Программирование Unity','teacherNames':['Archive Teacher 11'],
        'classNames':[name for name in classes if class_grade(name)==7],'weeklyCount':2,
        'activeFrom':PHASE_TWO.isoformat(),'reason':'second_half_year','phase':'second_half'}
    unity_hyp = assume('module_phase','Начало и назначение Unity',unity,
        'ДО5 задаёт второе полугодие и сдвоенные часы.11.01.2027,2часа на каждый7класс и Archive Teacher 11 — явные рабочие предположения; это не доказанная квалификация/назначение.')
    if start < PHASE_TWO:
        deferred.append({**unity,'assumptionIds':[unity_hyp]})
    else:
        for name in unity['classNames']:
            add(unity['subject'],2,[name],'Archive Teacher 11','teacher_assignment',f'Unity: {name}',
                'Рабочее назначение существующего педагога программирования после предположенной даты второй фазы.')
    # Build domains from four observed alternatives, retaining actual legacy
    # rooms first when an exact class/subject/teacher match exists.
    legacy = defaultdict(list)
    for row in rows:
        key=(row['className'],normalise_subject_name(row['className'],row['subject']),tuple(sorted(row['teachers'])))
        legacy[key].append(row)
    demands, baseline, used_legacy = [], [], set()
    for unit in sorted(units,key=lambda unit:(unit['sourceCells'] or ['row'+str(unit['sourceRows'])],unit['subject'],unit['classNames'])):
        identifier=_id('exp_d_',[unit['sourceCells'],unit['subject'],unit['classNames'],unit['teacherNames'],unit['sourceRows']])
        observed=[]
        for name in unit['classNames']:
            observed.extend(legacy[(name,unit['subject'],tuple(sorted(unit['teacherNames'])))])
        pool=[]
        for row in observed:
            if len(row['rooms'])==1 and row['rooms'][0] in room_id and row['rooms'][0] not in pool:pool.append(row['rooms'][0])
        offset=int(_hash([unit['classNames'],unit['subject']])[:8],16)%len(rooms_observed)
        rotated=rooms_observed[offset:]+rooms_observed[:offset]
        for name in rotated:
            if name not in pool:pool.append(name)
        pool=pool[:4]
        course_label=', '.join(unit['classNames'])+': '+unit['subject']
        hyp=assume('room_eligibility',f'Кабинеты {course_label}',pool,
            'Точные одиночные кабинеты из совпадающей старой сетки предпочтительны. До4наблюдаемых альтернатив временно считаются оснащёнными и доступными; реальная пригодность не подтверждена.',unit['sourceCells'])
        group_hyp=assume('group_assignment',f'Участники {course_label}',
            {'groupIds':unit['groupIds'],'classes':unit['classNames']},
            'Привязка к целому классу или временным когортамA/B — рабочее распределение. Постоянство и непересечение когорт между разными языками/элективами предполагаются, списками детей не подтверждены.',unit['sourceCells'])
        demand={'id':identifier,'subject':unit['subject'],'weeklyCount':unit['weeklyCount'],
            'groupIds':unit['groupIds'],'teacherIds':[teacher_id[name] for name in unit['teacherNames']],
            'roomIds':[room_id[name] for name in pool],'maxPerDay':max(2,unit['weeklyCount']),
            'allowedSlotIds':[],'sourceLessonIds':[],'requiredTags':[]}
        demands.append(demand)
        for name in unit['teacherNames']:teacher_subjects[name].add(unit['subject'])
        # Baseline is a preference, never a pin or a new asserted school fact.
        eligible=[row for row in observed if row['id'] not in used_legacy and len(row['rooms'])==1 and row['rooms'][0] in pool]
        eligible.sort(key=lambda row:(row['day'],row['slot'],row['id']))
        selected=[]
        for row in eligible:
            slot=next((slot for slot in slots if (slot['day'],slot['slot'],slot['start'],slot['end'])==(row['day'],row['slot'],row['start'],row['end'])),None)
            if slot and len(selected)<unit['weeklyCount']:
                selected.append(row['id']);used_legacy.add(row['id'])
                baseline.append({'eventId':f'{identifier}_{len(selected)-1}','slotId':slot['id'],'roomId':room_id[row['rooms'][0]]})
        provenance.append({**deepcopy(unit),'demandId':identifier,'legacyLessonIds':selected,
            'assumptionIds':[*unit.get('assumptionIds',[]),hyp,group_hyp,phase_id],
            'displayTeacherNames':['Archive Teacher 13'] if set(unit['sourceCells'])&{'O41','P41'} else unit['teacherNames']})
    teachers=[]
    for name in teacher_names:
        assume('teacher_limits',f'Ограничения {name}',{'maxDaily':10,'maxWeekly':100,'maxConsecutive':10,
            'assumedAllowedSubjects':sorted(teacher_subjects[name])},
            'Кадровые нормативы неизвестны. Предметы из источника и отдельно отмеченные временные назначения для эксперимента считаются допустимыми; пределы10/100/10 — вычислительные гипотезы, не трудовая норма.')
        teachers.append({'id':teacher_id[name],'name':name,'subjects':sorted(teacher_subjects[name]),
            'maxDaily':10,'maxWeekly':100,'maxConsecutive':10,'unavailableSlotIds':[],'workWindows':[]})
    plan={'periodStart':period_start,'weekType':'B' if week_phase else 'A','confirmed':True,
        'slots':slots,'groups':groups,'teachers':teachers,'rooms':rooms,'demands':demands,
        'baseline':[],'pins':[],'eventChains':[],
        'preferences':{'earlyWeight':0,'changeWeight':100,'roomChangeWeight':10},
        'notes':'ЭКСПЕРИМЕНТ: working_assumptions. Пользователь разрешил вычисление с гипотезами; confirmed=True НЕ означает подтверждение фактов. Нормативная активация и публикация запрещены внешней metadata.'}
    # Reuse the reviewed literal hard fragments. Their unresolved remainder
    # stays visible in the experiment; no manual attestation is fabricated.
    ruled=apply_source_rules(package,{'classMap':class_map,'teacherMap':teacher_id},plan,provenance)
    plan=ruled['input']
    if any(issue['code']=='source_rule_empty_domain' for issue in ruled['unresolved']):
        raise ValueError('Рабочие предположения несовместимы с явным ограничением источника.')
    # User authorises a computation with visible hypotheses, not attestation
    # of normative facts. The external metadata explicitly forbids activation.
    plan['confirmed']=True
    for issue in ruled['unresolved']:
        if issue['conditionId']=='DO2026-p5' and issue['code']=='source_rule_required_load' and start < PHASE_TWO:
            warnings.append({**issue,'code':'source_course_deferred_by_phase',
                'message':'Unity учтён в deferredLoads: второе полугодие, рабочая дата11.01.2027. В текущую неделю курс не включён по календарной причине.'})
        else:
            warnings.append(issue)
    warnings.extend({'code':'source_condition_partial','conditionId':item['conditionId'],'message':item['remaining']} for item in ruled['partialConditions'])
    # Additional literal constraints not fully represented by the reusable
    # source compiler are explicit, bounded domains in this experimental model.
    def restrict(demand,predicate):
        previous=demand['allowedSlotIds'] or [slot['id'] for slot in slots]
        ids=[slot['id'] for slot in slots if slot['id'] in previous and predicate(slot)]
        if not ids:raise ValueError('Экспериментальное условие оставило пустой домен: '+demand['id'])
        demand['allowedSlotIds']=ids
    def chain(identifier,event_ids,gap=20):
        if len(event_ids)>1:
            plan['eventChains'].append({'id':_id('exp_chain_',identifier),'eventIds':event_ids,'sameDay':True,'maxGapMinutes':gap})
    by_demand={item['demandId']:item for item in provenance}
    for demand in plan['demands']:
        names={next(teacher['name'] for teacher in teachers if teacher['id']==key) for key in demand['teacherIds']}
        if demand['subject']=='Arduino':
            restrict(demand,lambda slot:slot['day'] in {3,4} and slot['slot']<=4)
            chain(demand['id'],[f"{demand['id']}_{index}" for index in range(demand['weeklyCount'])])
        if demand['subject']=='Школа дронов':restrict(demand,lambda slot:slot['day']==5 and slot['slot'] in {2,3})
        if demand['subject']=='Спец.информатика':restrict(demand,lambda slot:slot['day']==5 and slot['slot'] in {3,4})
        if demand['subject']=='Kerbal Space':
            restrict(demand,lambda slot:slot['day'] in {0,3} and slot['start']>='12:45')
            demand['maxPerDay']=1
        if demand['subject']=='Интернет вещей' and names&{'Archive Teacher 13','Archive Teacher 25'}:
            ordinals={1,2} if any(class_grade(name)==10 for name in by_demand[demand['id']]['classNames']) else {3,4}
            restrict(demand,lambda slot:slot['day']==2 and slot['slot'] in ordinals)
        if demand['subject']=='Спец.физика':restrict(demand,lambda slot:slot['day'] in {0,1,2} and slot['start']>='13:45')
        if demand['subject']=='Информатика' and names=={'Archive Teacher 14'}:restrict(demand,lambda slot:slot['day']==4 and slot['slot'] in {6,7,8,9})
        if demand['subject']=='Разговоры о важном':restrict(demand,lambda slot:slot['day']==0 and slot['slot'] in {1,2})
        if set(by_demand[demand['id']]['sourceCells'])=={'O111','P111'}:
            restrict(demand,lambda slot:slot['slot']==(8 if slot['day']==5 else 10))
        if set(by_demand[demand['id']]['sourceCells']) in ({'M109'},{'M110'}):
            demand['syncKey']='exp_chinese_8a_working_sync'
        if demand['subject']=='Native English':
            connor='Mr Corner' in names
            restrict(demand,lambda slot: (slot['day'] in {0,2} and slot['end']<='12:30')
                or (slot['day'] in {1,4} and slot['end']<='13:30') or (slot['day']==3 and connor and slot['end']<='14:30'))
        if demand['subject']=='Программирование Unity':
            chain(demand['id'],[f"{demand['id']}_{index}" for index in range(demand['weeklyCount'])])
        if demand['subject']=='Информатика' and names=={'Archive Teacher 20'} and by_demand[demand['id']]['classNames']==['11А']:
            restrict(demand,lambda slot:slot['slot']>=7)
            for index in range(0,demand['weeklyCount']-1,2):chain([demand['id'],index],[f"{demand['id']}_{index}",f"{demand['id']}_{index+1}"])
        if demand['subject']=='Гос. язык РТ' and names=={'Archive Teacher 08'}:
            if all(class_grade(name)!=9 for name in by_demand[demand['id']]['classNames']):
                demand['roomIds']=[room_id['2']] if '2' in room_id else demand['roomIds']
            elif '2' in room_id:
                demand['roomIds']=[key for key in demand['roomIds'] if key!=room_id['2']]
                if not demand['roomIds']:raise ValueError('Не осталось кабинета для9класса внекабинета2.')
    for teacher in plan['teachers']:
        if teacher['name']=='Archive Teacher 03':
            teacher['unavailableSlotIds']=sorted(set(teacher['unavailableSlotIds'])|{s['id'] for s in slots if s['day'] in {1,3} and s['end']>'14:30'})
        if teacher['name']=='Archive Teacher 06':
            teacher['unavailableSlotIds']=sorted(set(teacher['unavailableSlotIds'])|{s['id'] for s in slots if s['day'] in {1,3} and s['end']>'12:20'})
        if teacher['name']=='Archive Teacher 02':
            teacher['unavailableSlotIds']=sorted(set(teacher['unavailableSlotIds'])|{s['id'] for s in slots if s['end']>'13:25'})
        if teacher['name']=='Archive Teacher 28':
            teacher['maxDaily']=2
            teacher['unavailableSlotIds']=sorted(set(teacher['unavailableSlotIds'])|{s['id'] for s in slots if s['day'] not in {0,2,4}})
            assume('teacher_identity','Archive Teacher A: временное сопоставление',
                {'teacher':'Archive Teacher 28','days':[0,2,4],'maxDaily':2},
                'В условии указаны имя/отчество безфамилии. Единственное совпадение инициаловЛ.Р. в исходных педагогах принято рабочей гипотезой; три конкретных дняПн/Ср/Пт также предполагаются.')
    for name,subject in [('Archive Teacher 29','Science'),('Archive Teacher 32','Основы электроники'),('Archive Teacher 17','Science')]:
        selected=[d for d in plan['demands'] if d['subject']==subject and teacher_id[name] in d['teacherIds']]
        if name=='Archive Teacher 17':
            for demand in selected:restrict(demand,lambda slot:slot['day']==0 and slot['slot'] in {6,7})
        chain([name,subject],[f"{demand['id']}_{index}" for demand in selected for index in range(demand['weeklyCount'])])
    assume('availability','Перенос субботних времён спецкурсов',
        {'specialInformaticsSaturday':[3,4],'droneSchoolSaturday':[2,3]},
        'Дни заданы условиямиДО, номера уроков наблюдались24октября. Их действие на новую субботу31октября — отдельная рабочая гипотеза.')
    assume('availability','Последний звонок общей спецбиологии9А/9В',
        {'conditionId':'DO2026-p24','classes':['9А','9В'],'weekdaySlot':10,'saturdaySlot':8},
        'ДО24 прямо требует одно объединённое занятие двух9классов последними уроками. Для эксперимента это обеспечено последним звонком дня (будни10,суббота8). Такая точная интерпретация строже последнего урока конкретной группы и школой не подтверждена.',
        ['O111','P111'])
    assume('group_assignment','Одновременные подгруппы китайского8А',
        {'sourceCells':['M109','M110'],'classes':['8А'],'weeklyCount':2,'synchronousSubgroups':True},
        'ДО23 задаёт2часа китайского с делением8А на подгруппы и двух педагогов. Одновременность двух подгрупп — отдельная рабочая интерпретация: это не дословное подтверждение из документа. У групп разные педагоги и кабинеты;2времени общие.',
        ['M109','M110'])
    assume('availability','Остатки условий и резервная среда физики',
        {'physicsReserveWednesday':True,'softPreferences':'not_hard','rawMethodDays':'not_interpreted'},
        'Недвусмысленные машинные запреты применены существующим модулем. Для10часов физики при8слотахПн/Вт задействуется явно названная резервная среда. Неясное направление методдней не угадано; остатки условий остаются предупреждениями.')
    assume('algorithm','Первый эксперимент без оптимизации старой недели',
        {'baselineOptimized':False,'legacyMatchingEvents':len(baseline),'feasibilityFirst':True},
        'Сетка689уроков сохранена отдельно. Её совпадения показываются вprovenance, но это не подтверждённая база26октября; первый расчёт проверяет выполнимость, не меняя штатный режимrepair.')
    # Keep precise old placements only as soft preferences, even when a new
    # literal availability rule requires the existing solver to move them.
    PlanningInput.model_validate(plan)
    active={cell for item in provenance for cell in item['sourceCells']}
    inactive={cell for item in deferred for cell in item['sourceCells']}
    all_cells={cell.sourceCell for cell in source.cells}
    if active & inactive or active | inactive != all_cells:
        raise ValueError('Нарушено полное непересекающееся покрытие исходных ячеек.')
    extra=[item for item in provenance if item['sourceRows']]
    return {'input':plan,'assumptions':assumptions,'provenance':provenance,'warnings':warnings,'deferredLoads':deferred,
        'metadata':{'mode':'working_assumptions','normativeActivation':False,'publicationAllowed':False,
            'userAuthorizedComputation':True,'packageHash':_hash(package),'draftHash':_hash(rows),
            'legacyBaselineHints':baseline},
        'coverage':{'sourceCells':len(all_cells),'coveredCells':len(active|inactive),'excludedCells':[],
            'activeSourceCellCount':len(active),'deferredSourceCellCount':len(inactive),
            'activeSourceCells':sorted(active),'deferredSourceCells':sorted(inactive),
            'currentEventCount':sum(d['weeklyCount'] for d in plan['demands']),
            'eventCount':sum(d['weeklyCount'] for d in plan['demands']),
            'classes':len(classes),'classNames':classes,'teachers':len(teachers),'rooms':len(rooms),
            'confirmedSharedLinks':len(confirmed_shared),'extraRows':sorted({row for item in extra for row in item['sourceRows']}),
            'extraRowHours':sum(item['weeklyCount'] for item in extra),'extraRowDemandIds':[item['demandId'] for item in extra],
            'baselineEvents':0,'legacyMatchingEvents':len(baseline),'assumptionCount':len(assumptions)}}
