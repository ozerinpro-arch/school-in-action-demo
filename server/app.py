"""Local English demo. Role selection represents fictional users."""
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .auth import COOKIE_NAME, SESSION_SECONDS, create_session, require_roles, session_profile
from .boundary import LocalBoundaryMiddleware
from .clubs import project_clubs, router as clubs_router
from .db import edit_state, read_state, reset_state

app = FastAPI(title="School in Action demo", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LocalBoundaryMiddleware)
app.include_router(clubs_router)
director = require_roles("director")
teacher = require_roles("teacher")
staff = require_roles("director", "teacher")
student = require_roles("student")
Day = Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse({"detail": "Check the required fields and their values."}, status_code=422)


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Session(Input):
    role: Literal["director", "teacher", "student"]
    teacherId: Literal["t1", "t2", "t3", "t4"] | None = None

    @model_validator(mode="after")
    def teacher_only(self):
        if self.teacherId and self.role != "teacher":
            raise ValueError("Choose a teacher role.")
        return self


class Lesson(Input):
    day: Day
    start: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    end: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    className: Literal["Grade 7A", "Grade 7B"]
    teacherId: str = Field(max_length=40)
    room: str = Field(min_length=1, max_length=40)
    topic: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def interval(self):
        if time.fromisoformat(self.start) >= time.fromisoformat(self.end):
            raise ValueError("End time must follow start time.")
        return self


class Substitution(Input):
    lessonId: str = Field(max_length=40)
    reason: str = Field(min_length=1, max_length=500)


class Approval(Input):
    teacherId: str = Field(max_length=40)


class Assignment(Input):
    title: str = Field(min_length=1, max_length=120)
    instructions: str = Field(min_length=1, max_length=2000)
    studentId: str = Field(max_length=40)
    subject: str = Field(max_length=60)
    dueDate: date


class Submission(Input):
    answer: str = Field(min_length=1, max_length=5000)


class Review(Input):
    score: int = Field(ge=0, le=100, strict=True)
    feedback: str = Field(min_length=1, max_length=1500)


class Material(Input):
    lessonId: str = Field(max_length=40)
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=4000)


class Task(Input):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(max_length=1000)


class TaskStatus(Input):
    status: Literal["open", "in progress", "done"]


def find(state, collection, identity):
    item = next((item for item in state[collection] if item["id"] == identity), None)
    if item is None:
        raise HTTPException(404, "Record not found.")
    return item


def new_id(prefix):
    return f"{prefix}_{uuid4().hex[:12]}"


def activity(state, title, profile, *audience):
    state["activity"].insert(0, {
        "id": new_id("event"), "title": title, "actor": profile["name"],
        "at": datetime.now(timezone.utc).isoformat(), "audience": [profile["userId"], *audience],
        "readBy": [profile["userId"]],
    })
    del state["activity"][250:]


def conflicts(schedule, lesson, *, class_check=True):
    for other in schedule:
        if other["id"] == lesson["id"] or other["day"] != lesson["day"]:
            continue
        if lesson["start"] >= other["end"] or other["start"] >= lesson["end"]:
            continue
        if other["teacherId"] == lesson["teacherId"]:
            return f"{other['teacherName']} already teaches {other['className']} at this time."
        if other["room"].casefold() == lesson["room"].casefold():
            return f"{other['room']} is already booked at this time."
        if class_check and other["className"] == lesson["className"]:
            return f"{other['className']} already has a lesson at this time."
    return None


def candidates(state, lesson, absent_id):
    options = []
    for person in state["teachers"]:
        if person["id"] == absent_id or person["subject"] != lesson["subject"]:
            continue
        room = person.get("requiredRoom", lesson["room"])
        conflict = conflicts(state["schedule"], {**lesson, "teacherId": person["id"], "room": room}, class_check=False)
        options.append({"id": person["id"], "name": person["name"], "room": room, "conflict": conflict})
    return sorted(options, key=lambda option: bool(option["conflict"]))


def assignment_targets(state, user):
    return {(lesson["className"], lesson["subject"]) for lesson in state["schedule"] if lesson["teacherId"] == user}


