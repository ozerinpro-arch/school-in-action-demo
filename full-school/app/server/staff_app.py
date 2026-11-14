"""Separate, unpublished staff frontdoor. Own origin; existing owner gateway unchanged.
Run: uvicorn server.staff_app:create_app --factory --host 127.0.0.1 --port 18828.
Requires explicit SHKOLA_STAFF_ORIGIN, SHKOLA_STAFF_DB_PATH, SHKOLA_SCHOOL_ID,
SHKOLA_UI_DIRECTORY (a staff-mode build), SHKOLA_WORKSPACE_MODE=school.
"""
from contextlib import closing
import hmac,os,re
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import APIRouter,Depends,FastAPI,HTTPException,Request,Response
from pydantic import BaseModel,ConfigDict,Field
from starlette.responses import JSONResponse,FileResponse
from . import staff_access as store
from .staff_policy import enforce
from .portal_app import _build_file,_ASSET_SUFFIXES

class Input(BaseModel):model_config=ConfigDict(extra='forbid',strict=True)
class Login(Input):username:str=Field(min_length=3,max_length=80);password:str=Field(min_length=1,max_length=256)
class Accept(Input):token:str=Field(min_length=43,max_length=128);password:str=Field(min_length=12,max_length=256)
class Nomination(Input):username:str=Field(min_length=3,max_length=80);name:str=Field(min_length=1,max_length=120);role:str=Field(min_length=1,max_length=30);teacherRefs:list[str]=Field(default_factory=list,max_length=20);calendarTeacherIds:list[str]=Field(default_factory=list,max_length=20)
class Invite(Input):nominationId:str=Field(min_length=1,max_length=80)
class Absence(Input):
 lessonIds:list[str]=Field(min_length=1,max_length=100)
 startDate:str=Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
 endDate:str=Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
 note:str=Field(default='',max_length=1000)

