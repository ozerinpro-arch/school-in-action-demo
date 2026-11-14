import SchoolPageHelp from './SchoolPageHelp'
import './school-proposal-notes.css'
import { useEffect, useRef, useState } from 'react'
import { jsonBody, schoolRequest } from './school-ops-api'

type Lesson = { className: string; subject: string; day: number; slot: number; start: string; end: string; teachers: string[]; rooms: string[] }
type Run = { id: string; status: string; message: string; schoolRequestId?: string; schoolRequestRevision?: number; targetWeekStart?: string; result?: { validation: { valid: boolean }; metrics: { baselineChanges?: number } } | null; draftDiff?: { lessonId: string; before: Lesson | null; after: Lesson | null }[]; changeSummary?: { changed: number; added: number; removed: number; unchanged: number } }
type Task = { id: string; status: string; message: string }
const active = new Set(['queued', 'running'])
const candidates = new Set(['optimal', 'feasible'])
const showLesson = (lesson: Lesson | null, week?: string) => {
 if (!lesson) return 'Занятия нет'
 let date = ''
 if (week) { const value = new Date(week + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + lesson.day); if (!Number.isNaN(value.getTime())) date = value.toISOString().slice(0, 10) + ' · ' }
 return `${lesson.className} · ${lesson.subject} · ${date}${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][lesson.day]} · ${lesson.slot} урок · ${lesson.start}–${lesson.end} · ${lesson.teachers.join(', ')} · кабинет ${lesson.rooms.join(', ') || 'не указан'}`
}

