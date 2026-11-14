import {useCallback,useEffect,useRef,useState} from 'react'
import {apiFetch,APP_BASE,SESSION_EXPIRED_EVENT} from './api'

export type LearningRole='teacher'|'student'|'director'
export type LearningState={ai:{enabled:boolean;status:'configured'|'off'};max:{enabled:false;status:'off'}}
export type Assignment={id:string;revision:number;title:string;subject:string;topic:string;className:string;content:string;kind:'teacher_assignment'|'self_practice';status:'sent'|'active'|'submitted'|'revision_requested'|'reviewed';createdAt:string;dueAt:string|null}
export type TeacherAssignment=Assignment&{studentId:string;gap:string;answers:string;teacherMemberId:string}
export type LearningMessage={id:string;kind:'assignment'|'teacher'|'student'|'tutor';text:string;at:string}
export type WorkAttempt={id:string;text:string;submittedAt:string;review:{decision:'revision_requested'|'reviewed';comment:string;reviewedAt:string}|null}
export type AssignmentWork={draft:{text:string}|null;attempts:WorkAttempt[]}
export type AssignmentDetail<T extends Assignment=Assignment>={assignment:T;thread:{revision:number};messages:LearningMessage[];work:AssignmentWork}
export const assignmentStatusLabel=(status:Assignment['status'])=>({sent:'Выдано',active:'Личная тренировка',submitted:'На проверке',revision_requested:'На доработке',reviewed:'Проверено'}[status])
export function formatLearningDue(value:string|null|undefined){if(!value)return 'Без срока';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})+' мск':'Срок не подтверждён'}
export type AllowedStudent={id:string;name:string;className:string;subjects:string[];accountReady:boolean}
export type TeacherLearning=LearningState&{students:AllowedStudent[];assignments:TeacherAssignment[]}
export type StudentLearning=LearningState&{student:{name:string;className:string};assignments:Assignment[];practiceSubjects:string[];practiceSubjectSource:'published'|'personal'}
export type StudentAccessRow={id:string;name:string;className:string;username:string|null;status:'not_invited'|'invited'|'active'|'revoked'}
export type StudentInvitation={nominationId:string;invite:{path:string;expiresAt:number};student:{id:string;name:string;className:string}}
type Obj=Record<string,unknown>
const obj=(x:unknown):x is Obj=>!!x&&typeof x==='object'&&!Array.isArray(x)
export const learningTextLength=(value:string)=>Array.from(value).length
const text=(x:unknown,n:number)=>typeof x==='string'&&learningTextLength(x)<=n
const nonblank=(x:unknown,n:number)=>text(x,n)&&!!(x as string).trim()
const positive=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=1&&Number(x)<=2147483647
const list=(x:unknown,n:number,test:(v:unknown)=>boolean)=>Array.isArray(x)&&x.length<=n&&x.every(test)
const exact=(x:Obj,keys:string[])=>Object.keys(x).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(x,k))
const student=(x:unknown):boolean=>obj(x)&&nonblank(x.id,80)&&nonblank(x.name,120)&&nonblank(x.className,160)
const state=(x:Obj)=>obj(x.ai)&&typeof x.ai.enabled==='boolean'&&['configured','off'].includes(String(x.ai.status))&&(x.ai.enabled===(x.ai.status==='configured'))&&obj(x.max)&&x.max.enabled===false&&x.max.status==='off'
const baseKeys=['id','revision','title','subject','topic','className','content','status','createdAt','kind','dueAt']
export function validAssignment(x:unknown,teacher=false):x is TeacherAssignment{
 if(!obj(x)||!exact(x,teacher?[...baseKeys,'studentId','gap','answers','teacherMemberId']:baseKeys))return false
 return nonblank(x.id,80)&&positive(x.revision)&&nonblank(x.title,200)&&nonblank(x.subject,160)&&nonblank(x.topic,240)&&nonblank(x.className,160)&&text(x.content,4000)&&(x.kind==='self_practice'||nonblank(x.content,4000))&&((x.kind==='teacher_assignment'&&['sent','submitted','revision_requested','reviewed'].includes(String(x.status)))||(!teacher&&x.kind==='self_practice'&&x.status==='active'))&&nonblank(x.createdAt,80)&&(x.dueAt===null||nonblank(x.dueAt,80)&&Number.isFinite(Date.parse(String(x.dueAt))))&&(!teacher||(nonblank(x.studentId,80)&&text(x.gap,2000)&&text(x.answers,8000)&&nonblank(x.teacherMemberId,160)))
}
export function validDetail(x:unknown,teacher=false):x is AssignmentDetail<TeacherAssignment>{
 if(!obj(x)||!validAssignment(x.assignment,teacher)||!obj(x.thread)||!positive(x.thread.revision)||x.thread.revision!==x.assignment.revision||!list(x.messages,200,v=>obj(v)&&exact(v,['id','kind','text','at'])&&nonblank(v.id,80)&&['assignment','teacher','student','tutor'].includes(String(v.kind))&&nonblank(v.text,4000)&&nonblank(v.at,80)))return false
 const work=x.work
 return obj(work)&&exact(work,['draft','attempts'])&&(teacher||x.assignment.kind==='self_practice'?work.draft===null:obj(work.draft)&&exact(work.draft,['text'])&&text(work.draft.text,8000))&&list(work.attempts,100,v=>obj(v)&&exact(v,['id','text','submittedAt','review'])&&nonblank(v.id,80)&&nonblank(v.text,8000)&&nonblank(v.submittedAt,80)&&(v.review===null||obj(v.review)&&exact(v.review,['decision','comment','reviewedAt'])&&['revision_requested','reviewed'].includes(String(v.review.decision))&&text(v.review.comment,2000)&&nonblank(v.review.reviewedAt,80)))
}
export function validTeacherLearning(x:unknown):x is TeacherLearning{return obj(x)&&state(x)&&list(x.students,5000,v=>obj(v)&&student(v)&&list(v.subjects,2000,s=>nonblank(s,160))&&typeof v.accountReady==='boolean')&&list(x.assignments,2000,v=>validAssignment(v,true))}
export function validStudentLearning(x:unknown):x is StudentLearning{return obj(x)&&state(x)&&obj(x.student)&&exact(x.student,['name','className'])&&nonblank(x.student.name,120)&&nonblank(x.student.className,160)&&list(x.assignments,2000,v=>validAssignment(v))&&list(x.practiceSubjects,2000,v=>nonblank(v,160))&&['published','personal'].includes(String(x.practiceSubjectSource))}
export function validAccess(x:unknown):x is {students:StudentAccessRow[]}{return obj(x)&&list(x.students,5000,v=>obj(v)&&student(v)&&(v.username===null||nonblank(v.username,80))&&['not_invited','invited','active','revoked'].includes(String(v.status)))}
export function safeInvitationPath(path:unknown):string{
 if(typeof path!=='string'||path.length>2048||/[\s\\]/.test(path))return ''
 const base=APP_BASE.endsWith('/')?APP_BASE:APP_BASE+'/'
 // Same application only. No query, external host, pathname alias or encoded path.
 if(!path.startsWith(base+'#invite='))return ''
 const token=path.slice((base+'#invite=').length)
 return /^[A-Za-z0-9_-]{20,512}$/.test(token)?path:''
}
export function validInvitation(x:unknown):x is StudentInvitation{return obj(x)&&nonblank(x.nominationId,80)&&obj(x.invite)&&!!safeInvitationPath(x.invite.path)&&typeof x.invite.expiresAt==='number'&&Number.isFinite(x.invite.expiresAt)&&x.invite.expiresAt>0&&x.invite.expiresAt<=8640000000000&&student(x.student)}

