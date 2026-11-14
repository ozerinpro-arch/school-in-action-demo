import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { apiFetch } from './api'
import WholeSchoolTimetable from './WholeSchoolTimetable'
import './experimental-school-plan.css'
import './experimental-draft-workspace.css'
import './short-week-draft.css'

type Lesson = { id: string; className: string; day: number; slot: number; start: string; end: string; subject: string; teachers: string[]; rooms: string[]; date?: string; sourceCell?: string; raw?: string }
type Issue = { id: string; kind: string; severity: 'error' | 'warning'; message: string; lessonIds: string[] }
type Draft = { id: string; revision: number; weekStart: string; title: string; teachingDates: string[]; closedDates: string[]; holidayEnd: null; sourceName: string; sourcePeriod: string; sourceChanged?: boolean; lessons: Lesson[]; issues: Issue[]; notes: string[]; repairs: (string | { message: string })[]; scope: 'historical_carryover'; publicationBlocked: true }
type Envelope = { draft: Draft | null; canCreate: boolean }
type Command = { weekStart: string; expectedSourceRevision: number; requestId: string }
const weekStart = '2026-10-26'
const teachingDates = ['2026-10-26', '2026-10-27', '2026-10-28']
const closedDates = ['2026-10-29', '2026-10-30', '2026-10-31']
const dayNames = ['Понедельник, 26 октября', 'Вторник, 27 октября', 'Среда, 28 октября']
const endpoint = '/api/timetable/dated-draft'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 5000): v is string => typeof v === 'string' && v.length <= max
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min
const strings = (v: unknown, max = 2000): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => text(x))
const time = (v: unknown): v is string => text(v, 5) && /^\d{2}:\d{2}$/.test(v) && Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60
const sameDates = (value: unknown, expected: string[]) => strings(value, expected.length) && value.length === expected.length && expected.every(date => value.includes(date))
function validEnvelope(value: unknown): value is Envelope {
 if (!object(value) || typeof value.canCreate !== 'boolean') return false
 if (value.draft === null) return true
 const d = value.draft
 if (!object(d) || !text(d.id, 160) || !d.id || !integer(d.revision, 1) || d.weekStart !== weekStart || !text(d.title) || d.scope !== 'historical_carryover' || d.publicationBlocked !== true || d.holidayEnd !== null || !sameDates(d.teachingDates, teachingDates) || !sameDates(d.closedDates, closedDates) || !text(d.sourceName) || !text(d.sourcePeriod) || d.sourceChanged !== undefined && typeof d.sourceChanged !== 'boolean') return false
 if (!Array.isArray(d.lessons) || d.lessons.length > 30000 || !d.lessons.every(l => object(l) && text(l.id, 160) && !!l.id && text(l.className, 80) && !!l.className && integer(l.day) && Number(l.day) <= 2 && integer(l.slot, 1) && Number(l.slot) <= 20 && time(l.start) && time(l.end) && l.start < l.end && text(l.subject) && strings(l.teachers) && strings(l.rooms) && (l.date === undefined || l.date === teachingDates[Number(l.day)]) && (l.sourceCell === undefined || text(l.sourceCell)) && (l.raw === undefined || text(l.raw, 20000)))) return false
 return Array.isArray(d.issues) && d.issues.length <= 5000 && d.issues.every(i => object(i) && text(i.id, 160) && text(i.kind, 160) && ['error', 'warning'].includes(String(i.severity)) && text(i.message) && strings(i.lessonIds, 30000)) && strings(d.notes) && Array.isArray(d.repairs) && d.repairs.length <= 5000 && d.repairs.every(r => text(r) || object(r) && text(r.message))
}
class Failure extends Error { constructor(message: string, public status = 0) { super(message) } }
async function request(controller: AbortController, command?: Command): Promise<Envelope> {
 const timer = setTimeout(() => controller.abort(), 15000)
 try {
  const response = await apiFetch(command ? endpoint : endpoint + '?weekStart=' + weekStart, { signal: controller.signal, ...(command ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) } : {}) })
  let data: unknown
  try { data = await response.json() } catch { throw new Failure('Сервер вернул неполный ответ. Повторите проверку сохранения.') }
  if (!response.ok) throw new Failure(object(data) && text(data.detail, 2000) ? data.detail : response.status === 409 ? 'Исходная сетка изменилась. Обновите просмотр перед созданием черновика.' : response.status === 401 || response.status === 403 ? 'Доступ к школьному черновику не подтверждён.' : 'Не удалось загрузить датированный черновик. Повторите действие.', response.status)
  if (!validEnvelope(data) || command && data.draft === null) throw new Failure('Сервер не подтвердил датированный исторический черновик. Последний просмотр сохранён.')
  return data
 } catch (cause) {
  if ((cause as Error)?.name === 'AbortError') throw new Failure('Ответ не получен вовремя. Проверка сохранения повторит тот же запрос.')
  if (cause instanceof Failure) throw cause
  throw new Failure('Нет связи с сервером. Повторите загрузку или проверку сохранения.')
 } finally { clearTimeout(timer) }
}
const roomNames = (lesson: Lesson) => lesson.rooms.filter(name => name.trim() && name.trim().toLocaleLowerCase('ru') !== 'extra')
const roomLabel = (lesson: Lesson) => {
 const names = roomNames(lesson)
 const known = names.map(name => /^каб(?:\.|инет|\s)/i.test(name.trim()) ? name : `Каб. ${name}`).join(', ')
 return !known ? 'Кабинет уточняется' : names.length !== lesson.rooms.length ? known + ' · кабинет уточняется' : known
}

