"""Explicit, finite-week teacher substitutions; no external delivery or full-run bypass."""
from contextlib import closing
from copy import deepcopy
from datetime import date,timedelta,datetime,timezone
import hashlib,json,sqlite3
from uuid import uuid4
from fastapi import APIRouter,Depends,HTTPException
from pydantic import Field,field_validator
from . import db,timetable,school_publications as pub,school_ops,launch_identity,staff_access
from .school_requests import Input,SafeRoute,require_bound_school,_atomic_domain
from .auth import session_profile
from .school_calendar import effective_calendar_snapshot

KEY='_schoolReplacements';LIMIT=1000
NOTICE='Замена относится только к указанной дате опубликованной недели. Внешние уведомления не отправляются.'
MANUAL='Школьные ограничения не проверены: ответственный сотрудник подтверждает замену вручную.'
class PreviewInput(Input):
 date:str=Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
 lessonId:str=Field(min_length=1,max_length=80,pattern=r'^[A-Za-z0-9_-]+$')
 expectedActiveVersion:int=Field(ge=1,le=2**31-1)
 expectedDraftRevision:int=Field(ge=0,le=2**31-1)
 replacementTeacher:str=Field(min_length=1,max_length=120)
 reason:str=Field(min_length=1,max_length=2000)
 acknowledgeUnchecked:bool=False
 @field_validator('date')
 @classmethod
 def valid_date(cls,value):date.fromisoformat(value);return value
 @field_validator('replacementTeacher','reason')
 @classmethod
 def not_blank(cls,value):
  value=school_ops.StrictInput.safe_text(value)
  if not value.strip()or any(ord(c)<32 and c not in '\n\r\t'for c in value):raise ValueError('Укажите допустимый текст')
  return value.strip()
class ApplyInput(Input):
 requestId:str=Field(pattern=r'^[A-Za-z0-9_-]{16,80}$')
 previewHash:str=Field(pattern=r'^[a-f0-9]{64}$')
 input:PreviewInput
class Versions(Input):
 expectedActiveVersion:int=Field(ge=1,le=2**31-1)
 expectedDraftRevision:int=Field(ge=1,le=2**31-1)
class PublishInput(Versions):
 requestId:str=Field(pattern=r'^[A-Za-z0-9_-]{16,80}$')
 previewHash:str=Field(pattern=r'^[a-f0-9]{64}$')
def _actor(profile,permission='schedule.manage'):
 pub._actor(profile,permission);require_bound_school(profile['schoolId'])
 if not school_ops.school_workspace():raise HTTPException(404,'Раздел недоступен')
 return profile

def _block(code,message):return {'code':code,'message':str(message)}
def _state(c):
 row=c.execute('SELECT payload FROM demo_state WHERE id=1').fetchone()if pub._exists(c,'demo_state')else None
 return json.loads(row[0])if row else {}
def _ns(state,school):
 root=state.get(KEY,{'version':1,'schools':{}})
 if not isinstance(root,dict)or root.get('version')!=1 or not isinstance(root.get('schools'),dict):raise HTTPException(409,'История замен требует проверки')
 return root['schools'].get(school,{'records':{},'receipts':{}})
def _put(state,school,ns):
 root=state.setdefault(KEY,{'version':1,'schools':{}});root['schools'][school]=ns
 if len(pub._json(root).encode())>8*1024*1024:raise HTTPException(429,'Достигнут лимит истории замен')
def _binding(profile):return {k:deepcopy(profile[k])for k in ('userId','membershipId','membershipRevision','schoolId','role','permissions','membershipVerified','identitySource','teacherRefs','calendarTeacherIds')if k in profile}|({'staffRole':profile['staffRole']}if profile.get('staffRole')else{})
def _public_record(r):return {k:deepcopy(r[k])for k in ('id','date','lessonId','before','after','status','draftRevision','publishedVersion','createdAt','reason','validationMode')}
def _receipt(ns,request,fp,profile):
 old=ns['receipts'].get(request)
 if old:
  if old['fingerprint']!=fp or old['actor']!=profile['membershipId']:raise HTTPException(409,'Идентификатор уже использован другим действием или сотрудником')
  return deepcopy(old['result'])
 return None