def project(state, profile):
    role, user = profile["role"], profile["userId"]
    lessons, students = state["schedule"], state["students"]
    assignments, replacements = state["assignments"], state["replacements"]
    materials, tasks = state["materials"], state["tasks"]
    targets = assignment_targets(state, user)
    if role == "teacher":
        replacements = [item for item in replacements if user in (item["absentTeacherId"], item["teacherId"])]
        related = {item["lessonId"] for item in replacements}
        lessons = [lesson for lesson in lessons if lesson["teacherId"] == user or lesson["id"] in related]
        students = [item for item in students if any(group == item["className"] for group, _ in targets)]
        assignments = [item for item in assignments if item["teacherId"] == user]
        own_lessons = {lesson["id"] for lesson in lessons if lesson["teacherId"] == user}
        materials = [item for item in materials if item["teacherId"] == user or item["lessonId"] in own_lessons]
        tasks = [item for item in tasks if item["ownerId"] == user]
    if role == "student":
        own = find(state, "students", user)
        students = [own]
        lessons = [lesson for lesson in lessons if lesson["className"] == own["className"]]
        assignments = [item for item in assignments if item["studentId"] == user]
        lesson_ids = {lesson["id"] for lesson in lessons}
        materials = [item for item in materials if item["lessonId"] in lesson_ids]
        replacements, tasks = [], []
    replacements = [
        {**item, "lesson": find(state, "schedule", item["lessonId"]),
         "candidates": candidates(state, find(state, "schedule", item["lessonId"]), item["absentTeacherId"])
         if item["status"] == "pending" and role == "director" else []}
        for item in replacements
    ]
    return {
        "role": role, "profile": profile, "schedule": lessons, "students": students,
        "teachers": state["teachers"] if role == "director" else [],
        "assignments": assignments, "replacements": replacements, "materials": materials, "tasks": tasks,
        "documents": state["documents"] if role == "director" else [],
        "activity": [
            {key: value for key, value in item.items() if key not in {"audience", "readBy"}}
            | {"unread": user not in item["readBy"]}
            for item in state["activity"] if role == "director" or user in item["audience"]
        ],
        "assignmentTargets": [{"className": group, "subject": subject} for group, subject in sorted(targets)],
        "clubs": project_clubs(state, profile),
    }


@app.get("/api/health")
def health():
    read_state()
    return {"status": "ok", "demo": True}


@app.post("/api/demo/session")
def select_role(body: Session, request: Request, response: Response):
    token, profile = create_session(body.role, request.cookies.get(COOKIE_NAME), body.teacherId)
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True, samesite="strict", path="/api")
    return profile


@app.post("/api/demo/reset")
def reset_demo(profile=Depends(director)):
    reset_state()
    return {"ok": True}


@app.get("/api/state")
def get_state(profile=Depends(session_profile)):
    return project(read_state(), profile)


@app.post("/api/schedule")
@app.patch("/api/schedule/{lesson_id}")
def save_lesson(body: Lesson, lesson_id: str | None = None, profile=Depends(director)):
    with edit_state() as state:
        person = find(state, "teachers", body.teacherId)
        if lesson_id:
            previous = find(state, "schedule", lesson_id)
            if any(item["lessonId"] == lesson_id for item in state["replacements"]):
                raise HTTPException(409, "This lesson has a substitution record.")
            if previous["className"] != body.className and any(item["lessonId"] == lesson_id for item in state["materials"]):
                raise HTTPException(409, "A lesson with shared materials must keep its class.")
        lesson = body.model_dump() | {"id": lesson_id or new_id("lesson"), "teacherName": person["name"],
                                      "subject": person["subject"], "status": "normal"}
        conflict = conflicts(state["schedule"], lesson)
        if conflict:
            raise HTTPException(409, conflict)
        if lesson_id:
            previous.update(lesson)
        else:
            state["schedule"].append(lesson)
        activity(state, f"Saved {lesson['subject']} for {lesson['className']}", profile, person["id"])
    return lesson


@app.post("/api/replacements")
def request_substitution(body: Substitution, profile=Depends(staff)):
    with edit_state() as state:
        lesson = find(state, "schedule", body.lessonId)
        existing = next((item for item in state["replacements"] if item["lessonId"] == lesson["id"]), None)
        if profile["role"] == "teacher" and profile["userId"] != (existing or {}).get("absentTeacherId", lesson["teacherId"]):
            raise HTTPException(403, "You can request a substitution for your own lesson.")
        if existing:
            return existing
        item = {"id": new_id("sub"), "lessonId": lesson["id"], "reason": body.reason,
                "absentTeacherId": lesson["teacherId"], "teacherId": None, "status": "pending"}
        state["replacements"].append(item)
        activity(state, f"Substitution requested for {lesson['subject']} · {lesson['className']}", profile, lesson["teacherId"])
        return item


@app.post("/api/replacements/{identity}/approve")
def approve_substitution(identity: str, body: Approval, profile=Depends(director)):
    with edit_state() as state:
        item = find(state, "replacements", identity)
        if item["status"] != "pending":
            if item["teacherId"] == body.teacherId:
                return item
            raise HTTPException(409, "This substitution has already been approved.")
        lesson = find(state, "schedule", item["lessonId"])
        option = next((entry for entry in candidates(state, lesson, item["absentTeacherId"]) if entry["id"] == body.teacherId), None)
        if not option or option["conflict"]:
            raise HTTPException(409, option["conflict"] if option else "Choose a teacher who can cover this subject.")
        item.update(teacherId=option["id"], status="approved")
        lesson.update(teacherId=option["id"], teacherName=option["name"], room=option["room"], status="replacement")
        audience = [p["id"] for p in state["students"] if p["className"] == lesson["className"]]
        activity(state, f"{option['name']} will cover {lesson['subject']} · {lesson['className']}",
                 profile, item["absentTeacherId"], option["id"], *audience)
        return item


