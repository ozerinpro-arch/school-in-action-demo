#!/usr/bin/env python3
"""Run the English owner and staff applications with a fictional school."""
import argparse
import os
from pathlib import Path
import secrets
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
TRANSLATED = HERE.parent / 'app'
PUBLIC_PORT = int(os.environ.get('DEMO_PORT', '5261'))
if not 1 <= PUBLIC_PORT <= 65535:
    raise ValueError('DEMO_PORT must be a TCP port.')
HOST = f'127.0.0.1:{PUBLIC_PORT}'
ORIGIN = 'http://' + HOST
OWNER = '/client/school'
STAFF = '/school-staff'
SCHOOL = 'demo-school-v30'
HISTORICAL_ACTIONS = {'/api/timetable/dated-draft', '/api/planning/experimental-school'}


def offline(event, args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'socket.gethostbyname', 'socket.sendto'}:
        raise OSError('Outbound networking is disabled in this synthetic preview.')
    if event == 'open' and isinstance(args[0], (str, bytes)):
        path = os.fsdecode(args[0])
        if '/server/assets/' in path and path.endswith('.json'):
            raise PermissionError('Original source data is disabled in this synthetic preview.')


def applications(backend, ui, storage, *, initialize=True):
    from starlette.responses import JSONResponse, RedirectResponse

    secret = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    secret_file = storage / 'preview-bridge'
    fd = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(secret)
    for name in tuple(os.environ):
        if name.startswith(('SHKOLA_', 'AGENT_', 'NANOGPT_', 'OPENAI_', 'LANGCHAIN_', 'LANGSMITH_', 'LANGGRAPH_')):
            del os.environ[name]
    os.environ.update({
        'PYTHON_DOTENV_DISABLED': '1', 'SHKOLA_WORKSPACE_MODE': 'school', 'SHKOLA_TEST_MODE': 'isolated',
        'SHKOLA_SCHOOL_ID': SCHOOL, 'SHKOLA_DB_PATH': str(storage / 'domain.sqlite3'),
        'AGENT_DB_PATH': str(storage / 'agent.sqlite3'), 'SHKOLA_STAFF_DB_PATH': str(storage / 'staff.sqlite3'),
        'SHKOLA_STAFF_ORIGIN': ORIGIN, 'SHKOLA_STAFF_BASE_PATH': STAFF,
        'SHKOLA_PORTAL_MODE': 'closed', 'SHKOLA_PORTAL_PREVIEW': 'true',
        'SHKOLA_GATEWAY_SECRET_FILE': str(secret_file), 'NANOGPT_ALLOW_REQUESTS': 'false',
        'SHKOLA_REQUEST_AI_ENABLED': 'false', 'SHKOLA_MAX_ENABLED': 'false', 'SHKOLA_MAX_SEND_ENABLED': 'false',
    })
    sys.path.insert(0, str(backend))
    sys.addaudithook(offline)

    from server import dated_timetable, experimental_school, portal_app, school_plan_sources, staff_app
    from seed_school import seed, source_package
    synthetic_source = storage / 'fictional-planning-input.json'
    synthetic_source.write_text(source_package())
    school_plan_sources.PACKAGE_PATH = synthetic_source
    dated_timetable.BASIS_PATH = storage / 'unavailable-historical-basis.json'
    experimental_school.SEED_PATH = storage / 'unavailable-historical-warmstart.json'
    from server import launch_identity
    original_register = launch_identity.register_portal_principal

    def register_preview(profile):
        if profile.get('identitySource') == 'portal-preview':
            profile.update(name='Avery Morgan', title='Director · fictional preview', initials='AM')
        return original_register(profile)

    launch_identity.register_portal_principal = register_preview

    os.environ['SHKOLA_UI_DIRECTORY'] = str(ui / 'dist')
    owner = portal_app.create_app()
    os.environ['SHKOLA_UI_DIRECTORY'] = str(ui / 'dist-staff')
    staff = staff_app.create_app()
    if initialize:
        seed(staff, owner, ORIGIN, STAFF, SCHOOL, secret)

    async def app(scope, receive, send):
        if scope['type'] == 'lifespan':
            return await staff(scope, receive, send)
        if scope['type'] != 'http':
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            return
        headers = scope['headers']
        host = [value for key, value in headers if key == b'host']
        origin = [value for key, value in headers if key == b'origin']
        if host != [HOST.encode()] or origin not in ([], [ORIGIN.encode()]) or (b'sec-fetch-site', b'cross-site') in headers:
            return await JSONResponse({'detail': 'Open the local demo on its loopback address.'}, 403)(scope, receive, send)
        path = scope['path']
        method = scope['method']
        if path == '/health' and method == 'GET':
            return await JSONResponse({'status': 'ok'})(scope, receive, send)
        if path == '/__v30_recording' and method == 'GET':
            return await JSONResponse({'fixture': 'school-v30-fictional-disposable', 'schoolId': SCHOOL},
                                      headers={'Cache-Control': 'no-store'})(scope, receive, send)
        if path in {'/', OWNER, STAFF} and method in {'GET', 'HEAD'}:
            return await RedirectResponse((OWNER if path == '/' else path) + '/')(scope, receive, send)
        if method == 'POST' and any(path == prefix + action for prefix in (OWNER, STAFF) for action in HISTORICAL_ACTIONS):
            return await JSONResponse({'detail': 'This historical workflow requires its verified school source and is unavailable in the fictional preview.'}, 409)(scope, receive, send)
        if path.startswith(STAFF + '/'):
            return await staff(scope, receive, send)
        if not path.startswith(OWNER + '/'):
            return await JSONResponse({'detail': 'Not found.'}, 404)(scope, receive, send)
        inner = path[len(OWNER):]
        if method not in {'GET', 'HEAD', 'OPTIONS'}:
            tokens = [value for key, value in headers if key == b'x-csrf-token']
            if not origin or len(tokens) != 1 or not secrets.compare_digest(tokens[0], csrf.encode()):
                return await JSONResponse({'detail': 'Reload the demo to confirm the request.'}, 403)(scope, receive, send)
        if inner == '/api/portal-session' and method == 'GET':
            return await JSONResponse({'csrfToken': csrf}, headers={'Cache-Control': 'no-store'})(scope, receive, send)
        rewritten = [(k, v) for k, v in headers if k not in {b'host', b'origin', b'x-school-bridge'}]
        rewritten.extend([(b'host', b'localhost:8798'), (b'x-school-bridge', secret.encode())])
        if origin:
            rewritten.append((b'origin', b'http://localhost:8798'))
        await owner({**scope, 'path': inner, 'raw_path': inner.encode(), 'headers': rewritten}, receive, send)
    return app


def main():
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', action='store_true', help='Bind to the Compose container interface.')
    options = parser.parse_args()
    if not all((TRANSLATED / directory / 'index.html').is_file() for directory in ('dist', 'dist-staff')):
        parser.error('Build both owner and staff bundles first.')

    if options.container:
        storage = Path('/tmp/school-demo')
        storage.mkdir(mode=0o700, exist_ok=True)
        ready = storage / 'seed-ready'
        if not ready.exists() and (storage / 'domain.sqlite3').exists():
            raise RuntimeError('Demo initialization was interrupted. Run docker compose down -v to reset the fictional volume.')
        app = applications(TRANSLATED, TRANSLATED, storage, initialize=not ready.exists())
        ready.touch(mode=0o600)
        uvicorn.run(app, host='0.0.0.0', port=5261, access_log=False, proxy_headers=False, lifespan='off', loop='asyncio')
    else:
        with TemporaryDirectory(prefix='school-v30-preview-', dir='/tmp') as folder:
            app = applications(TRANSLATED, TRANSLATED, Path(folder).resolve())
            uvicorn.run(app, host='127.0.0.1', port=PUBLIC_PORT, access_log=False, proxy_headers=False, lifespan='off', loop='asyncio')

if __name__ == '__main__':
    main()
