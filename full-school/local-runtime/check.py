"""Exercise native v30 routes with an in-process disposable store."""
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from serve import HISTORICAL_ACTIONS, HOST, ORIGIN, OWNER, STAFF, TRANSLATED, applications
from seed_school import PASSWORD, check, send


def run(app):
    with TestClient(app, base_url=ORIGIN) as owner, TestClient(app, base_url=ORIGIN) as teacher, TestClient(app, base_url=ORIGIN) as student:
        assert owner.get(OWNER + '/').status_code == 200
        assert teacher.get(STAFF + '/').status_code == 200
        assert check(owner.get('/__v30_recording'))['fixture'] == 'school-v30-fictional-disposable'
        assert owner.get(OWNER + '/api/state', headers={'Host': 'example.invalid'}).status_code == 403
        assert student.get(STAFF + '/api/student/learning').status_code == 401
        assert owner.post(OWNER + '/api/school/replacements/preview', json={}).status_code == 403
        for action in HISTORICAL_ACTIONS:
            unavailable = owner.post(OWNER + action, json={})
            assert unavailable.status_code == 409 and 'unavailable' in unavailable.json()['detail']
        for client, username in [(teacher, 'demo.teacher'), (student, 'demo.student')]:
            send(client, STAFF, ORIGIN, '/api/staff/login', {'username': username, 'password': PASSWORD})
        assert student.get(STAFF + '/api/teacher/learning').status_code == 403
        assert teacher.get(STAFF + '/api/student/learning').status_code == 403
        clubs = check(owner.get(OWNER + '/api/school/clubs'))
        assert {row['title'] for row in clubs['programs']} == {'Robotics club', 'Sketchbook club'}
        charge = send(owner, OWNER, ORIGIN, '/api/school/clubs/charges/preview', {
            'expectedRevision': clubs['revision'], 'enrollmentId': clubs['enrollments'][0]['id'],
            'period': '2026-11', 'quantity': 1})
        assert charge['proposal']['amountKopeks'] == 1250
        [record] = [item for item in clubs['charges'] if item['status'] == 'confirmed']
        receipt = f'/api/school/clubs/charges/{record["id"]}/receipt.pdf'
        student_pdf = f'/api/student/clubs/receipts/{record["id"]}/receipt.pdf'
        assert student.get(STAFF + receipt).status_code == 403
        assert teacher.get(STAFF + student_pdf).status_code == 403
        own = check(student.get(STAFF + '/api/student/clubs/receipts'))['receipts']
        assert [row['id'] for row in own] == [record['id']]
        owner_copy = owner.get(OWNER + receipt)
        assert owner_copy.status_code == 200 and owner_copy.content.startswith(b'%PDF-')
        assert owner_copy.headers['cache-control'] == 'no-store'
        assert student.get(STAFF + student_pdf).content == owner_copy.content
        assert student.get(STAFF + '/api/student/clubs/receipts/charge-' + '0'*32 + '/receipt.pdf').status_code == 404
        send(owner, OWNER, ORIGIN, f'/api/school/clubs/charges/{record["id"]}/cancel',
             {'expectedRevision': clubs['revision']})
        assert owner.get(OWNER + receipt).status_code == 404
        assert student.get(STAFF + student_pdf).status_code == 404
        assert not check(student.get(STAFF + '/api/student/clubs/receipts'))['receipts']
        preparations = check(teacher.get(STAFF + '/api/teacher/preparation'))
        assert preparations['materialsTotal'] == 1
        assignment = check(student.get(STAFF + '/api/student/learning'))['assignments'][0]
        assert assignment['status'] == 'sent' and assignment['dueAt']
        assignment_path = '/api/student/learning/assignments/' + assignment['id']
        submitted = send(student, STAFF, ORIGIN, assignment_path + '/submit', {
            'requestId': 'fictional-assignment-submit', 'expectedRevision': 1,
            'text': 'The diagram shades the same area using different partitions.'})
        assert submitted['assignment']['status'] == 'submitted'
        attempt = submitted['work']['attempts'][0]['id']
        reviewed = send(teacher, STAFF, ORIGIN, '/api/teacher/learning/assignments/' + assignment['id'] + '/review', {
            'requestId': 'fictional-assignment-review', 'expectedRevision': 2,
            'attemptId': attempt, 'decision': 'reviewed', 'comment': 'Your diagram explains the equivalence clearly.'})
        assert reviewed['assignment']['status'] == 'reviewed'
        assert check(student.get(STAFF + assignment_path))['work']['attempts'][0]['review']['decision'] == 'reviewed'

        with TestClient(app, base_url=ORIGIN) as planner:
            send(planner, STAFF, ORIGIN, '/api/staff/login', {'username': 'demo.planner', 'password': PASSWORD})
            today = datetime.now(ZoneInfo('Europe/Moscow')).date()
            target = next(day for day in (today + timedelta(days=offset) for offset in range(7))
                          if day.weekday() in {0, 1, 2, 4}).isoformat()
            brief = check(planner.get(STAFF + '/api/planning/daily-brief', params={'targetDate': target}))
            assert brief['saved'] is True
            preflight = send(planner, STAFF, ORIGIN, '/api/planning/daily-brief/preflight', {
                'targetDate': target, 'expectedRevision': brief['revision'], 'expectedSourceBindingHash': brief['sourceBindingHash']})
            assert preflight['readiness']['ready'], preflight['readiness']['blockers']
            run = send(planner, STAFF, ORIGIN, '/api/planning/runs', {**preflight['runInput'],
                       'timeLimitSeconds': 1, 'requestId': 'fictional-daily-run-check'})
            deadline = monotonic() + 5
            while run['status'] in {'queued', 'running'} and monotonic() < deadline:
                sleep(0.05)
                run = check(planner.get(STAFF + '/api/planning/runs/' + run['id']))
            assert run['status'] in {'optimal', 'feasible'}, run['status']

        lesson_id = 'demo-math-1'
        current = check(owner.get(OWNER + '/api/school/replacements'))
        lesson = next(row for row in current['lessons'] if row['id'] == lesson_id)
        replacement_input = {'date': lesson['date'], 'lessonId': lesson_id, 'replacementTeacher': 'Owen Reed',
                             'reason': 'Training workshop coverage', 'expectedActiveVersion': current['activeVersion'],
                             'expectedDraftRevision': current['draftRevision']}
        def replace(action, value):
            return send(owner, OWNER, ORIGIN, '/api/school/replacements/' + action, value)
        proposed = replace('preview', replacement_input)
        assert proposed['ready'], proposed['blockers']
        applied = replace('apply', {'input': replacement_input, 'previewHash': proposed['previewHash'],
                                   'requestId': 'fictional-replacement-check-apply'})
        identity = applied['record']['id']
        versions = {'expectedActiveVersion': current['activeVersion'], 'expectedDraftRevision': applied['draftRevision']}
        publication = replace(identity + '/publish-preview', versions)
        assert publication['ready'], publication['blockers']
        published = replace(identity + '/publish', {**versions, 'previewHash': publication['previewHash'],
                                                   'requestId': 'fictional-replacement-check-publish'})
        assert published['publication']['version'] == current['activeVersion'] + 1
        assert lesson_id not in {row['id'] for row in check(teacher.get(STAFF + '/api/staff/my-schedule'))['lessons']}
        send(teacher, STAFF, ORIGIN, '/api/staff/logout', {})
        send(teacher, STAFF, ORIGIN, '/api/staff/login', {'username': 'demo.substitute', 'password': PASSWORD})
        assert lesson_id in {row['id'] for row in check(teacher.get(STAFF + '/api/staff/my-schedule'))['lessons']}
        assert check(student.get(STAFF + '/api/student/learning'))['assignments'][0]['id'] == assignment['id']
    print(f'PASS native v30 on {HOST}: role boundaries, CSRF, club fee preview, receipt ownership and withdrawal, materials, assignment submission and review, daily solver, replacement and publication.')


if __name__ == '__main__':
    with TemporaryDirectory(prefix='school-v30-check-', dir='/tmp') as folder:
        run(applications(TRANSLATED, TRANSLATED, Path(folder).resolve()))
