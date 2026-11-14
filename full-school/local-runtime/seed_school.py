"""Populate only the new preview store, adapting the v30 staff and daily fixtures."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

PASSWORD = 'SchoolDemo-2026-Local!'
SOURCE = 'Fictional classroom timetable.xlsx'
NAMES = {'demo.teacher': 'Maya Brooks', 'demo.substitute': 'Owen Reed'}
LESSONS = [
    ('demo-math-1', '7A', 0, 1, '08:00', '08:40', 'Mathematics', 'Maya Brooks', '101'),
    ('demo-science-1', '8B', 0, 2, '09:00', '09:40', 'Science', 'Owen Reed', '202'),
    ('demo-math-2', '7A', 0, 3, '10:00', '10:40', 'Mathematics', 'Maya Brooks', '101'),
    ('demo-science-2', '8B', 1, 2, '09:00', '09:40', 'Science', 'Owen Reed', '202'),
    ('demo-math-3', '7A', 2, 1, '08:00', '08:40', 'Mathematics', 'Maya Brooks', '101'),
    ('demo-math-4', '7A', 4, 1, '08:00', '08:40', 'Mathematics', 'Maya Brooks', '101'),
]


def source_package():
    cells = []
    for column, group, subject, teacher, count in [('C', '7A', 'Mathematics', 'Maya Brooks', 4), ('D', '8B', 'Science', 'Owen Reed', 2)]:
        cells.append({'sourceCell': column + '2', 'sourceId': 'demo-timetable', 'sourceLocator': 'Fictional!' + column + '2',
                      'row': 2, 'classLabel': group, 'rawCount': count, 'teacher': teacher, 'rawSubject': subject,
                      'normalizedSubjects': [{'subject': subject, 'weeklyCount': count}], 'status': 'confirmed', 'blockers': []})
    return json.dumps({'schemaVersion': 1, 'packageId': 'fictional-v30', 'asOf': '2026-11-13',
        'sources': [{'id': 'demo-timetable', 'title': SOURCE, 'name': SOURCE, 'kind': 'timetable'}],
        'cells': cells, 'conditions': [], 'sourceRows': [], 'groupObservations': [],
        'confirmedCorrections': [], 'unresolvedQuestions': []})


def schedule():
    return [dict(id=identity, className=group, day=day, slot=slot, start=start, end=end, subject=subject,
                 teachers=[teacher], rooms=[room], sourceCell=f'Fictional!C{index}', raw=subject, edited=False)
            for index, (identity, group, day, slot, start, end, subject, teacher, room) in enumerate(LESSONS, 2)]


def planning(week, lessons):
    slots = [{'id': f"d{row['day']}-s{row['slot']}", **{key: row[key] for key in ('day', 'slot', 'start', 'end')}} for row in lessons]
    teaching = {'Mathematics': ('math', 'math-room'), 'Science': ('science', 'science-room')}
    groups = [{'id': f'group-{grade}', 'className': grade, 'name': f'Grade {grade}', 'size': 18,
               'kind': 'whole', 'partition': '', 'maxDaily': 5, 'unavailableSlotIds': []} for grade in ('7A', '8B')]
    teachers = [{'id': identity, 'name': name, 'subjects': subjects, 'unavailableSlotIds': [], 'maxDaily': 5,
                 'maxWeekly': 20, 'maxConsecutive': 5} for identity, name, subjects in [
                     ('math', 'Maya Brooks', ['Mathematics']), ('science', 'Owen Reed', ['Mathematics', 'Science'])]]
    rooms = [{'id': identity, 'name': name, 'capacity': 24, 'tags': [], 'unavailableSlotIds': []}
             for identity, name in [('math-room', '101'), ('science-room', '202')]]
    demands, baseline = [], []
    for row, slot in zip(lessons, slots):
        teacher, room = teaching[row['subject']]
        demand = row['id'] + '-demand'
        demands.append({'id': demand, 'subject': row['subject'], 'groupIds': ['group-' + row['className']],
                        'teacherIds': [teacher], 'roomIds': [room], 'weeklyCount': 1, 'sourceLessonIds': [row['id']]})
        baseline.append({'eventId': demand + '_0', 'slotId': slot['id'], 'roomId': room})
    return {'periodStart': week, 'confirmed': True, 'slots': slots, 'groups': groups, 'teachers': teachers,
            'rooms': rooms, 'demands': demands, 'baseline': baseline}


def send(client, prefix, origin, path, value, method='POST', *, bridge=None):
    if bridge is None:
        csrf = check(client.get(prefix + '/api/portal-session'))['csrfToken']
        headers = {'Origin': origin, 'X-CSRF-Token': csrf}
    else:
        headers = {'x-school-bridge': bridge}
    return check(client.request(method, prefix + path, json=value, headers=headers))


def check(response):
    if not response.is_success:
        raise RuntimeError(f'Preview fixture {response.request.method} {response.request.url.path}: {response.status_code} {response.text}')
    return response.json()


def seed(staff, owner, origin, prefix, school, bridge):
    from server import db, school_publications, staff_access, timetable
    from server.school_calendar import effective_calendar_snapshot

    today = datetime.now(ZoneInfo('Europe/Moscow')).date()
    monday = today - timedelta(days=today.weekday())
    week = monday.isoformat()
    lessons = schedule()
    stamp = datetime.now(timezone.utc).isoformat()
    timetable.apply_batch(lessons, 0, {'role': 'director', 'userId': 'demo-seed'}, idempotency_key='v30-demo-schedule',
                          expected_hash=timetable.batch_hash(lessons, 0, SOURCE), source_name=SOURCE)
    staff_access.bootstrap_director('demo.director', 'Avery Morgan', PASSWORD)

    with TestClient(staff, base_url=origin) as director, TestClient(owner, base_url='http://localhost:8798') as director_portal:
        actor = send(director, prefix, origin, '/api/staff/login', {'username': 'demo.director', 'password': PASSWORD})['profile']
        calendar = send(director, prefix, origin, '/api/school/calendar/config', {'expectedRevision': 0, 'config': {
            'timezone': 'Europe/Moscow', 'periodStart': week, 'periodEnd': (monday + timedelta(days=13)).isoformat(),
            'source': 'Fictional term calendar', 'confirmed': True}}, 'PATCH')
        revision = calendar['revision']
        for week_start in (monday, monday + timedelta(days=7)):
            calendar_week = send(director, prefix, origin, '/api/school/calendar/records/weeks', {'expectedRevision': revision,
                'record': {'weekStart': week_start.isoformat(), 'schoolDays': [0, 1, 2, 3, 4],
                           'source': 'Fictional term calendar', 'confirmed': True}})
            revision = calendar_week['revision']
        snapshot = effective_calendar_snapshot(week, school_id=school)
        publication = {'version': 1, 'schoolId': school, 'draftRevision': 1, 'periodStart': week,
                       'calendarRevision': revision, 'calendarHash': snapshot['inputHash'], 'lessons': timetable.read_draft()['lessons'],
                       'publishedAt': stamp, 'publicationId': 'fictional-initial-publication', 'runId': 'fictional-initial-run'}
        with closing(sqlite3.connect(db.database_path())) as connection:
            school_publications._schema(connection)
            connection.execute('INSERT INTO school_publications VALUES(?,?,?,?,?,?,?,?,?,?)',
                (publication['publicationId'], school, 1, 'fictional-publication-command', 1, publication['runId'],
                 json.dumps(publication), '{}', stamp, actor['membershipId']))
            connection.commit()
        send(director, prefix, origin, '/api/planning/config', {'expectedRevision': 0, 'baseDraftRevision': 1, 'input': planning(week, lessons)})

        staff_members = [('demo.planner', 'Taylor Vale', 'planner', [], []), ('demo.access', 'Harper Quinn', 'access_admin', [], []),
                         ('demo.teacher', NAMES['demo.teacher'], 'teacher', [NAMES['demo.teacher']], ['math']),
                         ('demo.substitute', NAMES['demo.substitute'], 'teacher', [NAMES['demo.substitute']], ['science'])]
        for username, name, role, refs, teacher_ids in staff_members:
            nomination = send(director, prefix, origin, '/api/staff/nominations', {
                'username': username, 'name': name, 'role': role, 'teacherRefs': refs, 'calendarTeacherIds': teacher_ids})
            invite = send(director, prefix, origin, '/api/staff/invites', {'nominationId': nomination['id']})
            with TestClient(staff, base_url=origin) as invitee:
                send(invitee, prefix, origin, '/api/staff/accept', {'token': invite['token'], 'password': PASSWORD})

        revision = 0
        records = [('students', {'name': 'Jamie Lane', 'className': '7A', 'attendancePercent': 96.5, 'averageGrade': 4.4}),
                   ('students', {'name': 'Riley Bell', 'className': '8B', 'attendancePercent': 92, 'averageGrade': 4.1}),
                   ('teacherProfiles', {'name': 'Maya Brooks', 'subject': 'Mathematics', 'weeklyHours': 4, 'available': True}),
                   ('teacherProfiles', {'name': 'Owen Reed', 'subject': 'Science', 'weeklyHours': 2, 'available': True}),
                   ('tasks', {'title': 'Prepare Friday math materials', 'description': 'Copy the fraction worksheet for Grade 7A.', 'owner': 'Maya Brooks'}),
                   ('documents', {'title': 'Classroom safety checklist', 'type': 'Procedure', 'status': 'review', 'content': 'Check clear walkways and shared supplies.'})]
        student_id = None
        for kind, record in records:
            result = send(director_portal, '', origin, '/api/school/records/' + kind,
                          {'expectedRevision': revision, 'record': record}, bridge=bridge)
            revision = result['revision']
            if kind == 'students' and student_id is None:
                student_id = result['record']['id']
        send(director_portal, '', origin, '/api/school/settings', {'expectedRevision': revision,
             'settings': {'schoolName': 'Oakbridge School · Fictional demo'}}, 'PATCH', bridge=bridge)

        invitation = send(director, prefix, origin, '/api/staff/student-access/invitations', {
            'requestId': 'v30-fictional-student-invite', 'studentId': student_id, 'username': 'demo.student'})
        token = invitation['invite']['path'].split('#invite=')[1]
        with TestClient(staff, base_url=origin) as student:
            send(student, prefix, origin, '/api/staff/accept', {'token': token, 'password': PASSWORD})
        with TestClient(staff, base_url=origin) as teacher:
            send(teacher, prefix, origin, '/api/staff/login', {'username': 'demo.teacher', 'password': PASSWORD})
            send(teacher, prefix, origin, '/api/teacher/learning/assignments', {
                'requestId': 'v30-fictional-assignment-1', 'studentId': student_id, 'subject': 'Mathematics',
                'topic': 'Equivalent fractions', 'gap': 'Explain fractions with diagrams',
                'content': 'Draw a model that shows why 2/4 and 1/2 are equal. Explain your reasoning in two sentences.',
                'answers': 'The models shade the same area.', 'generate': False,
                'dueAt': (today + timedelta(days=5)).isoformat() + 'T16:00:00+03:00'})
            send(teacher, prefix, origin, '/api/teacher/preparation/materials', {
                'requestId': 'v30-fictional-material-1', 'kind': 'lesson_plan', 'title': 'Equivalent fractions workshop',
                'topic': 'Equivalent fractions', 'className': '7A', 'subject': 'Mathematics', 'lessonId': 'demo-math-1',
                'content': 'Compare paper strips marked in halves and quarters.', 'durationMinutes': 40})

        daily = '/api/planning/daily-brief'
        next_lesson = next(day for day in (today + timedelta(days=offset) for offset in range(7))
                           if day.weekday() in {row['day'] for row in lessons})
        target = next_lesson.isoformat()
        brief = check(director.get(prefix + daily, params={'targetDate': target}))
        brief_input = {'targetDate': target, 'expectedRevision': brief['revision'],
                       'expectedSourceBindingHash': brief['sourceBindingHash'], 'callReview': 'recorded',
                       'teacherOverrides': [], 'confirmedLessonIds': []}
        preview = send(director, prefix, origin, daily + '/preview', brief_input)
        send(director, prefix, origin, daily + '/save', {**brief_input, 'previewHash': preview['previewHash'],
             'requestId': 'v30-fictional-daily-brief'})

        for title, description, fee, schedule_note, room in [
            ('Robotics club', 'Build a small tabletop rover in pairs.', 1250, 'Wednesday at 15:30', '202'),
            ('Sketchbook club', 'Practice drawing from observation.', 0, 'Friday at 15:00', '101'),
        ]:
            latest = check(director_portal.get('/api/school/clubs', headers={'x-school-bridge': bridge}))
            created = send(director_portal, '', origin, '/api/school/clubs/programs', {'expectedRevision': latest['revision'], 'record': {
                'title': title, 'description': description, 'scheduleNote': schedule_note, 'room': room,
                'teacherName': 'Owen Reed', 'feeKopeks': fee, 'billingUnit': 'month'}}, bridge=bridge)
            if fee:
                enrolled = send(director_portal, '', origin, '/api/school/clubs/enrollments', {'expectedRevision': created['revision'],
                    'record': {'programId': created['record']['id'], 'studentId': student_id, 'status': 'active'}}, bridge=bridge)
                charge_input = {'expectedRevision': enrolled['revision'], 'enrollmentId': enrolled['record']['id'],
                                'period': (today.replace(day=1) - timedelta(days=1)).strftime('%Y-%m'), 'quantity': 1}
                quote = send(director_portal, '', origin, '/api/school/clubs/charges/preview', charge_input, bridge=bridge)
                charge = send(director_portal, '', origin, '/api/school/clubs/charges',
                              {**charge_input, 'expectedHash': quote['hash']}, bridge=bridge)
                send(director_portal, '', origin, f"/api/school/clubs/charges/{charge['record']['id']}/confirm",
                     {'expectedRevision': charge['revision']}, bridge=bridge)
    print(f'Fictional publication week: {week}. Prepared daily brief: {target}.', flush=True)
