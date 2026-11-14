import {useCallback,useEffect,useRef,useState} from 'react'
import {AlertCircle,RefreshCw} from 'lucide-react'
import {schoolRequest} from './school-ops-api'

type Row={name:string;lessonCount:number;scheduledMinutes:number}
type Analytics={source:{kind:'draft';isPublished:false;revision:number;sourceName:string;updatedAt:string|null};totals:{lessonCount:number;classCount:number;teacherCount:number;roomCount:number;subjectCount:number;scheduledMinutes:number};completeness:{missingTeacherLessons:number;missingRoomLessons:number;multiTeacherLessons:number;multiRoomLessons:number};checks:{issueCount:number;errorCount:number;warningCount:number;overlapIssueCount:number;affectedLessonCount:number;byKind:{kind:string;count:number}[]};byDay:{day:number;lessonCount:number;scheduledMinutes:number}[];byClass:Row[];byTeacher:Row[];byRoom:Row[];bySubject:Row[]}
const groups={byClass:'Классы',byTeacher:'Учителя',byRoom:'Кабинеты',bySubject:'Предметы'}as const
const days=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье']
const number=(value:number)=>value.toLocaleString('en-GB')
const count=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0
function valid(value:Analytics){return value?.source?.kind==='draft'&&value.source.isPublished===false&&count(value.source.revision)&&typeof value.source.sourceName==='string'
 &&value.totals&&['lessonCount','classCount','teacherCount','roomCount','subjectCount','scheduledMinutes'].every(key=>count(value.totals[key as keyof Analytics['totals']]))
 &&value.completeness&&Object.values(value.completeness).length===4&&Object.values(value.completeness).every(count)
 &&value.checks&&['issueCount','errorCount','warningCount','overlapIssueCount','affectedLessonCount'].every(key=>count(value.checks[key as 'issueCount']))
 &&Array.isArray(value.byDay)&&value.byDay.every(row=>count(row.day)&&row.day<=6&&count(row.lessonCount)&&count(row.scheduledMinutes))
 &&Object.keys(groups).every(key=>Array.isArray(value[key as keyof typeof groups])&&value[key as keyof typeof groups].every(row=>typeof row.name==='string'&&count(row.lessonCount)&&count(row.scheduledMinutes)))}

