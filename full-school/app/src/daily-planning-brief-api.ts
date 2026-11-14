import {apiFetch} from './api'

export type DailyWindow={start:string;end:string}
export type DailyTeacherOverride={teacherId:string;status:'unknown'|'available'|'unavailable';windows:DailyWindow[];contacted:boolean;comment:string}
export type DailyBriefContent={targetDate:string;callReview:'none'|'recorded'|'pending';teacherOverrides:DailyTeacherOverride[];confirmedLessonIds:string[]}
export type DailySourceBinding={schoolId:string;targetDate:string;draftRevision:number;draftHash:string;configRevision:number;configHash:string|null;calendarRevision:number;calendarHash:string}
export type DailyRunBinding={targetDate:string;revision:number;sourceBindingHash:string;briefHash:string}
export type DailyRunInput={expectedConfigRevision:number;expectedDraftRevision:number;periodStart:string;mode:'repair';dailyBrief:DailyRunBinding}
export type DailyBriefView={version:1;targetDate:string;weekStart:string;sourceName:string|null;timezone:'Europe/Moscow';revision:number;saved:boolean;content:DailyBriefContent;sourceBinding:DailySourceBinding;sourceBindingHash:string;briefHash:string|null;previewHash:string|null;teachers:{id:string;name:string;sourceKind:'planning_id'|'source_label'}[];lessons:{id:string;className:string;day:number;slot:number;start:string;end:string;subject:string;teachers:string[];rooms:string[]}[];readiness:{ready:boolean;blockers:{code:string;message:string;entityIds:string[]}[];missingForms:string[]};dailyBriefBinding:DailyRunBinding|null;runInput:DailyRunInput|null;receipt:{requestId:string;revision:number;briefHash:string}|null;notice:string}
export type DailyPreviewInput=DailyBriefContent&{expectedRevision:number;expectedSourceBindingHash:string}
export type DailySaveInput=DailyPreviewInput&{previewHash:string;requestId:string}
export type DailyPreflightInput={targetDate:string;expectedRevision:number;expectedSourceBindingHash:string}
export type DailyRunCommand=DailyRunInput&{requestId:string}
export type DailyCreatedRun={id:string;status:string;mode:'repair';configRevision:number;draftRevision:number;periodStart:string;dailyBriefBinding:DailyRunBinding}
const base='/api/planning/daily-brief'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key))
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Array.from(v).length<=max&&!Array.from(v).some(char=>/[\p{Cc}\p{Cs}]/u.test(char)&&!['\n','\r','\t'].includes(char))
const label=(v:unknown,max=160):v is string=>text(v,max)&&!!v.trim()&&!/[\r\n\t]/.test(v)
const integer=(v:unknown,max=2147483647,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const unique=(values:unknown[])=>new Set(values).size===values.length
const list=(v:unknown,max:number,test:(v:unknown)=>boolean):v is unknown[]=>Array.isArray(v)&&v.length<=max&&v.every(test)
const stringList=(v:unknown,max:number,length:number)=>list(v,max,item=>label(item,length))
export function dailyDate(value:unknown):value is string{
 if(typeof value!=='string'||!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))return false
 const stamp=Date.parse(value+'T00:00:00Z')
 return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value
}
export function tomorrowInMoscow(){const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)}
export const dailyTime=(v:unknown):v is string=>typeof v==='string'&&/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)
function validWindows(value:unknown):value is DailyWindow[]{
 if(!list(value,20,item=>object(item)&&exact(item,['start','end'])&&dailyTime(item.start)&&dailyTime(item.end)&&item.start<item.end))return false
 const sorted=[...value as DailyWindow[]].sort((a,b)=>a.start.localeCompare(b.start))
 return sorted.every((row,index)=>index===0||row.start>=sorted[index-1].end)
}
export function validDailyContent(value:unknown):value is DailyBriefContent{
 return object(value)&&exact(value,['targetDate','callReview','teacherOverrides','confirmedLessonIds'])&&dailyDate(value.targetDate)&&typeof value.callReview==='string'&&['none','recorded','pending'].includes(value.callReview)&&
  list(value.teacherOverrides,200,row=>object(row)&&exact(row,['teacherId','status','windows','contacted','comment'])&&label(row.teacherId)&&typeof row.status==='string'&&['unknown','available','unavailable'].includes(row.status)&&validWindows(row.windows)&&typeof row.contacted==='boolean'&&text(row.comment,2000)&&(row.status==='available'?row.windows.length>0:row.windows.length===0))&&unique(value.teacherOverrides.map(row=>(row as DailyTeacherOverride).teacherId))&&
  stringList(value.confirmedLessonIds,2000,80)&&unique(value.confirmedLessonIds as string[])
}
export function equalDailyContent(first:DailyBriefContent,second:DailyBriefContent){
 const normalized=(value:DailyBriefContent)=>({targetDate:value.targetDate,callReview:value.callReview,teacherOverrides:value.teacherOverrides.map(row=>({...row,comment:row.comment.trim(),windows:[...row.windows].sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))})).sort((a,b)=>a.teacherId.localeCompare(b.teacherId)),confirmedLessonIds:[...value.confirmedLessonIds].sort()})
 return JSON.stringify(normalized(first))===JSON.stringify(normalized(second))
}
function validBinding(value:unknown):value is DailyRunBinding{return object(value)&&exact(value,['targetDate','revision','sourceBindingHash','briefHash'])&&dailyDate(value.targetDate)&&integer(value.revision,2147483647,1)&&hash(value.sourceBindingHash)&&hash(value.briefHash)}
function sameBinding(first:DailyRunBinding,second:DailyRunBinding){return first.targetDate===second.targetDate&&first.revision===second.revision&&first.sourceBindingHash===second.sourceBindingHash&&first.briefHash===second.briefHash}
export function validDailyView(value:unknown,targetDate:string,schoolId:string):value is DailyBriefView{
 if(!object(value)||!exact(value,['version','targetDate','weekStart','sourceName','timezone','revision','saved','content','sourceBinding','sourceBindingHash','briefHash','previewHash','teachers','lessons','readiness','dailyBriefBinding','runInput','receipt','notice'])||value.version!==1||value.targetDate!==targetDate||!dailyDate(value.targetDate)||!dailyDate(value.weekStart)||new Date(value.weekStart+'T00:00:00Z').getUTCDay()!==1||Date.parse(targetDate)<Date.parse(value.weekStart)||Date.parse(targetDate)-Date.parse(value.weekStart)>6*86400000||(value.sourceName!==null&&!label(value.sourceName,180))||value.timezone!=='Europe/Moscow'||!integer(value.revision)||typeof value.saved!=='boolean'||!validDailyContent(value.content)||value.content.targetDate!==targetDate||!hash(value.sourceBindingHash)||(value.briefHash!==null&&!hash(value.briefHash))||(value.previewHash!==null&&!hash(value.previewHash))||!text(value.notice,4000))return false
 const source=value.sourceBinding
 if(!object(source)||!exact(source,['schoolId','targetDate','draftRevision','draftHash','configRevision','configHash','calendarRevision','calendarHash'])||source.schoolId!==schoolId||source.targetDate!==targetDate||!integer(source.draftRevision)||!hash(source.draftHash)||!integer(source.configRevision)||(source.configHash!==null&&!hash(source.configHash))||!integer(source.calendarRevision)||!hash(source.calendarHash))return false
 if(!list(value.teachers,300,row=>object(row)&&exact(row,['id','name','sourceKind'])&&label(row.id)&&label(row.name)&&typeof row.sourceKind==='string'&&['planning_id','source_label'].includes(row.sourceKind))||!unique(value.teachers.map(row=>(row as {id:string}).id))||
  !list(value.lessons,2000,row=>object(row)&&exact(row,['id','className','day','slot','start','end','subject','teachers','rooms'])&&label(row.id)&&label(row.className,80)&&integer(row.day,5)&&integer(row.slot,20,1)&&dailyTime(row.start)&&dailyTime(row.end)&&row.start<row.end&&label(row.subject)&&stringList(row.teachers,8,120)&&stringList(row.rooms,8,80))||!unique(value.lessons.map(row=>(row as {id:string}).id)))return false
 const ready=value.readiness
 if(!object(ready)||!exact(ready,['ready','blockers','missingForms'])||typeof ready.ready!=='boolean'||!list(ready.blockers,2000,row=>object(row)&&exact(row,['code','message','entityIds'])&&label(row.code,80)&&text(row.message,2000)&&!!row.message.trim()&&stringList(row.entityIds,2000,160))||!stringList(ready.missingForms,2000,2000)||ready.ready&&(ready.blockers.length>0||ready.missingForms.length>0))return false
 if(value.receipt!==null&&(!object(value.receipt)||!exact(value.receipt,['requestId','revision','briefHash'])||!label(value.receipt.requestId,80)||value.receipt.revision!==value.revision||value.receipt.briefHash!==value.briefHash))return false
 if(value.dailyBriefBinding!==null&&(!validBinding(value.dailyBriefBinding)||value.dailyBriefBinding.targetDate!==targetDate||value.dailyBriefBinding.revision!==value.revision||value.dailyBriefBinding.sourceBindingHash!==value.sourceBindingHash||value.dailyBriefBinding.briefHash!==value.briefHash))return false
 if(value.runInput!==null){
  const run=value.runInput
  if(!object(run)||!exact(run,['expectedConfigRevision','expectedDraftRevision','periodStart','mode','dailyBrief'])||run.expectedConfigRevision!==source.configRevision||run.expectedDraftRevision!==source.draftRevision||run.periodStart!==value.weekStart||run.mode!=='repair'||!validBinding(run.dailyBrief)||!validBinding(value.dailyBriefBinding)||!sameBinding(run.dailyBrief,value.dailyBriefBinding)||!value.saved||!ready.ready||source.configHash===null)return false
 }
 return true
}
export function validDailyRun(value:unknown,command:DailyRunCommand):value is DailyCreatedRun{
 return object(value)&&label(value.id,100)&&typeof value.id==='string'&&/^run_[A-Za-z0-9_-]+$/.test(value.id)&&typeof value.status==='string'&&['queued','running','optimal','feasible','infeasible','unknown','invalid','failed','interrupted','cancelled','stale','approved','rejected'].includes(value.status)&&value.mode==='repair'&&value.configRevision===command.expectedConfigRevision&&value.draftRevision===command.expectedDraftRevision&&value.periodStart===command.periodStart&&validBinding(value.dailyBriefBinding)&&sameBinding(value.dailyBriefBinding,command.dailyBrief)
}
export class DailyBriefError extends Error{constructor(public status:number,message:string){super(message)}}
export const ambiguousDailyFailure=(status:number)=>status===0||status===408||status===425||status===429||status>=500
export async function dailyBriefRequest(path:'load'|'preview'|'save'|'preflight'|'run',ownerId:string,signal:AbortSignal,body?:DailyPreviewInput|DailySaveInput|DailyPreflightInput|DailyRunCommand,targetDate?:string):Promise<unknown>{
 try{
  const url=path==='run'?'/api/planning/runs':path==='load'?base+'?'+new URLSearchParams({targetDate:targetDate||''}):base+'/'+path
  const response=await apiFetch(url,{headers:{'X-Learning-Owner':ownerId,...(body?{'Content-Type':'application/json'}:{})},signal,cache:'no-store',...(body?{method:'POST',body:JSON.stringify(body)}:{})})
  if(!response.ok)throw new DailyBriefError(response.status,response.status===409?'Исходные сведения изменились. Обновите их и проверьте бриф.':response.status===422?'Проверьте дату, ответы и интервалы доступности.':response.status===401||response.status===403?'Доступ к планированию не подтверждён.':'Сервер не подтвердил результат. Повторите действие.')
  return await response.json().catch(()=>{throw new DailyBriefError(0,'Сервер вернул неполный ответ. Результат не подтверждён.')})
 }catch(cause){if(cause instanceof DailyBriefError)throw cause;throw new DailyBriefError(0,'Нет подтверждённого ответа сервера. Повторите действие.')}
}
