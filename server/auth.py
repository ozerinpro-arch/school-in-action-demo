"""Opaque in-memory DEMO sessions. Role selection is intentionally public.

This is a local demo convenience, not identity verification or production auth.
"""
import secrets
import threading
import time

from fastapi import Depends, HTTPException, Request

COOKIE_NAME = "shkola_demo_session"
SESSION_SECONDS = 8 * 60 * 60
PROFILES = {
    "director": {"name": "Avery Morgan", "title": "Director", "initials": "AM", "userId": "d1"},
    "teacher": {"name": "Maya Brooks", "title": "Teacher", "initials": "MB", "userId": "t1"},
    "student": {"name": "Jamie Lane", "title": "Student", "initials": "JL", "userId": "s1"},
}
_sessions: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def create_session(role: str, old_token: str | None = None, teacher_id: str | None = None) -> tuple[str, dict]:
    now = time.monotonic()
    token = secrets.token_urlsafe(32)
    profile = {"role": role, **PROFILES[role]}
    alternate = {
        "t2": ("Owen Reed", "OR"),
        "t3": ("Nora Finch", "NF"),
        "t4": ("Alex Vale", "AV"),
    }
    if role == "teacher" and teacher_id in alternate:
        name, initials = alternate[teacher_id]
        profile.update(name=name, initials=initials, userId=teacher_id)
    with _lock:
        for expired in [key for key, (end, _) in _sessions.items() if end <= now]:
            del _sessions[expired]
        if old_token:
            _sessions.pop(old_token, None)
        # Bound memory even when a local client repeatedly creates sessions.
        if len(_sessions) >= 512:
            _sessions.pop(next(iter(_sessions)))
        _sessions[token] = (now + SESSION_SECONDS, profile)
    return token, profile.copy()


def session_profile(request: Request) -> dict:
    token = request.cookies.get(COOKIE_NAME, "")
    with _lock:
        session = _sessions.get(token)
        if not session or session[0] <= time.monotonic():
            _sessions.pop(token, None)
            raise HTTPException(401, "Choose a demo role to continue.")
        return session[1].copy()


def require_roles(*roles: str):
    """Dependency factory: Depends(require_roles('director', 'admin'))."""
    def checked(profile: dict = Depends(session_profile)) -> dict:
        if profile["role"] not in roles:
            raise HTTPException(403, "This action is unavailable for your role.")
        return profile
    return checked