export default function ScheduleAnalytics({openSchedule}:{openSchedule:()=>void}){
 const [data,setData]=useState<Analytics|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[group,setGroup]=useState<keyof typeof groups>('byClass')
 const request=useRef<AbortController|null>(null)
 const reload=useCallback(async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('')
  try{const result=await schoolRequest<Analytics>('/api/school/analytics/schedule',{signal:controller.signal});if(!valid(result))throw new Error('Сервер не подтвердил сведения аналитики. Повторите загрузку.');if(!controller.signal.aborted)setData(result)}
  catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Не удалось загрузить аналитику.')}
  finally{if(!controller.signal.aborted)setLoading(false)}
 },[])
 useEffect(()=>{void reload();const updated=()=>{void reload()};window.addEventListener('school-timetable-updated',updated);return()=>{request.current?.abort();window.removeEventListener('school-timetable-updated',updated)}},[reload])
 return <div className="sg-page" aria-busy={loading}>
  <div className="sg-page-heading"><div><h1>Аналитика расписания</h1><p>Текущий черновик: уроки, длительность занятий и замечания проверки.</p></div><button type="button" className="sg-control" disabled={loading} onClick={()=>void reload()}><RefreshCw size={16}/>Обновить</button></div>
  {error&&<div className="sg-error" role="alert"><AlertCircle size={20}/><div><p>{error}</p>{data&&<p>Ниже показана последняя загруженная версия.</p>}<button type="button" className="sg-control" disabled={loading} onClick={()=>void reload()}>Повторить загрузку</button></div></div>}
  {loading&&!data?<p role="status">Собираем показатели черновика…</p>:data&&<>
   <section className="sg-panel"><div className="sg-section-heading"><h2>Черновик · ревизия {data.source.revision}</h2><span className="sg-badge">Не публикация</span></div><p>{data.source.sourceName||'Источник ещё не загружен'}</p><p>Эти показатели не подтверждают публикацию недели, соблюдение нормативной нагрузки или готовность учебного плана.</p>
    {!data.totals.lessonCount?<div><h3>В черновике пока нет уроков</h3><p>Добавьте или загрузите расписание. Ученики, оценки и посещаемость здесь не создаются автоматически.</p><button type="button" className="sg-control" onClick={openSchedule}>Открыть расписание</button></div>:<><div className="sg-completeness">{([['Записи уроков',data.totals.lessonCount],['Классы',data.totals.classCount],['Имена учителей',data.totals.teacherCount],['Кабинеты',data.totals.roomCount],['Предметы',data.totals.subjectCount],['Минуты занятий в сетке',data.totals.scheduledMinutes]]as const).map(([label,value])=><div key={label}><span>{label}</span><strong>{number(value)}</strong></div>)}</div><p className="sw-muted">Сумма длительностей записей. Это не нормативные часы и не нагрузка ставки; подгруппы и совместные занятия автоматически не объединяются.</p></>}
   </section>
   {!!data.totals.lessonCount&&<><section className="sg-panel"><h2>Что требует проверки</h2><div className="sg-completeness">{([['Ошибки проверки',data.checks.errorCount],['Предупреждения',data.checks.warningCount],['Группы пересечений времени',data.checks.overlapIssueCount],['Затронутые записи уроков',data.checks.affectedLessonCount],['Без учителя',data.completeness.missingTeacherLessons],['Без кабинета',data.completeness.missingRoomLessons],['Несколько учителей',data.completeness.multiTeacherLessons],['Несколько кабинетов',data.completeness.multiRoomLessons]]as const).map(([label,value])=><div key={label}><span>{label}</span><strong>{number(value)}</strong></div>)}</div><p className="sw-muted">Пересечения учителей и кабинетов могут требовать проверки подгрупп. Здесь показаны результаты той же проверки, что в редакторе.</p><button type="button" className="sg-control" onClick={openSchedule}>Проверить в расписании</button></section>
   <section className="sg-panel"><h2>Распределение по дням сетки</h2><div className="sw-table-scroll" tabIndex={0} role="region" aria-label="Распределение по дням"><table className="sw-table"><thead><tr><th scope="col">День</th><th scope="col">Записи уроков</th><th scope="col">Минуты</th></tr></thead><tbody>{data.byDay.map(row=><tr key={row.day}><th scope="row">{days[row.day]||'День не указан'}</th><td>{number(row.lessonCount)}</td><td>{number(row.scheduledMinutes)}</td></tr>)}</tbody></table></div><p className="sw-muted">Дни сетки без утверждения календарного периода.</p></section>
   <section className="sg-panel"><h2>Занятия и ресурсы</h2><label className="sg-settings-field">Показать<select value={group} onChange={event=>setGroup(event.target.value as keyof typeof groups)}>{Object.entries(groups).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>{data[group].length?<div className="sw-table-scroll" tabIndex={0} role="region" aria-label={groups[group]}><table className="sw-table"><thead><tr><th scope="col">{groups[group]}</th><th scope="col">Записи уроков</th><th scope="col">Минуты участия</th></tr></thead><tbody>{data[group].map(row=><tr key={row.name}><th scope="row">{row.name||'Не указано'}</th><td>{number(row.lessonCount)}</td><td>{number(row.scheduledMinutes)}</td></tr>)}</tbody></table></div>:<p>Эти ресурсы в черновике пока не указаны.</p>}<p className="sw-muted">Для нескольких учителей или кабинетов длительность учитывается у каждого участника. Проценты занятости не рассчитываются: доступные интервалы и нормы школы здесь не подтверждаются.</p></section></>}
  </>}
 </div>
}
