import {useCallback,useEffect,useId,useRef,useState} from 'react'
import {CalendarDays,Plus,RefreshCw,Trash2} from 'lucide-react'
import {SESSION_EXPIRED_EVENT} from './api'
import {ambiguousDailyFailure,dailyBriefRequest,dailyDate,dailyTime,DailyBriefError,equalDailyContent,tomorrowInMoscow,validDailyContent,validDailyRun,validDailyView,type DailyBriefContent,type DailyBriefView,type DailyPreviewInput,type DailyRunCommand,type DailySaveInput,type DailyTeacherOverride} from './daily-planning-brief-api'
import './daily-planning-brief.css'

type Props={schoolId:string;actorId:string;disabled?:boolean;active?:boolean;onRunCreated:(runId:string,targetDate:string)=>void;onOpenConditions?:(targetDate:string)=>void;onOpenCalendar?:(targetDate:string)=>void;focusRequest?:number}
type Action='load'|'preview'|'save'|'preflight'|'run'
type Pending={kind:'save';body:DailySaveInput;continueToRun?:boolean}|{kind:'run';body:DailyRunCommand}
const clone=(content:DailyBriefContent):DailyBriefContent=>({...content,teacherOverrides:content.teacherOverrides.map(row=>({...row,windows:row.windows.map(window=>({...window}))})),confirmedLessonIds:[...content.confirmedLessonIds]})
const unconfirmed=()=>new DailyBriefError(0,'Сервер вернул неполный ответ. Результат не подтверждён.')
const missingFormLabel=(key:string)=>({normativePlan:'Нормативная модель: группы, кабинеты, связи и нагрузка',calendar:'Школьный календарь выбранной недели'}[key]||'Дополнительные условия расчёта — уточните сведения из списка выше')
const rowCount=(count:number)=>`${count} ${new Intl.PluralRules('ru').select(count)==='one'?'строка':new Intl.PluralRules('ru').select(count)==='few'?'строки':'строк'}`
const contentForRequest=(content:DailyBriefContent)=>({...clone(content),teacherOverrides:content.teacherOverrides.map(row=>({...row,comment:row.comment.trim(),windows:[...row.windows].sort((a,b)=>a.start.localeCompare(b.start))}))})