def _recover(request,fp,profile,permission='schedule.manage'):
 c=pub._read_connection()
 if c is None:raise HTTPException(409,'Сначала нужна опубликованная школьная неделя')
 try:
  if not pub._exists(c,'demo_state')or not pub._exists(c,'school_publications'):raise HTTPException(409,'Сначала нужна опубликованная школьная неделя')
  c.execute('BEGIN');result=_receipt(_ns(_state(c),profile['schoolId']),request,fp,profile);_actor(profile,permission);return result
 finally:c.close()
def _save_receipt(ns,request,fp,profile,result):
 if len(ns['receipts'])>=2*LIMIT:raise HTTPException(429,'Достигнут лимит квитанций замен')
 ns['receipts'][request]={'fingerprint':fp,'actor':profile['membershipId'],'result':deepcopy(result)}
def _draft(c):return timetable._load(c)if pub._exists(c,'timetable_draft')else timetable._empty()
def _grid(rows):return pub._canonical_grid(rows)
def _teacher_options(c,active):
 names={n for row in(active or{}).get('lessons',[])for n in row.get('teachers',[])if isinstance(n,str)and n.strip()}
 for actor in staff_access.list_respondents(active['schoolId']):
  if actor.get('staffRole')=='teacher'and staff_access.membership_status(actor)=='current':names.update(ref for ref in actor.get('teacherRefs',[])if isinstance(ref,str)and ref.strip())
 for row in _state(c).get('_schoolOps',{}).get('records',{}).get('teacherProfiles',[]):
  if isinstance(row,dict)and row.get('archived')is False and row.get('schoolId',active.get('schoolId'))==active.get('schoolId')and isinstance(row.get('name'),str)and row['name'].strip():names.add(row['name'])
 if pub._exists(c,'planning_config'):
  row=c.execute('SELECT input_json FROM planning_config WHERE id=1').fetchone()
  if row:
   for t in json.loads(row[0]).get('teachers',[]):names.add(t['name'])
 return sorted(n for n in names if 1<=len(n)<=120)
def status(profile):
 _actor(profile);c=pub._read_connection()
 try:
  if c is None:return {'activeVersion':0,'periodStart':None,'draftRevision':0,'lessons':[],'teacherOptions':[],'records':[],'blockers':[_block('publication_required','Сначала нужна опубликованная датированная неделя')],'notice':NOTICE}
  c.execute('BEGIN');active=pub.read_active_snapshot(profile['schoolId'],c);draft=_draft(c);blockers=[];lessons=[]
  if active:
   first=date.fromisoformat(active['periodStart'])
   lessons=[{**deepcopy(r),'date':(first+timedelta(days=r['day'])).isoformat()}for r in active['lessons']]
   if _grid(active['lessons'])!=_grid(draft['lessons']):blockers.append(_block('draft_drift','Черновик отличается от публикации. Завершите или разберите уже подготовленные изменения.'))
  else:blockers.append(_block('publication_required','Сначала нужна опубликованная датированная неделя'))
  records=sorted(_ns(_state(c),profile['schoolId'])['records'].values(),key=lambda x:x['createdAt'],reverse=True)
  _actor(profile);return {'activeVersion':active['version']if active else 0,'periodStart':active['periodStart']if active else None,'draftRevision':draft['revision'],'lessons':lessons,'teacherOptions':_teacher_options(c,active)if active else[],'records':[_public_record(r)for r in records],'blockers':blockers,'notice':NOTICE}
 finally:
  if c:c.close()

def _origin_publication(c,active,school):
 """Verify each previously published single-row replacement, never restore
 solver provenance onto a changed teaching event."""
 current=active;seen=set();records=_ns(_state(c),school)['records']
 for _ in range(LIMIT+1):
  identifier=current.get('replacementId')
  if not identifier:return current
  if identifier in seen:raise ValueError('Cyclic replacement lineage')
  seen.add(identifier);record=records.get(identifier)
  parent=pub._row(c,'SELECT snapshot_json FROM school_publications WHERE id=? AND school_id=?',(current.get('parentPublicationId'),school))
  if not record or not parent:raise ValueError('Missing replacement lineage')
  previous=json.loads(parent['snapshot_json'])
  if(record['status']!='published'or record['publishedVersion']!=current['version']or previous['version']+1!=current['version']or previous['periodStart']!=current['periodStart']or record['date'][:10]!=(date.fromisoformat(current['periodStart'])+timedelta(days=record['after']['day'])).isoformat()or pub._hash(previous)!=record['proof']['activeHash']or pub._hash(_grid(current['lessons']))!=record['appliedDraftHash']or pub._diff(_grid(previous['lessons']),_grid(current['lessons']))!=[{'lessonId':record['lessonId'],'before':record['before'],'after':record['after']}]):raise ValueError('Invalid replacement lineage')
  current=previous
 raise ValueError('Replacement lineage exceeds limit')

