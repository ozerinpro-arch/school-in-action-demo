import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {AlertCircle,Download,Plus,RefreshCw,Sparkles} from 'lucide-react'
import {apiFetch} from './api'
import './teacher-preparation.css'

type Kind='lesson_plan'|'material'|'assessment'
export type PreparationAssignment={title:string;topic:string;subject:string;className:string;content:string;answers:string;objective?:string}
export type PreparationSelection={lessonId:string;nonce:number}
type OwnLesson={id:string;className:string;subject:string;day:number;slot:number;start:string;end:string;date?:string}
type Material={id:string;revision:number;kind:Kind;title:string;topic:string;className:string;subject?:string;objective?:string;durationMinutes?:number|null;lessonId?:string|null;content:string;answers:string;origin:'manual'|'ai';status:'draft';bindingStatus?:string;publicationVersion?:number|null;updatedAt:string}
type Dashboard={ai:{enabled:boolean;status:string};schedule:{publicationState:string;bindingReady:boolean;publicationVersion:number|null};lessons:OwnLesson[];nextLesson:OwnLesson|null;nextLessonBlocker?:string|null;classes:{className:string;lessonCount:number;materialCount:number;withContentCount:number}[];materialsTotal:number}
type Form={kind:Kind;title:string;topic:string;className:string;subject:string;objective:string;duration:string;lessonId:string;content:string;answers:string;instructions:string}
const blank=():Form=>({kind:'lesson_plan',title:'',topic:'',className:'',subject:'',objective:'',duration:'',lessonId:'',content:'',answers:'',instructions:''})
const kinds:Record<Kind,string>={lesson_plan:'План урока',material:'Учебный материал',assessment:'Проверочные задания'}
const dayNames=['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
const lessonLabel=(l:OwnLesson)=>`${l.className} · ${l.subject} · ${l.date||dayNames[l.day]||'День не задан'} · ${l.start}–${l.end}`
const toForm=(m:Material):Form=>({kind:m.kind,title:m.title,topic:m.topic,className:m.className,subject:m.subject||'',objective:m.objective||'',duration:m.durationMinutes==null?'':String(m.durationMinutes),lessonId:m.lessonId||'',content:m.content,answers:m.answers||'',instructions:''})
class PreparationError extends Error{constructor(message:string,public status:number){super(message)}}

export default function TeacherPreparation({selection,ownerId,onAssign}:{selection?:PreparationSelection|null;ownerId:string;onAssign?:(material:PreparationAssignment)=>void}){
 const[data,setData]=useState<Dashboard|null>(null),[materials,setMaterials]=useState<Material[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState(false),[authUncertain,setAuthUncertain]=useState(false),[view,setView]=useState<'materials'|'classes'>('materials')
 const[form,setForm]=useState<Form>(blank),[saved,setSaved]=useState<Material|null>(null),[baseline,setBaseline]=useState(()=>JSON.stringify(blank())),[pending,setPending]=useState<null|{label:string;run:()=>void}>(null),[stale,setStale]=useState(false),[remote,setRemote]=useState<Material|null>(null)
 const alive=useRef(true),locked=useRef(false),denied=useRef(false),controllers=useRef(new Set<AbortController>()),serial=useRef(0),loadSerial=useRef(0),command=useRef<{fingerprint:string;requestId:string}|null>(null),seenSelection=useRef<number|undefined>(undefined),selectionLoad=useRef<{nonce:number;ready:boolean}|null>(null),topicInput=useRef<HTMLInputElement>(null),pendingRegion=useRef<HTMLElement>(null),currentForm=useRef(form),currentDirty=useRef(false)
 const dirty=JSON.stringify(form)!==baseline;currentForm.current=form;currentDirty.current=dirty
 const failClosed=useCallback(()=>{denied.current=true;serial.current++;loadSerial.current++;controllers.current.forEach(c=>c.abort());setBlocked(true);setAuthUncertain(false);setData(null);setMaterials([]);setSaved(null);setForm(blank());setBaseline(JSON.stringify(blank()));setPending(null);setRemote(null)},[])
 const lockUncertain=useCallback(()=>{denied.current=true;serial.current++;loadSerial.current++;setAuthUncertain(true);setBlocked(true)},[])
 const sameTeacher=(value:{profile?:{userId?:string;staffRole?:string;membershipVerified?:boolean}})=>value.profile?.userId===ownerId&&value.profile?.staffRole==='teacher'&&value.profile?.membershipVerified===true
 const call=useCallback(async<T,>(path:string,options:RequestInit={}):Promise<T>=>{
  const controller=new AbortController();controllers.current.add(controller)
  try{
   const headers=new Headers(options.headers);headers.set('X-Learning-Owner',ownerId)
   const response=await apiFetch('/api/teacher/preparation'+path,{...options,headers,signal:controller.signal})
   if(response.status===401){if(alive.current)failClosed();throw new PreparationError('Доступ к личным материалам завершён. Войдите в свой школьный кабинет.',401)}
   if(response.status===403){
    try{const me=await apiFetch('/api/staff/me',{signal:controller.signal});if(me.ok){const identity=await me.json();if(!sameTeacher(identity)){if(alive.current)failClosed();throw new PreparationError('Доступ к личным материалам завершён. Войдите в свой школьный кабинет.',403)}}else if(me.status===401||me.status===403){if(alive.current)failClosed();throw new PreparationError('Доступ к личным материалам завершён. Войдите в свой школьный кабинет.',403)}else{if(alive.current)lockUncertain();throw new PreparationError('Не удалось подтвердить доступ. Ввод сохранён, действия приостановлены.',0)}}catch(cause){if(cause instanceof PreparationError)throw cause;if(alive.current)lockUncertain();throw new PreparationError('Не удалось подтвердить доступ. Ввод сохранён, действия приостановлены.',0)}
   }
   let result:unknown;try{result=await response.json()}catch{throw new PreparationError('Сервер вернул неполный ответ. Ваш ввод сохранён; повторите действие.',0)}
   if(!response.ok){const detail=result&&typeof result==='object'&&'detail'in result?result.detail:null;throw new PreparationError(typeof detail==='string'?detail:response.status===409?'Материал уже изменился. Ваш ввод сохранён. Проверьте новую версию.':'Не удалось выполнить действие. Ваш ввод сохранён.',response.status)}
   return result as T
  }catch(cause){if(cause instanceof PreparationError)throw cause;throw new PreparationError('Нет подтверждённого ответа сервера. Ваш ввод сохранён. Повторите то же действие для проверки результата.',0)}
  finally{controllers.current.delete(controller)}
 },[failClosed,lockUncertain,ownerId])
 const load=useCallback(async()=>{
  if(denied.current)return
  const seq=++loadSerial.current;setLoading(true);setError('')
  try{const[d,list]=await Promise.all([call<Dashboard>(''),call<{materials:Material[]}>('/materials')]);if(alive.current&&!denied.current&&seq===loadSerial.current){if(selectionLoad.current)selectionLoad.current.ready=true;setData(d);setMaterials(list.materials)}}
  catch(cause){if(alive.current&&!denied.current&&seq===loadSerial.current)setError((cause as Error).message)}
  finally{if(alive.current&&seq===loadSerial.current)setLoading(false)}
 },[call])
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;controllers.current.forEach(c=>c.abort())}},[load])
 useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(currentDirty.current){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[])
 const reset=(next:Form,material:Material|null=null)=>{if(view!=='materials')setView('materials');serial.current++;setForm(next);setBaseline(JSON.stringify(next));setSaved(material);setStale(false);setRemote(null);setError('');setNotice('');command.current=null;requestAnimationFrame(()=>topicInput.current?.focus())}
 const choose=(label:string,run:()=>void)=>{if(locked.current)return;if(currentDirty.current){setPending({label,run});requestAnimationFrame(()=>{pendingRegion.current?.focus();pendingRegion.current?.scrollIntoView({block:'nearest'})});return}run()}
 const fromLesson=(lesson:OwnLesson)=>{
  const minutes=(t:string)=>{const[h,m]=t.split(':').map(Number);return h*60+m};const length=minutes(lesson.end)-minutes(lesson.start)
  const next={...blank(),lessonId:lesson.id,className:lesson.className,subject:lesson.subject,duration:length>0&&length<=240?String(length):''};reset(next)
 }
 useEffect(()=>{
  if(!selection||!data||seenSelection.current===selection.nonce||denied.current||loading||busy||locked.current)return
  // An external timetable selection may refer to a newer publication than this mounted page.
  // Consume its nonce only after a successful fresh dashboard read and an owned-lesson lookup.
  if(selectionLoad.current?.nonce!==selection.nonce){selectionLoad.current={nonce:selection.nonce,ready:false};void load();return}
  if(!selectionLoad.current.ready)return
  const lesson=data.lessons.find(l=>l.id===selection.lessonId)
  if(!lesson){setError('Занятие больше не входит в ваше опубликованное расписание. Обновите сведения и выберите своё занятие.');return}
  seenSelection.current=selection.nonce;choose('Перейти к выбранному занятию',()=>fromLesson(lesson))
 },[selection,data,loading,busy,load])
 const change=(key:keyof Form,value:string)=>{setForm(old=>({...old,[key]:value}));command.current=null;setNotice('')}
 const open=async(id:string)=>{
  if(locked.current)return;locked.current=true;setBusy(true);setError('');const seq=++serial.current
  try{const result=await call<{material:Material}>('/materials/'+encodeURIComponent(id));if(alive.current&&!denied.current&&seq===serial.current)reset(toForm(result.material),result.material)}
  catch(cause){if(alive.current&&!denied.current&&seq===serial.current)setError((cause as Error).message)}finally{locked.current=false;if(alive.current)setBusy(false)}
 }
 const metadata=()=>({className:form.className,subject:form.subject,objective:form.objective,durationMinutes:form.duration?Number(form.duration):null,lessonId:form.lessonId||null})
 const submit=async(generate=false)=>{
  if(locked.current||denied.current)return
  locked.current=true;setBusy(true);setError('');setNotice('')
  const path=generate?'/generate':saved?'/materials/'+encodeURIComponent(saved.id):'/materials',method=generate||!saved?'POST':'PATCH'
  const payload=generate?{kind:form.kind,topic:form.topic,...metadata(),instructions:form.instructions}:{...(saved?{expectedRevision:saved.revision}:{kind:form.kind}),title:form.title,topic:form.topic,...metadata(),content:form.content,answers:form.kind==='assessment'?form.answers:''}
  const fingerprint=JSON.stringify({path,method,payload});if(command.current?.fingerprint!==fingerprint)command.current={fingerprint,requestId:crypto.randomUUID()}
  const seq=++serial.current
  try{
   const result=await call<{material:Material}>(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestId:command.current.requestId})})
   if(alive.current&&!denied.current&&seq===serial.current){reset(toForm(result.material),result.material);setNotice(generate?'ИИ создал и сохранил личный черновик. Проверьте содержание и ответы перед использованием.':'Личный черновик сохранён. Расписание и публикации не изменены.');void load()}
  }catch(cause){if(alive.current&&!denied.current&&seq===serial.current){setError((cause as Error).message);if(cause instanceof PreparationError&&cause.status===409){setStale(true);command.current=null}}}
  finally{locked.current=false;if(alive.current)setBusy(false)}
 }
 const checkVersion=async()=>{if(!saved||locked.current)return;locked.current=true;setBusy(true);try{const result=await call<{material:Material}>('/materials/'+encodeURIComponent(saved.id));if(alive.current&&!denied.current)setRemote(result.material)}catch(cause){if(alive.current&&!denied.current)setError((cause as Error).message)}finally{locked.current=false;if(alive.current)setBusy(false)}}
 const verifyAccess=async()=>{if(locked.current)return;locked.current=true;setBusy(true);const controller=new AbortController();controllers.current.add(controller);try{const response=await apiFetch('/api/staff/me',{signal:controller.signal});if(response.ok&&sameTeacher(await response.json())){if(alive.current){denied.current=false;setBlocked(false);setAuthUncertain(false);void load()}}else if(response.status===401||response.status===403||response.ok){if(alive.current)failClosed()}}catch{/* Remain closed while authority cannot be checked. */}finally{controllers.current.delete(controller);locked.current=false;if(alive.current)setBusy(false)}}
 const download=()=>{const text=[form.title,kinds[form.kind],`Класс: ${form.className||'Не указан'}`,`Предмет: ${form.subject||'Не указан'}`,`Тема: ${form.topic}`,`Цель: ${form.objective||'Не указана'}`,`Длительность: ${form.duration?form.duration+' мин':'Не указана'}`,'','Черновик учителя. Проверьте перед использованием.','',form.content,...(form.kind==='assessment'&&form.answers?['','Ответы для учителя',form.answers]:[])].join('\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(form.title.trim()||'Материал к уроку').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,120)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 const valid=form.title.trim()&&form.topic.trim()&&(!form.duration||Number.isInteger(Number(form.duration))&&Number(form.duration)>=1&&Number(form.duration)<=240)
 if(blocked)return <section className="sg-panel"><h1>Подготовка к урокам</h1><p role="alert">{authUncertain?'Не удалось подтвердить доступ. Ввод сохранён, действия приостановлены.':'Доступ к личным материалам завершён. Войдите в свой школьный кабинет.'}</p>{authUncertain&&<button className="sg-control" disabled={busy} onClick={()=>void verifyAccess()}>Проверить доступ</button>}</section>
 return <div className="sg-page teacher-preparation cp-stack" aria-busy={loading||busy}>
  <div className="sg-page-heading"><div><h1>Подготовка к урокам</h1><p>Планы уроков, материалы и проверочные задания.</p></div><button className="sg-control" disabled={loading||busy} onClick={()=>void load()}><RefreshCw size={16}/>Обновить материалы</button></div>
  {error&&<div className="sg-settings-error" role="alert"><AlertCircle size={18}/><div><p>{error}</p>{!data&&!blocked&&<button className="sg-control" disabled={loading||busy} onClick={()=>void load()}>Повторить загрузку</button>}</div></div>}{notice&&<p className="tp-result" role="status">{notice}</p>}
  {pending&&<section ref={pendingRegion} tabIndex={-1} className="sg-panel tp-pending" aria-label="Несохранённый черновик"><h2>Есть несохранённый ввод</h2><p>{pending.label}? Текущие несохранённые поля будут заменены.</p><div className="sg-actions"><button className="sg-control" disabled={busy} onClick={()=>{setPending(null);topicInput.current?.focus()}}>Продолжить редактирование</button><button className="sg-control" disabled={busy} onClick={()=>{const action=pending.run;setPending(null);action()}}>Отбросить ввод и перейти</button></div></section>}
  {loading&&!data?<p role="status">Загружаем ваши материалы и опубликованные занятия…</p>:data&&<>
   <section className="sg-panel tp-tools"><div className="tp-tabs" role="group" aria-label="Раздел подготовки"><button className="sg-control" aria-pressed={view==='materials'} onClick={()=>{if(view!=='materials')setView('materials');}}>Материалы</button><button className="sg-control" aria-pressed={view==='classes'} onClick={()=>{if(view!=='classes'){setView('classes')}}}>По классам</button><span className="sg-badge">{data.ai.enabled?'ИИ доступен':'Ручной режим · ИИ выключен'}</span></div><div className="tp-next"><button className="sg-control" disabled={busy||!data.nextLesson} onClick={()=>data.nextLesson&&choose('Подготовить следующий урок',()=>fromLesson(data.nextLesson!))}>Подготовить следующий урок</button><span>{data.nextLesson?lessonLabel(data.nextLesson):'Нет подтверждённой даты следующего урока — выберите занятие или создайте личный материал.'}</span></div></section>
   <div>
   {view==='classes'&&<section className="sg-panel"><h2>Мои классы и подготовка</h2><p>Количество собственных опубликованных занятий и личных черновиков. Наличие текста не означает, что материал проверен. Сведений об успеваемости нет.</p>{!data.classes.length?<p>Классы пока не появились. Сохраните личный материал с меткой класса или дождитесь публикации своих занятий.</p>:<div className="sw-table-scroll" role="region" aria-label="Подготовка по классам" tabIndex={0}><table className="sw-table"><thead><tr><th>Класс</th><th>Мои занятия</th><th>Личные черновики</th><th>Черновики с текстом</th><th>Темы</th></tr></thead><tbody>{data.classes.map(row=><tr key={row.className}><td>{row.className}</td><td>{row.lessonCount}</td><td>{row.materialCount}</td><td>{row.withContentCount}</td><td>{materials.filter(m=>m.className===row.className).map(m=><button key={m.id} className="sg-control" disabled={busy} onClick={()=>choose('Открыть материал «'+m.title+'»',()=>void open(m.id))}>{m.topic}</button>)}</td></tr>)}</tbody></table></div>}</section>}
   <div className="tp-layout cp-grid" hidden={view!=='materials'}><section className="sg-panel"><div className="sg-section-heading"><h2>{saved?'Редактировать черновик':'Новый черновик'}</h2><button className="sg-control" disabled={busy} onClick={()=>choose('Создать новый материал',()=>reset(blank()))}><Plus size={16}/>Новый материал</button></div>
    <form className="sg-settings-form" aria-label="Подготовка материала" onSubmit={(event:FormEvent)=>{event.preventDefault();void submit()}}>
     <label className="sg-settings-field">Моё опубликованное занятие<select value={form.lessonId} disabled={busy} onChange={e=>{const l=data.lessons.find(l=>l.id===e.target.value);if(l)choose('Подготовить выбранный урок',()=>fromLesson(l));else change('lessonId','')}}><option value="">Без связи с расписанием — личный черновик</option>{form.lessonId&&!data.lessons.some(l=>l.id===form.lessonId)&&<option value={form.lessonId}>Занятие из прежней публикации — выберите актуальное</option>}{data.lessons.map(l=><option key={l.id} value={l.id}>{lessonLabel(l)}</option>)}</select></label>
     {!data.lessons.length&&<p className="sw-muted">Собственных опубликованных занятий пока нет. Подготовка вручную доступна.</p>}
     <div className="tp-fields"><label className="sg-settings-field">Класс<input maxLength={120} value={form.className} disabled={busy||!!form.lessonId} onChange={e=>change('className',e.target.value)}/></label><label className="sg-settings-field">Предмет<input maxLength={200} value={form.subject} disabled={busy||!!form.lessonId} onChange={e=>change('subject',e.target.value)}/></label></div>
     <label className="sg-settings-field">Тип материала<select value={form.kind} disabled={busy||!!saved} onChange={e=>change('kind',e.target.value)}>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
     <label className="sg-settings-field">Тема<input ref={topicInput} required maxLength={240} value={form.topic} disabled={busy} onChange={e=>setForm(old=>({...old,topic:e.target.value,title:!old.title||old.title===old.topic?e.target.value.slice(0,200):old.title}))}/></label>
     <label className="sg-settings-field">Название материала<input required maxLength={200} value={form.title} disabled={busy} onChange={e=>change('title',e.target.value)}/></label>
     <label className="sg-settings-field">Цель урока<textarea maxLength={2000} rows={2} value={form.objective} disabled={busy} onChange={e=>change('objective',e.target.value)}/></label>
     <label className="sg-settings-field">Длительность, минут<input type="number" min={1} max={240} value={form.duration} disabled={busy} onChange={e=>change('duration',e.target.value)}/></label>
     <details className="tp-ai-instructions"><summary>Пожелания для ИИ</summary><label className="sg-settings-field">Дополнительные пожелания<textarea maxLength={2000} rows={2} value={form.instructions} disabled={busy||!!saved} onChange={e=>change('instructions',e.target.value)}/></label><p className="sw-muted">Не вводите данные учеников и другие персональные сведения.</p></details>
     <button type="button" className="sg-control sg-primary" disabled={busy||!!saved||!data.ai.enabled||!valid||!!form.content.trim()||!!form.answers.trim()} onClick={()=>void submit(true)}><Sparkles size={16}/>{busy?'Обрабатываем…':'Сгенерировать и сохранить черновик'}</button>{(saved||form.content.trim()||form.answers.trim())&&<p className="sw-muted">ИИ не заменяет введённый текст. Для новой генерации создайте новый материал.</p>}
     <label className="sg-settings-field">Текст материала<textarea className="tp-content" maxLength={24000} rows={14} value={form.content} disabled={busy} onChange={e=>change('content',e.target.value)}/></label>
     {form.kind==='assessment'&&<label className="sg-settings-field">Ответы для учителя<textarea maxLength={12000} rows={7} value={form.answers} disabled={busy} onChange={e=>change('answers',e.target.value)}/></label>}
     {saved&&<p className="sw-muted">Сохранённый личный черновик · версия {saved.revision} · {saved.origin==='ai'?'создан с ИИ':'ручная подготовка'}. Проверьте перед использованием.</p>}
     {stale&&<div className="sg-settings-conflict"><h3>Версия изменилась</h3><p>Ваши поля сохранены. Сначала сравните их с текущей серверной версией.</p><button type="button" className="sg-control" disabled={busy} onClick={()=>void checkVersion()}>Проверить новую версию</button>{remote&&<><p>На сервере: {remote.title} · {remote.className} · {remote.subject} · версия {remote.revision}</p><details><summary>Показать текущий серверный текст</summary><pre className="tp-server-text">{remote.content}{remote.answers?'\n\nОтветы для учителя\n'+remote.answers:''}</pre></details><button type="button" className="sg-control" disabled={busy} onClick={()=>{setSaved(remote);setRemote(null);setStale(false);setError('');command.current=null;setNotice('Новая версия принята для сравнения. Ваш текст сохранён в форме; следующее сохранение заменит серверный черновик вашим вводом.')}}>Использовать новую версию, сохранив мой ввод</button></>}</div>}
     <div className="sg-settings-actions"><button className="sg-control sg-primary" disabled={busy||!valid||stale||!!saved&&!dirty} type="submit">{busy?'Сохраняем…':saved?'Сохранить изменения':'Сохранить ручной черновик'}</button><button type="button" className="sg-control" disabled={busy||!form.content.trim()&&!form.answers.trim()} onClick={download}><Download size={16}/>Скачать TXT</button>{onAssign&&<button type="button" className="sg-control sg-primary" disabled={busy||dirty||stale||!saved||!form.content.trim()||!form.subject.trim()||form.content.length>4000||form.answers.length>8000} onClick={()=>{if(saved)onAssign({title:saved.title,topic:saved.topic,subject:saved.subject||'',className:saved.className,content:saved.content,answers:saved.answers||'',objective:saved.objective})}}>Перейти к выдаче задания</button>}</div>{dirty&&<p role="status">Есть несохранённый ввод. При переходе в другие разделы этого кабинета он останется в форме.</p>}
     {onAssign&&<p className="sw-muted">Для выдачи сначала сохраните и проверьте материал. Текст задания до 4000 знаков, служебные ответы до 8000. В следующем шаге выберите ученика и подтвердите назначение.</p>}<details className="tp-help"><summary>О личных черновиках и данных</summary><p>Материалы доступны только вам. Класс и предмет без связи с опубликованным уроком — личные метки, не школьные назначения. Результат ИИ требует вашей проверки; он не утверждает расписание. Не вводите данные учеников, оценки и контакты.</p></details>
    </form></section>
    <section className="sg-panel"><h2>Мои сохранённые материалы</h2>{!materials.length?<p>Материалов пока нет. Создайте ручной черновик или воспользуйтесь ИИ, если он подключён.</p>:<ul className="tp-materials">{materials.map(m=><li key={m.id}><h3>{m.title}</h3><p>{kinds[m.kind]} · {m.className||'Без метки класса'} · {m.subject||'Предмет не указан'}</p><p>{m.topic} · {m.content.trim()?'Есть текст, требует проверки':'Пока без текста'}</p><button className="sg-control" disabled={busy} onClick={()=>choose('Открыть материал «'+m.title+'»',()=>void open(m.id))}>Открыть материал</button></li>)}</ul>}</section></div></div>
  </>}
 </div>
}
