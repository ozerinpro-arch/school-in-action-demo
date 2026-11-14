import { useCallback, useEffect, useRef, useState } from 'react'
import { schoolRequest, jsonBody } from './school-ops-api'
import RequestCalculation from './RequestCalculation'
import MaxConnection from './MaxConnection'

type Lesson = { id?: string; className: string; day: number; slot: number; start: string; end: string; subject: string; teachers: string[]; rooms: string[]; date?: string }
type Question = { id: string; text: string; respondentMembershipId?: string; respondentId?: string; answer?: string | null; status?: string; state?: string }
type Proposal = { action: 'add' | 'change'; before: Lesson | null; after: Lesson; hash: string; expectedDraftRevision: number; targetDate: string; targetWeekStart: string; blockers?: { message: string }[] }
type RequestRow = { id: string; revision: number; kind: string; status: string; text: string; resolvedDate: string | null; slot?: number | null; lessonIds: string[]; lesson?: Lesson | null; owner: { membershipId: string; displayName: string }; questions: Question[]; serverReply: string; proposal: Proposal | null }
type Status = { canManage: boolean; currentUserId: string; membershipId: string; ownLessons: Lesson[]; ownTeacherRefs?: string[]; blockers: (string | { message: string })[] }
type Result = { request: RequestRow; serverReply?: string }
export type AbsenceSelection = { date: string; lessonIds: string[]; nonce: number }
type Editor = { date: string; className: string; slot: string; start: string; end: string; subject: string; teachers: string; rooms: string }
const emptyEditor: Editor = { date: '', className: '', slot: '1', start: '', end: '', subject: '', teachers: '', rooms: '' }
const labels: Record<string, string> = { needs_clarification: 'Нужно уточнение', submitted: 'Передано на проверку', waiting_reply: 'Ожидается ответ', proposed: 'Предложение для проверки', applied: 'Сохранено в черновике', rejected: 'Отклонено' }
const kindLabels: Record<string, string> = { unavailability: 'Недоступность', add_lesson: 'Добавление занятия', change_lesson: 'Изменение занятия', question: 'Обращение' }
const names = (value: string) => value.split(',').map(v => v.trim()).filter(Boolean)
const weekday = (value: string) => (new Date(value + 'T12:00:00Z').getUTCDay() + 6) % 7
const describe = (l: Lesson) => `${l.className} · ${l.subject} · ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][l.day]} · ${l.slot} урок · ${l.start}–${l.end} · ${l.teachers.join(', ') || 'учитель не указан'} · кабинет ${l.rooms.join(', ') || 'не указан'}`
const call = <T,>(path: string, body?: unknown) => schoolRequest<T>(path, body === undefined ? undefined : jsonBody(body))

