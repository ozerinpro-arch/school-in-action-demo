"""Fail-closed staff permissions; legacy core is never broadly granted admin."""
import re
from fastapi import HTTPException
LEGACY_MANAGE=('/api/timetable','/api/planning','/api/schedule-agent')
LEGACY_RULES={
 'GET':[r'/api/timetable',r'/api/timetable/history',r'/api/timetable/history/[0-9]+',r'/api/planning/(config|readiness|template|runs|questions)',r'/api/planning/runs/[^/]+',r'/api/schedule-agent/status',r'/api/schedule-agent/tasks/[^/]+'],
 'POST':[r'/api/timetable/(preview|import|restore|export)',r'/api/timetable/lessons/[^/]+',r'/api/planning/(config|from-draft|runs|questions|substitutions)',r'/api/planning/runs/[^/]+/(cancel|propose|adjust)',r'/api/planning/questions/[^/]+/answer',r'/api/schedule-agent/tasks',r'/api/schedule-agent/tasks/[^/]+/(decision|reply)']}

def match(patterns,path):return any(re.fullmatch(p,path)for p in patterns)
def allowed(role,method,path):
 if path=='/api/planning/daily-brief':return method=='GET'and role in{'director','planner'}
 if path in{'/api/planning/daily-brief/preview','/api/planning/daily-brief/save','/api/planning/daily-brief/preflight'}:return method=='POST'and role in{'director','planner'}
 if role=='student':
  if path in{'/api/portal-session','/api/staff/me'}:return method=='GET'
  if path=='/api/staff/logout':return method=='POST'
  if path=='/api/student/learning':return method=='GET'
  if path=='/api/student/clubs/receipts' or re.fullmatch(r'/api/student/clubs/receipts/charge-[a-f0-9]{32}/receipt\.pdf',path):return method=='GET'
  if path=='/api/student/learning/practice':return method=='POST'
  if re.fullmatch(r'/api/student/learning/assignments/[^/]+',path):return method=='GET'
  if re.fullmatch(r'/api/student/learning/assignments/[^/]+/messages',path):return method=='POST'
  if re.fullmatch(r'/api/student/learning/assignments/[^/]+/(draft|submit)',path):return method=='POST'
  return False
 if path=='/api/staff/student-access':return method=='GET'and role=='director'
 if path=='/api/staff/student-access/invitations':return method=='POST'and role=='director'
 if path=='/api/teacher/learning':return method=='GET'and role=='teacher'
 if path=='/api/teacher/learning/assignments':return method=='POST'and role=='teacher'
 if re.fullmatch(r'/api/teacher/learning/assignments/[^/]+',path):return method=='GET'and role=='teacher'
 if re.fullmatch(r'/api/teacher/learning/assignments/[^/]+/messages',path):return method=='POST'and role=='teacher'
 if re.fullmatch(r'/api/teacher/learning/assignments/[^/]+/review',path):return method=='POST'and role=='teacher'
 if path=='/api/portal-session':return method=='GET'
 if path=='/api/staff/me':return method=='GET'
 if path=='/api/staff/logout':return method=='POST'
 if path=='/api/staff/directory':return method=='GET'and role in{'director','access_admin'}
 if path=='/api/staff/nominations':return method=='POST'and role=='director'
 if path=='/api/staff/invites':return method=='POST'and role in{'director','access_admin'}
 if path=='/api/staff/my-schedule':return method=='GET'and role=='teacher'
 if path=='/api/staff/my-absence':return method=='POST'and role=='teacher'
 if path=='/api/staff/absences':return method=='GET'and role in{'director','planner'}
 if re.fullmatch(r'/api/staff/members/[^/]+/(revoke|approve-revoke)',path):return method=='POST'and role=='director'
 if re.fullmatch(r'/api/staff/revocations/[^/]+/execute',path):return method=='POST'and role in{'director','access_admin'}

 if path=='/api/teacher/preparation':return method=='GET'and role=='teacher'
 if path=='/api/teacher/preparation/materials':return method in{'GET','POST'}and role=='teacher'
 if path=='/api/teacher/preparation/generate':return method=='POST'and role=='teacher'
 if re.fullmatch(r'/api/teacher/preparation/materials/[^/]+',path):return method in{'GET','PATCH'}and role=='teacher'
 if path=='/api/health':return method=='GET'
 if path=='/api/timetable'and method=='GET':return role in{'director','planner','teacher'}
 if path=='/api/timetable/dated-draft':return role in{'director','planner'}and method in{'GET','POST'}
 if path=='/api/launch/status':return method=='GET'
 if re.fullmatch(r'/api/planning/runs/run_[A-Za-z0-9_-]+/projection',path):return method=='GET'and role in{'director','planner'}
 if path=='/api/school/replacements':return method=='GET'and role in{'director','planner'}
 if path in{'/api/school/replacements/preview','/api/school/replacements/apply'}:return method=='POST'and role in{'director','planner'}
 if re.fullmatch(r'/api/school/replacements/replacement_[a-f0-9]{32}/(publish-preview|publish)',path):return method=='POST'and role in{'director','planner'}
 if path=='/api/school/analytics/director':return method=='GET'and role=='director'
 if re.fullmatch(r'/api/school/clubs/charges/charge-[a-f0-9]{32}/receipt\.pdf',path):return method=='GET'and role=='director'
 if path=='/api/school/analytics/schedule':return method=='GET'and role in{'director','planner'}
 if path=='/api/school/integrations/status':return method=='GET'and role in{'director','planner','teacher','access_admin'}
 if path=='/api/school/integrations/max/me':return method=='GET'and role=='teacher'
 if path in{'/api/school/integrations/max/link','/api/school/integrations/max/revoke'}:return method=='POST'and role=='teacher'
 if role in{'director','planner','teacher'}:
  if method=='GET'and(path in{'/api/school/requests','/api/school/requests/status'}or re.fullmatch(r'/api/school/requests/[A-Za-z0-9_-]+',path)):return True
  if method=='POST'and(path=='/api/school/requests'or re.fullmatch(r'/api/school/requests/[A-Za-z0-9_-]+/reply',path)):return True
  if role in{'director','planner'}and method=='POST'and re.fullmatch(r'/api/school/requests/[A-Za-z0-9_-]+/(question|proposal|decision)',path):return True
 if role in{'director','planner'}:
  if path=='/api/planning/experimental-school':return method in{'GET','POST'}
  if re.fullmatch(r'/api/planning/experimental-school/exp_[a-f0-9]{32}',path):return method=='GET'
  if re.fullmatch(r'/api/planning/experimental-school/exp_[a-f0-9]{32}/version',path):return method=='GET'
  if re.fullmatch(r'/api/planning/experimental-school/exp_[a-f0-9]{32}/(edits/(preview|apply)|approval|publication/(preview|publish))',path):return method=='POST'
  if path=='/api/planning/school-source-registry':return method in{'GET','POST'}
  if path=='/api/planning/sources':return method=='GET'
  if path in{'/api/planning/sources/preview','/api/planning/sources/import'}:return method=='POST'
  if method=='GET'and path=='/api/school/publications':return True
  if method=='POST'and path in{'/api/school/publications/preview','/api/school/publications/publish'}:return True
  if match(LEGACY_RULES.get(method,[]),path):return True
  if method=='GET'and match([r'/api/launch/tasks',r'/api/launch/tasks/[^/]+',r'/api/launch/outbox',r'/api/launch/respondents'],path):return True
  if method=='POST'and match([r'/api/launch/tasks',r'/api/launch/recover',r'/api/launch/tasks/[^/]+/(transition|questions)',r'/api/launch/questions/[^/]+/answer',r'/api/launch/outbox/[^/]+/dry-run'],path):return True
  if method=='GET'and path in{'/api/school/calendar','/api/school/calendar/effective'}:return True
  if method=='PATCH'and path=='/api/school/calendar/config':return True
  if method=='POST'and match([r'/api/school/calendar/records/[^/]+',r'/api/school/calendar/records/[^/]+/[^/]+/(archive|restore)'],path):return True
  if method=='PATCH'and re.fullmatch(r'/api/school/calendar/records/[^/]+/[^/]+',path):return True
  if method=='POST'and path in{'/api/school/calendar/preview','/api/school/calendar/resolve-date'}:return True
 if role=='teacher':
  if method=='GET'and match([r'/api/launch/tasks',r'/api/launch/tasks/[^/]+'],path):return True
  if method=='POST'and re.fullmatch(r'/api/launch/questions/[^/]+/answer',path):return True
  if method=='GET'and path in{'/api/school/calendar','/api/school/calendar/effective'}:return True
  if method=='POST'and path=='/api/school/calendar/resolve-date':return True
 # Core state, finance, student records, generic workspace, demo, unknown routes: deny.
 return False

def enforce(profile,method,path):
 if not allowed(profile['staffRole'],method,path):raise HTTPException(403,'Для этой роли действие недоступно')

def domain_profile(profile,roles,path):
 if not profile.get('staffRole'):return profile
 if profile['staffRole']=='planner'and 'planner'not in roles and 'admin'in roles and any(path==p or path.startswith(p+'/')for p in LEGACY_MANAGE):return {**profile,'role':'admin'}
 return profile
