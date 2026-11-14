"""Local CP-SAT scheduling and an independent, loop-based result validator."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
import math
import time

from pydantic import ValidationError

from .scheduling_models import Assignment, MAX_EVENTS, SCHOOL_DAYS, PlanningInput, canonical, eligible_room_ids, minutes, planning_readiness

ISSUE_LIMIT = 256


class _BudgetExceeded(RuntimeError):
    def __init__(self, budget):
        self.budget = budget


class _Deadline:
    def __init__(self, seconds, *, started=None, metrics=None):
        self.started = time.monotonic() if started is None else started
        self.end = self.started + seconds
        self.metrics = metrics
        self.ticks = 0

    def check(self):
        if time.monotonic() >= self.end:
            raise _BudgetExceeded(self)

    def tick(self):
        self.ticks += 1
        if self.ticks % 64 == 0:
            self.check()

    def stage(self, name):
        if self.metrics is not None:
            self.metrics["phase"] = name
        self.check()

    def remaining(self):
        return max(0.0, self.end - time.monotonic())


def validate_solution(value: PlanningInput | dict, assignments: list[dict | Assignment], *, time_limit: float = 5) -> dict:
    """Independent verification has its own bounded, fail-closed wall budget."""
    if (isinstance(time_limit, bool) or not isinstance(time_limit, (int, float))
            or not 0 <= time_limit <= 30 or not math.isfinite(time_limit)):
        return {"valid": False, "issues": [{"code": "invalid_validation_limit", "message": "Некорректный предел времени проверки.", "entityIds": []}]}
    budget = _Deadline(float(time_limit))
    try:
        return _validate_solution(value, assignments, budget)
    except _BudgetExceeded:
        return {"valid": False, "issues": [{"code": "validation_time_limit", "message": "Независимая проверка не завершена в пределах времени; кандидат не подтверждён.", "entityIds": []}]}


def _validate_solution(value: PlanningInput | dict, assignments: list[dict | Assignment], budget: _Deadline) -> dict:
    """Check every hard constraint without using CP-SAT or its constraints.

    Consecutive means adjacent ordinal lesson numbers within the same day.
    Missing ordinal numbers break a run; real interval overlap is checked
    independently. Availability IDs denote the full interval of that slot.
    """
    issues = []
    omitted = 0

    def add(code, message, ids=()):
        nonlocal omitted
        if len(issues) < ISSUE_LIMIT:
            issues.append({"code": code, "message": message, "entityIds": sorted(set(ids))[:MAX_EVENTS]})
        else:
            omitted += 1

    try:
        budget.stage("validation_input")
        plan = PlanningInput.model_validate(value, context={"scheduling_check": budget.check})
    except (ValidationError, TypeError, ValueError):
        return {"valid": False, "issues": [{"code": "invalid_input", "message": "Некорректная модель планирования.", "entityIds": []}]}
    if not plan.confirmed:
        add("unconfirmed", "Исходные ограничения не подтверждены оператором.")
    for group in plan.groups:
        if group.maxDaily is None:
            add("missing_group_daily_limit", "Не подтверждён дневной предел учебной нагрузки группы.", [group.id])
    if not isinstance(assignments, list) or len(assignments) > MAX_EVENTS * 2:
        add("invalid_assignments", "Некорректный или слишком большой список назначений.")
        return {"valid": False, "issues": issues}
    slots = {item.id: item for item in plan.slots}
    groups = {item.id: item for item in plan.groups}
    teachers = {item.id: item for item in plan.teachers}
    rooms = {item.id: item for item in plan.rooms}
    budget.stage("validation_indexes")
    group_classes = {item.id: canonical(item.className) for item in plan.groups}
    related_groups = {}
    for first in plan.groups:
        budget.check()
        # Independent student relation; do not call solver/model predicates.
        related_groups[first.id] = {second.id for second in plan.groups if group_classes[first.id] == group_classes[second.id]
                                   and not (first.id != second.id and first.kind == second.kind == "subgroup"
                                            and bool(first.partition) and first.partition == second.partition)}
    slot_overlaps = {}
    for blocked in plan.slots:
        budget.check()
        slot_overlaps[blocked.id] = {current.id for current in plan.slots if current.day == blocked.day and current.start < blocked.end and blocked.start < current.end}
    availability_cache = {}

    def unavailable(entity):
        key = tuple(sorted(entity.unavailableSlotIds))
        if key not in availability_cache:
            blocked_slots = set()
            for blocked_id in key:
                budget.tick()
                blocked_slots.update(slot_overlaps[blocked_id])
            availability_cache[key] = blocked_slots
        return availability_cache[key]

    group_blocked, teacher_blocked, room_blocked = {}, {}, {}
    for entities, destination in ((plan.groups, group_blocked), (plan.teachers, teacher_blocked), (plan.rooms, room_blocked)):
        for entity in entities:
            budget.check()
            destination[entity.id] = unavailable(entity)
    qualifications = {item.id: {canonical(subject) for subject in item.subjects} for item in plan.teachers}
    room_tags = {item.id: {canonical(tag) for tag in item.tags} for item in plan.rooms}
    demand_data = {}
    for demand in plan.demands:
        budget.check()
        affected = set()
        for group_id in demand.groupIds:
            budget.tick()
            affected.update(related_groups[group_id])
        demand_data[demand.id] = {"groups": set(demand.groupIds), "teachers": set(demand.teacherIds), "affected": affected,
                                  "blockedGroups": [(group_id, group_blocked[group_id]) for group_id in affected if group_blocked[group_id]],
                                  "size": sum(groups[group_id].size for group_id in demand.groupIds),
                                  "subject": canonical(demand.subject), "tags": {canonical(tag) for tag in demand.requiredTags}}
    # Expand separately from solver construction; validate exact coverage.
    expected = {}
    for demand in plan.demands:
        budget.check()
        for occurrence in range(demand.weeklyCount):
            expected[f"{demand.id}_{occurrence}"] = (demand, occurrence)
    if not expected:
        add("empty_plan", "План не содержит учебной нагрузки.")
    seen, accepted = set(), {}
    for index, supplied in enumerate(assignments):
        budget.check()
        try:
            assignment = Assignment.model_validate(supplied)
        except (ValidationError, ValueError, TypeError):
            add("invalid_assignment", "Назначение содержит некорректные поля.", [str(index)])
            continue
        event_id = assignment.eventId
        if event_id in seen:
            add("duplicate_event", "Занятие назначено несколько раз.", [event_id])
            continue
        seen.add(event_id)
        if event_id not in expected:
            add("unknown_event", "Назначено неизвестное занятие.", [event_id])
            continue
        demand, occurrence = expected[event_id]
        if assignment.slotId not in slots or assignment.roomId not in rooms:
            add("unknown_resource", "Неизвестный слот или кабинет назначения.", [event_id])
            continue
        slot, room = slots[assignment.slotId], rooms[assignment.roomId]
        data = demand_data[demand.id]
        accepted[event_id] = (assignment, demand, slot, occurrence)
        if demand.allowedSlotIds and slot.id not in demand.allowedSlotIds:
            add("slot_domain", "Занятие назначено вне разрешённых слотов.", [event_id, slot.id])
        if demand.weekTypes and canonical(plan.weekType) not in {canonical(kind) for kind in demand.weekTypes}:
            add("demand_week_type", "Тип выбранной недели не соответствует нагрузке.", [event_id])
        if demand.activeFrom or demand.activeUntil:
            lesson_date = (date.fromisoformat(plan.periodStart) + timedelta(days=slot.day)).isoformat()
            if (demand.activeFrom and lesson_date < demand.activeFrom) or (demand.activeUntil and lesson_date > demand.activeUntil):
                add("demand_active_dates", "Занятие назначено вне дат действия нагрузки.", [event_id, slot.id])
        if room.id not in demand.roomIds:
            add("room_domain", "Кабинет не входит в альтернативы занятия.", [event_id, room.id])
        if room.capacity < data["size"]:
            add("capacity", "Вместимость кабинета меньше числа учеников.", [event_id, room.id])
        if not data["tags"] <= room_tags[room.id]:
            add("room_tags", "В кабинете отсутствует необходимое оснащение.", [event_id, room.id])
        for group_id, blocked_slots in data["blockedGroups"]:
            budget.tick()
            if slot.id in blocked_slots:
                add("group_unavailable", "Занятие пересекает недоступность учеников группы.", [event_id, group_id])
        for teacher_id in demand.teacherIds:
            teacher = teachers[teacher_id]
            if data["subject"] not in qualifications[teacher_id]:
                add("qualification", "Не подтверждена квалификация участвующего преподавателя.", [event_id, teacher_id])
            if slot.id in teacher_blocked[teacher_id]:
                add("teacher_unavailable", "Назначение пересекает недоступность преподавателя.", [event_id, teacher_id])
            if teacher.workWindows and not any(window.day == slot.day and window.start <= slot.start
                                               and slot.end <= window.end for window in teacher.workWindows):
                add("teacher_work_window", "Занятие не помещается целиком в подтверждённое рабочее окно.", [event_id, teacher_id])
        if slot.id in room_blocked[room.id]:
            add("room_unavailable", "Назначение пересекает недоступность кабинета.", [event_id, room.id])
    for event_id in expected.keys() - seen:
        budget.tick()
        add("missing_event", "Занятие не назначено.", [event_id])
    for pin in plan.pins:
        budget.tick()
        current = accepted.get(pin.eventId)
        if current is None or current[0].slotId != pin.slotId or current[0].roomId != pin.roomId:
            add("pin", "Зафиксированное назначение изменено или отсутствует.", [pin.eventId])
    daily_events, pupil_days = defaultdict(list), defaultdict(set)
    teacher_events, demand_days, synced = defaultdict(list), defaultdict(list), defaultdict(list)
    for event_id, (assignment, demand, slot, occurrence) in accepted.items():
        budget.check()
        daily_events[slot.day].append((event_id, assignment, demand, slot))
        demand_days[(demand.id, slot.day)].append(event_id)
        for teacher_id in demand.teacherIds:
            teacher_events[teacher_id].append((event_id, slot))
        if demand.syncKey:
            synced[(demand.syncKey, occurrence)].append((event_id, slot.id))
        for group_id in demand_data[demand.id]["affected"]:
            budget.tick()
            pupil_days[(group_id, slot.day)].add(event_id)
    for day, events in daily_events.items():
        budget.check()
        events.sort(key=lambda item: (item[3].start, item[3].end, item[0]))
        for index, (event_id, assignment, demand, slot) in enumerate(events):
            for other_id, other_assignment, other_demand, other_slot in events[index + 1:]:
                budget.tick()
                if other_slot.start >= slot.end:
                    break
                if slot.start >= other_slot.end:
                    continue
                ids = [event_id, other_id]
                if not demand_data[demand.id]["teachers"].isdisjoint(demand_data[other_demand.id]["teachers"]):
                    add("teacher_overlap", "Преподаватель занят в пересекающихся интервалах.", ids)
                if assignment.roomId == other_assignment.roomId:
                    add("room_overlap", "Кабинет занят в пересекающихся интервалах.", ids)
                if not demand_data[demand.id]["groups"].isdisjoint(demand_data[other_demand.id]["affected"]):
                    add("group_overlap", "Пересекаются занятия одной группы учеников.", ids)
    for teacher_id, events in teacher_events.items():
        budget.check()
        teacher = teachers[teacher_id]
        if len(events) > teacher.maxWeekly:
            add("weekly_load", "Превышена недельная нагрузка преподавателя.", [teacher_id])
        for day in range(SCHOOL_DAYS):
            assigned = [(event_id, slot) for event_id, slot in events if slot.day == day]
            if assigned:
                intervals = sorted((minutes(slot.start), minutes(slot.end)) for _, slot in assigned)
                span = max(end for _, end in intervals) - intervals[0][0]
                # Compute union independently, including malformed overlapping candidates.
                occupied, until = 0, -1
                for start, end in intervals:
                    occupied += max(0, end - max(start, until))
                    until = max(until, end)
                if teacher.maxDailySpanMinutes is not None and span > teacher.maxDailySpanMinutes:
                    add("teacher_daily_span", "Превышен подтверждённый дневной размах занятости преподавателя.", [teacher_id])
                if teacher.maxDailyGapMinutes is not None and span - occupied > teacher.maxDailyGapMinutes:
                    add("teacher_daily_gaps", "Превышена подтверждённая сумма промежутков между занятиями преподавателя.", [teacher_id])
            if len(assigned) > teacher.maxDaily:
                add("daily_load", "Превышена дневная нагрузка преподавателя.", [teacher_id, *[event_id for event_id, _ in assigned]])
            run, previous = 0, -2
            for ordinal in sorted({slot.slot for _, slot in assigned}):
                run = run + 1 if ordinal == previous + 1 else 1
                previous = ordinal
                if run > teacher.maxConsecutive:
                    add("consecutive_load", "Превышено число последовательных уроков преподавателя.", [teacher_id, *[event_id for event_id, _ in assigned]])
                    break
    demands = {item.id: item for item in plan.demands}
    for (demand_id, _day), event_ids in demand_days.items():
        budget.tick()
        if len(event_ids) > demands[demand_id].maxPerDay:
            add("demand_daily", "Превышено дневное число занятий одной нагрузки.", [demand_id, *event_ids])
    for entries in synced.values():
        budget.tick()
        if len({slot_id for _, slot_id in entries}) > 1:
            add("sync", "Синхронные занятия назначены в разные слоты.", [event_id for event_id, _ in entries])
    for chain in plan.eventChains:
        budget.check()
        for first_id, second_id in zip(chain.eventIds, chain.eventIds[1:]):
            if first_id not in accepted or second_id not in accepted:
                continue  # Coverage already reports missing events.
            first, second = accepted[first_id][2], accepted[second_id][2]
            gap = second.day * 1440 + minutes(second.start) - (first.day * 1440 + minutes(first.end))
            if gap < 0 or (chain.sameDay and first.day != second.day) or (chain.maxGapMinutes is not None and gap > chain.maxGapMinutes):
                add("event_chain", "Нарушены порядок, день или промежуток явно связанной пары занятий.", [chain.id, first_id, second_id])
    classes = defaultdict(list)
    for group in plan.groups:
        classes[canonical(group.className)].append(group)
    for class_groups in classes.values():
        budget.check()
        representatives = [group for group in class_groups if group.kind == "subgroup"] or class_groups
        whole_limits = [group.maxDaily for group in class_groups if group.kind == "whole" and group.maxDaily is not None]
        for representative in representatives:
            budget.check()
            if representative.maxDaily is None:
                continue
            limit = min([representative.maxDaily, *whole_limits])
            for day in range(SCHOOL_DAYS):
                counted = pupil_days[(representative.id, day)]
                if len(counted) > limit:
                    add("group_daily_load", "Превышен подтверждённый дневной предел уроков учеников группы.", [representative.id, *counted])
    if omitted:
        issues.append({"code": "issues_truncated", "message": f"Дополнительно обнаружено нарушений: {omitted}.", "entityIds": []})
    budget.check()
    return {"valid": not issues, "issues": issues}


def _assignment_metrics(plan, assignments, budget):
    """Descriptive metrics only, evaluated after independent acceptance."""
    baseline = {item.eventId: item for item in plan.baseline}
    slots = {item.id: item for item in plan.slots}
    demands = {f"{demand.id}_{occurrence}": demand for demand in plan.demands for occurrence in range(demand.weeklyCount)}
    teacher_days = defaultdict(list)
    changed_slots = changed_rooms = changed_events = early = 0
    for item in assignments:
        budget.tick()
        event_id, slot = item["eventId"], slots[item["slotId"]]
        early += slot.slot - 1
        if event_id in baseline:
            slot_changed = item["slotId"] != baseline[event_id].slotId
            room_changed = item["roomId"] != baseline[event_id].roomId
            changed_slots += slot_changed
            changed_rooms += room_changed
            changed_events += slot_changed or room_changed
        for teacher_id in demands[event_id].teacherIds:
            teacher_days[(teacher_id, slot.day)].append((minutes(slot.start), minutes(slot.end)))
    timing = []
    for (teacher_id, day), intervals in sorted(teacher_days.items()):
        budget.tick()
        first, last = min(start for start, _ in intervals), max(end for _, end in intervals)
        occupied = sum(end - start for start, end in intervals)  # Accepted: no teacher overlap.
        timing.append({"teacherId": teacher_id, "day": day, "lessonCount": len(intervals),
                       "startMinute": first, "endMinute": last, "occupiedMinutes": occupied,
                       "spanMinutes": last - first, "gapMinutes": last - first - occupied})
    budget.check()
    return {"baselineChanges": changed_events, "baselineComparedEvents": len(baseline),
            "changedSlots": changed_slots, "changedRooms": changed_rooms, "earlySlotPenalty": early,
            "teacherDailyTiming": timing, "timingDefinition": "real_minutes; gaps_include_all_breaks_between_first_start_and_last_end"}


def _solve_plan(value: PlanningInput | dict, mode: str = "generate", time_limit: float = 10) -> dict:
    """Build CP-SAT, solve with one worker, independently verify all candidates.

    Both modes minimize baseline event changes before weighted slot/room changes
    and ordinal lateness. A fully valid baseline has a zero-change proof.
    Preferences are costs, never permission to relax a hard constraint.
    """
    started = time.monotonic()
    valid_mode = isinstance(mode, str) and mode in {"generate", "repair"}
    metrics = {"engine": "ortools_cp_sat", "mode": mode if valid_mode else "invalid",
               "eventCount": 0, "candidateCount": 0, "objective": None, "bestBound": None,
               "solverStatus": "NOT_RUN", "timeLimitSeconds": None, "wallTimeSeconds": 0.0}

    def result(status, diagnostics=(), assignments=(), validation=None):
        metrics["wallTimeSeconds"] = round(time.monotonic() - started, 6)
        return {"status": status, "assignments": list(assignments), "diagnostics": list(diagnostics)[:ISSUE_LIMIT],
                "metrics": dict(metrics), "validation": validation or {"valid": False, "issues": []}}

    def diagnostic(code, message, ids=()):
        return {"code": code, "message": message, "entityIds": sorted(set(ids))[:MAX_EVENTS]}

    if (not valid_mode or isinstance(time_limit, bool) or not isinstance(time_limit, (int, float))
            or not 0 <= time_limit <= 30 or not math.isfinite(time_limit)):
        return result("invalid", [diagnostic("invalid_options", "Некорректный режим или предел времени расчёта (0–30 секунд).")])
    metrics["timeLimitSeconds"] = float(time_limit)
    budget = _Deadline(float(time_limit), started=started, metrics=metrics)
    budget.stage("input_validation")
    try:
        plan = PlanningInput.model_validate(value, context={"scheduling_check": budget.check})
    except (ValidationError, TypeError, ValueError):
        return result("invalid", [diagnostic("invalid_input", "Некорректная или слишком большая модель планирования.")])
    readiness = planning_readiness(plan, context={"scheduling_check": budget.check})
    if not readiness["ready"]:
        return result("invalid", readiness["blockers"], validation={"valid": False, "issues": readiness["blockers"]})
    events = [(f"{demand.id}_{occurrence}", demand, occurrence) for demand in sorted(plan.demands, key=lambda item: item.id) for occurrence in range(demand.weeklyCount)]
    metrics["eventCount"] = len(events)
    warnings = []
    if mode == "repair" and not plan.baseline:
        warnings.append(diagnostic("no_baseline", "Базовых назначений нет; близость к предыдущему расписанию не оценивается."))
    if time_limit == 0:
        metrics["solverStatus"] = "UNKNOWN"
        return result("unknown", [*warnings, diagnostic("time_limit", "Предел времени равен нулю; поиск не запускался. Неразрешимость не установлена.")])
    if plan.baseline and len(plan.baseline) == len(events):
        budget.stage("baseline_validation")
        preserved = [item.model_dump() for item in plan.baseline]
        checked = validate_solution(plan, preserved, time_limit=min(5.0, budget.remaining()))
        metrics["baselineValidated"] = checked["valid"]
        if checked["valid"]:
            metrics.update(_assignment_metrics(plan, preserved, budget))
            objective = plan.preferences.earlyWeight * metrics["earlySlotPenalty"]
            metrics.update(solverStatus="BASELINE_VALIDATED", objective=objective, bestBound=objective,
                           baselinePreserved=True, objectiveDefinition="lexicographic(baselineChanges, weightedSlotRoomChanges, weightedOrdinalLateness)",
                           consecutiveDefinition="adjacent_slot_numbers_within_day")
            return result("optimal", warnings, preserved, checked)
        if any(issue["code"] == "validation_time_limit" for issue in checked["issues"]):
            return result("unknown", [diagnostic("validation_time_limit", "Базовое расписание не проверено в пределах времени.")], validation=checked)
    budget.stage("proof_prechecks")
    slots = sorted(plan.slots, key=lambda item: (item.day, item.start, item.end, item.slot, item.id))
    rooms = sorted(plan.rooms, key=lambda item: item.id)
    slot_index, room_index = {item.id: index for index, item in enumerate(slots)}, {item.id: index for index, item in enumerate(rooms)}
    group_by_id, teacher_by_id = {item.id: item for item in plan.groups}, {item.id: item for item in plan.teachers}
    room_by_id = {item.id: item for item in rooms}
    teacher_events = defaultdict(list)
    for event_number, (_event_id, demand, _occurrence) in enumerate(events):
        budget.tick()
        for teacher_id in demand.teacherIds:
            teacher_events[teacher_id].append(event_number)
    for teacher_id, event_numbers in teacher_events.items():
        if len(event_numbers) > teacher_by_id[teacher_id].maxWeekly:
            metrics["solverStatus"] = "INFEASIBLE_PRECHECK"
            return result("infeasible", [*warnings, diagnostic("weekly_load", "Число требуемых занятий превышает недельный предел преподавателя.", [teacher_id])])
        budget.check()
    qualifications = {teacher.id: {canonical(subject) for subject in teacher.subjects} for teacher in plan.teachers}
    for demand in plan.demands:
        if demand.weekTypes and canonical(plan.weekType) not in {canonical(kind) for kind in demand.weekTypes}:
            metrics["solverStatus"] = "INFEASIBLE_PRECHECK"
            return result("infeasible", [*warnings, diagnostic("demand_week_type", "Тип выбранной недели не соответствует нагрузке; сначала примените календарный снимок.", [demand.id])])
        unqualified = [teacher_id for teacher_id in demand.teacherIds if canonical(demand.subject) not in qualifications[teacher_id]]
        if unqualified or demand.weeklyCount > len({slot.day for slot in slots if not demand.allowedSlotIds or slot.id in demand.allowedSlotIds}) * demand.maxPerDay:
            metrics["solverStatus"] = "INFEASIBLE_PRECHECK"
            proof = diagnostic("qualification", "Не подтверждена квалификация всех участвующих преподавателей.", [demand.id, *unqualified]) if unqualified else diagnostic("demand_daily", "Недельное число занятий больше суммы дневных пределов доступных дней.", [demand.id])
            return result("infeasible", [*warnings, proof])
        budget.check()
    budget.stage("availability_indexes")
    # Compile real interval overlap once (<=100x100), not for each event.
    slot_overlaps = {}
    slot_times = []
    for slot in slots:
        budget.check()
        start, end = slot.day * 1440 + minutes(slot.start), slot.day * 1440 + minutes(slot.end)
        slot_times.append((start, end, end - start))
        slot_overlaps[slot.id] = {index for index, other in enumerate(slots) if slot.day == other.day and slot.start < other.end and other.start < slot.end}
    pattern_cache = {}

    def unavailable_indices(entity):
        pattern = tuple(sorted(entity.unavailableSlotIds))
        if pattern not in pattern_cache:
            blocked = set()
            for slot_id in pattern:
                budget.tick()
                blocked.update(slot_overlaps[slot_id])
            pattern_cache[pattern] = blocked
        return pattern_cache[pattern]

    group_blocked, teacher_blocked, room_blocked = {}, {}, {}
    for roster, index in ((plan.groups, group_blocked), (plan.teachers, teacher_blocked), (plan.rooms, room_blocked)):
        for entity in roster:
            budget.check()
            index[entity.id] = unavailable_indices(entity)
    for teacher in plan.teachers:
        if teacher.workWindows:
            blocked = set(teacher_blocked[teacher.id])
            for index, slot in enumerate(slots):
                budget.tick()
                if not any(window.day == slot.day and window.start <= slot.start and slot.end <= window.end
                           for window in teacher.workWindows):
                    blocked.add(index)
            teacher_blocked[teacher.id] = blocked
    group_classes = {group.id: canonical(group.className) for group in plan.groups}
    related_groups = {}
    for first in plan.groups:
        budget.check()
        related_groups[first.id] = {second.id for second in plan.groups if group_classes[first.id] == group_classes[second.id]
                                   and not (first.id != second.id and first.kind == second.kind == "subgroup"
                                            and first.partition and first.partition == second.partition)}
    room_tags = {room.id: {canonical(tag) for tag in room.tags} for room in rooms}
    student_patterns = {}
    demand_domains, demand_student_groups = {}, {}
    budget.stage("candidate_domains")
    for demand in plan.demands:
        budget.check()
        pattern = tuple(sorted(demand.groupIds))
        if pattern not in student_patterns:
            affected, blocked = set(), set()
            for group_id in pattern:
                budget.tick()
                affected.update(related_groups[group_id])
            for group_id in affected:
                budget.tick()
                blocked.update(group_blocked[group_id])
            student_patterns[pattern] = affected, blocked
        affected, student_blocked = student_patterns[pattern]
        demand_student_groups[demand.id] = affected
        eligible_rooms = [room_index[room_id] for room_id in
                          eligible_room_ids(demand, group_by_id, room_by_id, room_tags, check=budget.check)]
        blocked = set(student_blocked)
        for teacher_id in demand.teacherIds:
            blocked.update(teacher_blocked[teacher_id])
        candidates = []
        allowed_slots = sorted(slot_index[slot_id] for slot_id in demand.allowedSlotIds) if demand.allowedSlotIds else range(len(slots))
        for slot_number in allowed_slots:
            budget.check()
            if slot_number in blocked:
                continue
            if demand.activeFrom or demand.activeUntil:
                lesson_date = (date.fromisoformat(plan.periodStart) + timedelta(days=slots[slot_number].day)).isoformat()
                if (demand.activeFrom and lesson_date < demand.activeFrom) or (demand.activeUntil and lesson_date > demand.activeUntil):
                    continue
            for room_number in eligible_rooms:
                budget.tick()
                if slot_number not in room_blocked[rooms[room_number].id]:
                    candidates.append((slot_number, room_number, *slot_times[slot_number]))
        demand_domains[demand.id] = candidates
        metrics["candidateCount"] += len(candidates) * demand.weeklyCount
        if not candidates:
            metrics["solverStatus"] = "INFEASIBLE_PRECHECK"
            return result("infeasible", [*warnings, diagnostic("empty_domain", "Нет допустимой пары слот–кабинет с учётом квалификации, доступности, вместимости и оснащения.", [demand.id])])
    budget.stage("engine_initialization")
    try:
        from ortools.sat.python import cp_model
    except ImportError:
        return result("invalid", [diagnostic("solver_unavailable", "Локальная библиотека OR-Tools недоступна.")])
    budget.stage("model_construction")
    model = cp_model.CpModel()
    event_vars, event_slot_domains, event_starts, event_ends, event_durations, event_days = [], [], [], [], [], []
    room_intervals, group_intervals = defaultdict(list), defaultdict(list)
    demand_events = defaultdict(list)
    objective_terms = []
    baseline_change_terms, weighted_change_terms = [], []
    baseline = {item.eventId: item for item in plan.baseline}
    event_index = {event_id: index for index, (event_id, _demand, _occurrence) in enumerate(events)}
    pinned = {item.eventId for item in plan.pins}
    linked = {event_id for chain in plan.eventChains for event_id in chain.eventIds}
    day_booleans = []
    for index, (event_id, demand, occurrence) in enumerate(events):
        budget.check()
        candidates = demand_domains[demand.id]
        selected_slot = model.NewIntVar(0, len(slots) - 1, f"slot_{index}")
        selected_room = model.NewIntVar(0, len(rooms) - 1, f"room_{index}")
        start = model.NewIntVar(min(item[2] for item in candidates), max(item[2] for item in candidates), f"start_{index}")
        end = model.NewIntVar(min(item[3] for item in candidates), max(item[3] for item in candidates), f"end_{index}")
        duration = model.NewIntVar(min(item[4] for item in candidates), max(item[4] for item in candidates), f"duration_{index}")
        model.AddAllowedAssignments([selected_slot, selected_room, start, end, duration], candidates)
        interval = model.NewIntervalVar(start, duration, end, f"event_{index}")
        event_vars.append((selected_slot, selected_room, interval))
        event_starts.append(start)
        event_ends.append(end)
        event_durations.append(duration)
        event_slot_domains.append({item[0] for item in candidates})
        demand_events[demand.id].append(index)
        for group_id in demand.groupIds:
            group_intervals[group_id].append(index)
        options = []
        for room_number in sorted({item[1] for item in candidates}):
            budget.tick()
            selected = model.NewBoolVar(f"room_choice_{index}_{room_number}")
            model.Add(selected_room == room_number).OnlyEnforceIf(selected)
            model.Add(selected_room != room_number).OnlyEnforceIf(selected.Not())
            room_intervals[room_number].append(model.NewOptionalIntervalVar(start, duration, end, selected, f"room_event_{index}_{room_number}"))
            options.append(selected)
        model.AddExactlyOne(options)
        day = model.NewIntVar(0, SCHOOL_DAYS - 1, f"day_{index}")
        model.AddElement(selected_slot, [slot.day for slot in slots], day)
        event_days.append(day)
        day_choices = []
        for day_number in range(SCHOOL_DAYS):
            selected = model.NewBoolVar(f"day_choice_{index}_{day_number}")
            model.Add(day == day_number).OnlyEnforceIf(selected)
            model.Add(day != day_number).OnlyEnforceIf(selected.Not())
            day_choices.append(selected)
        day_booleans.append(day_choices)
        if plan.preferences.earlyWeight:
            lateness = model.NewIntVar(0, 19, f"lateness_{index}")
            model.AddElement(selected_slot, [slot.slot - 1 for slot in slots], lateness)
            objective_terms.append(plan.preferences.earlyWeight * lateness)
        if event_id in baseline:
            previous = baseline[event_id]
            changes = []
            for selected, previous_index, weight, label in (
                (selected_slot, slot_index[previous.slotId], plan.preferences.changeWeight, "slot"),
                (selected_room, room_index[previous.roomId], plan.preferences.roomChangeWeight, "room"),
            ):
                changed = model.NewBoolVar(f"changed_{label}_{index}")
                model.Add(selected != previous_index).OnlyEnforceIf(changed)
                model.Add(selected == previous_index).OnlyEnforceIf(changed.Not())
                changes.append(changed)
                if weight:
                    weighted_change_terms.append(weight * changed)
                model.AddHint(selected, previous_index)
            any_change = model.NewBoolVar(f"changed_event_{index}")
            model.AddMaxEquality(any_change, changes)
            baseline_change_terms.append(any_change)
    for intervals in room_intervals.values():
        budget.check()
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)
    for event_numbers in group_intervals.values():
        budget.check()
        if len(event_numbers) > 1:
            model.AddNoOverlap([event_vars[index][2] for index in event_numbers])
    used_groups = sorted(group_intervals)
    for position, first_id in enumerate(used_groups):
        budget.check()
        for second_id in used_groups[position + 1:]:
            budget.tick()
            if second_id in related_groups[first_id]:
                indexes = sorted(set(group_intervals[first_id]) | set(group_intervals[second_id]))
                if len(indexes) > 1:
                    model.AddNoOverlap([event_vars[index][2] for index in indexes])
    slot_bools = {}

    def at_slot(event_number, slot_number):
        budget.tick()
        key = (event_number, slot_number)
        if key not in slot_bools:
            selected = model.NewBoolVar(f"at_slot_{event_number}_{slot_number}")
            model.Add(event_vars[event_number][0] == slot_number).OnlyEnforceIf(selected)
            model.Add(event_vars[event_number][0] != slot_number).OnlyEnforceIf(selected.Not())
            slot_bools[key] = selected
        return slot_bools[key]

    for teacher_id, event_numbers in teacher_events.items():
        budget.check()
        teacher = teacher_by_id[teacher_id]
        if len(event_numbers) > 1:
            model.AddNoOverlap([event_vars[index][2] for index in event_numbers])
        for day_number in range(SCHOOL_DAYS):
            model.Add(sum(day_booleans[index][day_number] for index in event_numbers) <= teacher.maxDaily)
            if teacher.maxDailySpanMinutes is not None or teacher.maxDailyGapMinutes is not None:
                starts, ends, durations = [], [], []
                day_start, day_end = day_number * 1440, (day_number + 1) * 1440
                for index in event_numbers:
                    budget.tick()
                    present = day_booleans[index][day_number]
                    local_start = model.NewIntVar(day_start, day_end, f"teacher_start_{teacher_id}_{day_number}_{index}")
                    local_end = model.NewIntVar(day_start, day_end, f"teacher_end_{teacher_id}_{day_number}_{index}")
                    model.Add(local_start == event_starts[index]).OnlyEnforceIf(present)
                    model.Add(local_start == day_end).OnlyEnforceIf(present.Not())
                    model.Add(local_end == event_ends[index]).OnlyEnforceIf(present)
                    model.Add(local_end == day_start).OnlyEnforceIf(present.Not())
                    starts.append(local_start)
                    ends.append(local_end)
                    if teacher.maxDailyGapMinutes is not None:
                        duration_on_day = model.NewIntVar(0, 1440, f"teacher_duration_{teacher_id}_{day_number}_{index}")
                        model.Add(duration_on_day == event_durations[index]).OnlyEnforceIf(present)
                        model.Add(duration_on_day == 0).OnlyEnforceIf(present.Not())
                        durations.append(duration_on_day)
                first = model.NewIntVar(day_start, day_end, f"teacher_first_{teacher_id}_{day_number}")
                last = model.NewIntVar(day_start, day_end, f"teacher_last_{teacher_id}_{day_number}")
                span = model.NewIntVar(0, 1440, f"teacher_span_{teacher_id}_{day_number}")
                model.AddMinEquality(first, starts)
                model.AddMaxEquality(last, ends)
                model.AddMaxEquality(span, [last - first, 0])
                if teacher.maxDailySpanMinutes is not None:
                    model.Add(span <= teacher.maxDailySpanMinutes)
                if teacher.maxDailyGapMinutes is not None:
                    model.Add(span - sum(durations) <= teacher.maxDailyGapMinutes)
            if teacher.maxConsecutive >= teacher.maxDaily:
                continue
            occupancy = {}
            for slot_number, slot in enumerate(slots):
                budget.tick()
                if slot.day != day_number:
                    continue
                candidates = [at_slot(index, slot_number) for index in event_numbers if slot_number in event_slot_domains[index]]
                if candidates:
                    occupied = model.NewBoolVar(f"occupied_{teacher_id}_{day_number}_{slot.slot}")
                    model.Add(sum(candidates) == occupied)
                    occupancy[slot.slot] = occupied
            for first in range(1, 21 - teacher.maxConsecutive):
                model.Add(sum(occupancy.get(number, 0) for number in range(first, first + teacher.maxConsecutive + 1)) <= teacher.maxConsecutive)
    for demand in plan.demands:
        budget.check()
        for day_number in range(SCHOOL_DAYS):
            model.Add(sum(day_booleans[index][day_number] for index in demand_events[demand.id]) <= demand.maxPerDay)
        # Occurrences have identical domains. Order only interchangeable ones:
        # exact pins, synchronized/linked occurrence identities and baselines
        # prohibit this symmetry reduction and are always retained verbatim.
        indexes = demand_events[demand.id]
        interchangeable = (not demand.syncKey and not any(events[index][0] in pinned for index in indexes)
                           and not any(events[index][0] in linked or events[index][0] in baseline for index in indexes))
        if interchangeable:
            for first, second in zip(indexes, indexes[1:]):
                model.Add(event_starts[first] < event_starts[second])
    class_groups = defaultdict(list)
    for group in plan.groups:
        class_groups[canonical(group.className)].append(group)
    for class_roster in class_groups.values():
        budget.check()
        representatives = [group for group in class_roster if group.kind == "subgroup"] or class_roster
        whole_limits = [group.maxDaily for group in class_roster if group.kind == "whole"]
        for representative in representatives:
            budget.check()
            limit = min([representative.maxDaily, *whole_limits])
            affected_events = [index for index, (_event_id, demand, _occurrence) in enumerate(events) if representative.id in demand_student_groups[demand.id]]
            for day_number in range(SCHOOL_DAYS):
                model.Add(sum(day_booleans[index][day_number] for index in affected_events) <= limit)
    sync_groups = defaultdict(list)
    for index, (_event_id, demand, occurrence) in enumerate(events):
        budget.tick()
        if demand.syncKey:
            sync_groups[(demand.syncKey, occurrence)].append(index)
    for indexes in sync_groups.values():
        budget.tick()
        for index in indexes[1:]:
            model.Add(event_vars[index][0] == event_vars[indexes[0]][0])
    for pin in plan.pins:
        budget.tick()
        index = event_index[pin.eventId]
        model.Add(event_vars[index][0] == slot_index[pin.slotId])
        model.Add(event_vars[index][1] == room_index[pin.roomId])
    for chain in plan.eventChains:
        budget.check()
        for first_id, second_id in zip(chain.eventIds, chain.eventIds[1:]):
            first, second = event_index[first_id], event_index[second_id]
            model.Add(event_starts[second] >= event_ends[first])
            if chain.sameDay:
                model.Add(event_days[first] == event_days[second])
            if chain.maxGapMinutes is not None:
                model.Add(event_starts[second] - event_ends[first] <= chain.maxGapMinutes)
    # Exact integer lexicographic encoding. Strict model bounds give a maximum
    # < 2e16 (well below signed int64); every higher tier beats ALL lower costs.
    early_upper = len(events) * 19 * plan.preferences.earlyWeight
    secondary_upper = len(baseline) * (plan.preferences.changeWeight + plan.preferences.roomChangeWeight)
    secondary_scale = early_upper + 1
    primary_scale = (secondary_upper + 1) * secondary_scale
    model.Minimize(primary_scale * sum(baseline_change_terms)
                   + secondary_scale * sum(weighted_change_terms) + sum(objective_terms))
    metrics["objectiveScales"] = {"baselineChanges": primary_scale, "weightedSlotRoomChanges": secondary_scale}
    solver = cp_model.CpSolver()
    budget.stage("cp_sat_search")
    remaining = budget.remaining()
    if remaining == 0:
        metrics["solverStatus"] = "UNKNOWN"
        return result("unknown", [*warnings, diagnostic("time_limit", "Предел времени исчерпан при построении модели; неразрешимость не установлена.")])
    # Reserve a bounded slice for the independent verifier; an unverified
    # candidate can never be returned as feasible when search uses its budget.
    solver.parameters.max_time_in_seconds = max(0.000001, remaining - min(0.5, float(time_limit) * 0.1))
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.log_search_progress = False
    status = solver.Solve(model)
    metrics.update(solverStatus=solver.StatusName(status), solverWallTimeSeconds=round(solver.WallTime(), 6),
                   branches=solver.NumBranches(), conflicts=solver.NumConflicts())
    if status == cp_model.INFEASIBLE:
        return result("infeasible", [*warnings, diagnostic("no_feasible_model", "CP-SAT доказал отсутствие расписания при заданных жёстких ограничениях. Точный набор причин не вычислялся.")])
    if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        return result("invalid" if status == cp_model.MODEL_INVALID else "unknown", [*warnings, diagnostic("invalid_solver_model" if status == cp_model.MODEL_INVALID else "search_unfinished", "Модель расчёта недопустима." if status == cp_model.MODEL_INVALID else "Поиск завершён без проверенного решения; неразрешимость не установлена.")])
    budget.stage("independent_validation")
    assignments = []
    for index, (event_id, _demand, _occurrence) in enumerate(events):
        budget.tick()
        assignments.append({"eventId": event_id, "slotId": slots[solver.Value(event_vars[index][0])].id, "roomId": rooms[solver.Value(event_vars[index][1])].id})
    checked = validate_solution(plan, assignments, time_limit=min(5.0, budget.remaining()))
    if not checked["valid"]:
        if any(issue["code"] == "validation_time_limit" for issue in checked["issues"]):
            return result("unknown", [diagnostic("validation_time_limit", "Кандидат не проверен в пределах времени; неразрешимость не установлена.")], validation=checked)
        return result("invalid", [diagnostic("validator_rejected", "Независимая проверка отклонила результат решателя.")], validation=checked)
    metrics.update(_assignment_metrics(plan, assignments, budget))
    metrics.update(objective=solver.ObjectiveValue(), bestBound=solver.BestObjectiveBound(),
                   consecutiveDefinition="adjacent_slot_numbers_within_day", baselinePreserved=False,
                   objectiveDefinition="lexicographic(baselineChanges, weightedSlotRoomChanges, weightedOrdinalLateness)")
    budget.check()
    return result("optimal" if status == cp_model.OPTIMAL else "feasible", warnings, assignments, checked)


def solve_plan(value: PlanningInput | dict, mode: str = "generate", time_limit: float = 10) -> dict:
    """One walltime budget covers validation, indexing, construction and search.

    Python preprocessing checks the deadline cooperatively at bounded intervals.
    CP-SAT receives only the remaining budget and one search worker. A deadline
    without a previously established proof is always unknown, never infeasible.
    """
    try:
        return _solve_plan(value, mode, time_limit)
    except _BudgetExceeded as error:
        budget = error.budget
        metrics = dict(budget.metrics or {})
        metrics.update(solverStatus="UNKNOWN", wallTimeSeconds=round(time.monotonic() - budget.started, 6))
        return {"status": "unknown", "assignments": [],
                "diagnostics": [{"code": "time_limit", "message": "Предел времени исчерпан; неразрешимость не установлена.", "entityIds": []}],
                "metrics": metrics, "validation": {"valid": False, "issues": []}}