export default function SchoolRequests({ onApplied, initialAbsence, onInitialAbsenceHandled }: { onApplied?: () => void; initialAbsence?: AbsenceSelection | null; onInitialAbsenceHandled?: () => void }) {
 const [status, setStatus] = useState<Status | null>(null), [rows, setRows] = useState<RequestRow[]>([]), [selected, setSelected] = useState<RequestRow | null>(null)
 const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
 const [kind, setKind] = useState('message'), [text, setText] = useState(''), [form, setForm] = useState<Editor>({ ...emptyEditor }), [ownIds, setOwnIds] = useState<string[]>([])
 const [reply, setReply] = useState(''), [questionText, setQuestionText] = useState(''), [recipient, setRecipient] = useState('')
 const [includeFields, setIncludeFields] = useState(false), [replyKind, setReplyKind] = useState('unavailability'), [clarification, setClarification] = useState<Editor>({ ...emptyEditor })
 const [respondents, setRespondents] = useState<{ membershipId: string; name: string }[]>([]), [draft, setDraft] = useState<{ revision: number; lessons: Lesson[] } | null>(null)
 const [proposalEditor, setProposalEditor] = useState<Editor>({ ...emptyEditor }), [proposalAction, setProposalAction] = useState<'add' | 'change'>('add'), [proposalLessonId, setProposalLessonId] = useState('')
 const alive = useRef(true), inFlight = useRef(false), sequence = useRef(0), command = useRef<{ signature: string; id: string } | null>(null), selectedId = useRef<string | null>(null)
 const refreshButton = useRef<HTMLButtonElement>(null), seededAbsence = useRef<number | null>(null)
 const canManage = status?.canManage === true
 useEffect(() => {
  if (!status || canManage || !initialAbsence || seededAbsence.current === initialAbsence.nonce) return
  seededAbsence.current = initialAbsence.nonce
  const selectedLessons = status.ownLessons.filter(item => initialAbsence.lessonIds.includes(item.id || '') && item.date === initialAbsence.date)
  if (selectedLessons.length !== initialAbsence.lessonIds.length || !selectedLessons.length) { setError('Опубликованные занятия изменились. Обновите личное расписание и выберите уроки заново.'); onInitialAbsenceHandled?.(); return }
  setKind('unavailability'); setOwnIds(selectedLessons.map(item => item.id!)); setForm(previous => ({ ...previous, date: initialAbsence.date, slot: '' })); setText(''); setNotice('Выбраны ваши опубликованные уроки на одну дату. Проверьте их и передайте обращение завучу.'); setSelected(null); selectedId.current = null; onInitialAbsenceHandled?.()
 }, [status, canManage, initialAbsence, onInitialAbsenceHandled])
 const change = (key: keyof Editor, value: string, proposal = false, clarify = false) => (clarify ? setClarification : proposal ? setProposalEditor : setForm)(old => ({ ...old, [key]: value }))
 const load = useCallback(async () => {
  const current = ++sequence.current
  setLoading(true); setError('')
  try {
   const access = await call<Status>('/api/school/requests/status')
   const list = await call<{ requests: RequestRow[] }>('/api/school/requests')
   let members: typeof respondents = [], grid: typeof draft = null
   if (access.canManage) {
    const [people, timetable] = await Promise.all([call<{ respondents: typeof respondents }>('/api/launch/respondents'), call<NonNullable<typeof draft>>('/api/timetable')])
    members = people.respondents; grid = timetable
   }
   const detail = selectedId.current ? await call<Result>('/api/school/requests/' + encodeURIComponent(selectedId.current)) : null
   if (!alive.current || current !== sequence.current) return
   setStatus(access); setRows(list.requests); setRespondents(members); setDraft(grid)
   if (detail && detail.request.id === selectedId.current) setSelected(detail.request)
  } catch (cause) { if (alive.current && current === sequence.current) setError((cause as Error).message) }
  finally { if (alive.current && current === sequence.current) setLoading(false) }
 }, [])
 useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; sequence.current++ } }, [load])
 async function refresh() {
  const restore = document.activeElement === refreshButton.current
  await load()
  if (restore && alive.current) requestAnimationFrame(() => {
   if (alive.current && (document.activeElement === document.body || document.activeElement === refreshButton.current)) refreshButton.current?.focus()
  })
 }
 async function mutate(path: string, payload: object, onSuccess?: (value: Result) => void) {
  if (inFlight.current) return
  inFlight.current = true; setBusy(true); setError(''); setNotice('')
  const signature = JSON.stringify([path, payload])
  if (command.current?.signature !== signature) command.current = { signature, id: 'req_' + crypto.randomUUID().replaceAll('-', '') }
  try {
   const value = await call<Result>(path, { ...payload, requestId: command.current.id })
   if (!alive.current) return
   if (!value.request?.id) throw new Error('Сервер не подтвердил сохранённое обращение.')
   command.current = null; selectedId.current = value.request.id; setSelected(value.request)
   setNotice(value.serverReply || value.request.serverReply); onSuccess?.(value)
   if (value.request.status === 'applied') { onApplied?.(); window.dispatchEvent(new Event('school-timetable-updated')) }
   await load()
  } catch (cause) { if (alive.current) setError((cause as Error).message) }
  finally { inFlight.current = false; if (alive.current) setBusy(false) }
 }
 function targetWeekStart(value: string) { const date = new Date(value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() - weekday(value)); return date.toISOString().slice(0, 10) }
 function lesson(editor: Editor): Lesson {
  return { className: editor.className.trim(), day: weekday(editor.date), slot: Number(editor.slot), start: editor.start, end: editor.end, subject: editor.subject.trim(), teachers: names(editor.teachers), rooms: names(editor.rooms) }
 }
 async function create() {
  const body: Record<string, unknown> = text.trim() ? { text: text.trim() } : {}
  if (kind !== 'message') body.kind = kind
  if (form.date) body.date = form.date
  if (kind === 'unavailability') { if (ownIds.length) body.lessonIds = ownIds; else if (form.slot) body.slot = Number(form.slot) }
  if (kind === 'add_lesson') body.lesson = lesson(form)
  await mutate('/api/school/requests', body, () => { setText(''); setOwnIds([]) })
 }
 async function open(row: RequestRow) {
  if (busy) return
  selectedId.current = row.id; setSelected(null); setReply(''); setQuestionText(''); setRecipient(''); setError('')
  const current = ++sequence.current
  try {
   const value = await call<Result>('/api/school/requests/' + encodeURIComponent(row.id))
   if (!alive.current || current !== sequence.current || selectedId.current !== row.id) return
   setSelected(value.request)
   const source = value.request.lesson || draft?.lessons.find(item => item.id === value.request.lessonIds[0])
   setIncludeFields(false); setReplyKind(value.request.kind === 'question' ? 'unavailability' : value.request.kind)
   setClarification(source ? { date: value.request.resolvedDate || '', className: source.className, slot: String(source.slot), start: source.start, end: source.end, subject: source.subject, teachers: source.teachers?.join(', ') || '', rooms: source.rooms.join(', ') } : { ...emptyEditor, date: value.request.resolvedDate || '', slot: value.request.slot ? String(value.request.slot) : '' })
   setProposalAction(value.request.kind === 'add_lesson' ? 'add' : 'change'); setProposalLessonId(source?.id || value.request.lessonIds[0] || '')
   setProposalEditor(source ? { date: value.request.resolvedDate || '', className: source.className, slot: String(source.slot), start: source.start, end: source.end, subject: source.subject, teachers: source.teachers.join(', '), rooms: source.rooms.join(', ') } : { ...emptyEditor, date: value.request.resolvedDate || '' })
  } catch (cause) { if (alive.current && current === sequence.current) setError((cause as Error).message) }
 }
 function fields(editor: Editor, proposal = false, clarify = false) {
  const edit = (key: keyof Editor, value: string) => change(key, value, proposal, clarify)
  return <>
   <label className="sg-settings-field">Дата занятия<input required type="date" value={editor.date} disabled={busy} onChange={e => edit('date', e.target.value)} /></label>
   <label className="sg-settings-field">Класс<input required maxLength={80} value={editor.className} disabled={busy} onChange={e => edit('className', e.target.value)} /></label>
   <label className="sg-settings-field">Предмет<input required maxLength={160} value={editor.subject} disabled={busy} onChange={e => edit('subject', e.target.value)} /></label>
   <label className="sg-settings-field">Номер урока<input required type="number" min={1} max={20} value={editor.slot} disabled={busy} onChange={e => edit('slot', e.target.value)} /></label>
   <label className="sg-settings-field">Начало<input required type="time" value={editor.start} disabled={busy} onChange={e => edit('start', e.target.value)} /></label>
   <label className="sg-settings-field">Окончание<input required type="time" value={editor.end} disabled={busy} onChange={e => edit('end', e.target.value)} /></label>
   {canManage && <label className="sg-settings-field">Учителя через запятую<input maxLength={960} value={editor.teachers} disabled={busy} onChange={e => edit('teachers', e.target.value)} /></label>}
   {!canManage && !!status?.ownTeacherRefs && status.ownTeacherRefs.length > 1 && <label className="sg-settings-field">Моя запись преподавателя<select required value={editor.teachers} disabled={busy} onChange={e => edit('teachers', e.target.value)}><option value="">Выберите подтверждённую запись</option>{status.ownTeacherRefs.map(ref => <option key={ref} value={ref}>{ref}</option>)}</select></label>}
   <label className="sg-settings-field">Кабинеты через запятую<input maxLength={640} value={editor.rooms} disabled={busy} onChange={e => edit('rooms', e.target.value)} /></label>
  </>
 }
 const terminal = selected && ['applied', 'rejected'].includes(selected.status)
 const canReply = selected && status && !terminal && (selected.owner.membershipId === status.membershipId || selected.questions.some(q => q.respondentMembershipId === status.membershipId && q.state === 'open'))
 return <section className="sg-panel" aria-label="Обращения по расписанию" aria-busy={busy || loading}>
  <div className="sg-section-heading"><h2>Обращения по расписанию</h2><button ref={refreshButton} className="sg-control" disabled={busy || loading} onClick={() => void refresh()}>Обновить обращения</button></div>
  <p>Сообщите о недоступности или предложите занятие. Изменение сохраняется в черновике после проверки и утверждения завучем.</p>
  <div className="sg-actions"><button className="sg-control" disabled={busy} onClick={() => setKind('message')}>Написать сообщение</button><button className="sg-control" disabled={busy} onClick={() => setKind('add_lesson')}>Добавить занятие</button></div>
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  {loading && !status ? <p role="status">Загружаем обращения…</p> : status && <>
   <form className="sg-settings-form" aria-label="Новое обращение" onSubmit={e => { e.preventDefault(); void create() }}>
    <label className="sg-settings-field">Способ обращения<select value={kind} disabled={busy} onChange={e => setKind(e.target.value)}><option value="message">Написать сообщение</option><option value="unavailability">Не могу провести занятие</option><option value="add_lesson">Добавить занятие</option></select></label>
    {kind === 'unavailability' && <>
     <label className="sg-settings-field">Дата недоступности<input type="date" required value={form.date} disabled={busy} onChange={e => { change('date', e.target.value); change('slot', ''); setOwnIds([]) }} /></label>
     <p>Одно обращение относится к одной дате. Для другой даты создайте отдельное обращение.</p>
     {canManage ? !!draft?.lessons.length && <label className="sg-settings-field">Занятие<select value={ownIds[0] || ''} disabled={busy} onChange={e => { setOwnIds(e.target.value ? [e.target.value] : []); const item = draft.lessons.find(l => l.id === e.target.value); if (item) change('slot', String(item.slot)) }}><option value="">Уточнить по номеру урока</option>{draft.lessons.map(l => <option key={l.id} value={l.id}>{l.className} · {l.subject} · {l.slot} урок · {l.start}</option>)}</select></label> : <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}><legend>Мои занятия на выбранную дату</legend>{status.ownLessons.filter(l => l.date === form.date).map(l => <label key={l.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0'}}><input type="checkbox" style={{width:18,height:18,minHeight:18,flex:'0 0 18px',padding:0}} checked={ownIds.includes(l.id!)} onChange={e => { setOwnIds(ids => e.target.checked ? [...ids, l.id!] : ids.filter(id => id !== l.id)); change('slot', '') }} />{l.className} · {l.subject} · {l.slot} урок · {l.start}</label>)}{!status.ownLessons.some(l => l.date === form.date) && <p>Выберите дату собственного опубликованного занятия.</p>}</fieldset>}
     {!ownIds.length && <label className="sg-settings-field">Номер урока<input type="number" min={1} max={20} value={form.slot} disabled={busy} onChange={e => change('slot', e.target.value)} /></label>}
    </>}
    {kind === 'add_lesson' && fields(form)}
    <label className="sg-settings-field">Сообщение<textarea required={kind === 'message'} maxLength={2000} placeholder="Например: завтра не смогу провести третий урок" value={text} disabled={busy} onChange={e => setText(e.target.value)} /></label>
    <button className="sg-control" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Передать обращение'}</button>
   </form>
   {!!status.blockers.length && <p>{status.blockers.map(b => typeof b === 'string' ? b : b.message).join(' ')}</p>}
   <h3>{canManage ? 'Обращения школы' : 'Мои обращения и вопросы'}</h3>
   {!canManage && <MaxConnection />}
   {!rows.length ? <p>Обращений пока нет.</p> : <ul>{rows.map(row => <li key={row.id}><button className="sg-control" disabled={busy} onClick={() => void open(row)}>{kindLabels[row.kind] || 'Обращение'} · {row.resolvedDate || 'Дата уточняется'} · {labels[row.status] || row.status}{canManage ? ' · ' + row.owner.displayName : ''}</button></li>)}</ul>}
   {selected && <section aria-label="Выбранное обращение">
    <h3>{kindLabels[selected.kind] || 'Обращение'} · {labels[selected.status] || selected.status}</h3>
    <p>{selected.text}</p><p>{selected.serverReply}</p>
    {selected.resolvedDate && <p>Дата: {selected.resolvedDate}. Версия обращения: {selected.revision}.</p>}
    {selected.questions.map(q => <div key={q.id}><p><strong>Уточнение:</strong> {q.text}</p>{q.answer && <p>Ответ: {q.answer}</p>}</div>)}
    {canReply && <form className="sg-settings-form" aria-label="Ответ по обращению" onSubmit={e => { e.preventDefault(); void mutate('/api/school/requests/' + selected.id + '/reply', { expectedRevision: selected.revision, text: reply, ...(includeFields && selected.owner.membershipId === status.membershipId ? { fields: { kind: replyKind, ...(clarification.date ? { date: clarification.date } : {}), ...(clarification.slot ? { slot: Number(clarification.slot) } : {}), ...(['add_lesson', 'change_lesson'].includes(replyKind) ? { lesson: lesson(clarification) } : {}) } } : {}) }, () => { setReply(''); setIncludeFields(false) }) }}>
     {selected.owner.membershipId === status.membershipId && <><label><input type="checkbox" checked={includeFields} disabled={busy} onChange={e => setIncludeFields(e.target.checked)} />Уточнить поля обращения</label>{includeFields && <>
      <label className="sg-settings-field">Вид уточнённого обращения<select value={replyKind} disabled={busy} onChange={e => setReplyKind(e.target.value)}><option value="unavailability">Недоступность</option><option value="add_lesson">Добавление занятия</option><option value="change_lesson">Изменение занятия</option></select></label>
      {['add_lesson', 'change_lesson'].includes(replyKind) ? fields(clarification, false, true) : <><label className="sg-settings-field">Уточнённая дата<input required type="date" value={clarification.date} disabled={busy} onChange={e => change('date', e.target.value, false, true)} /></label><label className="sg-settings-field">Уточнённый номер урока<input required type="number" min={1} max={20} value={clarification.slot} disabled={busy} onChange={e => change('slot', e.target.value, false, true)} /></label></>}
     </>}</>}
     <label className="sg-settings-field">Ответить или уточнить<textarea required maxLength={2000} value={reply} disabled={busy} onChange={e => setReply(e.target.value)} /></label><button className="sg-control" disabled={busy}>Сохранить ответ</button></form>}
    {canManage && selected.kind === 'unavailability' && ['submitted', 'applied'].includes(selected.status) && <RequestCalculation key={selected.id} requestId={selected.id} requestStatus={selected.status} requestRevision={selected.revision} targetWeekStart={selected.resolvedDate ? targetWeekStart(selected.resolvedDate) : ''} onApplied={() => { onApplied?.(); void load() }}/>}
    {canManage && !terminal && <>
     <form className="sg-settings-form" aria-label="Вопрос сотруднику" onSubmit={e => { e.preventDefault(); void mutate('/api/school/requests/' + selected.id + '/question', { expectedRevision: selected.revision, text: questionText, respondentMembershipId: recipient }, () => setQuestionText('')) }}>
      <label className="sg-settings-field">Кому задать вопрос<select required value={recipient} disabled={busy} onChange={e => setRecipient(e.target.value)}><option value="">Выберите сотрудника</option>{respondents.map(p => <option key={p.membershipId} value={p.membershipId}>{p.name}</option>)}</select></label>
      <label className="sg-settings-field">Вопрос<textarea required maxLength={1000} value={questionText} disabled={busy} onChange={e => setQuestionText(e.target.value)} /></label><button className="sg-control" disabled={busy}>Сохранить вопрос сотруднику</button>
     </form>
     {draft && <form className="sg-settings-form" aria-label="Подготовить изменение" onSubmit={e => { e.preventDefault(); void mutate('/api/school/requests/' + selected.id + '/proposal', { expectedRevision: selected.revision, expectedDraftRevision: draft.revision, targetWeekStart: targetWeekStart(proposalEditor.date), action: proposalAction, ...(proposalAction === 'change' ? { lessonId: proposalLessonId } : {}), lesson: lesson(proposalEditor) }) }}>
      <h3>Предложение для утверждения</h3>
      <label className="sg-settings-field">Действие<select value={proposalAction} disabled={busy} onChange={e => setProposalAction(e.target.value as 'add' | 'change')}><option value="add">Добавить занятие</option><option value="change">Изменить занятие</option></select></label>
      {proposalAction === 'change' && <label className="sg-settings-field">Исходное занятие<select required value={proposalLessonId} disabled={busy} onChange={e => { setProposalLessonId(e.target.value); const item = draft.lessons.find(l => l.id === e.target.value); if (item) setProposalEditor(old => ({ ...old, className: item.className, slot: String(item.slot), start: item.start, end: item.end, subject: item.subject, teachers: item.teachers.join(', '), rooms: item.rooms.join(', ') })) }}><option value="">Выберите занятие</option>{draft.lessons.map(l => <option key={l.id} value={l.id}>{l.className} · {l.subject} · {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][l.day]} · {l.start}</option>)}</select></label>}
      {fields(proposalEditor, true)}<button className="sg-control" disabled={busy}>Проверить и подготовить предложение</button>
     </form>}
    </>}
    {canManage && selected.proposal && <div>
     <h3>Точное изменение</h3>
     <p>Дата: {selected.proposal.targetDate}. Неделя с {selected.proposal.targetWeekStart}. Ревизия черновика: {selected.proposal.expectedDraftRevision}.</p>
     <p>Было: {selected.proposal.before ? describe(selected.proposal.before) : 'Занятия не было'}</p>
     <p>Предложено: {describe(selected.proposal.after)}</p>
     {selected.proposal.blockers?.map((b, i) => <p key={i}>{b.message}</p>)}
     {selected.status === 'proposed' && <div className="sg-actions"><button className="sg-control" disabled={busy || !!selected.proposal.blockers?.length} onClick={() => void mutate('/api/school/requests/' + selected.id + '/decision', { expectedRevision: selected.revision, decision: 'approve', proposalHash: selected.proposal!.hash })}>Утвердить изменение черновика</button><button className="sg-control" disabled={busy} onClick={() => void mutate('/api/school/requests/' + selected.id + '/decision', { expectedRevision: selected.revision, decision: 'reject', proposalHash: selected.proposal!.hash })}>Отклонить предложение</button></div>}
    </div>}
   </section>}
  </>}
 </section>
}
