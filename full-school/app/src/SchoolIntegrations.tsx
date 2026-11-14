import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ClipboardList, Clock3, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { jsonBody, schoolRequest, SchoolApiError } from './school-ops-api'
import './school-automations.css'
import './SchoolIntegrations.css'

type Profile = { role?: string; staffRole?: string; userId?: string }
type Status = { mode: string; currentUserId: string; canManage: boolean; canReadTasks: boolean; ai: { enabled: boolean; readiness: string; keyConfigured: boolean | null; keyNotice: string }; max: { enabled: boolean; mode: string; termsStatus: string; networkSenderImplemented: boolean }; local: { persistentTasks: boolean; leases: boolean; inboxDedupe: boolean; outboxDryRun: boolean }; blockers: string[] }
type Respondent = { membershipId: string; userId: string; name: string; staffRole: string }
type Respondents = { respondents: Respondent[]; configured: boolean; blockers: string[] }
type Task = { id: string; title: string; state: string; revision: number; createdAt: number; deadlineAt: number; deadlineExceeded: boolean; nextAction: string; message?: string; result?: { message?: string; externalCalls?: number; schoolMutations?: number } }
type Question = { id: string; text: string; state: string; respondentId: string; revision: number; answer: string | null }
type Detail = { task: Task; questions: Question[] }
type CreateCommand = { title: string; message: string; deadlineAt: number; requestId: string }
type QuestionCommand = { taskId: string; title: string; body: { text: string; respondentMembershipId: string; expectedRevision: number; requestId: string } }
const labels: Record<string, string> = { queued: 'В локальной очереди', running: 'Локальная подготовка', blocked: 'Нужно разрешение', waiting_reply: 'Ожидает ответа', completed: 'Локальная подготовка завершена', cancelled: 'Отменена', stale: 'Входы или доступ устарели', expired: 'Срок истёк', failed: 'Сбой локальной подготовки' }
const roleLabels: Record<string, string> = { director: 'Директор', planner: 'Завуч', teacher: 'Учитель' }
const requestId = () => 'launch_' + crypto.randomUUID().replaceAll('-', '')
const formatDate = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })

