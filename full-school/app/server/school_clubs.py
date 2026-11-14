"""School-entered programmes, enrolments and internal charge drafts. No banking/tax documents."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import re
import sqlite3
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from .auth import require_roles
from .db import database_path, edit_state
from .workspace import empty_school_state, school_workspace, verify_school_state

router = APIRouter(prefix='/api/school/clubs')
MAX_RECORDS = 10000
MAX_UNIT_KOPEKS = 100_000_000
MAX_TOTAL_KOPEKS = 10_000_000_000


def actor(profile=Depends(require_roles('director', 'admin', 'accountant'))):
    if not school_workspace():
        raise HTTPException(404, 'Раздел не найден')
    return profile


def read_school_state():
    path = database_path()
    if not path.exists():
        return empty_school_state()
    with closing(sqlite3.connect('file:'+str(path)+'?mode=ro', uri=True)) as connection:
        row = connection.execute('SELECT payload FROM demo_state WHERE id=1').fetchone()
    state = json.loads(row[0]) if row else empty_school_state()
    verify_school_state(state)
    return state


def store(state):
    return state.get('_schoolClubs', {'revision':0, 'programs':[], 'enrollments':[], 'charges':[], 'history':[]})


def students(state):
    return state.get('_schoolOps', {}).get('records', {}).get('students', [])


def current(data, revision):
    if data['revision'] != revision:
        raise HTTPException(409, 'Данные уже изменились. Обновите их и проверьте введённые значения.')


def found(items, identity, active=False):
    record = next((x for x in items if x['id']==identity), None)
    if not record or (active and record.get('archived')):
        raise HTTPException(404, 'Запись не найдена или находится в архиве')
    return record


def change(state, data, profile, action, record):
    data['revision'] += 1
    data['history'].insert(0, {'id':uuid4().hex, 'at':datetime.now(timezone.utc).isoformat(),
        'actor':profile['name'], 'action':action, 'recordId':record['id'], 'title':record.get('title','Начисление' if 'amountKopeks' in record else 'Участник программы')})
    del data['history'][1000:]
    state['_schoolClubs'] = data
    return {'revision':data['revision'], 'record':deepcopy(record)}


def metadata(prefix):
    now = datetime.now(timezone.utc).isoformat()
    return {'id':prefix+'-'+uuid4().hex, 'archived':False, 'createdAt':now, 'updatedAt':now}


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, strict=True)

    @field_validator('*', mode='before')
    @classmethod
    def controls(cls, value):
        if isinstance(value,str) and any(ord(char)<32 and char not in '\n\t' for char in value):
            raise ValueError('Недопустимые управляющие символы')
        return value


class Revision(StrictBody):
    expectedRevision: Annotated[StrictInt, Field(ge=0)]


class Program(StrictBody):
    title: Annotated[str, Field(min_length=1,max_length=160)]
    teacherName: Annotated[str, Field(max_length=160)] = ''
    scheduleNote: Annotated[str, Field(max_length=500)] = ''
    room: Annotated[str, Field(max_length=80)] = ''
    description: Annotated[str, Field(max_length=10000)] = ''
    feeKopeks: Annotated[StrictInt, Field(ge=0,le=MAX_UNIT_KOPEKS)] | None = None
    billingUnit: Literal['month','lesson'] = 'month'


class ProgramWrite(Revision):
    record: Program


class Enrollment(StrictBody):
    programId: Annotated[str, Field(min_length=1,max_length=100)]
    studentId: Annotated[str, Field(min_length=1,max_length=100)]
    status: Literal['active','paused','completed'] = 'active'
    note: Annotated[str, Field(max_length=2000)] = ''


class EnrollmentWrite(Revision):
    record: Enrollment


class ChargeInput(Revision):
    enrollmentId: Annotated[str, Field(min_length=1,max_length=100)]
    period: Annotated[str, Field(pattern=r'^(20\d{2}|2100)-(0[1-9]|1[0-2])$')]
    quantity: Annotated[StrictInt, Field(ge=1,le=366)] = 1


class ChargeWrite(ChargeInput):
    expectedHash: Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')]


@router.get('')
def overview(profile=Depends(actor)):
    state = read_school_state()
    data = deepcopy(store(state))
    data['students'] = [{'id':x['id'],'name':x['name'],'className':x['className'],'archived':x.get('archived',False)} for x in students(state)]
    data['internalRecordsOnly'] = True
    return data


@router.post('/programs')
def create_program(body: ProgramWrite, profile=Depends(actor)):
    with edit_state() as state:
        data = store(state); current(data,body.expectedRevision)
        if len(data['programs']) >= MAX_RECORDS: raise HTTPException(422,'Достигнут лимит программ')
        item = {**metadata('program'),**body.record.model_dump()}
        data['programs'].append(item)
        return change(state,data,profile,'program_created',item)


@router.patch('/programs/{identity}')
def update_program(identity: str, body: ProgramWrite, profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);current(data,body.expectedRevision);item=found(data['programs'],identity,True)
        item.update(body.record.model_dump());item['updatedAt']=datetime.now(timezone.utc).isoformat()
        return change(state,data,profile,'program_updated',item)



def validate_enrollment(state,data,value,own_id=None):
    found(data['programs'],value.programId,True)
    student=found(students(state),value.studentId,True)
    if any(x['id']!=own_id and not x.get('archived') and x['programId']==value.programId and x['studentId']==value.studentId for x in data['enrollments']):
        raise HTTPException(409,'Этот ученик уже записан на программу')
    return student


@router.post('/enrollments')
def create_enrollment(body:EnrollmentWrite,profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);current(data,body.expectedRevision)
        if len(data['enrollments'])>=MAX_RECORDS:raise HTTPException(422,'Достигнут лимит участников')
        student=validate_enrollment(state,data,body.record)
        item={**metadata('enrollment'),**body.record.model_dump(),'studentName':student['name'],'className':student['className']}
        data['enrollments'].append(item)
        return change(state,data,profile,'enrollment_created',item)


@router.patch('/enrollments/{identity}')
def update_enrollment(identity:str,body:EnrollmentWrite,profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);current(data,body.expectedRevision);item=found(data['enrollments'],identity,True)
        # Stable participant/program identity keeps historical charges attached to the original relation.
        if item['studentId']!=body.record.studentId or item['programId']!=body.record.programId:
            raise HTTPException(422,'Для другой программы или ученика создайте отдельную запись')
        student=validate_enrollment(state,data,body.record,identity)
        item.update(body.record.model_dump());item.update(studentName=student['name'],className=student['className'],updatedAt=datetime.now(timezone.utc).isoformat())
        return change(state,data,profile,'enrollment_updated',item)


def preview(state,data,body):
    current(data,body.expectedRevision)
    entry=found(data['enrollments'],body.enrollmentId,True)
    if entry['status']!='active':raise HTTPException(422,'Участие в программе не активно')
    program=found(data['programs'],entry['programId'],True)
    student=found(students(state),entry['studentId'],True)
    rate=program['feeKopeks']
    if rate is None:raise HTTPException(422,'Укажите подтверждённый тариф программы')
    if program['billingUnit']=='month' and body.quantity!=1:raise HTTPException(422,'Для месячного тарифа количество равно одному')
    amount=rate*body.quantity
    if amount>MAX_TOTAL_KOPEKS:raise HTTPException(422,'Сумма превышает допустимый предел')
    proposal={'enrollmentId':entry['id'],'programId':program['id'],'studentId':student['id'],
        'programTitle':program['title'],'studentName':student['name'],'className':student['className'],
        'period':body.period,'quantity':body.quantity,'billingUnit':program['billingUnit'],
        'unitAmountKopeks':rate,'amountKopeks':amount,'sourceRevision':body.expectedRevision}
    digest=hashlib.sha256(json.dumps(proposal,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'proposal':proposal,'hash':digest,'internalRecordsOnly':True}


@router.post('/charges/preview')
def preview_charge(body:ChargeInput,profile=Depends(actor)):
    state=read_school_state()
    return preview(state,store(state),body)


@router.post('/charges')
def create_charge(body:ChargeWrite,profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);result=preview(state,data,body)
        if result['hash']!=body.expectedHash:raise HTTPException(409,'Исходные сведения изменились. Повторите предварительный расчёт.')
        if len(data['charges'])>=MAX_RECORDS:raise HTTPException(422,'Достигнут лимит начислений')
        # Archiving/recreating an enrolment must not reset the billing identity.
        proposal=result['proposal']
        if any(x['period']==body.period and x['status']!='cancelled'
               and (x['enrollmentId']==body.enrollmentId
                    or (x['studentId']==proposal['studentId'] and x['programId']==proposal['programId']))
               for x in data['charges']):
            raise HTTPException(409,'Начисление за этот период уже существует')
        item={**metadata('charge'),**result['proposal'],'status':'draft'}
        data['charges'].append(item)
        return change(state,data,profile,'charge_created',item)


@router.post('/charges/{identity}/{decision}')
def decide_charge(identity:str,decision:Literal['confirm','cancel'],body:Revision,profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);current(data,body.expectedRevision);item=found(data['charges'],identity)
        if item['status']=='cancelled':raise HTTPException(409,'Начисление уже отменено')
        if decision=='confirm' and item['status']!='draft':raise HTTPException(409,'Начисление уже подтверждено')
        item['status']='confirmed' if decision=='confirm' else 'cancelled'
        item['updatedAt']=datetime.now(timezone.utc).isoformat()
        return change(state,data,profile,'charge_'+decision,item)


RECEIPT_ID = r'charge-[a-f0-9]{32}'


def receipt_fields(student_id=None):
    """Return only confirmed, immutable charge display fields."""
    if not school_workspace():
        raise HTTPException(404, 'Club charge receipts are unavailable.')
    fields = ('id', 'studentName', 'programTitle', 'className', 'period', 'quantity', 'billingUnit',
              'unitAmountKopeks', 'amountKopeks', 'updatedAt')
    return [{key: charge[key] for key in fields} for charge in store(read_school_state())['charges']
            if charge['status'] == 'confirmed' and (student_id is None or charge['studentId'] == student_id)]


def receipt_pdf(identity, *, student_id=None):
    # Never interpolate request input into a response header or resolve another student's record.
    if not re.fullmatch(RECEIPT_ID, identity):
        raise HTTPException(404, 'Club charge receipt not found.')
    charge = next((charge for charge in receipt_fields(student_id) if charge['id'] == identity), None)
    if charge is None:
        raise HTTPException(404, 'Club charge receipt not found.')

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import Paragraph
    from xml.sax.saxutils import escape

    from .school_pdf import school_pdf_font

    def money(kopeks):
        return f'{kopeks // 100:,}.{kopeks % 100:02d} RUB'

    out = BytesIO()
    page = Canvas(out, pagesize=A4, invariant=True)
    page.setTitle('School in Action - Demo club charge receipt')
    page.setAuthor('School in Action')
    font = school_pdf_font()
    blue, dark, muted = map(colors.HexColor, ('#244cff', '#202947', '#586581'))
    page.setFillColor(blue)
    page.roundRect(38, 716, 519, 88, 14, fill=1, stroke=0)
    page.setFillColor(colors.white)
    page.setFont(font, 20)
    page.drawString(56, 765, 'School in Action')
    page.setFont(font, 12)
    page.drawString(56, 738, 'Demo club charge receipt')

    rows = (
        ('Reference', charge['id']), ('Student', charge['studentName']), ('Class', charge['className']),
        ('Club', charge['programTitle']), ('Billing period', charge['period']), ('Status', 'Confirmed'),
        ('Confirmed at', datetime.fromisoformat(charge['updatedAt']).astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')),
        ('Calculation', f"{charge['quantity']} × {money(charge['unitAmountKopeks'])} per {charge['billingUnit']}"),
    )
    row_style = ParagraphStyle('receipt-value', fontName=font, fontSize=12, leading=17, textColor=dark)
    y = 683
    for label, value in rows:
        paragraph = Paragraph(escape(value), row_style)
        _, height = paragraph.wrap(348, 90)
        page.setFont(font, 10)
        page.setFillColor(muted)
        page.drawString(42, y - 13, label)
        paragraph.drawOn(page, 166, y - height)
        y -= max(37, height + 12)

    page.setFillColor(dark)
    page.setFont(font, 24)
    page.drawString(42, y - 20, money(charge['amountKopeks']))
    page.setStrokeColor(colors.HexColor('#d9e0f5'))
    page.line(42, y - 44, 553, y - 44)
    page.setFont(font, 12)
    page.drawString(42, y - 70, 'Demonstration only. No payment was processed.')
    page.setFillColor(muted)
    page.setFont(font, 10)
    page.drawString(42, y - 90, 'Internal school charge record. No amount is payable using this document.')
    page.showPage()
    page.save()
    return Response(out.getvalue(), media_type='application/pdf', headers={
        'Content-Disposition': f'attachment; filename="club-receipt-{identity}.pdf"', 'Cache-Control': 'no-store',
    })


@router.get('/charges/{identity}/receipt.pdf')
def download_receipt(identity: str, profile=Depends(actor)):
    return receipt_pdf(identity)


@router.post('/{kind}/{identity}/{action}')
def archive_record(kind: Literal['programs','enrollments'], identity:str, action:Literal['archive','restore'], body:Revision, profile=Depends(actor)):
    with edit_state() as state:
        data=store(state);current(data,body.expectedRevision);item=found(data[kind],identity)
        if kind=='enrollments' and action=='restore':
            value=Enrollment(**{key:item[key] for key in ('programId','studentId','status','note')})
            validate_enrollment(state,data,value,identity)
        item['archived']=action=='archive';item['updatedAt']=datetime.now(timezone.utc).isoformat()
        return change(state,data,profile,kind+'_'+action,item)