def _evaluate(c,body,profile,base_draft=None):
 active=pub.read_active_snapshot(profile['schoolId'],c);draft=_draft(c)if base_draft is None else base_draft;blockers=[];warnings=[];before=after=None;proof={}
 def block(code,message):blockers.append(_block(code,message))
 if active is None:block('publication_required','Сначала нужна опубликованная датированная неделя')
 elif active['version']!=body.expectedActiveVersion:block('active_changed','Опубликованная версия изменилась')
 if draft['revision']!=body.expectedDraftRevision:block('draft_changed','Версия черновика изменилась')
 if active:
  try:
   first=date.fromisoformat(active['periodStart']);day=date.fromisoformat(body.date)
   if first.weekday()!=0 or not first<=day<=first+timedelta(days=5):block('date_outside_publication','Дата должна относиться к активной опубликованной учебной неделе')
   if _grid(active['lessons'])!=_grid(draft['lessons']):block('draft_drift','Черновик содержит другие неопубликованные изменения')
   before=next((r for r in _grid(active['lessons'])if r['id']==body.lessonId),None)
   if before is None:block('lesson_missing','Урок отсутствует в выбранной публикации')
   elif (first+timedelta(days=before['day'])).isoformat()!=body.date:block('date_lesson_mismatch','Выбранная дата не совпадает с днём конкретного урока')
   if before:
    if len(before['teachers'])!=1:block('joint_lesson','Урок с несколькими учителями требует отдельного согласования')
    event=before.get('planningEventId')
    if event and sum(r.get('planningEventId',r.get('_planningEventId'))==event for r in active['lessons'])>1:block('joint_lesson','Совместное занятие нескольких классов нельзя менять частично')
    if body.replacementTeacher in before['teachers']:block('no_change','Выберите другого учителя')
    if body.replacementTeacher not in _teacher_options(c,active):block('teacher_unknown','Учитель отсутствует в подтверждённом списке школы')
    after={k:deepcopy(v)for k,v in before.items()if k not in ('planningEventId','planningGroups')};after['teachers']=[body.replacementTeacher]
    timetable.EditableLessonInput.model_validate({k:after[k]for k in timetable.EditableLessonInput.model_fields})
    proposed=[after if r['id']==body.lessonId else r for r in _grid(active['lessons'])]
    for issue in timetable.compute_issues(proposed):
     if body.lessonId in issue['lessonIds']and issue['kind']in {'class','teacher','room','ambiguous'}:block('schedule_conflict',issue.get('message','Пересечение или неоднозначность урока'))
   configrow=c.execute('SELECT revision,input_json FROM planning_config WHERE id=1').fetchone()if pub._exists(c,'planning_config')else None
   plan=json.loads(configrow[1])if configrow else None
   confirmed=plan is not None and plan.get('confirmed')is True
   proof['configHash']=pub._hash({'revision':configrow[0],'input':plan})if configrow else None
   proof['validationMode']='confirmed_plan'if confirmed else'manual_acknowledged'
   if confirmed and before:
    from .planning import PlanningService,SubstitutionInput
    wrapper=PlanningService._wrapper(c,profile)
    if plan.get('periodStart')!=active['periodStart']:block('plan_week_mismatch','Нормативный план относится к другой неделе')
    # A matching immutable publication proves this base grid; exclude only the
    # old base revision warning, never any substantive normative blocker.
    ready=wrapper['readiness'];ready={**ready,'blockers':[b for b in ready['blockers']if b['code']!='draft_changed']};ready['ready']=not ready['blockers'];wrapper={**wrapper,'readiness':ready}
    effective=deepcopy(wrapper.get('effectiveInput',wrapper['input']))
    origin=_origin_publication(c,active,profile['schoolId'])
    source=next((row for row in _grid(origin['lessons'])if row['id']==body.lessonId),None)
    proof['originPublicationHash']=pub._hash(origin)
    geometry=('id','className','day','slot','start','end','subject','rooms')
    if not source or any(source[k]!=before[k]for k in geometry):block('lineage_mismatch','Исходный урок не совпадает с проверенной цепочкой замен')
    if source and source.get('planningEventId') and pub._exists(c,'planning_runs'):
     run=pub._row(c,'SELECT * FROM planning_runs WHERE id=?',(origin.get('runId'),))
     if run:
      runbase=json.loads(run['base_snapshot_json']);seed=runbase.get('materializationRunId',run['id'])
      current_teachers=[t for t in effective['teachers']if t['name']==before['teachers'][0]and timetable.canonical(before['subject'])in{timetable.canonical(x)for x in t['subjects']}]
      for demand in effective['demands']:
       for occurrence in range(demand['weeklyCount']):
        event='pe_'+hashlib.sha256((seed+'|'+demand['id']+'_'+str(occurrence)).encode()).hexdigest()[:24]
        if event==source['planningEventId'] and len(current_teachers)==1:
         demand['sourceLessonIds']=list(dict.fromkeys(demand.get('sourceLessonIds',[])+[body.lessonId]));demand['teacherIds']=[current_teachers[0]['id']]
    wrapper['effectiveInput']=effective
    candidates=PlanningService._substitution_candidates(wrapper,draft,SubstitutionInput(lessonId=body.lessonId,expectedDraftRevision=body.expectedDraftRevision,configRevision=wrapper['revision']))
    blockers.extend(_block(b['code'],b['message'])for b in candidates['blockers'])
    selected=[t for t in candidates['candidates']if t['name']==body.replacementTeacher]
    if len(selected)!=1 or not selected[0]['available']:block('teacher_not_available','Учитель не прошёл проверку квалификации, доступности и нагрузки: '+('; '.join(selected[0]['reasons'])if len(selected)==1 else'нет точного подтверждённого соответствия'))
    calendar=effective_calendar_snapshot(active['periodStart'],school_id=profile['schoolId'],connection=c,teacher_ids={t['id']for t in plan['teachers']},room_ids={r['id']for r in plan['rooms']})
   else:
    warnings.append(_block('manual_review_required',MANUAL))
    if not body.acknowledgeUnchecked:block('acknowledgement_required',MANUAL)
    calendar=effective_calendar_snapshot(active['periodStart'],school_id=profile['schoolId'],connection=c)
   blockers.extend(_block(b['code'],b['message'])for b in calendar['readiness']['blockers'])
   if not any(d['date']==body.date and d['status']=='school'for d in calendar['days']):block('day_not_confirmed','Дата не подтверждена как учебная')
   proof.update(calendarBinding={k:calendar[k]for k in ('calendarRevision','inputHash','weekStart')},activeHash=pub._hash(active),baseGridHash=pub._hash(_grid(active['lessons'])))
  except (ValueError,KeyError,TypeError,sqlite3.Error)as error:block('invalid_source','Исходная публикация или школьные условия требуют проверки')
 input=body.model_dump();payload={'input':input,'before':before,'after':after,'proof':proof}
 return {'ready':not blockers,'blockers':blockers,'warnings':warnings,'before':before,'after':after,'date':body.date,'previewHash':pub._hash(payload)if not blockers else None,'input':input,'proof':proof}