export class LearningApiError extends Error{constructor(public status:number,message:string){super(message)}}
const messages:Record<number,string>={401:'Сеанс завершён. Войдите снова.',403:'Действие не разрешено. Проверьте доступ и выбранные данные.',404:'Запись недоступна. Обновите список.',409:'Данные изменились или запрос уже выполняется. Обновите переписку; введённый текст сохранён.',413:'Текст слишком большой.',425:'Этот запрос ИИ ещё выполняется. Повторите тот же запрос позже; новая команда не создаётся.',422:'Проверьте обязательные поля и длину текста.',429:'Достигнут защитный предел. Повторите позже.',503:'Сервис не подтвердил результат. Автоматического повторного вызова ИИ нет; прежние данные сохранены.'}
/** No server exception text is displayed: it may contain provider or private metadata. */
export function useLearningClient(role:LearningRole,ownerId:string,onDenied:()=>void){
 const [authority,setAuthority]=useState<'current'|'uncertain'|'denied'>('current')
 const alive=useRef(true),denied=useRef(false),controllers=useRef(new Set<AbortController>()),denyCallback=useRef(onDenied)
 denyCallback.current=onDenied
 const invalidate=useCallback(()=>{if(denied.current)return;denied.current=true;controllers.current.forEach(c=>c.abort());if(alive.current){setAuthority('denied');denyCallback.current()}},[])
 useEffect(()=>{alive.current=true;const expired=()=>invalidate();window.addEventListener(SESSION_EXPIRED_EVENT,expired);return()=>{alive.current=false;controllers.current.forEach(c=>c.abort());window.removeEventListener(SESSION_EXPIRED_EVENT,expired)}},[invalidate])
 const verify=useCallback(async()=>{
  if(denied.current)return false
  try{const r=await apiFetch('/api/staff/me');if(r.status===401||r.status===403){invalidate();return false}if(!r.ok)throw Error();const value:unknown=await r.json();if(!obj(value)||!obj(value.profile)||value.profile.membershipVerified!==true||value.profile.staffRole!==role||value.profile.userId!==ownerId){invalidate();return false}if(alive.current)setAuthority('current');return true}catch{if(!denied.current&&alive.current)setAuthority('uncertain');return false}
 },[invalidate,ownerId,role])
 const request=useCallback(async<T,>(path:string,validate:(v:unknown)=>v is T,body?:unknown):Promise<T>=>{
  if(denied.current)throw new LearningApiError(401,messages[401])
  const controller=new AbortController();controllers.current.add(controller);const timeout=setTimeout(()=>controller.abort(),body===undefined?20000:120000)
  try{
   const r=await apiFetch(path,{signal:controller.signal,headers:{'X-Learning-Owner':ownerId},...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Owner':ownerId},body:JSON.stringify(body)})})
   if(r.status===401){invalidate();throw new LearningApiError(401,messages[401])}
   if(r.status===403){await verify();throw new LearningApiError(403,messages[403])}
   if(!r.ok)throw new LearningApiError(r.status,messages[r.status]||'Сервер не подтвердил результат. Сохранённые данные не заменены.')
   const value:unknown=await r.json();if(!validate(value))throw new LearningApiError(502,'Ответ сервера неполон. Обновите данные; результат отправки пока не подтверждён.')
   if(denied.current||!alive.current)throw new LearningApiError(401,messages[401])
   return value
  }catch(cause){if(cause instanceof LearningApiError)throw cause;throw new LearningApiError(0,'Нет подтверждённого ответа. Повторите тот же запрос, чтобы проверить его результат.')}
  finally{clearTimeout(timeout);controllers.current.delete(controller)}
 },[invalidate,verify])
 return {request,authority,verify}
}
type Pending={path:string;body:Record<string,unknown>;label:string}
export function newLearningId(){return 'learning:'+crypto.randomUUID()}
/** Frozen command survives response loss. No automatic retry or second request ID. */
export function useLearningMutation<T>(client:ReturnType<typeof useLearningClient>,validate:(v:unknown)=>v is T,onSuccess:(v:T)=>void){
 const [pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const lock=useRef(false),command=useRef<Pending|null>(null),callback=useRef(onSuccess);callback.current=onSuccess
 const clear=useCallback(()=>{command.current=null;setPending(null);setError('')},[])
 useEffect(()=>{if(client.authority==='denied')clear()},[client.authority,clear])
 async function send(next:Pending){
  if(lock.current||client.authority!=='current')return
  lock.current=true;setBusy(true);setError('');command.current=next;setPending(next)
  try{const value=await client.request(next.path,validate,next.body);command.current=null;setPending(null);callback.current(value)}
  catch(cause){const e=cause instanceof LearningApiError?cause:new LearningApiError(0,'Нет подтверждённого ответа.');setError(e.message);if(e.status>=400&&e.status<500&&e.status!==425){command.current=null;setPending(null)}}
  finally{lock.current=false;setBusy(false)}
 }
 return {busy,pending,error,clear,run:(path:string,body:Record<string,unknown>,label:string)=>{if(command.current||lock.current)return;void send({path,body:{...body,requestId:newLearningId()},label})},retry:()=>{if(command.current)void send(command.current)}}
}
