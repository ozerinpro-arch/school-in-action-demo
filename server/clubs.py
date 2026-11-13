"""Club enrollment and fictional charges for the local demo."""

from collections import Counter
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .auth import require_roles
from .db import edit_state, read_state


router = APIRouter(prefix="/api/clubs", tags=["clubs"])
director = require_roles("director")
enrollment_actor = require_roles("director", "student")
RecordId = Annotated[str, Field(min_length=1, max_length=80)]
Cents = Annotated[int, Field(ge=0, le=1_000_000)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


class ProgramInput(Input):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=1000)]
    meetingTime: Annotated[str, Field(min_length=1, max_length=120)]
    capacity: Annotated[int, Field(ge=1, le=100)]
    feeCents: Cents


class EnrollmentInput(Input):
    studentId: RecordId | None = None
    status: Literal["enrolled", "withdrawn"]


class ChargeInput(Input):
    programId: RecordId
    studentId: RecordId
    period: Annotated[str, Field(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")]


class CreateChargeInput(ChargeInput):
    expectedAmountCents: Cents


def project_clubs(state, profile):
    data = state["clubs"]
    counts = Counter(item["programId"] for item in data["enrollments"] if item["status"] == "enrolled")
    programs = [{**program, "enrolledCount": counts[program["id"]]} for program in data["programs"]]
    names = {program["id"]: program["name"] for program in programs}
    charges = [
        {"programName": names.get(charge["programId"], "Club"), **charge}
        for charge in data["charges"]
    ]
    if profile["role"] == "director":
        return {**data, "programs": programs, "charges": charges}

    active_programs = [program for program in programs if not program["archived"]]
    if profile["role"] == "student":
        student_id = profile["userId"]
        return {
            "programs": active_programs,
            "enrollments": [item for item in data["enrollments"] if item["studentId"] == student_id],
            "charges": [item for item in charges if item["studentId"] == student_id],
        }

    return {
        "programs": [{key: value for key, value in item.items() if key != "feeCents"} for item in active_programs],
        "enrollments": [],
        "charges": [],
    }


def find_record(records, identity, label):
    record = next((item for item in records if item["id"] == identity), None)
    if record is None:
        raise HTTPException(404, f"{label} not found.")
    return record


def program_enrollments(data, program_id):
    return [item for item in data["enrollments"] if item["programId"] == program_id]


def enrollment_count(enrollments):
    return sum(item["status"] == "enrolled" for item in enrollments)


@router.post("/programs")
def create_program(body: ProgramInput, profile=Depends(director)):
    with edit_state() as state:
        program = {"id": f"club-{uuid4().hex}", **body.model_dump(), "archived": False}
        state["clubs"]["programs"].append(program)
        return program


@router.patch("/programs/{program_id}")
def update_program(program_id: str, body: ProgramInput, profile=Depends(director)):
    with edit_state() as state:
        data = state["clubs"]
        program = find_record(data["programs"], program_id, "Club")
        if body.capacity < enrollment_count(program_enrollments(data, program_id)):
            raise HTTPException(409, "Capacity cannot be lower than current enrollment.")
        program.update(body.model_dump())
        return program


@router.post("/programs/{program_id}/enrollments")
def set_enrollment(program_id: str, body: EnrollmentInput, profile=Depends(enrollment_actor)):
    student_id = body.studentId
    if profile["role"] == "student":
        if student_id is not None and student_id != profile["userId"]:
            raise HTTPException(403, "You can change only your own enrollment.")
        student_id = profile["userId"]
    if student_id is None:
        raise HTTPException(422, "Choose a student.")

    with edit_state() as state:
        find_record(state["students"], student_id, "Student")
        data = state["clubs"]
        program = find_record(data["programs"], program_id, "Club")
        enrollments = program_enrollments(data, program_id)
        enrollment = next((item for item in enrollments if item["studentId"] == student_id), None)
        if enrollment is not None and enrollment["status"] == body.status:
            return enrollment
        if body.status == "enrolled":
            if program["archived"]:
                raise HTTPException(409, "This club is archived.")
            if enrollment_count(enrollments) >= program["capacity"]:
                raise HTTPException(409, "This club is full.")
        elif enrollment is None:
            raise HTTPException(404, "Enrollment not found.")

        if enrollment is None:
            enrollment = {"programId": program_id, "studentId": student_id, "status": body.status}
            data["enrollments"].append(enrollment)
        else:
            enrollment["status"] = body.status
        return enrollment


@router.post("/programs/{program_id}/{action}")
def set_program_status(program_id: str, action: Literal["archive", "restore"], profile=Depends(director)):
    with edit_state() as state:
        data = state["clubs"]
        program = find_record(data["programs"], program_id, "Club")
        if action == "restore" and program["capacity"] < enrollment_count(program_enrollments(data, program_id)):
            raise HTTPException(409, "Increase capacity before restoring this club.")
        program["archived"] = action == "archive"
        return program


def billable_program(state, body):
    find_record(state["students"], body.studentId, "Student")
    data = state["clubs"]
    program = find_record(data["programs"], body.programId, "Club")
    if program["archived"]:
        raise HTTPException(409, "This club is archived.")
    if not any(item["studentId"] == body.studentId and item["status"] == "enrolled"
               for item in program_enrollments(data, body.programId)):
        raise HTTPException(409, "The student must be enrolled in this club.")
    if program["feeCents"] == 0:
        raise HTTPException(409, "Free clubs do not have charges.")
    return program


@router.post("/charges/preview")
def preview_charge(body: ChargeInput, profile=Depends(director)):
    return {"amountCents": billable_program(read_state(), body)["feeCents"]}


@router.post("/charges")
def create_charge(body: CreateChargeInput, profile=Depends(director)):
    with edit_state() as state:
        program = billable_program(state, body)
        amount = program["feeCents"]
        if amount != body.expectedAmountCents:
            raise HTTPException(409, "The club fee changed. Preview the charge again.")
        charges = state["clubs"]["charges"]
        if any(item["programId"] == body.programId and item["studentId"] == body.studentId
               and item["period"] == body.period and item["status"] != "cancelled" for item in charges):
            raise HTTPException(409, "A charge already exists for this student, club and month.")
        charge = {
            "id": f"charge-{uuid4().hex}",
            **body.model_dump(exclude={"expectedAmountCents"}),
            "programName": program["name"],
            "amountCents": amount,
            "status": "draft",
        }
        charges.append(charge)
        return charge


@router.post("/charges/{charge_id}/{action}")
def set_charge_status(charge_id: str, action: Literal["confirm", "cancel"], profile=Depends(director)):
    with edit_state() as state:
        charge = find_record(state["clubs"]["charges"], charge_id, "Charge")
        status = "confirmed" if action == "confirm" else "cancelled"
        if charge["status"] == "cancelled" and status != "cancelled":
            raise HTTPException(409, "A cancelled charge cannot be confirmed.")
        charge["status"] = status
        return charge