def preview(body,profile):
 _actor(profile);c=pub._read_connection()
 if c is None:return {'ready':False,'blockers':[_block('publication_required','Сначала нужна публикация')],'warnings':[],'before':None,'after':None,'date':body.date,'previewHash':None,'input':body.model_dump()}
 try:c.execute('BEGIN');result=_evaluate(c,body,profile);_actor(profile);return {k:v for k,v in result.items()if k!='proof'}
 finally:c.close()

def apply(body,profile):
 _actor(profile);fp=pub._hash({'operation':'apply','body':body.model_dump()})
 recovered=_recover(body.requestId,fp,profile)
 if recovered:return recovered
 with _atomic_domain()as(c,state):
  _actor(profile);ns=_ns(state,profile['schoolId']);old=_receipt(ns,body.requestId,fp,profile)
  if old:return old
  if len(ns['records'])>=LIMIT:raise HTTPException(429,'Достигнут лимит замен')
  checked=_evaluate(c,body.input,profile)
  if not checked['ready']or checked['previewHash']!=body.previewHash:raise HTTPException(409,'Предложение изменилось или содержит блокеры; повторите предпросмотр')
  previous=_draft(c);draft=deepcopy(previous);target=next(r for r in draft['lessons']if r['id']==body.input.lessonId)
  target.update({k:v for k,v in checked['after'].items()if k!='id'});target.pop('_planningEventId',None);target.pop('_planningGroups',None);target.pop('planningEventId',None);target.pop('planningGroups',None)
  stamp=datetime.now(timezone.utc).isoformat();target.update(edited=True,_editedAt=stamp,_parseWarnings=[]);draft.update(revision=previous['revision']+1,updatedAt=stamp,issues=timetable.compute_issues(draft['lessons']))
  adapter={**profile,'role':'admin'if profile.get('staffRole')=='planner'else'director'};actor=timetable._actor(adapter)
  timetable._save(c,previous,draft,actor,'date_bound_replacement');identifier='replacement_'+uuid4().hex
  result=timetable._public(draft);command='date_replacement_'+identifier
  c.execute('INSERT INTO timetable_command_receipts(command_key,command_hash,actor_id,actor_role,result,created_at) VALUES(?,?,?,?,?,?)',(command,body.previewHash,*actor,pub._json(result),stamp))
  record={'id':identifier,'date':body.input.date,'lessonId':body.input.lessonId,'before':checked['before'],'after':checked['after'],'status':'applied','draftRevision':draft['revision'],'publishedVersion':None,'createdAt':stamp,'reason':body.input.reason,'validationMode':checked['proof']['validationMode'],'input':body.input.model_dump(),'previewHash':body.previewHash,'proof':checked['proof'],'baseDraft':previous,'appliedDraftHash':pub._hash(_grid(draft['lessons'])),'approval':_binding(profile),'receiptKey':command}
  ns['records'][identifier]=record;response={'record':_public_record(record),'draftRevision':draft['revision'],'notice':'Замена сохранена в черновик. Опубликованная школьная версия изменится после отдельной публикации. '+NOTICE};_save_receipt(ns,body.requestId,fp,profile,response);_put(state,profile['schoolId'],ns);_actor(profile);return response