def create_app():
 os.environ['PYTHON_DOTENV_DISABLED']='1'
 from . import auth,core
 if os.environ.get('SHKOLA_WORKSPACE_MODE')!='school':raise RuntimeError('Staff requires explicit school workspace')
 origin=os.environ.get('SHKOLA_STAFF_ORIGIN','');parsed=urlsplit(origin)
 if not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:raise RuntimeError('Explicit canonical staff origin required')
 secure=parsed.scheme=='https'
 base=os.environ.get('SHKOLA_STAFF_BASE_PATH','/client/school')
 if len(base)>120 or not re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_-]*(?:/[A-Za-z0-9][A-Za-z0-9_-]*)*',base):raise RuntimeError('Explicit canonical staff base path required')
 if not secure:
  from .test_isolation import isolated_database_paths
  isolated_database_paths()
  if parsed.scheme!='http'or parsed.hostname not in{'localhost','127.0.0.1'}:raise RuntimeError('HTTP staff allowed only in isolated loopback tests')
  staff_path,_=store.configuration()
  if not staff_path.resolve().is_relative_to(Path('/tmp').resolve())and not staff_path.resolve().is_relative_to(Path(os.environ.get('TMPDIR','/tmp')).resolve()):raise RuntimeError('Synthetic staff DB required for HTTP')
 ui=Path(os.environ.get('SHKOLA_UI_DIRECTORY',''))
 if not ui.is_absolute()or not(ui/'index.html').is_file():raise RuntimeError('Explicit staff UI build required')
 domain_config=(os.environ.get('SHKOLA_DB_PATH',''),os.environ.get('AGENT_DB_PATH',''))
 store.initialize();staff_config=store.configuration();store.register_configuration(staff_config)
 from .integration_settings import IntegrationSettings
 from .school_integrations import IntegrationMiddleware,IntegrationResources
 resources=IntegrationResources(IntegrationSettings.from_environment(staff_config[1]))
 # Personal teacher material storage is separate from identities and school data.
 # Reuse the explicitly selected provider/model and both existing request gates.
 from .teacher_preparation import TeacherPreparationService,CreateMaterial,UpdateMaterial,GenerateMaterial,make_generator
 from .schedule_agent import ModelConfiguration
 teacher_configuration=ModelConfiguration(resources.settings.ai_key,resources.settings.ai_model,
  bool(resources.settings.request_ai_requested and resources.manager_ai_enabled and not resources.settings.errors))
 teacher_preparation=TeacherPreparationService(staff_config[1],staff_config[0].parent/'teacher-preparation.sqlite3',
  generator=make_generator(teacher_configuration),
  forbidden=tuple(p for p in (staff_config[0],*domain_config,resources.settings.ai_db,resources.settings.max_db,
   *(os.environ.get(k,'')for k in ('NANOGPT_API_KEY_FILE','SHKOLA_MAX_BOT_TOKEN_FILE','SHKOLA_MAX_WEBHOOK_SECRET_FILE')))if p))
 from .student_learning import StudentLearningService,InvitationInput,AssignmentInput as LearningAssignment,MessageInput as LearningMessage,PracticeInput,DraftInput,ReviewInput,bound_service as bound_learning
 learning=StudentLearningService(staff_config[1],staff_config[0].parent/'student-learning.sqlite3',generator=make_generator(teacher_configuration),
  forbidden=(*teacher_preparation.forbidden,teacher_preparation.path))
 from .launch_identity import install
 install()
 cookie='__Host-shkola_staff'if secure else'shkola_staff_test';pre='__Host-shkola_staff_pre'if secure else'shkola_staff_pre_test'
 app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
 app.add_exception_handler(core.RequestValidationError,core.safe_validation_error)
 marker=object()
 def actor(request:Request):
  if request.scope.get('_staff_marker')is not marker:raise HTTPException(401,'Войдите в школьный кабинет')
  profile=request.scope['staff_profile'].copy();expected_owner=request.headers.get('x-learning-owner')
  # An optional UI precondition never grants authority; the verified session owns it.
  if expected_owner is not None and expected_owner!=profile.get('userId'):raise HTTPException(401,'Сеанс изменился. Войдите в свой школьный кабинет')
  return profile
 def require_current_session(request,profile):
  session=store.get_session(request.cookies.get(cookie,''))
  if not session or session.get('profile')!=profile:raise HTTPException(401,'Сеанс изменился. Войдите в свой школьный кабинет')
 app.dependency_overrides[auth.session_profile]=actor
 def teacher_actor(profile=Depends(actor)):
  if profile.get('staffRole')!='teacher'or profile.get('schoolId')!=staff_config[1]or not store.membership_current(profile):
   raise HTTPException(403,'Личные материалы доступны только действующему учителю')
  return profile
 @app.get('/api/teacher/preparation')
 def teacher_dashboard(profile=Depends(teacher_actor)):return teacher_preparation.dashboard(profile)
 @app.get('/api/teacher/preparation/materials')
 def teacher_materials(className:str|None=None,profile=Depends(teacher_actor)):return teacher_preparation.list_materials(profile,class_name=className)
 @app.post('/api/teacher/preparation/materials')
 def teacher_create_material(body:CreateMaterial,profile=Depends(teacher_actor)):return teacher_preparation.create_material(profile,body.model_dump())
 @app.get('/api/teacher/preparation/materials/{material_id}')
 def teacher_material(material_id:str,profile=Depends(teacher_actor)):return teacher_preparation.get_material(profile,material_id)
 @app.patch('/api/teacher/preparation/materials/{material_id}')
 def teacher_update_material(material_id:str,body:UpdateMaterial,profile=Depends(teacher_actor)):return teacher_preparation.update_material(profile,material_id,body.model_dump(exclude_unset=True))
 @app.post('/api/teacher/preparation/generate')
 def teacher_generate_material(body:GenerateMaterial,profile=Depends(teacher_actor)):
  data=body.model_dump();recovered=teacher_preparation.recover_generation(profile,data)
  if recovered is not None:return recovered
  store.limited('teacher-preparation-generate',profile['membershipId'],20)
  return teacher_preparation.generate(profile,data)
 @app.get('/api/staff/student-access')
 def student_access(profile=Depends(actor)):return learning.access_list(profile)
 @app.post('/api/staff/student-access/invitations')
 def student_invitation(body:InvitationInput,profile=Depends(actor)):
  value=learning.invite_student(profile,body.model_dump())
  path=value['invite']['path'];return {**value,'invite':{**value['invite'],'path':base+'/#invite='+path.split('#invite=',1)[1]}}
 @app.get('/api/teacher/learning')
 def teacher_learning(profile=Depends(actor)):return learning.teacher_dashboard(profile)
 @app.post('/api/teacher/learning/assignments')
 def create_learning_assignment(body:LearningAssignment,profile=Depends(actor)):
  data=body.model_dump();old=learning.recover(profile,data,'assignment')
  if old is not None:return old
  return learning.execute(profile,data)
 @app.get('/api/teacher/learning/assignments/{assignment_id}')
 @app.get('/api/student/learning/assignments/{assignment_id}')
 def learning_assignment(assignment_id:str,profile=Depends(actor)):return learning.detail(profile,assignment_id)
 @app.post('/api/teacher/learning/assignments/{assignment_id}/messages')
 @app.post('/api/student/learning/assignments/{assignment_id}/messages')
 def learning_message(assignment_id:str,body:LearningMessage,profile=Depends(actor)):
  data=body.model_dump();old=learning.recover(profile,data,'message:'+assignment_id)
  if old is not None:return old
  if data['askAi']:store.limited('student-learning-tutor',profile['membershipId'],20)
  return learning.execute(profile,data,assignment_id=assignment_id)
 @app.post('/api/student/learning/assignments/{assignment_id}/draft')
 def learning_draft(assignment_id:str,body:DraftInput,profile=Depends(actor)):
  return learning.execute_work(profile,body.model_dump(),assignment_id,'draft')
 @app.post('/api/student/learning/assignments/{assignment_id}/submit')
 def learning_submit(assignment_id:str,body:DraftInput,profile=Depends(actor)):
  return learning.execute_work(profile,body.model_dump(),assignment_id,'submit')
 @app.post('/api/teacher/learning/assignments/{assignment_id}/review')
 def learning_review(assignment_id:str,body:ReviewInput,profile=Depends(actor)):
  return learning.execute_work(profile,body.model_dump(),assignment_id,'review')
 @app.post('/api/student/learning/practice')
 def student_practice(body:PracticeInput,profile=Depends(actor)):
  data=body.model_dump();old=learning.recover(profile,data,'practice')
  if old is not None:return old
  store.limited('student-learning-tutor',profile['membershipId'],20)
  return learning.execute(profile,data,practice=True)
 @app.get('/api/student/learning')
 def student_learning(profile=Depends(actor)):return learning.student_dashboard(profile)
 @app.get('/api/student/clubs/receipts')
 def student_club_receipts(request:Request,profile=Depends(actor)):
  from .school_clubs import receipt_fields
  result=[{key:row[key] for key in ('id','programTitle','period','amountKopeks')} for row in receipt_fields(learning.current_student_id(profile))]
  require_current_session(request,profile)
  return {'receipts':result}
 @app.get('/api/student/clubs/receipts/{identity}/receipt.pdf')
 def student_club_receipt(identity:str,request:Request,profile=Depends(actor)):
  from .school_clubs import receipt_pdf
  result=receipt_pdf(identity,student_id=learning.current_student_id(profile))
  require_current_session(request,profile)
  return result
 def cookie_set(response,name,value,ttl):response.set_cookie(name,value,max_age=ttl,secure=secure,httponly=True,samesite='strict',path='/')
 @app.get('/api/portal-session')
 def portal_session(request:Request,response:Response):
  session=request.scope.get('_staff_session')
  if not session:
   store.limited('preauth',request.client.host if request.client else'unknown',100)
   token,csrf=store.new_session();cookie_set(response,pre,token,600)
  else:csrf=session['csrf']
  return {'csrfToken':csrf,'staff':True}
 @app.post('/api/staff/login')
 def signin(body:Login,request:Request,response:Response):
  address=request.client.host if request.client else'unknown'
  store.limited('login-ip',address,100)
  store.limited('login',address+':'+body.username.lower())
  token,profile=store.login(body.username,body.password,request.scope['_staff_session']['csrf']);cookie_set(response,cookie,token,store.SESSION_TTL)
  return {'profile':profile}
 @app.post('/api/staff/accept')
 def accept(body:Accept,request:Request,response:Response):
  store.limited('accept',request.client.host if request.client else'unknown',50)
  token,profile=store.accept(body.token,body.password,request.scope['_staff_session']['csrf']);cookie_set(response,cookie,token,store.SESSION_TTL)
  return {'profile':profile}
 @app.get('/api/staff/me')
 def me(profile=Depends(actor)):return {'profile':profile}
 @app.post('/api/staff/logout')
 def logout(request:Request,response:Response,profile=Depends(actor)):
  store.destroy_session(request.cookies.get(cookie,''));response.delete_cookie(cookie,path='/',secure=secure,httponly=True,samesite='strict');return {'loggedOut':True}
 @app.get('/api/staff/directory')
 def directory(profile=Depends(actor)):return store.directory(profile)
 @app.post('/api/staff/nominations')
 def nominate(body:Nomination,profile=Depends(actor)):return store.nomination(profile,body.model_dump())
 @app.post('/api/staff/invites')
 def invitation(body:Invite,profile=Depends(actor)):
  result=store.invite(profile,body.nominationId)
  return {**result,'path':base+'/#invite='+result['token']}
 @app.post('/api/staff/members/{member_id}/revoke')
 def revoke(member_id:str,profile=Depends(actor)):return store.revoke(profile,member_id)
 @app.post('/api/staff/members/{member_id}/approve-revoke')
 def approve_revoke(member_id:str,profile=Depends(actor)):return store.approve_revocation(profile,member_id)
 @app.post('/api/staff/revocations/{approval_id}/execute')
 def execute_revoke(approval_id:str,profile=Depends(actor)):return store.execute_revocation(profile,approval_id)
 @app.get('/api/staff/my-schedule')
 def own_schedule(profile=Depends(actor)):return store.own_timetable(profile)
 @app.get('/api/staff/absences')
 def absence_requests(profile=Depends(actor)):return store.list_absences(profile)
 @app.post('/api/staff/my-absence')
 def absence(body:Absence,profile=Depends(actor)):return store.create_absence(profile,body.model_dump())
 # Real core routers are reused. Teacher timetable has an explicit projection and never reaches the full route.
 routes=[r for r in core.app.router.routes if not getattr(r,'path','').startswith(('/api/demo','/api/health','/api/state'))]
 app.include_router(APIRouter(routes=routes))
 from .daily_brief_routes import router_for as daily_brief_router
 app.include_router(daily_brief_router(actor,require_current_session))
 @app.get('/api/health')
 def health():return {'status':'ok','staff':True}
 @app.api_route('/api/{path:path}',methods=['GET','POST','PATCH','PUT','DELETE','HEAD','OPTIONS'])
 def unknown_api(path:str):raise HTTPException(404,'Не найдено')
 @app.get('/{path:path}')
 def ui_files(path:str):
  if path in{'','index.html'}:target=_build_file(ui.resolve(),'index.html')
  elif path=='favicon.svg':target=_build_file(ui.resolve(),path)
  elif path.startswith('assets/')and Path(path).suffix.lower()in _ASSET_SUFFIXES:target=_build_file(ui.resolve(),path)
  else:raise HTTPException(404,'Не найдено')
  return FileResponse(target)
 @app.head('/')
 @app.head('/index.html')
 def ui_entry_head():return FileResponse(_build_file(ui.resolve(),'index.html'))

 class Frontdoor:
  async def __call__(self,scope,receive,send):
   from .school_requests import bound_school
   with store.bound_configuration(staff_config):
    with bound_school(staff_config[1]):
     with bound_learning(learning):await self.handle(scope,receive,send)
  async def handle(self,scope,receive,send):
   if scope['type']!='http':
    if scope['type']=='lifespan':return await app(scope,receive,send)
    if scope['type']=='websocket':await send({'type':'websocket.close','code':1008})
    return
   original_send=send
   async def safe_send(message):
    if message['type']=='http.response.start':
     additions={b'cache-control':b'no-store',b'x-content-type-options':b'nosniff',b'referrer-policy':b'no-referrer',b'content-security-policy':b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}
     message={**message,'headers':[(k,v)for k,v in message.get('headers',[])if k.lower()not in additions]+list(additions.items())}
    await original_send(message)
   send=safe_send
   if domain_config!=(os.environ.get('SHKOLA_DB_PATH',''),os.environ.get('AGENT_DB_PATH','')):return await JSONResponse({'detail':'Настройка хранилища изменилась; нужен новый запуск'},503)(scope,receive,send)
   request=Request(scope,receive);path=scope['path'];prefix=base
   if not path.startswith(prefix+'/'):return await JSONResponse({'detail':'Не найдено'},404)(scope,receive,send)
   inner_path=path[len(prefix):];headers={}
   for k,v in scope['headers']:
    key=k.lower()
    if key in headers and key in{b'host',b'origin',b'cookie',b'x-csrf-token',b'content-length'}:return await JSONResponse({'detail':'Неоднозначный запрос'},400)(scope,receive,send)
    headers[key]=v
   cookie_keys=[part.strip().split('=',1)[0]for part in headers.get(b'cookie',b'').decode('latin1').split(';')if '='in part]
   if any(cookie_keys.count(key)>1 for key in(cookie,pre)):return await JSONResponse({'detail':'Неоднозначная сессия'},400)(scope,receive,send)
   if headers.get(b'host',b'').decode()!=parsed.netloc:return await JSONResponse({'detail':'Неверный адрес'},400)(scope,receive,send)
   # Only the public sign-in document may be reached by an external link.
   # API, mutations, embeddings and requests with Origin keep the same fence.
   document_entry=(scope['method']in{'GET','HEAD'}and inner_path in{'/','/index.html'}
    and headers.get(b'sec-fetch-mode')==b'navigate'and headers.get(b'sec-fetch-dest')==b'document'and b'origin'not in headers)
   if (headers.get(b'origin')and headers[b'origin'].decode()!=origin)or(headers.get(b'sec-fetch-site')==b'cross-site'and not document_entry):return await JSONResponse({'detail':'Внешний источник запрещён'},403)(scope,receive,send)
   if len(scope['query_string'])>4096 or '..'in inner_path.split('/')or '%'in inner_path or '\\'in inner_path or '//'in inner_path:return await JSONResponse({'detail':'Не найдено'},404)(scope,receive,send)
   teacher_material_write=(scope['method']=='POST'and inner_path=='/api/teacher/preparation/materials')or(
    scope['method']=='PATCH'and re.fullmatch(r'/api/teacher/preparation/materials/[^/]+',inner_path))
   learning_assignment_write=scope['method']=='POST'and inner_path=='/api/teacher/learning/assignments'
   limit=256*1024 if teacher_material_write else 128*1024 if learning_assignment_write else core.request_body_limit(scope['method'],inner_path)
   try:length=int(headers.get(b'content-length',b'0'))
   except ValueError:length=-1
   if length<0 or length>limit:return await JSONResponse({'detail':'Тело запроса превышает допустимый размер или имеет неверную длину'},413)(scope,receive,send)
   body=b''
   while True:
    message=await receive()
    if message['type']=='http.disconnect':return
    body+=message.get('body',b'')
    if len(body)>limit:return await JSONResponse({'detail':'Слишком большой запрос'},413)(scope,receive,send)
    if not message.get('more_body'):break
   session=store.get_session(request.cookies.get(cookie,''));session=session or store.get_session(request.cookies.get(pre,''));profile=session.get('profile')if session else None
   public=inner_path=='/api/portal-session'or inner_path in{'/api/staff/login','/api/staff/accept'}
   try:
    if inner_path.startswith('/api/')and profile and profile.get('staffRole')=='student':enforce(profile,scope['method'],inner_path)
    if inner_path.startswith('/api/')and not public:
     if not profile:raise HTTPException(401,'Войдите в школьный кабинет')
     enforce(profile,scope['method'],inner_path)
    if scope['method']not in{'GET','HEAD'}:
     if headers.get(b'origin',b'').decode()!=origin or not session or not hmac.compare_digest(headers.get(b'x-csrf-token',b''),session['csrf'].encode()):raise HTTPException(403,'Обновите страницу для подтверждения безопасности')
    if profile and profile['staffRole']=='teacher'and inner_path=='/api/timetable'and scope['method']=='GET':return await JSONResponse(store.own_timetable(profile))(scope,receive,send)
   except HTTPException as e:return await JSONResponse({'detail':e.detail},e.status_code)(scope,receive,send)
   inner={**scope,'path':inner_path,'raw_path':inner_path.encode(),'_staff_marker':marker,'staff_identity_verified':bool(profile),'staff_profile':profile,'_staff_session':session,'headers':[(k,v)for k,v in scope['headers']if k.lower()not in{b'host',b'origin',b'x-school-bridge',b'authorization'}]+[(b'host',b'localhost:8798'),(b'origin',b'http://localhost:8798')]}
   if inner_path=='/api/timetable/import':inner['_staff_require_current_session']=require_current_session
   delivered=False
   async def replay():
    nonlocal delivered
    if not delivered:delivered=True;return {'type':'http.request','body':body,'more_body':False}
    return await receive()
   async def secured(message):
    if message['type']=='http.response.start':message={**message,'headers':[*message.get('headers',[]),(b'cache-control',b'no-store'),(b'x-content-type-options',b'nosniff'),(b'referrer-policy',b'no-referrer'),(b'content-security-policy',b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")]}
    await send(message)
   await app(inner,replay,secured)
 return IntegrationMiddleware(Frontdoor(),resources)