@app.post("/api/lessons/{identity}/complete")
def complete_lesson(identity: str, profile=Depends(staff)):
    with edit_state() as state:
        lesson = find(state, "schedule", identity)
        if profile["role"] == "teacher" and lesson["teacherId"] != profile["userId"]:
            raise HTTPException(403, "The assigned teacher can complete this lesson.")
        item = next((entry for entry in state["replacements"] if entry["lessonId"] == identity), None)
        if not item or item["status"] == "pending":
            raise HTTPException(409, "Approve the substitution first.")
        if item["status"] != "completed":
            item["status"] = lesson["status"] = "completed"
            activity(state, f"Substitution completed for {lesson['subject']} · {lesson['className']}",
                     profile, item["absentTeacherId"], lesson["teacherId"])
        return lesson


@app.post("/api/assignments")
def publish_assignment(body: Assignment, profile=Depends(teacher)):
    with edit_state() as state:
        person = find(state, "students", body.studentId)
        if (person["className"], body.subject) not in assignment_targets(state, profile["userId"]):
            raise HTTPException(403, "Choose a student and subject from your own classes.")
        item = body.model_dump(mode="json") | {"id": new_id("assignment"), "teacherId": profile["userId"],
                                               "status": "open", "answer": "", "score": None, "feedback": ""}
        state["assignments"].append(item)
        activity(state, f"Assignment published · {body.title}", profile, body.studentId)
        return item


@app.post("/api/assignments/{identity}/submit")
def submit_assignment(identity: str, body: Submission, profile=Depends(student)):
    with edit_state() as state:
        item = find(state, "assignments", identity)
        if item["studentId"] != profile["userId"]:
            raise HTTPException(403, "You can submit your own assignments.")
        if item["status"] == "reviewed":
            raise HTTPException(409, "This assignment has already been reviewed.")
        if item["status"] != "submitted" or item["answer"] != body.answer:
            item.update(status="submitted", answer=body.answer)
            activity(state, f"Answer submitted · {item['title']}", profile, item["teacherId"])
        return item


@app.post("/api/assignments/{identity}/review")
def review_assignment(identity: str, body: Review, profile=Depends(staff)):
    with edit_state() as state:
        item = find(state, "assignments", identity)
        if profile["role"] == "teacher" and item["teacherId"] != profile["userId"]:
            raise HTTPException(403, "You can review the assignments you issued.")
        if item["status"] == "open":
            raise HTTPException(409, "Wait for the student to submit an answer.")
        if item["status"] != "reviewed" or item["score"] != body.score or item["feedback"] != body.feedback:
            item.update(status="reviewed", score=body.score, feedback=body.feedback)
            activity(state, f"Feedback posted · {item['title']}", profile, item["studentId"])
        return item


@app.post("/api/materials")
def share_material(body: Material, profile=Depends(teacher)):
    with edit_state() as state:
        lesson = find(state, "schedule", body.lessonId)
        if lesson["teacherId"] != profile["userId"]:
            raise HTTPException(403, "Choose one of your own lessons.")
        item = body.model_dump() | {"id": new_id("material"), "teacherId": profile["userId"]}
        state["materials"].append(item)
        audience = [person["id"] for person in state["students"] if person["className"] == lesson["className"]]
        activity(state, f"Lesson material shared · {body.title}", profile, *audience)
        return item


@app.post("/api/tasks")
def create_task(body: Task, profile=Depends(staff)):
    with edit_state() as state:
        item = body.model_dump() | {"id": new_id("task"), "status": "open",
                                    "ownerId": profile["userId"], "owner": profile["name"]}
        state["tasks"].append(item)
        return item


@app.post("/api/tasks/{identity}/status")
def update_task(identity: str, body: TaskStatus, profile=Depends(staff)):
    with edit_state() as state:
        item = find(state, "tasks", identity)
        if profile["role"] == "teacher" and item["ownerId"] != profile["userId"]:
            raise HTTPException(403, "You can update your own tasks.")
        item["status"] = body.status
        return item


@app.post("/api/documents/{identity}/approve")
def approve_document(identity: str, profile=Depends(director)):
    with edit_state() as state:
        item = find(state, "documents", identity)
        if item["status"] != "approved":
            item["status"] = "approved"
            activity(state, f"Document approved · {item['title']}", profile)
        return item


@app.post("/api/activity/read")
def mark_activity_read(profile=Depends(session_profile)):
    with edit_state() as state:
        user = profile["userId"]
        for item in state["activity"]:
            if (profile["role"] == "director" or user in item["audience"]) and user not in item["readBy"]:
                item["readBy"].append(user)
    return {"ok": True}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
def unknown_api(path: str):
    raise HTTPException(404, "Demo endpoint not found.")


app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent / "dist", html=True), name="ui")