export default function DailyPlanningBrief({schoolId,actorId,disabled=false,active=true,onRunCreated,onOpenConditions,onOpenCalendar,focusRequest}:Props){
 const headingId=useId(),identity=JSON.stringify([schoolId,actorId])
 const [targetDate,setTargetDate]=useState(tomorrowInMoscow),[catalog,setCatalog]=useState<{key:string;data:DailyBriefView}|null>(null),[form,setForm]=useState<DailyBriefContent|null>(null)
 const [preview,setPreview]=useState<DailyBriefView|null>(null),[preflight,setPreflight]=useState<DailyBriefView|null>(null),[pending,setPending]=useState<Pending|null>(null)
 const [busy,setBusy]=useState<Action|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[denied,setDenied]=useState(false),[stale,setStale]=useState(false),[chosenTeacher,setChosenTeacher]=useState(''),[createdRun,setCreatedRun]=useState<{id:string;date:string}|null>(null),[initialReadEpoch,setInitialReadEpoch]=useState(0)
 const operation=useRef<{controller:AbortController;sequence:number;kind:Action}|null>(null),sequence=useRef(0),alive=useRef(true),activeRef=useRef(active),disabledRef=useRef(disabled),formRef=useRef(form),dataRef=useRef<DailyBriefView|null>(null),callback=useRef(onRunCreated),handoffs=useRef(new Set<string>())
 const [pipelineGoal,setPipelineGoal]=useState<'save'|'run'|null>(null)
 const pipeline=useRef<number|null>(null),pipelineSequence=useRef(0),sourceEpoch=useRef(0),contextKey=useRef(''),refreshOnReturn=useRef(false),lastFocusRequest=useRef<number|undefined>(undefined),firstActivationDate=useRef<string|null>(active?null:'')
 const heading=useRef<HTMLHeadingElement>(null)
 const section=useRef<HTMLElement>(null),previewHeading=useRef<HTMLHeadingElement>(null),readinessHeading=useRef<HTMLHeadingElement>(null),teacherPicker=useRef<HTMLSelectElement>(null),callReviewField=useRef<HTMLSelectElement>(null),statusFields=useRef(new Map<string,HTMLSelectElement>()),focusAfter=useRef<'heading'|'preview'|'preflight'|'add'|{teacherId:string}|null>(null)
 activeRef.current=active;disabledRef.current=disabled;formRef.current=form;callback.current=onRunCreated
 const key=identity+':'+targetDate,data=!denied&&!disabled&&catalog?.key===key?catalog.data:null
 contextKey.current=key;dataRef.current=data
 const currentForm=data&&form?.targetDate===targetDate?form:null
 const dirty=!!data&&!!currentForm&&(!data.saved||!equalDailyContent(currentForm,data.content))
 const mutation=busy==='save'||busy==='run',blocked=disabled||denied||!!pending||mutation||!!pipelineGoal
 const readiness=preflight?.readiness||preview?.readiness||data?.readiness
 const readyToRun=!!data&&!!currentForm&&!dirty&&!stale&&!busy&&!pending&&!pipelineGoal&&!!preflight?.readiness.ready&&!!preflight.runInput

 const stopPipeline=useCallback((forgetContinuation=true)=>{pipeline.current=null;setPipelineGoal(null);if(forgetContinuation)setPending(command=>command?.kind==='save'&&command.continueToRun?{...command,continueToRun:false}:command)},[])
 const stopRead=useCallback(()=>{if(operation.current&&['load','preview','preflight'].includes(operation.current.kind)){operation.current.controller.abort();operation.current=null;sequence.current++;setBusy(null)}},[])
 const clearPrivate=useCallback(()=>{stopPipeline();operation.current?.controller.abort();operation.current=null;sequence.current++;dataRef.current=null;formRef.current=null;focusAfter.current=null;handoffs.current.clear();setCatalog(null);setForm(null);setPreview(null);setPreflight(null);setPending(null);setCreatedRun(null);setChosenTeacher('');setBusy(null);setNotice('');setError('')},[stopPipeline])
 async function execute<T,>(kind:Action,body:Parameters<typeof dailyBriefRequest>[3],accept:(value:unknown)=>T):Promise<T|undefined>{
  if(operation.current||disabledRef.current||denied||!actorId||!schoolId)return
  const controller=new AbortController(),serial=++sequence.current,requestKey=key
  operation.current={controller,sequence:serial,kind};setBusy(kind);setError('');setNotice('')
  const timeout=setTimeout(()=>controller.abort(),kind==='run'?45000:20000)
  try{
   const value=await dailyBriefRequest(kind,actorId,controller.signal,body,targetDate)
   if(!alive.current||operation.current?.sequence!==serial||contextKey.current!==requestKey)return
   if(controller.signal.aborted)throw unconfirmed()
   return accept(value)
  }catch(cause){
   if(!alive.current||operation.current?.sequence!==serial||contextKey.current!==requestKey)return
   const failure=cause instanceof DailyBriefError?cause:unconfirmed()
   if(failure.status===401||failure.status===403){clearPrivate();setDenied(true);return}
   if(kind==='preview')setPreview(null)
   if(kind==='preflight')setPreflight(null)
   if((kind==='save'||kind==='run')&&!ambiguousDailyFailure(failure.status)){setPending(null);setPreview(null);setPreflight(null)}
   if(kind==='load'&&dataRef.current)setStale(true)
   if(failure.status===409){setStale(true);setPreview(null);setPreflight(null)}
   setError((kind==='save'||kind==='run')&&ambiguousDailyFailure(failure.status)?'Подтверждение не получено. Проверьте результат тем же сохранённым запросом.':failure.message)
  }finally{clearTimeout(timeout);if(operation.current?.sequence===serial){operation.current=null;if(alive.current)setBusy(null)}}
 }
 function load(keepEdits=false){
  if(!activeRef.current||operation.current||pending||disabledRef.current||denied||!dailyDate(targetDate))return
  if(firstActivationDate.current!==null&&!dataRef.current&&!formRef.current){firstActivationDate.current ||=tomorrowInMoscow();if(targetDate!==firstActivationDate.current){setTargetDate(firstActivationDate.current);return}}
  firstActivationDate.current=null
  const previous=dataRef.current
  setPreview(null);setPreflight(null);setStale(!!previous)
  void execute('load',undefined,value=>{
   if(!validDailyView(value,targetDate,schoolId))throw unconfirmed()
   const edited=keepEdits&&previous&&formRef.current&&!equalDailyContent(formRef.current,previous.content)?clone(formRef.current):null
   setCatalog({key,data:value});setForm(edited||clone(value.content));setPreview(null);setPreflight(null);setStale(false);if(!keepEdits)setCreatedRun(null)
   if(edited)setNotice('Исходные сведения обновлены. Ваши несохранённые ответы оставлены в форме — проверьте их.')
  })
 }
 useEffect(()=>{
  alive.current=true;setDenied(false);sourceEpoch.current++;clearPrivate();setStale(false)
  if(activeRef.current&&dailyDate(targetDate)&&!disabledRef.current)load()
  else if(!dailyDate(targetDate))setError('Выберите существующую дату планирования.')
  return()=>{sequence.current++;operation.current?.controller.abort();operation.current=null}
 },[identity,targetDate,disabled])
 useEffect(()=>{if(active&&!data&&!busy&&!error&&!disabled&&!denied)load()},[active,denied,disabled,initialReadEpoch])
 useEffect(()=>{
  if(!active){refreshOnReturn.current=true;stopPipeline(false);stopRead();return}
  if(!refreshOnReturn.current||disabled||denied)return
  if(!dataRef.current&&operation.current?.kind==='load'){refreshOnReturn.current=false;return}
  if(!operation.current&&!pending){refreshOnReturn.current=false;load(true)}
 },[active,busy,pending,disabled,denied,stopPipeline,stopRead])
 useEffect(()=>{
  const expire=()=>{clearPrivate();setDenied(true)}
  const changed=()=>{sourceEpoch.current++;stopPipeline();stopRead();setPreview(null);setPreflight(null);if(!dataRef.current){setStale(false);setError('');setNotice('');setInitialReadEpoch(value=>value+1);return}setStale(true);setNotice('Условия или расписание изменились. Обновите сведения и повторите проверку брифа.')}
  window.addEventListener(SESSION_EXPIRED_EVENT,expire);window.addEventListener('school-timetable-updated',changed);window.addEventListener('school-ops-updated',changed)
  return()=>{window.removeEventListener(SESSION_EXPIRED_EVENT,expire);window.removeEventListener('school-timetable-updated',changed);window.removeEventListener('school-ops-updated',changed);alive.current=false;operation.current?.controller.abort();operation.current=null}
 },[clearPrivate,stopRead,stopPipeline,identity])
 useEffect(()=>{if(focusRequest!==undefined&&focusRequest!==lastFocusRequest.current){lastFocusRequest.current=focusRequest;focusAfter.current='heading'}},[focusRequest])
 useEffect(()=>{
  if(!active||disabled||denied)return
  const target=focusAfter.current
  const node=target==='heading'?heading.current:target==='preview'?previewHeading.current:target==='preflight'?readinessHeading.current:target==='add'?(teacherPicker.current&&!teacherPicker.current.disabled?teacherPicker.current:callReviewField.current):target?statusFields.current.get(target.teacherId):null
  if(node?.isConnected&&!node.closest('[hidden],[inert]')&&node.getClientRects().length){focusAfter.current=null;node.focus({preventScroll:target==='heading'});if(target==='heading')node.scrollIntoView({block:'start',behavior:'auto'})}
 },[form,preview,preflight,active,disabled,denied,focusRequest])
 function change(next:DailyBriefContent){
  if(blocked)return
  stopPipeline();stopRead();setForm(next);setPreview(null);setPreflight(null);setCreatedRun(null);setError('');setNotice('')
 }
 function updateTeacher(index:number,patch:Partial<DailyTeacherOverride>){if(!currentForm)return;change({...currentForm,teacherOverrides:currentForm.teacherOverrides.map((row,i)=>i===index?{...row,...patch}:row)})}
 function checkedContent():DailyBriefContent|null{
  if(!currentForm||!data)return null
  const body=contentForRequest(currentForm)
  if(!validDailyContent(body)){setError('Проверьте преподавателей и окна: начало и окончание в формате ЧЧ:ММ, без пересечений. Для доступного преподавателя укажите хотя бы одно окно.');return null}
  const known=new Set(data.teachers.map(row=>row.id)),lessons=new Set(data.lessons.map(row=>row.id))
  if(body.teacherOverrides.some(row=>!known.has(row.teacherId))||body.confirmedLessonIds.some(id=>!lessons.has(id))){setError('В источнике изменились преподаватели или уроки. Сверьте сохранённые строки с текущими сведениями.');return null}
  return body
 }
 function requestPreview(content:DailyBriefContent,base:DailyBriefView,focus=true){
  const input:DailyPreviewInput={...content,expectedRevision:base.revision,expectedSourceBindingHash:base.sourceBindingHash}
  return execute('preview',input,value=>{
   if(!validDailyView(value,targetDate,schoolId)||value.revision!==input.expectedRevision||value.sourceBindingHash!==input.expectedSourceBindingHash||!value.previewHash||!equalDailyContent(value.content,content))throw unconfirmed()
   if(focus)focusAfter.current='preview';setPreview(value);setPreflight(null);return value
  })
 }
 function review(){if(blocked||busy||stale||!data)return;const content=checkedContent();if(content)void requestPreview(content,data)}
 function sendSave(command:Extract<Pending,{kind:'save'}>){
  if(disabled||denied||operation.current)return Promise.resolve(undefined)
  const epoch=sourceEpoch.current
  setPending(command)
  return execute('save',command.body,value=>{
   const {expectedRevision,expectedSourceBindingHash,requestId}=command.body
   if(!validDailyView(value,targetDate,schoolId)||!value.saved||value.revision!==expectedRevision+1||value.sourceBindingHash!==expectedSourceBindingHash||!value.receipt||value.receipt.requestId!==requestId||!value.briefHash||!equalDailyContent(value.content,command.body))throw unconfirmed()
   setCatalog({key,data:value});setForm(clone(value.content));setPreview(null);setPreflight(null);setPending(null);setStale(sourceEpoch.current!==epoch);setNotice('Бриф сохранён. Теперь проверьте готовность расчёта.');return value
  })
 }
 function save(){
  if(blocked||busy||stale||!data||!preview||!currentForm||!equalDailyContent(preview.content,contentForRequest(currentForm))||!preview.previewHash)return
  void sendSave({kind:'save',body:{...contentForRequest(currentForm),expectedRevision:data.revision,expectedSourceBindingHash:data.sourceBindingHash,previewHash:preview.previewHash,requestId:crypto.randomUUID()}})
 }
 function requestPreflight(base:DailyBriefView,content:DailyBriefContent,focus=true){
  return execute('preflight',{targetDate,expectedRevision:base.revision,expectedSourceBindingHash:base.sourceBindingHash},value=>{
   if(!validDailyView(value,targetDate,schoolId)||!value.saved||value.revision!==base.revision||value.sourceBindingHash!==base.sourceBindingHash||!equalDailyContent(value.content,content)||value.readiness.ready&&!value.runInput)throw unconfirmed()
   if(focus||!value.readiness.ready)focusAfter.current='preflight';setPreflight(value);return value
  })
 }
 function checkReadiness(){if(blocked||busy||stale||dirty||!data?.saved||!currentForm)return;void requestPreflight(data,currentForm)}
 function handoff(id:string,date:string){if(!activeRef.current||disabledRef.current||handoffs.current.has(id)||!section.current?.getClientRects().length||section.current.closest('[hidden],[inert]'))return;handoffs.current.add(id);callback.current(id,date)}
 function sendRun(command:Extract<Pending,{kind:'run'}>){
  if(disabled||denied||operation.current)return Promise.resolve(undefined)
  setPending(command)
  return execute('run',command.body,value=>{
   if(!validDailyRun(value,command.body))throw unconfirmed()
   setPending(null);setCreatedRun({id:value.id,date:command.body.dailyBrief.targetDate});setNotice('Расчёт создан. Откройте вариант, проверьте отличия и подтвердите его отдельно.');handoff(value.id,command.body.dailyBrief.targetDate);return value
  })
 }
 function calculate(){if(!readyToRun||!preflight?.runInput)return;void sendRun({kind:'run',body:{...preflight.runInput,requestId:crypto.randomUUID()}})}
 async function dailyFlow(goal:'save'|'run',retry?:Extract<Pending,{kind:'save'}>){
  if(pipeline.current!==null||operation.current||!activeRef.current||disabledRef.current||denied||!data||!currentForm||(!retry&&(pending||stale)))return
  const content=retry?contentForRequest(retry.body):checkedContent();if(!content)return
  if(retry)refreshOnReturn.current=false
  const ticket=++pipelineSequence.current,epoch=sourceEpoch.current,flowKey=key
  pipeline.current=ticket;setPipelineGoal(goal)
  const continuing=()=>pipeline.current===ticket&&activeRef.current&&!disabledRef.current&&sourceEpoch.current===epoch&&contextKey.current===flowKey
  try{
   let saved:DailyBriefView|undefined=data
   if(retry)saved=await sendSave({...retry,continueToRun:goal==='run'})
   else{
    const reviewed=await requestPreview(content,data,false)
    if(!reviewed||!continuing())return
    if(!data.saved||!equalDailyContent(content,data.content)||data.readiness.blockers.some(issue=>issue.code==='daily_source_changed'))saved=await sendSave({kind:'save',continueToRun:goal==='run',body:{...content,expectedRevision:data.revision,expectedSourceBindingHash:data.sourceBindingHash,previewHash:reviewed.previewHash!,requestId:crypto.randomUUID()}})
   }
   if(!saved||!continuing())return
   if(goal==='save'){setNotice('Ответы сохранены. Расчёт не запускался.');return}
   const ready=await requestPreflight(saved,content,false)
   if(!ready||!continuing())return
   if(!ready.readiness.ready||!ready.runInput){focusAfter.current='preflight';setNotice('Ответы сохранены. Перед расчётом завершите уточнения и заполните условия ниже.');return}
   await sendRun({kind:'run',body:{...ready.runInput,requestId:crypto.randomUUID()}})
  }finally{if(pipeline.current===ticket)stopPipeline(false)}
 }
 function retryPending(){if(!pending||!activeRef.current)return;if(pending.kind==='save'&&pending.continueToRun)void dailyFlow('run',pending);else if(pending.kind==='save')void sendSave(pending);else void sendRun(pending)}
 const available=data?.teachers.filter(teacher=>!currentForm?.teacherOverrides.some(row=>row.teacherId===teacher.id))||[]
 const unknownRows=currentForm?.teacherOverrides.filter(row=>!data?.teachers.some(teacher=>teacher.id===row.teacherId))||[]
 const missingLessons=currentForm?.confirmedLessonIds.filter(id=>!data?.lessons.some(row=>row.id===id))||[]
 const controlsBlocked=blocked

 return <section ref={section} className="dpb cp-stack" hidden={!active} aria-labelledby={headingId} aria-busy={!!busy||!!pipelineGoal}>
  <div className="sg-panel">
   <div className="dpb-header"><div><p className="dpb-eyebrow">Перед ежедневным расчётом</p><h2 ref={heading} id={headingId} tabIndex={-1}>План на день</h2></div><span className="dpb-badge"><CalendarDays size={14}/>&nbsp;{targetDate||'Выберите дату'}</span></div>
   <div className="dpb-fields"><label className="dpb-field dpb-date">Дата планирования<input type="date" value={targetDate} disabled={controlsBlocked} onChange={event=>setTargetDate(event.target.value)}/></label><div className="dpb-actions"><button type="button" className="sg-control" disabled={controlsBlocked} onClick={()=>setTargetDate(tomorrowInMoscow())}>На завтра</button><button type="button" className="sg-control" disabled={blocked||!!busy||!dailyDate(targetDate)} onClick={()=>load(true)}><RefreshCw size={16}/>Обновить сведения</button></div></div>
   {data&&<p className="dpb-note">Источник: {data.sourceName||'Название источника не указано'}</p>}
   <p>Если кому-нибудь уже звонили, внесите ответы сейчас.</p>
   {denied||disabled?<p role="status">Доступ к планированию не подтверждён.</p>:<>
    {busy==='load'&&<div className="dpb-loading" role="status"><span className="dpb-skeleton" aria-hidden="true"/><span className="dpb-skeleton" aria-hidden="true"/>Загружаем бриф на выбранную дату…</div>}
    {error&&<div className="dpb-message" role="alert"><p>{error}</p>{!data&&!busy&&!pending&&<div className="dpb-actions"><button type="button" className="sg-control" onClick={()=>load()}>Повторить загрузку брифа</button></div>}</div>}
    {notice&&<p className="dpb-message dpb-success" role="status">{notice}</p>}
    {stale&&<p className="dpb-message dpb-warning" role="status">Исходные сведения требуют обновления. Введённые ответы оставлены в форме.</p>}
    {pending&&<div className="dpb-message dpb-warning" role="status"><p>Запрос сохранён в открытом разделе. Повтор проверит тот же результат; новая команда не создаётся.</p><div className="dpb-actions"><button type="button" className="sg-control" disabled={!!busy} onClick={retryPending}>Проверить сохранённый запрос</button></div></div>}
    {data&&currentForm&&<>
     <label className="dpb-field">Сведения после звонков<select ref={callReviewField} value={currentForm.callReview} disabled={controlsBlocked} onChange={event=>change({...currentForm,callReview:event.target.value as DailyBriefContent['callReview']})}><option value="none">Оставить прежние сведения</option><option value="recorded">Ответы после звонков внесены</option><option value="pending">Ответы ещё ожидаются</option></select></label>
     <p className="dpb-note">«Оставить прежние сведения» сохраняет исходные условия. Это не отметка о звонках. Отсутствие ответа не означает доступность.</p>
     <div className="dpb-row-heading"><div><h3>Кто под вопросом</h3><p className="dpb-muted">Добавьте тех, чьи условия на эту дату нужно уточнить.</p></div><span className="dpb-badge">{rowCount(currentForm.teacherOverrides.length)}</span></div>
     <div className="dpb-fields"><label className="dpb-field">Преподаватель для уточнения<select ref={teacherPicker} value={chosenTeacher} disabled={controlsBlocked||!available.length||currentForm.teacherOverrides.length>=200} onChange={event=>setChosenTeacher(event.target.value)}><option value="">Выберите преподавателя</option>{available.map(teacher=><option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select></label><div className="dpb-actions"><button type="button" className="sg-control" disabled={controlsBlocked||!chosenTeacher||!available.some(row=>row.id===chosenTeacher)||currentForm.teacherOverrides.length>=200} onClick={()=>{focusAfter.current={teacherId:chosenTeacher};change({...currentForm,teacherOverrides:[...currentForm.teacherOverrides,{teacherId:chosenTeacher,status:'unknown',windows:[],contacted:false,comment:''}]});setChosenTeacher('')}}><Plus size={16}/>Добавить преподавателя</button></div></div>
     {!data.teachers.length&&<p className="dpb-note">В текущем источнике пока нет преподавателей. Заполните исходные условия расписания.</p>}
     {!currentForm.teacherOverrides.length&&<p className="dpb-note">Уточнений пока не внесено. Для остальных преподавателей сохраняются прежние условия.</p>}
     {unknownRows.length>0&&<p className="dpb-message dpb-warning">Источник изменился. Ранее введённые ответы сохранены; выберите актуальных преподавателей в этих строках.</p>}
     <ul className="dpb-people">{currentForm.teacherOverrides.map((row,index)=>{const teacher=data.teachers.find(item=>item.id===row.teacherId),name=teacher?.name||`Преподаватель из прежней версии ${index+1}`;return <li className="dpb-person" key={index}>
      <div className="dpb-row-heading"><h4>{name}</h4><button type="button" className="sg-control" disabled={controlsBlocked} onClick={()=>{focusAfter.current='add';change({...currentForm,teacherOverrides:currentForm.teacherOverrides.filter((_,i)=>i!==index)})}}><Trash2 size={16}/>Убрать строку</button></div>
      {!teacher&&<p className="dpb-note">Исходная запись: {row.teacherId}</p>}
      <div className="dpb-fields"><label className="dpb-field">Преподаватель в строке {index+1}<select value={row.teacherId} disabled={controlsBlocked} onChange={event=>updateTeacher(index,{teacherId:event.target.value})}>{!teacher&&<option value={row.teacherId}>Выберите актуального преподавателя</option>}{data.teachers.filter(item=>item.id===row.teacherId||!currentForm.teacherOverrides.some(other=>other.teacherId===item.id)).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="dpb-field">Ответ на дату · {name}<select ref={node=>{if(node)statusFields.current.set(row.teacherId,node);else statusFields.current.delete(row.teacherId)}} value={row.status} disabled={controlsBlocked} onChange={event=>{const status=event.target.value as DailyTeacherOverride['status'];updateTeacher(index,{status,windows:status==='available'?(row.windows.length?row.windows:[{start:'',end:''}]):[]})}}><option value="unknown">Ответ неизвестен</option><option value="available">Доступен в указанные окна</option><option value="unavailable">Недоступен на эту дату</option></select></label></div>
      <label className="dpb-check"><input type="checkbox" checked={row.contacted} disabled={controlsBlocked} onChange={event=>updateTeacher(index,{contacted:event.target.checked})}/><span>Уже звонили · {name}</span></label>
      {row.status==='available'&&<fieldset className="dpb-windows" disabled={controlsBlocked}><legend>Окна доступности · {name}</legend>{row.windows.map((window,wi)=><div className="dpb-window" key={wi}><label className="dpb-field">Начало окна {wi+1}<input type="time" value={window.start} onChange={event=>updateTeacher(index,{windows:row.windows.map((item,i)=>i===wi?{...item,start:event.target.value}:item)})}/></label><label className="dpb-field">Конец окна {wi+1}<input type="time" value={window.end} onChange={event=>updateTeacher(index,{windows:row.windows.map((item,i)=>i===wi?{...item,end:event.target.value}:item)})}/></label><button type="button" className="sg-control" onClick={()=>updateTeacher(index,{windows:row.windows.filter((_,i)=>i!==wi)})}>Убрать окно {wi+1}</button></div>)}<div className="dpb-actions"><button type="button" className="sg-control" disabled={row.windows.length>=20} onClick={()=>updateTeacher(index,{windows:[...row.windows,{start:'',end:''}]})}>Добавить окно</button></div></fieldset>}
      {row.status==='unknown'&&<p className="dpb-badge" data-tone="warning">Ответ неизвестен — расчёт пока заблокирован.</p>}
      <label className="dpb-field">Комментарий · {name}<textarea maxLength={2000} rows={2} value={row.comment} disabled={controlsBlocked} onChange={event=>updateTeacher(index,{comment:event.target.value})}/></label>
     </li>})}</ul>
     <details className="dpb-details"><summary>Уже подтверждённые уроки · {currentForm.confirmedLessonIds.length}</summary><div><p className="dpb-muted">Отмеченные уроки закрепляются. Расчёт подбирает оставшуюся часть выбранного дня.</p>{data.lessons.length?<ul className="dpb-lesson-list">{data.lessons.map(lesson=><li key={lesson.id}><label className="dpb-check"><input type="checkbox" checked={currentForm.confirmedLessonIds.includes(lesson.id)} disabled={controlsBlocked} onChange={event=>change({...currentForm,confirmedLessonIds:event.target.checked?[...currentForm.confirmedLessonIds,lesson.id]:currentForm.confirmedLessonIds.filter(id=>id!==lesson.id)})}/><span>{lesson.className} · {lesson.slot} урок · {lesson.start}–{lesson.end}<br/>{lesson.subject} · {lesson.teachers.join(', ')||'Преподаватель не указан'}</span></label></li>)}</ul>:<p>В источнике нет уроков на выбранную дату.</p>}{missingLessons.map((id,index)=><label key={id} className="dpb-check"><input type="checkbox" checked disabled={controlsBlocked} onChange={()=>change({...currentForm,confirmedLessonIds:currentForm.confirmedLessonIds.filter(item=>item!==id)})}/><span>Урок из прежней версии {index+1} больше не найден. Снимите отметку и проверьте источник.</span></label>)}</div></details>
     <div className="dpb-actions dpb-main-actions"><button type="button" className="sg-control sg-primary" disabled={controlsBlocked||!!busy||stale} onClick={()=>void dailyFlow('run')}>{pipelineGoal==='run'?(busy==='save'?'Сохраняем ответы…':busy==='preflight'?'Проверяем условия…':busy==='run'?'Составляем расписание…':'Проверяем ответы…'):'Составить расписание'}</button><button type="button" className="sg-control" disabled={controlsBlocked||!!busy||stale} onClick={()=>void dailyFlow('save')}>{pipelineGoal==='save'?'Сохраняем ответы…':'Сохранить ответы'}</button><span className="dpb-muted">{dirty?'Есть несохранённые ответы':data.saved?'Бриф сохранён':'Бриф ещё не сохранён'}</span></div>
    </>}
   </>}
  </div>
  {!denied&&!disabled&&data&&<div className="sg-panel"><div className="dpb-row-heading"><h3 ref={readinessHeading} tabIndex={-1}>Готовность расчёта</h3><span className="dpb-badge" data-tone={readyToRun?undefined:'warning'}>{readyToRun?'Можно составлять остаток':'Нужна проверка'}</span></div>
   {!!readiness?.blockers.length&&<ul className="dpb-blockers">{readiness.blockers.map((issue,index)=><li key={issue.code+index}>{issue.message}</li>)}</ul>}
   {!!readiness?.missingForms.length&&<div><h4>Что ещё заполнить</h4><ul className="dpb-blockers">{readiness.missingForms.map((field,index)=><li key={field+index}>{missingFormLabel(field)}</li>)}</ul></div>}
   {onOpenConditions&&<div className="dpb-actions"><button type="button" className="sg-control" disabled={blocked||!!busy} onClick={()=>onOpenConditions(targetDate)}>Заполнить данные школы</button></div>}
   {onOpenCalendar&&<div className="dpb-actions"><button type="button" className="sg-control" disabled={blocked||!!busy} onClick={()=>onOpenCalendar(targetDate)}>Заполнить календарь</button></div>}
   <p className="dpb-muted">Уточните ответы и нажмите «Составить расписание». Если чего-то не хватает, ответы сохранятся, а недостающие условия появятся здесь. Подтверждённые уроки и остальные даты сохраняются.</p>
   <details className="dpb-details dpb-manual"><summary>Подробная проверка</summary><div>
    <div className="dpb-actions"><button type="button" className="sg-control" disabled={controlsBlocked||!!busy||stale} onClick={review}>{busy==='preview'?'Проверяем бриф…':'Проверить бриф'}</button></div>
    {preview&&currentForm&&<div><h3 ref={previewHeading} tabIndex={-1}>Проверка брифа</h3><p>Строк преподавателей: {preview.content.teacherOverrides.length}. Подтверждённых уроков: {preview.content.confirmedLessonIds.length}.</p><p className="dpb-muted">Сохранение брифа не перестраивает расписание. Неизвестные ответы и незаполненные условия останутся видимыми.</p><div className="dpb-actions"><button type="button" className="sg-control sg-primary" disabled={blocked||!!busy||stale} onClick={save}>Сохранить бриф</button></div></div>}
   <div className="dpb-actions"><button type="button" className="sg-control" disabled={blocked||!!busy||dirty||stale||!data.saved} onClick={checkReadiness}>{busy==='preflight'?'Проверяем готовность…':'Проверить готовность'}</button><button type="button" className="sg-control sg-primary" disabled={!readyToRun} onClick={calculate}>{busy==='run'?'Создаём расчёт…':'Составить оставшееся'}</button></div>
   </div></details>
   {createdRun&&<div className="dpb-message dpb-success" role="status"><p>Расчёт создан на {createdRun.date}. Проверьте отличия в существующем планировщике.</p><div className="dpb-actions"><button type="button" className="sg-control" disabled={blocked||!!busy} onClick={()=>{handoffs.current.delete(createdRun.id);handoff(createdRun.id,createdRun.date)}}>Открыть рассчитанный вариант</button></div></div>}
  </div>}
 </section>
}
