"""Atomic SQLite storage for the fictional demo."""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .seed import seed_state

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "demo.sqlite3"


def database_path() -> Path:
    return Path(os.environ.get("SHKOLA_DB_PATH", str(DEFAULT_DB_PATH))).resolve()


def connect() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    connection.execute("PRAGMA busy_timeout=15000")
    connection.execute("CREATE TABLE IF NOT EXISTS demo_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)")
    if connection.execute("SELECT 1 FROM demo_state WHERE id=1").fetchone() is None:
        initial = json.dumps(seed_state())
        connection.execute("INSERT OR IGNORE INTO demo_state(id,payload) VALUES(1,?)", (initial,))
        connection.commit()
    return connection


def read_state() -> dict:
    connection = connect()
    try:
        state = json.loads(connection.execute("SELECT payload FROM demo_state WHERE id=1").fetchone()[0])
        return state
    finally:
        connection.close()


@contextmanager
def edit_state():
    """Yield mutable state under an exclusive transaction; exceptions roll back."""
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        state = json.loads(connection.execute("SELECT payload FROM demo_state WHERE id=1").fetchone()[0])
        yield state
        connection.execute("UPDATE demo_state SET payload=? WHERE id=1", (json.dumps(state, ensure_ascii=False),))
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def reset_state() -> dict:
    with edit_state() as state:
        state.clear()
        state.update(seed_state())
    return state