export default function RequestCalculation({ requestId, requestStatus, requestRevision, targetWeekStart, onApplied }: { requestId: string; requestStatus: string; requestRevision: number; targetWeekStart: string; onApplied: () => void }) {
 const [run, setRun] = useState<Run | null>(null), [task, setTask] = useState<Task | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reviewed, setReviewed] = useState(false)
 const alive = useRef(true), mutation = useRef(false), callback = useRef(onApplied), generation = useRef(0), readSequence = useRef(0)
 const calculateCommand = useRef<{ signature: string; id: string } | null>(null)
 callback.current = onApplied
 const storageKey = 'school-request-calculation:' + requestId
 const sourceCurrent = requestStatus === 'submitted' && run?.schoolRequestRevision === requestRevision
 const candidateReady = sourceCurrent && !!run && candidates.has(run.status) && run.result?.validation.valid === true
 useEffect(() => { setReviewed(false); setTask(null) }, [requestRevision])
 function remember(value: Run) {
  setRun(value)
  if (!candidates.has(value.status) || value.result?.validation.valid !== true) {
   setReviewed(false)
   setTask(previous => previous?.status === 'awaiting_approval' ? null : previous)
  }
  try { sessionStorage.setItem(storageKey, value.id) } catch { /* Server owns durable runs. */ }
 }
 async function refresh(id: string) {
  const expectedGeneration = generation.current, sequence = ++readSequence.current
  const current = () => alive.current && generation.current === expectedGeneration && readSequence.current === sequence
  try {
   const value = await schoolRequest<Run>('/api/planning/runs/' + encodeURIComponent(id))
   if (!current()) return
   if (value.id !== id || value.schoolRequestId !== requestId) throw new Error('Расчёт не относится к выбранному обращению.')
   remember(value)
  } catch (cause) { if (current()) throw cause }
 }
 useEffect(() => {
  alive.current = true
  let stored: string | null = null
  try { stored = sessionStorage.getItem(storageKey) } catch { /* Recovery is optional. */ }
  if (stored) void refresh(stored).catch(cause => { if (alive.current) setError((cause as Error).message) })
  return () => { alive.current = false; generation.current++ }
 }, [storageKey])
 useEffect(() => {
  if (!run || !active.has(run.status)) return
  const timer = setTimeout(() => void refresh(run.id).catch(cause => { if (alive.current) setError((cause as Error).message) }), 1000)
  return () => clearTimeout(timer)
 }, [run])
 async function perform(operation: () => Promise<void>) {
  if (mutation.current) return
  mutation.current = true; setBusy(true); setError('')
  try { await operation() } catch (cause) { if (alive.current) setError((cause as Error).message) }
  finally { mutation.current = false; if (alive.current) setBusy(false) }
 }
 async function calculate() {
  const date = new Date(targetWeekStart + 'T12:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetWeekStart) || Number.isNaN(date.getTime()) || date.getUTCDay() !== 1 || date.toISOString().slice(0,10) !== targetWeekStart) { setError('Нужна точная неделя подтверждённой даты обращения.'); return }
  await perform(async () => {
   const expectedGeneration = ++generation.current
   setTask(null); setReviewed(false)
   const [config, draft] = await Promise.all([schoolRequest<{ revision: number }>('/api/planning/config'), schoolRequest<{ revision: number }>('/api/timetable')])
   const payload = { expectedConfigRevision: config.revision, expectedDraftRevision: draft.revision, mode: 'repair', schoolRequestId: requestId, periodStart: targetWeekStart, timeLimitSeconds: 10 }
   const signature = JSON.stringify({ ...payload, requestRevision })
   if (calculateCommand.current?.signature !== signature) calculateCommand.current = { signature, id: 'request_run_' + crypto.randomUUID().replaceAll('-', '') }
   const value = await schoolRequest<Run>('/api/planning/runs', jsonBody({ ...payload, requestId: calculateCommand.current.id }))
   if (!alive.current || generation.current !== expectedGeneration) return
   if (value.schoolRequestId !== requestId) throw new Error('Сервер не подтвердил связь расчёта с обращением.')
   setTask(null); setReviewed(false); remember(value)
  })
 }
 async function prepare() {
  if (!run || !reviewed || !candidateReady) return
  await perform(async () => {
   const value = await schoolRequest<Task>('/api/planning/runs/' + encodeURIComponent(run.id) + '/propose', jsonBody({}))
   if (alive.current) setTask(value)
  })
 }
 async function decide(decision: 'approve' | 'reject') {
  if (!task || decision === 'approve' && (!reviewed || !candidateReady)) return
  await perform(async () => {
   const value = await schoolRequest<Task>('/api/schedule-agent/tasks/' + encodeURIComponent(task.id) + '/decision', jsonBody({ decision }))
   if (!alive.current) return
   setTask(value)
   if (value.status === 'completed') { window.dispatchEvent(new Event('school-timetable-updated')); callback.current() }
   if (run) await refresh(run.id)
  })
 }
 return <section aria-label="Подбор изменений по обращению">
  <h3>Подобрать изменения</h3><SchoolPageHelp page="request-calculation"/>
  <p>Расчёт учтёт сообщение о недоступности и сохранит остальные занятия насколько позволяют подтверждённые условия. Результат требует отдельного утверждения.</p>
  {error && <p role="alert">{error}</p>}
  <div className="sg-actions"><button className="sg-control" disabled={busy || !!run && active.has(run.status) || requestStatus !== 'submitted'} onClick={() => void calculate()}>Подобрать изменения по обращению</button>{run && <button className="sg-control" disabled={busy} onClick={() => void perform(async () => { await refresh(run.id) })}>Обновить расчёт обращения</button>}</div>
  {run && <div><p role="status">{run.message}</p>{active.has(run.status) && <p>Расчёт выполняется. Исходное расписание пока не изменено.</p>}
   {run.targetWeekStart && <p>Расчёт на неделю с {run.targetWeekStart}.</p>}
   {!sourceCurrent && requestStatus !== 'applied' && <p>Обращение изменилось после расчёта. Нужен новый подбор по актуальным сведениям.</p>}
   {run.changeSummary && <p>Изменено: {run.changeSummary.changed}; добавлено: {run.changeSummary.added}; удалено: {run.changeSummary.removed}; без изменений: {run.changeSummary.unchanged}.</p>}
   {!!run.draftDiff?.length && <details open><summary>Предложенные изменения занятий</summary>{run.draftDiff.map(item => <div className="school-proposed-change" key={item.lessonId}><span className="school-change-badge">Предложение платформы</span><p>Было: {showLesson(item.before, run.targetWeekStart)}</p><p>Вариант после согласования: {showLesson(item.after, run.targetWeekStart)}</p></div>)}</details>}
   {candidateReady && <><label><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />Проверены все предложенные изменения</label><button className="sg-control" disabled={busy || !reviewed || task?.status === 'awaiting_approval'} onClick={() => void prepare()}>Подготовить рассчитанный вариант к утверждению</button></>}
  </div>}
  {task && <div><p role="status">{task.message}</p>{task.status === 'awaiting_approval' && <div className="sg-actions"><button className="sg-control" disabled={busy || !reviewed || !candidateReady} onClick={() => void decide('approve')}>Утвердить рассчитанные изменения</button><button className="sg-control" disabled={busy} onClick={() => void decide('reject')}>Отклонить рассчитанные изменения</button></div>}</div>}
 </section>
}