def _publish_check(c,identifier,body,profile):
 ns=_ns(_state(c),profile['schoolId']);record=ns['records'].get(identifier)
 if not record:raise HTTPException(404,'Замена не найдена')
 blockers=[]
 if record['status']!='applied':blockers.append(_block('already_published','Эта замена уже опубликована'))
 active=pub.read_active_snapshot(profile['schoolId'],c);draft=_draft(c)
 if active is None or active['version']!=body.expectedActiveVersion or active['version']!=record['input']['expectedActiveVersion']:blockers.append(_block('active_changed','Публикация изменилась; подготовьте новую замену'))
 if draft['revision']!=body.expectedDraftRevision or draft['revision']!=record['draftRevision']or pub._hash(_grid(draft['lessons']))!=record['appliedDraftHash']:blockers.append(_block('draft_drift','После замены черновик изменился; нельзя опубликовать посторонние изменения'))
 if not launch_identity.membership_current(record['approval']):blockers.append(_block('approver_revoked','Доступ утвердившего замену сотрудника изменился'))
 checked=_evaluate(c,PreviewInput(**record['input']),profile,record['baseDraft'])
 if not checked['ready']or checked.get('previewHash')!=record['previewHash']:blockers.append(_block('conditions_changed','Календарь, школьные условия или исходный урок изменились после согласования'))
 receipt=pub._row(c,'SELECT * FROM timetable_command_receipts WHERE command_key=?',(record['receiptKey'],))
 if not receipt or receipt['command_hash']!=record['previewHash']or receipt['actor_id']!=record['approval']['userId']or pub._hash(_grid(json.loads(receipt['result'])['lessons']))!=record['appliedDraftHash']:blockers.append(_block('receipt_missing','Нет точной квитанции сохранения этой замены'))
 diff=pub._diff(_grid(active['lessons']),_grid(draft['lessons']))if active else[]
 if diff!=[{'lessonId':record['lessonId'],'before':record['before'],'after':record['after']}]:blockers.append(_block('unexpected_diff','Разница с публикацией не совпадает с одной утверждённой заменой'))
 content={'schoolId':profile['schoolId'],'replacementId':identifier,'recordHash':pub._hash(record),'activeVersion':body.expectedActiveVersion,'draftRevision':body.expectedDraftRevision,'diff':diff}
 return {'ready':not blockers,'blockers':blockers,'diff':diff,'previewHash':pub._hash(content)if not blockers else None,**body.model_dump()},record,active,draft