/** A dated historical copy, with no solver, edit, approval or publication action. */
export default function ShortWeekDraft({ sourceRevision, disabled = false }: { sourceRevision: number; disabled?: boolean }) {
 const [value, setValue] = useState<Envelope | null>(null), [busy, setBusy] = useState<'load' | 'create' | null>('load'), [error, setError] = useState(''), [pending, setPending] = useState(false)
 const [day, setDay] = useState<number | 'week'>(0), [search, setSearch] = useState('')
 const alive = useRef(true), lock = useRef(false), command = useRef<Command | null>(null), currentRequest = useRef<AbortController | null>(null)
 const accept = (next: Envelope) => { setValue(next); if (next.draft) { command.current = null; setPending(false) } }
 const handleError = (cause: unknown) => {
  const failure = cause as Failure
  if ([401, 403].includes(failure.status)) { setValue(null); command.current = null; setPending(false) }
  setError(failure.message)
 }
 async function load() {
  if (lock.current) return
  lock.current = true; setBusy('load'); setError('')
  const controller = new AbortController(); currentRequest.current = controller
  try { const next = await request(controller); if (alive.current && currentRequest.current === controller) accept(next) } catch (cause) { if (alive.current && currentRequest.current === controller) handleError(cause) }
  finally { if (currentRequest.current === controller) { lock.current = false; if (alive.current) setBusy(null) } }
 }
 async function create() {
  if (disabled || lock.current || !value || value.draft || !value.canCreate || !integer(sourceRevision)) return
  lock.current = true; setBusy('create'); setError('')
  const body = command.current || { weekStart, expectedSourceRevision: sourceRevision, requestId: crypto.randomUUID() }
  command.current = body; setPending(true)
  const controller = new AbortController(); currentRequest.current = controller
  try { const next = await request(controller, body); if (alive.current && currentRequest.current === controller) accept(next) }
  catch (cause) {
   const failure = cause as Failure
   if (currentRequest.current !== controller) return
   if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) { command.current = null; if (alive.current) setPending(false) }
   if (alive.current) handleError(cause)
  } finally { if (currentRequest.current === controller) { lock.current = false; if (alive.current) setBusy(null) } }
 }
 useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; currentRequest.current?.abort(); currentRequest.current = null; lock.current = false } }, [])
 const draft = value?.draft
 const classes = useMemo(() => [...new Set(draft?.lessons.map(l => l.className) || [])].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [draft])
 const shown = useMemo(() => (draft?.lessons || []).filter(l => (day === 'week' || l.day === day) && `${l.className} ${l.subject} ${l.teachers.join(' ')} ${roomLabel(l)} ${l.sourceCell || ''}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))), [draft, day, search])
 const lessonsById = useMemo(() => new Map(draft?.lessons.map(l => [l.id, l]) || []), [draft])
 const issuesByLesson = useMemo(() => { const result = new Map<string, Issue[]>(); for (const issue of draft?.issues || []) for (const id of issue.lessonIds) result.set(id, [...(result.get(id) || []), issue]); return result }, [draft])
 const errors = draft?.issues.filter(i => i.severity === 'error') || [], warnings = draft?.issues.filter(i => i.severity === 'warning') || []
 const lessonTitle = (l: Lesson) => [l.subject, ...(issuesByLesson.get(l.id) || []).map(i => i.message)].join('\n')
 const renderIssue = (issue: Issue) => <li key={issue.id} className={issue.severity === 'error' ? 'swd-issue-error' : ''}><strong>{issue.lessonIds.map(id => lessonsById.get(id)).filter((l): l is Lesson => !!l).map(l => `${l.className} · ${dayNames[l.day]} · ${l.slot} урок${l.sourceCell ? ' · ячейка ' + l.sourceCell : ''}`).join('; ') || 'Общий вопрос'}</strong><p>{issue.message}</p></li>
 const unknownRooms = draft?.lessons.filter(l => !roomNames(l).length || roomNames(l).length !== l.rooms.length).length || 0
 const blocked = disabled || !!busy
 return <section className="experimental-school-plan esp-editable swd-draft" aria-label="Датированный черновик на 26–28 октября 2026">
  <section className="sg-panel esp-panel">
   <div className="esp-heading"><div><span className="esp-eyebrow">Исторический перенос · 26–28 октября 2026</span><h2>{draft?.title || 'Черновик короткой недели'}</h2><p>{draft ? `Версия ${draft.revision} · ${classes.length} классов · ${draft.lessons.length} строк занятий` : 'Понедельник, вторник и среда. С четверга, 29 октября, каникулы.'}</p></div><span className="esp-state swd-incomplete">Неполный черновик</span></div>
   <div className="esp-working-note"><AlertCircle size={17}/><p>Основа — историческая сетка, а не новый полный расчёт нагрузки. Неизвестные данные требуют уточнения. Публикация этого неполного черновика заблокирована.</p></div>
   <p className="swd-calendar">29, 30 и 31 октября — каникулы. Дата их окончания не указана.</p>
   <div className="esp-toolbar">
    {value?.draft === null && value.canCreate && <button type="button" className="sg-control sg-primary esp-action" disabled={blocked || !integer(sourceRevision)} onClick={() => void create()}>{busy === 'create' ? 'Сохраняем черновик…' : pending ? 'Проверить сохранение тем же запросом' : 'Создать черновик на 26–28 октября'}</button>}
    <button type="button" className="sg-control esp-action" disabled={blocked} onClick={() => void load()}><RefreshCw size={15}/>{busy === 'load' ? 'Загружаем…' : 'Обновить черновик'}</button>
   </div>
   {pending && <p className="esp-note" role="status">Ответ на создание не подтверждён. Обновление проверит сохранённую запись; повтор создания использует тот же запрос и исходную ревизию.</p>}
   {error && <p className="esp-error" role="alert">{error}</p>}
   {busy === 'load' && !value && <p role="status">Загружаем датированный исторический черновик…</p>}
   {value?.draft === null && <p className="esp-note">{value.canCreate ? 'Сохранённого варианта пока нет. Создание перенесёт исторические занятия только на три учебные даты.' : 'Сохранённого варианта пока нет; создание недоступно для текущего доступа.'}</p>}
   {draft && <p className="esp-note">Источник: {draft.sourceName} · {draft.sourcePeriod}. Полнота актуальной нагрузки этим переносом не подтверждается.</p>}
   {draft?.sourceChanged && <p className="esp-working-note swd-source-changed" role="status">Исходная сетка изменилась после сохранения этого варианта. Исторический черновик не пересоздавался автоматически; проверьте его соответствие источнику.</p>}
  </section>
  {draft && <>
   <section className="sg-panel esp-panel tt-calendar esp-table-panel">
    <div className="esp-heading"><div><h3>Все классы · исторический черновик</h3><p>Занятия показаны как в сохранённой основе. Этот экран предназначен для просмотра.</p></div><span className="esp-state">Публикация заблокирована</span></div>
    <div className="esp-filters"><div className="tt-day-tabs esp-day-tabs swd-days" role="group" aria-label="Учебные даты короткой недели" style={{ '--tt-day-count': 4, '--tt-day-index': day === 'week' ? 3 : day } as CSSProperties}>{['Пн · 26 октября', 'Вт · 27 октября', 'Ср · 28 октября', 'Вся неделя'].map((label, i) => <button type="button" key={label} disabled={blocked} aria-pressed={day === (i === 3 ? 'week' : i)} onClick={() => setDay(i === 3 ? 'week' : i)}>{label}</button>)}</div><label className="swd-search"><span>Поиск по предмету, педагогу, кабинету или исходной ячейке</span><input type="search" value={search} disabled={blocked} onChange={event => setSearch(event.target.value)} placeholder="Найти занятие"/></label></div>
    {draft.lessons.length ? <div className="tt-workspace esp-grid"><WholeSchoolTimetable compactTime lessons={shown} classes={classes} dayNames={dayNames} filtered={!!search.trim()} viewLabel="Исторический черновик всех классов на 26–28 октября" renderLesson={l => <article className={`tt-lesson esp-card${issuesByLesson.get(l.id)?.some(i => i.severity === 'error') ? ' has-error' : ''}`} data-dated-lesson={l.id} title={lessonTitle(l)} aria-label={`${l.className}, ${l.subject}, ${dayNames[l.day]}, ${l.slot} урок${issuesByLesson.has(l.id) ? '. ' + (issuesByLesson.get(l.id) || []).map(i => i.message).join('; ') : ''}`}><strong className="esp-card-subject" title={lessonTitle(l)}>{l.subject}</strong>{' · '}<span className="esp-card-meta"><small className="esp-card-teacher" title={l.teachers.join(', ') || 'Педагог уточняется'}>{l.teachers.join(', ') || 'Педагог уточняется'}</small>{' · '}<span className={`esp-card-room${!roomNames(l).length || roomNames(l).length !== l.rooms.length ? ' swd-room-unknown' : ''}`} title={roomLabel(l)}>{roomLabel(l)}</span></span></article>}/></div> : <div className="sp-empty"><h4>В историческом черновике нет занятий</h4><p>Полнота нагрузки требует проверки.</p></div>}
    {draft.lessons.length > 0 && !shown.length && <p className="esp-note" role="status">Занятий по выбранным условиям нет. Выберите другой учебный день или измените поиск; колонки всех классов сохранены.</p>}
    {unknownRooms > 0 && <p className="esp-note">Кабинет уточняется в {unknownRooms} строках исходной записи. Неподтверждённые названия не принимаются за помещения.</p>}
   </section>
   <section className="sg-panel esp-panel swd-notes"><h3>Ограничения и известные вопросы</h3>{draft.notes.map((note, i) => <p key={i}>{note}</p>)}{errors.length > 0 && <div className="swd-errors"><h4>Проблемы · {errors.length}</h4><ul>{errors.map(renderIssue)}</ul></div>}{warnings.length > 0 && <details><summary>Уточнения · {warnings.length}</summary><ul>{warnings.map(renderIssue)}</ul></details>}{!draft.issues.length && <p>В этой записи нет отдельных замечаний. Это не подтверждает полноту нагрузки и школьных условий.</p>}{draft.repairs.length > 0 && <details><summary>Зафиксированные изменения · {draft.repairs.length}</summary><ul>{draft.repairs.map((repair, i) => <li key={i}>{typeof repair === 'string' ? repair : repair.message}</li>)}</ul></details>}</section>
  </>}
 </section>
}
