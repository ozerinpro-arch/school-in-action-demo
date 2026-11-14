import SchoolPageHelp from './SchoolPageHelp'
import StudentClubReceipts from './StudentClubReceipts'
import {useCallback,useEffect,useRef,useState} from 'react'
import {GraduationCap,LogOut,RefreshCw,Sparkles} from 'lucide-react'
import LearningThread,{AuthorityNotice,PendingNotice} from './LearningThread'
import {type Assignment,type AssignmentDetail,type StudentLearning,assignmentStatusLabel,formatLearningDue,useLearningClient,useLearningMutation,validStudentLearning,validDetail} from './student-learning-api'
import './school-gloss.css'
import './staff-workspace.css'
import './student-learning.css'
import './StudentWorkspace.css'
import './cloud-porcelain.css'

type AssignmentStatusFilter='all'|'sent'|'submitted'|'revision_requested'|'reviewed'
const statusOptions:AssignmentStatusFilter[]=['all','sent','submitted','revision_requested','reviewed']

export default function StudentWorkspace({ownerId,schoolId,onLogout,loggingOut=false,logoutError=''}:{ownerId:string;schoolId?:string;onLogout:()=>void;loggingOut?:boolean;logoutError?:string}){
 const [data,setData]=useState<StudentLearning|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[denied,setDenied]=useState(false),[selected,setSelected]=useState<string|null>(null),[search,setSearch]=useState(''),[page,setPage]=useState(1),[threadLocked,setThreadLocked]=useState(false)
 const [kind,setKind]=useState<Assignment['kind']>('teacher_assignment'),[status,setStatus]=useState<AssignmentStatusFilter>('all'),[activeSection,setActiveSection]=useState('today'),[openNonce,setOpenNonce]=useState(0)
 const [practice,setPractice]=useState({subject:'',topic:'',instructions:''}),[notice,setNotice]=useState('')
 const serial=useRef(0),main=useRef<HTMLElement>(null),thread=useRef<HTMLDivElement>(null),todayRegion=useRef<HTMLElement>(null),listRegion=useRef<HTMLElement>(null),practiceRegion=useRef<HTMLElement>(null)
 const clear=useCallback(()=>{serial.current++;setData(null);setSelected(null);setSearch('');setStatus('all');setKind('teacher_assignment');setPractice({subject:'',topic:'',instructions:''});setNotice('');setDenied(true)},[])
 const client=useLearningClient('student',ownerId,clear)
 const update=useCallback((assignment:Assignment)=>setData(old=>old?{...old,assignments:old.assignments.some(a=>a.id===assignment.id)?old.assignments.map(a=>a.id===assignment.id?assignment:a):[assignment,...old.assignments]}:old),[])
 const load=useCallback(async()=>{const seq=++serial.current;setLoading(true);setError('');try{const value=await client.request('/api/student/learning',validStudentLearning);if(seq===serial.current){setData(value);setSelected(id=>id&&value.assignments.some(a=>a.id===id)?id:null)}}catch(e){if(seq===serial.current)setError(e instanceof Error?e.message:'Нет связи с сервером.')}finally{if(seq===serial.current)setLoading(false)}},[client.request])
 useEffect(()=>{void load();return()=>{serial.current++}},[load])
 function focusRegion(region:HTMLElement|null){requestAnimationFrame(()=>{region?.focus();region?.scrollIntoView({block:'start'})})}
 function openAssignment(id:string){
  if(threadLocked||mutation.busy||mutation.pending||client.authority!=='current')return
  setSelected(id);setOpenNonce(value=>value+1);requestAnimationFrame(()=>{thread.current?.focus();thread.current?.scrollIntoView({block:'start'})})
 }
 function showAssignments(nextStatus:AssignmentStatusFilter='all'){
  setKind('teacher_assignment');setStatus(nextStatus);setSearch('');setPage(1);setActiveSection('assignments');focusRegion(listRegion.current)
 }
 const practiceDetail=useCallback((v:unknown):v is AssignmentDetail=>validDetail(v)&&v.assignment.kind==='self_practice',[])
 const mutation=useLearningMutation(client,practiceDetail,value=>{update(value.assignment);setSelected(value.assignment.id);setKind('self_practice');setStatus('all');setSearch('');setPage(1);setPractice({subject:'',topic:'',instructions:''});setNotice('Личная подготовка начата. Это ваш тренажёр, а не назначение учителя.');requestAnimationFrame(()=>{thread.current?.focus();thread.current?.scrollIntoView({block:'start'})})})
 const practiceSubjectReady=!!practice.subject.trim()&&(data?.practiceSubjectSource==='personal'||!!data?.practiceSubjects.includes(practice.subject))
 const practiceBlocked=mutation.busy||!!mutation.pending||threadLocked||client.authority!=='current'
 const schoolAssignments=(data?.assignments??[]).filter(a=>a.kind==='teacher_assignment')
 const personalPractice=(data?.assignments??[]).filter(a=>a.kind==='self_practice')
 const counts={sent:schoolAssignments.filter(a=>a.status==='sent').length,submitted:schoolAssignments.filter(a=>a.status==='submitted').length,revision_requested:schoolAssignments.filter(a=>a.status==='revision_requested').length,reviewed:schoolAssignments.filter(a=>a.status==='reviewed').length}
 const nearest=schoolAssignments.filter(a=>a.status==='sent'||a.status==='revision_requested').sort((a,b)=>(a.dueAt?Date.parse(a.dueAt):Infinity)-(b.dueAt?Date.parse(b.dueAt):Infinity)||a.createdAt.localeCompare(b.createdAt)).slice(0,3)
 const rows=(kind==='teacher_assignment'?schoolAssignments:personalPractice).filter(a=>(kind==='self_practice'||status==='all'||a.status===status)&&[a.title,a.subject,a.topic].some(v=>v.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))))
 const pages=Math.max(1,Math.ceil(rows.length/15)),current=Math.min(page,pages),now=Date.now()
 const dueLabel=(a:Assignment)=>a.dueAt?formatLearningDue(a.dueAt):'Без срока'
 const overdue=(a:Assignment)=>a.kind==='teacher_assignment'&&(a.status==='sent'||a.status==='revision_requested')&&!!a.dueAt&&Date.parse(a.dueAt)<now
 return <div className="school-app cp-design student-workspace"><div className="sg-shell sw-shell">
 <a className="sg-skip-link" href="#student-main">К моей учёбе</a>
 <aside className="sg-sidebar"><div className="sg-brand"><span className="sg-medallion"><GraduationCap size={23}/></span><span>Школа.Действие<span>Личный кабинет ученика</span></span></div>
 <nav className="sg-navigation" aria-label="Разделы ученика">
  <button className="sg-nav-item" aria-current={activeSection==='today'?'page':undefined} onClick={()=>{setActiveSection('today');focusRegion(todayRegion.current)}}><span className="sg-medallion"><GraduationCap size={18}/></span><span>Сегодня</span></button>
  <button className="sg-nav-item" aria-current={activeSection==='assignments'?'page':undefined} onClick={()=>showAssignments()}>Мои задания</button>
  <button className="sg-nav-item" aria-current={activeSection==='practice'?'page':undefined} onClick={()=>{setActiveSection('practice');focusRegion(practiceRegion.current)}}>Личная подготовка</button>
 </nav><div className="sg-sidebar-bottom"><div className="sg-profile"><span className="sg-medallion"><GraduationCap size={18}/></span><div><strong>{data?.student.name||'Ученик'}</strong><span>{data?.student.className||'Личный кабинет'}</span></div></div><button className="sg-control" disabled={loggingOut} onClick={onLogout}><LogOut size={16}/>{loggingOut?'Выходим…':'Выйти'}</button></div></aside>
 <div className="sg-workspace"><header className="sg-topbar"><div className="sg-breadcrumb"><GraduationCap size={20}/><strong>Моя учёба</strong></div><span className="sg-badge">Ученик</span></header>
 <main ref={main} id="student-main" className="sg-main cp-stack" tabIndex={-1}><div className="sg-page sl-workspace cp-stack">
 <SchoolPageHelp page="student-tasks"/><header className="sg-page-heading"><div><h1>Моя учёба</h1><p>Ваши задания, сохранённые попытки и обратная связь педагога.</p></div><button className="sg-control" disabled={loading||threadLocked||mutation.busy||!!mutation.pending} onClick={()=>void load()}><RefreshCw size={16}/>Обновить задания</button></header>
 {logoutError&&<p role="alert">{logoutError}</p>}<AuthorityNotice client={client}/>
 {denied?<section className="sg-panel"><h2>Доступ к заданиям закрыт</h2><p>Личные данные очищены. Войдите снова в свой кабинет.</p></section>:<>
 {loading&&<div className="student-loading" role="status"><p>Загружаем ваши задания…</p><span aria-hidden="true"/><span aria-hidden="true"/></div>}
 {error&&<p role="alert">{error}{data&&' Ниже последняя загруженная версия.'}</p>}
 {data&&<>
 <section ref={todayRegion} id="student-today" className="sg-panel student-today" tabIndex={-1} aria-labelledby="student-today-title"><div className="sg-section-heading"><div><h2 id="student-today-title">Сегодня</h2><p className="sl-muted">{new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'})} · Москва</p></div><span className="sg-badge">Заданий педагога: {schoolAssignments.length}</span></div>
  <div className="student-metrics" aria-label="Статусы школьных заданий">{(['sent','submitted','revision_requested','reviewed'] as const).map(value=><button key={value} className="sg-control student-metric" onClick={()=>showAssignments(value)} aria-label={`${assignmentStatusLabel(value)}: ${counts[value]}. Открыть задания`}><strong>{counts[value]}</strong><span>{assignmentStatusLabel(value)}</span></button>)}</div>
  <p className="sl-muted student-progress-note">Счётчики отражают состояния ваших школьных работ. «Проверено» означает решение педагога; автоматических оценок и показателя понимания здесь нет.</p>
  <div className="sg-section-heading"><h3>Ближайшие задания</h3><button className="sg-control" onClick={()=>showAssignments()}>Все школьные задания</button></div>
  {!nearest.length?<p>{schoolAssignments.length?'Новых заданий и работ на доработку сейчас нет. Проверенные работы и отправленные попытки доступны в списке.':'Педагог пока не выдал вам заданий. Когда появится назначение, оно будет здесь.'}</p>:<ul className="student-nearest">{nearest.map(a=><li key={a.id}><div><span className="sg-badge">{assignmentStatusLabel(a.status)} · {a.subject}</span><h3>{a.title}</h3><p className="student-due">Срок: {dueLabel(a)}{overdue(a)&&<span className="student-overdue">Срок прошёл</span>}</p></div><button className="sg-control" disabled={practiceBlocked} onClick={()=>openAssignment(a.id)}>Открыть задание</button></li>)}</ul>}
 </section>

 <section ref={listRegion} id="student-assignments" className="sg-panel student-assignment-list" tabIndex={-1} aria-labelledby="student-assignments-title"><div className="sg-section-heading"><h2 id="student-assignments-title">Мои задания и тренировки</h2><span className="sg-badge" role="status">Найдено: {rows.length}</span></div>
  <div className="sl-actions student-kind-filter" role="group" aria-label="Тип учебной работы"><button className="sg-control" aria-pressed={kind==='teacher_assignment'} onClick={()=>{setKind('teacher_assignment');setPage(1)}}>Задания педагога · {schoolAssignments.length}</button><button className="sg-control" aria-pressed={kind==='self_practice'} onClick={()=>{setKind('self_practice');setPage(1)}}>Личные тренировки · {personalPractice.length}</button></div>
  <p className="sl-muted">{kind==='teacher_assignment'?'Здесь школьные назначения и их фактические статусы. Сроки указаны по Москве.':'Личные тренировки созданы вами. Они не назначены педагогом и не входят в счётчики школьных работ.'} Сообщения сохраняются во внутреннем кабинете. Внешняя доставка и прочтение не подтверждаются.</p>
  <form className="sg-settings-form" onSubmit={e=>e.preventDefault()}><div className="sl-fields"><label className="sg-settings-field">Найти по названию, предмету или теме<input type="search" value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}}/></label>{kind==='teacher_assignment'&&<label className="sg-settings-field">Статус задания<select value={status} onChange={e=>{setStatus(e.target.value as AssignmentStatusFilter);setPage(1)}}>{statusOptions.map(value=><option key={value} value={value}>{value==='all'?'Все статусы':assignmentStatusLabel(value)}</option>)}</select></label>}</div></form>
  {!rows.length?<div className="student-empty"><h3>{search.trim()||status!=='all'&&kind==='teacher_assignment'?'Нет работ по выбранным условиям':kind==='self_practice'?'Пока нет личных тренировок':'Пока нет заданий педагога'}</h3><p>{search.trim()||status!=='all'&&kind==='teacher_assignment'?'Измените поисковый запрос или выберите другой статус.':kind==='self_practice'?'Начните самостоятельную подготовку ниже. Доступность тренажёра зависит от подключения ИИ.':'Выданные вам задания появятся в этом списке.'}</p></div>:<ul className="sl-list">{rows.slice((current-1)*15,current*15).map(a=><li key={a.id}><div className="sl-actions"><span className="sg-badge">{a.kind==='self_practice'?'Личная подготовка':'Задание педагога'} · {a.subject}</span><span className="student-status">{assignmentStatusLabel(a.status)}</span></div><h3>{a.title}</h3><p>{a.topic}</p>{a.kind==='teacher_assignment'&&<p className="student-due">Срок: {dueLabel(a)}{overdue(a)&&<span className="student-overdue">Срок прошёл</span>}</p>}<button className="sg-control" disabled={practiceBlocked} onClick={()=>openAssignment(a.id)}>{a.kind==='self_practice'?'Открыть тренировку':a.status==='reviewed'?'Посмотреть результат':'Открыть задание и попытки'}</button></li>)}</ul>}
  {pages>1&&<div className="sl-actions student-pagination"><button className="sg-control" disabled={current<=1} onClick={()=>setPage(current-1)}>Назад</button><span>Страница {current} из {pages}</span><button className="sg-control" disabled={current>=pages} onClick={()=>setPage(current+1)}>Далее</button></div>}
 </section>

 {selected&&<div ref={thread} className="student-thread-anchor" tabIndex={-1}><LearningThread key={`${selected}:${openNonce}`} id={selected} role="student" client={client} aiEnabled={data.ai.enabled} onUpdate={update} onClose={()=>{setSelected(null);focusRegion(listRegion.current)}} onLockChange={setThreadLocked}/></div>}


 <section ref={practiceRegion} id="student-practice" className="sg-panel" tabIndex={-1} aria-labelledby="student-practice-title"><h2 id="student-practice-title">Подготовка к контрольной</h2><p>Можно начать самостоятельно, даже без задания педагога. Помощник задаёт вопросы и даёт подсказки по теме; это не оценка и не школьное назначение.</p>
  <form className="sg-settings-form" onSubmit={e=>{e.preventDefault();if(!practiceBlocked&&data.ai.enabled&&practiceSubjectReady&&practice.topic.trim())mutation.run('/api/student/learning/practice',practice,'начало личной подготовки')}}><div className="sl-fields"><label className="sg-settings-field">Предмет подготовки{data.practiceSubjectSource==='published'?<select required value={practice.subject} disabled={practiceBlocked} onChange={e=>setPractice(old=>({...old,subject:e.target.value}))}><option value="">Выберите свой предмет</option>{data.practiceSubjects.map(subject=><option key={subject}>{subject}</option>)}</select>:<input required maxLength={160} value={practice.subject} disabled={practiceBlocked} onChange={e=>setPractice(old=>({...old,subject:e.target.value}))}/>}</label><label className="sg-settings-field">Тема контрольной<input required maxLength={240} value={practice.topic} disabled={practiceBlocked} onChange={e=>setPractice(old=>({...old,topic:e.target.value}))}/></label></div>
  <p className="sl-muted">{data.practiceSubjectSource==='published'?'Предметы взяты из опубликованного расписания вашего класса.':'Предмет — ваша личная метка подготовки; школьная программа здесь не подтверждается.'}</p><label className="sg-settings-field">Что хочется потренировать (необязательно)<textarea maxLength={2000} rows={3} value={practice.instructions} disabled={practiceBlocked} onChange={e=>setPractice(old=>({...old,instructions:e.target.value}))}/></label>
  <button className="sg-control sg-primary" type="submit" disabled={practiceBlocked||!data.ai.enabled||!practiceSubjectReady||!practice.topic.trim()}><Sparkles size={16}/>{mutation.busy?'Готовим первый вопрос…':'Начать подготовку к контрольной'}</button>{!data.ai.enabled&&<p role="status">ИИ сейчас выключен. Начать тренажёр пока нельзя; задания педагога и ручные ответы доступны.</p>}</form><PendingNotice mutation={mutation}/>{notice&&<p role="status">{notice}</p>}
 </section>
 {client.authority==='current'&&<StudentClubReceipts client={client} ownerId={ownerId}/>}
 </>}
 </>}
 </div></main></div></div></div>
}