def publish_preview(identifier,body,profile):
 _actor(profile,'publication.publish');c=pub._read_connection()
 if c is None:raise HTTPException(404,'Замена не найдена')
 try:c.execute('BEGIN');result,*_=_publish_check(c,identifier,body,profile);_actor(profile,'publication.publish');return result
 finally:c.close()

def publish(identifier,body,profile):
 _actor(profile,'publication.publish');fp=pub._hash({'operation':'publish','id':identifier,'body':body.model_dump()})
 recovered=_recover(body.requestId,fp,profile,'publication.publish')
 if recovered:return recovered
 with _atomic_domain()as(c,state):
  _actor(profile,'publication.publish');ns=_ns(state,profile['schoolId']);old=_receipt(ns,body.requestId,fp,profile)
  if old:return old
  checked,record,active,draft=_publish_check(c,identifier,Versions(**{k:getattr(body,k)for k in Versions.model_fields}),profile)
  if not checked['ready']or checked['previewHash']!=body.previewHash:raise HTTPException(409,'Публикация замены не прошла проверку. Повторите предпросмотр.')
  if c.execute('SELECT COUNT(*) FROM school_publications WHERE school_id=?',(profile['schoolId'],)).fetchone()[0]>=pub.MAX_PUBLICATIONS:raise HTTPException(429,'Достигнут лимит опубликованных версий')
  if c.execute('SELECT 1 FROM school_publications WHERE request_id=?',(body.requestId,)).fetchone():raise HTTPException(409,'Идентификатор публикации уже использован')
  pub._schema(c);stamp=datetime.now(timezone.utc).isoformat();pid='pub_'+uuid4().hex;proof=record['proof'];binding=proof['calendarBinding'];snapshot={'publicationId':pid,'schoolId':profile['schoolId'],'version':active['version']+1,'draftRevision':draft['revision'],'runId':'replacement:'+identifier,'sourceRunId':active.get('sourceRunId',active.get('runId')),'periodStart':active['periodStart'],'calendarRevision':binding['calendarRevision'],'calendarHash':binding['inputHash'],'lessons':_grid(draft['lessons']),'publishedAt':stamp,'replacementId':identifier,'parentPublicationId':active['publicationId']}
  evidence={'kind':'date_bound_replacement','replacementId':identifier,'date':record['date'],'parentPublicationId':active['publicationId'],'parentPublicationHash':pub._hash(active),'approval':record['approval'],'proof':proof,'diff':checked['diff'],'previewHash':body.previewHash,'notice':MANUAL if record['validationMode']=='manual_acknowledged'else'Проверено по подтверждённым условиям подбора замены'}
  c.execute('INSERT INTO school_publications VALUES(?,?,?,?,?,?,?,?,?,?)',(pid,profile['schoolId'],snapshot['version'],body.requestId,draft['revision'],snapshot['runId'],pub._json(snapshot),pub._json(evidence),stamp,profile['userId']))
  c.execute('INSERT INTO school_publication_audit VALUES(?,?,?,?,?,?,?,?)',(uuid4().hex,profile['schoolId'],pid,profile['userId'],profile.get('staffRole',profile['role']),'date_bound_replacement_published',stamp,pub._json(evidence)))
  outbox=pub._insert_outbox(c,pid,profile['schoolId'],snapshot,stamp);record.update(status='published',publishedVersion=snapshot['version']);ns['records'][identifier]=record
  response={'record':_public_record(record),'publication':snapshot,'notice':'Замена опубликована во внутреннем расписании. '+NOTICE};_save_receipt(ns,body.requestId,fp,profile,response);_put(state,profile['schoolId'],ns);_actor(profile,'publication.publish');return response

router=APIRouter(prefix='/api/school/replacements',tags=['date-bound replacements'],route_class=SafeRoute)
@router.get('')
def get_route(profile=Depends(session_profile)):return status(profile)
@router.post('/preview')
def preview_route(body:PreviewInput,profile=Depends(session_profile)):return preview(body,profile)
@router.post('/apply')
def apply_route(body:ApplyInput,profile=Depends(session_profile)):return apply(body,profile)
@router.post('/{identifier}/publish-preview')
def publish_preview_route(identifier:str,body:Versions,profile=Depends(session_profile)):return publish_preview(identifier,body,profile)
@router.post('/{identifier}/publish')
def publish_route(identifier:str,body:PublishInput,profile=Depends(session_profile)):return publish(identifier,body,profile)
