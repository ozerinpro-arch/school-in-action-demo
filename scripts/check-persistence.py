"""Check a disposable Compose project before and after a container restart."""
import argparse
from http.cookiejar import CookieJar
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPCookieProcessor

BASE = "http://127.0.0.1:5188"
client = build_opener(HTTPCookieProcessor(CookieJar()))


def request(path, body=None, *, headers=None, expected=200):
    headers = dict(headers or {})
    if body is not None:
        headers["Content-Type"] = "application/json"
    message = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with client.open(message, timeout=5) as response:
            status, raw = response.status, response.read()
    except HTTPError as error:
        status, raw = error.code, error.read()
    if status != expected:
        raise AssertionError(f"{path}: expected HTTP {expected}, received {status}")
    return json.loads(raw)


def login(role, teacher_id=None):
    request("/api/demo/session", {"role": role, **({"teacherId": teacher_id} if teacher_id else {})})


def wait_for_health():
    for _ in range(30):
        try:
            if request("/api/health") == {"status": "ok", "demo": True}:
                return
        except (URLError, OSError, AssertionError):
            time.sleep(1)
    raise RuntimeError("Demo failed to become healthy.")


def write_marker(file):
    request("/api/state", expected=401)
    request("/api/health", headers={"Host": "example.invalid"}, expected=403)
    request("/api/demo/session", {"role": "director"}, headers={"Origin": "https://example.invalid"}, expected=403)
    login("student")
    request("/api/demo/reset", {}, expected=403)
    request("/api/assignments", {
        "title": "Private role check", "instructions": "Role boundary", "studentId": "s1",
        "subject": "Biology", "dueDate": "2026-11-20",
    }, expected=403)
    view = request("/api/state")
    assert all(item["className"] == "Grade 7A" for item in view["schedule"])
    assert not view["documents"] and not view["teachers"]
    login("teacher", "t3")
    assert request("/api/state")["profile"]["name"] == "Nora Finch"
    login("director")
    item = request("/api/tasks", {"title": "Persistence marker", "description": "Fictional CI record"})
    item = request(f"/api/tasks/{item['id']}/status", {"status": "done"})
    file.write_text(json.dumps(item), encoding="utf-8")
    print("Role boundaries and fictional persistence marker verified.")


def verify_marker(file):
    request("/api/state", expected=401)
    login("director")
    original = json.loads(file.read_text(encoding="utf-8"))
    saved = next(item for item in request("/api/state")["tasks"] if item["id"] == original["id"])
    assert saved == original and saved["status"] == "done"
    print("Fictional record retained after the container restart.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["write", "verify"])
    parser.add_argument("marker", type=Path)
    options = parser.parse_args()
    wait_for_health()
    (write_marker if options.phase == "write" else verify_marker)(options.marker)