export default function SchoolIntegrations({ profile, embedded = false }: { profile?: Profile; embedded?: boolean }) {
 const [status, setStatus] = useState<Status | null>(null), [tasks, setTasks] = useState<Task[]>([]), [detail, setDetail] = useState<Detail | null>(null)
 const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
 const [title, setTitle] = useState(''), [message, setMessage] = useState(''), [answer, setAnswer] = useState('')
 const [respondents, setRespondents] = useState<Respondents | null>(null), [respondentId, setRespondentId] = useState(''), [questionText, setQuestionText] = useState('')
 const [detailFresh, setDetailFresh] = useState(false), [pendingQuestion, setPendingQuestion] = useState<QuestionCommand | null>(null)
 const alive = useRef(true), mutation = useRef(false), createRequest = useRef(requestId()), answerRequest = useRef(requestId()), questionRequest = useRef(requestId())
 const selectedId = useRef<string | null>(null), detailSequence = useRef(0), loadSequence = useRef(0)
 const createCommand = useRef<CreateCommand | null>(null), questionCommand = useRef<QuestionCommand | null>(null)
 const canReadTasks = profile?.staffRole !== 'access_admin' && profile?.role !== 'access_admin'
 const refreshDetail = useCallback(async (id: string) => {
  const sequence = ++detailSequence.current
  setDetailFresh(false)
  try {
   const value = await schoolRequest<Detail>('/api/launch/tasks/' + encodeURIComponent(id))
   if (value.task?.id !== id || !Number.isInteger(value.task.revision) || !Array.isArray(value.questions)) throw new Error('Неполная версия карточки')
   if (alive.current && selectedId.current === id && detailSequence.current === sequence) { setDetail(value); setDetailFresh(true) }
  } catch (cause) {
   if (alive.current && selectedId.current === id && detailSequence.current === sequence) {
    if (cause instanceof SchoolApiError && [401, 403, 404].includes(cause.status)) setDetail(null)
    setError('Не удалось обновить выбранную карточку. Ваш ввод сохранён; обновите и проверьте её версию перед повтором.')
   }
  }
 }, [])
 const load = useCallback(async () => {
  const sequence = ++loadSequence.current
  setLoading(true); setError('')
  try {
   const result = await schoolRequest<Status>('/api/launch/status')
   if (!result || typeof result.currentUserId !== 'string' || !Array.isArray(result.blockers) || !result.ai || !result.max || result.ai.enabled !== false || result.max.enabled !== false) throw new Error('Не удалось подтвердить безопасный статус подготовки')
   const rows = result.canReadTasks ? await schoolRequest<{ tasks: Task[] }>('/api/launch/tasks') : { tasks: [] }
   if (!Array.isArray(rows.tasks)) throw new Error('Неполный список локальных задач')
   let recipients: Respondents | null = null
   if (result.canManage) {
    try { recipients = await schoolRequest<Respondents>('/api/launch/respondents'); if (!Array.isArray(recipients.respondents)) throw new Error('Invalid respondents') }
    catch { recipients = { respondents: [], configured: false, blockers: ['respondent_provider_unavailable'] } }
   }
   if (alive.current && loadSequence.current === sequence) {
    setStatus(result); setTasks(rows.tasks); setRespondents(recipients)
    if (result.canReadTasks && selectedId.current) await refreshDetail(selectedId.current)
    else if (!result.canReadTasks) { selectedId.current = null; setDetail(null); setDetailFresh(false) }
   }
  } catch (cause) { if (alive.current && loadSequence.current === sequence) setError(cause instanceof Error ? cause.message : 'Не удалось получить статус подготовки') }
  finally { if (alive.current && loadSequence.current === sequence) setLoading(false) }
 }, [canReadTasks, refreshDetail])
 useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
 async function mutate(operation: () => Promise<void>) {
  if (mutation.current) return
  mutation.current = true; setBusy(true); setError(''); setNotice('')
  try { await operation() }
  catch (cause) { if (alive.current) { if (cause instanceof SchoolApiError && cause.status === 409) setDetailFresh(false); setError(cause instanceof Error ? cause.message : 'Действие не подтверждено. Обновите список перед повтором') } }
  finally { mutation.current = false; if (alive.current) setBusy(false) }
 }
 async function open(task: Task) {
  if (selectedId.current !== task.id) {
   selectedId.current = task.id; setDetail(null); setAnswer(''); setQuestionText(''); setRespondentId('')
   answerRequest.current = requestId(); questionRequest.current = requestId(); questionCommand.current = null
  }
  await refreshDetail(task.id)
 }
 async function create() {
  await mutate(async () => {
   // Capture time on the first send, then replay the complete immutable body.
   const command = createCommand.current ?? { title: title.trim(), message: message.trim(), deadlineAt: Date.now() + 86400000, requestId: createRequest.current }
   createCommand.current = command
   let result: Task
   try { result = await schoolRequest<Task>('/api/launch/tasks', jsonBody(command)) }
   catch (cause) { if (cause instanceof SchoolApiError && cause.status >= 400 && cause.status < 500) { createCommand.current = null; createRequest.current = requestId() }; throw cause }
   setNotice('Карточка сохранена. Модель, MAX и расписание не запускались.'); setTitle(''); setMessage(''); createRequest.current = requestId(); createCommand.current = null
   await load(); await open(result)
  })
 }
 async function action(task: Task, kind: 'prepare' | 'cancel' | 'retry') {
  await mutate(async () => {
   await schoolRequest<Task>('/api/launch/tasks/' + encodeURIComponent(task.id) + '/transition', jsonBody({ action: kind, expectedRevision: task.revision, requestId: requestId() }))
   await load()
   setNotice(kind === 'prepare' ? 'Проверка сохранена. Внешние вызовы отключены; нужен отдельный допуск.' : kind === 'cancel' ? 'Задача отменена; поздний результат не применяется.' : 'Локальная задача возвращена в очередь.')
  })
 }
 async function reply(q: Question) {
  await mutate(async () => {
   await schoolRequest('/api/launch/questions/' + encodeURIComponent(q.id) + '/answer', jsonBody({ text: answer, expectedRevision: q.revision, requestId: answerRequest.current }))
   setAnswer(''); answerRequest.current = requestId(); setNotice('Ответ связан с этим вопросом. Школьные данные автоматически не изменены.')
   await load()
  })
 }
 async function ask(task: Task) {
  const command = questionCommand.current ?? { taskId: task.id, title: task.title, body: { text: questionText, respondentMembershipId: respondentId, expectedRevision: task.revision, requestId: questionRequest.current } }
  questionCommand.current = command
  await sendQuestion(command)
 }
 async function sendQuestion(command: QuestionCommand) {
  await mutate(async () => {
   try { await schoolRequest('/api/launch/tasks/' + encodeURIComponent(command.taskId) + '/questions', jsonBody(command.body)) }
   catch (cause) {
    if (cause instanceof SchoolApiError && cause.status >= 400 && cause.status < 500) { setPendingQuestion(null); questionCommand.current = null; questionRequest.current = requestId() }
    else setPendingQuestion(command)
    throw cause
   }
   setPendingQuestion(null); questionCommand.current = null
   if (selectedId.current === command.taskId) { setQuestionText(''); setRespondentId(''); questionRequest.current = requestId() }
   setNotice('Адресный вопрос сохранён. Ответ появится в личной карточке сотрудника; MAX не использовался.')
   await load()
  })
 }
 const activeTask = detail?.task, heading = embedded ? 'h2' : 'h1', Heading = heading
 return <div className="sa-root si-root">
  <header className="sa-heading"><div><p className="sa-eyebrow">Подготовка запуска</p><Heading>ИИ и MAX</Heading><p>Сохранённые локальные задачи и честный статус внешних подключений.</p></div><button type="button" className="sa-icon-button" aria-label="Обновить подготовку подключений" aria-busy={loading} disabled={busy} onClick={() => { if (!loading) void load() }}><RefreshCw size={18} /></button></header>
  {loading && !status && <p role="status">Загружаем статус и локальную очередь…</p>}
  {error && <div className="sa-notice sa-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p><button type="button" className="sa-text-button" disabled={busy || loading} onClick={() => void load()}>Обновить и проверить результат</button></div></div>}
  {notice && <div className="sa-notice" role="status"><Check size={18} /><p>{notice}</p></div>}
  {pendingQuestion && status?.canManage && <div className="sa-notice" role="status"><div><p>Результат сохранения вопроса для карточки «{pendingQuestion.title}» пока не подтверждён. Повтор проверит то же действие и не создаст второй вопрос.</p><button type="button" className="sa-text-button" disabled={busy} onClick={() => void sendQuestion(pendingQuestion)}>Повторить и проверить сохранение вопроса</button></div></div>}
  {status && <>
   <div className="sa-grid si-status-grid cp-grid" aria-label="Статус подключения">
    <article className="sa-card"><div className="sa-card-top"><ShieldCheck size={20} /><span className="sa-badge sa-setup">{status.ai.enabled ? 'Вызовы разрешены в настройках' : 'Внешние вызовы выключены'}</span></div><h3>ИИ</h3><p>{status.ai.enabled ? 'Текстовые обращения обрабатываются в пределах включённого сценария. Изменения расписания требуют утверждения.' : 'Для живого разбора нужны ключ выбранного провайдера и явное включение.'}</p><p className="si-note">{status.ai.keyNotice}. Внешний контекст не расширяется: только сообщение пользователя.</p></article>
    <article className="sa-card"><div className="sa-card-top"><ShieldCheck size={20} /><span className="sa-badge sa-setup">{status.max.enabled ? 'Приём разрешён в настройках' : status.max.networkSenderImplemented ? 'Канал готов к настройке' : 'Только локальный dry-run'}</span></div><h3>MAX</h3><p>{status.max.networkSenderImplemented ? 'Обработчик и отправитель подготовлены. Для работы нужны настроенный бот, HTTPS и подтверждённые личные привязки.' : 'Рабочего отправителя и публичного webhook нет. Бот и привязки требуют проверки.'}</p><p className="si-note">Имитация ответа API не считается подключением, доставкой или прочтением.</p></article>
   </div>
   <section className="sa-card si-blockers" aria-label="Что нужно для запуска"><h3>Что остаётся</h3><ul>{status.blockers.map(text => <li key={text}>{text}</li>)}</ul><p className="si-note">Локально работают сохранение карточек, версии, сроки, отмена, lease и восстановление. Школьные изменения отдельно проходят согласование.</p></section>
   {status.canReadTasks && <div className="si-workspace cp-stack">
    <section className="sa-card"><div className="si-row"><h3>Локальная очередь</h3>{status.canManage && <button type="button" className="sa-text-button" disabled={busy} onClick={() => void mutate(async () => { const result = await schoolRequest<{ changedTaskIds: string[] }>('/api/launch/recover', jsonBody({})); setNotice(`Восстановление проверено. Изменено карточек: ${result.changedTaskIds.length}`); await load() })}>Проверить сроки и восстановить</button>}</div>
     {!tasks.length && <p>Локальных задач пока нет. Проверка подключений не запускается сама.</p>}
     <ul className="si-task-list">{tasks.map(task => <li key={task.id}><button type="button" className="sa-details-button si-task-button" onClick={() => void open(task)} aria-pressed={activeTask?.id === task.id}><span><strong>{task.title}</strong><small>{task.deadlineExceeded ? 'Срок истёк — нужна проверка очереди' : labels[task.state] || task.state}</small></span><Clock3 size={16} /></button></li>)}</ul>
    </section>
    <section className="sa-card">{activeTask ? <><div className="si-row"><h3>{activeTask.title}</h3><button type="button" className="sa-icon-button" aria-label="Закрыть локальную карточку" onClick={() => { selectedId.current = null; detailSequence.current++; setDetail(null); setDetailFresh(false) }}><X size={16} /></button></div><p><strong>{activeTask.deadlineExceeded ? 'Срок истёк' : labels[activeTask.state] || activeTask.state}</strong> · версия {activeTask.revision}</p><p className="si-note">Срок: {formatDate(activeTask.deadlineAt)}</p>{activeTask.message && <p className="si-message">{activeTask.message}</p>}<p>{activeTask.nextAction}</p>{activeTask.result?.message && <p role="status">{activeTask.result.message}</p>}
      {status.canManage && <div className="si-actions">{activeTask.state === 'queued' && !activeTask.deadlineExceeded && <button type="button" className="sa-action" disabled={busy || loading || !detailFresh} onClick={() => void action(activeTask, 'prepare')}>Проверить локально</button>}{activeTask.state === 'blocked' && !activeTask.deadlineExceeded && <button type="button" className="sa-action" disabled={busy || loading || !detailFresh} onClick={() => void action(activeTask, 'retry')}>Вернуть в очередь</button>}{!['completed', 'cancelled', 'stale', 'expired', 'failed'].includes(activeTask.state) && <button type="button" className="sa-text-button" disabled={busy || loading || !detailFresh} onClick={() => void action(activeTask, 'cancel')}>Отменить задачу</button>}</div>}
      {status.canManage && ['queued', 'blocked'].includes(activeTask.state) && !activeTask.deadlineExceeded && <section className="si-question"><h4>Задать вопрос сотруднику</h4>{!respondents?.configured ? <p role="status">Проверенный список сотрудников сейчас недоступен. Обновите сведения или обратитесь к администратору; адресат не выбирается по имени автоматически.</p> : !respondents.respondents.length ? <p role="status">Нет действующих сотрудников, которым можно адресовать вопрос. Сначала нужно подтвердить личный доступ сотрудника.</p> : <form onSubmit={event => { event.preventDefault(); void ask(activeTask) }}><label>Кому адресовать вопрос<select value={respondentId} required disabled={busy || !!pendingQuestion} onChange={event => { setRespondentId(event.target.value); questionCommand.current = null; questionRequest.current = requestId() }}><option value="">Выберите сотрудника</option>{respondents.respondents.map(person => <option key={person.membershipId} value={person.membershipId}>{person.name} · {roleLabels[person.staffRole] || person.staffRole}</option>)}</select></label><label>Вопрос по этой задаче<textarea required maxLength={1000} value={questionText} disabled={busy || !!pendingQuestion} onChange={event => { setQuestionText(event.target.value); questionCommand.current = null; questionRequest.current = requestId() }} /></label><button className="sa-action" disabled={busy || loading || !detailFresh || !!pendingQuestion || !respondentId || !questionText.trim()}>Сохранить адресный вопрос</button><p className="si-note">Вопрос появится только у назначенного сотрудника. Это локальная карточка, сообщения в MAX не отправляются.</p></form>}</section>}
      {detail?.questions.map(q => <div key={q.id} className="si-question"><h4>Вопрос сотруднику</h4><p>{q.text}</p>{q.answer ? <p>Ответ: {q.answer}</p> : q.respondentId === status.currentUserId && q.state === 'open' ? <form onSubmit={event => { event.preventDefault(); void reply(q) }}><label>Ответ на этот вопрос<textarea maxLength={2000} disabled={busy} value={answer} onChange={event => { setAnswer(event.target.value); answerRequest.current = requestId() }} required /></label><button className="sa-action" disabled={busy || loading || !detailFresh || !answer.trim()}>Сохранить ответ</button></form> : <p className="si-note">Ожидается ответ назначенного сотрудника.</p>}</div>)}
     </> : <><ClipboardList size={24} /><h3>Выберите карточку</h3><p>Здесь сохраняются состояние, срок, следующий шаг и адресные ответы. Внешние действия выключены.</p></>}</section>
   </div>}
   {status.canManage && <section className="sa-card si-create"><h3>Создать карточку подготовки</h3><p className="si-note">Это локальный рабочий процесс. Команда не отправляется модели или MAX и не меняет расписание.</p><form onSubmit={event => { event.preventDefault(); void create() }}><label>Название<input maxLength={180} value={title} disabled={busy} onChange={event => { setTitle(event.target.value); createCommand.current = null; createRequest.current = requestId() }} required /></label><label>Что проверить<textarea maxLength={2000} value={message} disabled={busy} onChange={event => { setMessage(event.target.value); createCommand.current = null; createRequest.current = requestId() }} required /></label><div className="si-actions"><button className="sa-action" disabled={busy || !title.trim() || !message.trim()}>{busy ? 'Сохраняем…' : 'Сохранить карточку'}</button><span className="si-note">Срок локальной подготовки — 24 часа.</span></div></form></section>}
  </>}
 </div>
}
