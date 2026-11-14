"""School staff frontdoor for a daily brief; reads do not initialize a planner."""
from contextlib import contextmanager
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from . import daily_brief
from .db import database_path


@contextmanager
def _connection(*, write=False):
    path = database_path().resolve()
    if not path.is_file():
        raise HTTPException(503, 'Сначала подготовьте хранилище школы')
    connection = sqlite3.connect(path.as_uri() + ('?mode=rw' if write else '?mode=ro'),
                                 uri=True, timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        yield connection
        if write:
            connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _query(request, allowed):
    if any(key not in allowed or len(request.query_params.getlist(key)) != 1
           for key in request.query_params):
        raise HTTPException(422, 'Некорректные параметры брифа')


def router_for(actor, require_session):
    router = APIRouter(prefix='/api/planning/daily-brief')

    @router.get('')
    def read(request: Request, targetDate: str = Query(min_length=10, max_length=10), profile=Depends(actor)):
        _query(request, {'targetDate'})
        require_session(request, profile)
        with _connection() as connection:
            result = daily_brief.read(connection, profile, targetDate)
            require_session(request, profile)
            return result

    @router.post('/preview')
    def preview(request: Request, body: daily_brief.PreviewInput, profile=Depends(actor)):
        _query(request, set())
        require_session(request, profile)
        with _connection() as connection:
            result = daily_brief.preview(connection, profile, body)
            require_session(request, profile)
            return result

    @router.post('/save')
    def save(request: Request, body: daily_brief.SaveInput, profile=Depends(actor)):
        _query(request, set())
        require_session(request, profile)
        with _connection(write=True) as connection:
            result = daily_brief.save(connection, profile, body)
            require_session(request, profile)
            return result

    @router.post('/preflight')
    def preflight(request: Request, body: daily_brief.PreflightInput, profile=Depends(actor)):
        _query(request, set())
        require_session(request, profile)
        with _connection() as connection:
            result = daily_brief.preflight(connection, profile, body)
            require_session(request, profile)
            return result

    return router
