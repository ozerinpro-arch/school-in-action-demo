import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiUrl } from './api'
import WholeSchoolTimetable from './WholeSchoolTimetable'
import ExperimentalDraftWorkspace from './ExperimentalDraftWorkspace'
import './experimental-school-plan.css'

type Status = 'queued' | 'running' | 'feasible' | 'optimal' | 'unknown' | 'infeasible' | 'failed' | 'stale'
type Assumption = { id: string; category: string; label: string; value: unknown; basis: string; sourceCells?: string[]; status: 'working_assumption' }
type Lesson = { id: string; eventId: string; className: string; day: number; slot: number; start: string; end: string; date?: string; subject: string; teachers: string[]; rooms: string[]; sourceCells: string[]; groupLabels: string[]; assumed: true }
export type SchoolExperiment = {
 id: string; schoolId: string; mode: 'working_assumptions'; periodStart: string; status: Status; message: string
 assumptions: Assumption[]; coverage: { sourceCells: number; coveredCells: number; eventCount: number; classes: number; teachers: number }
 warnings: unknown[]; provenance: unknown[]; deferredLoads?: unknown[]; sourceBinding: Record<string, unknown>; createdAt: string; updatedAt: string
 projection: { lessons: Lesson[]; issues: unknown[]; weekDays: number[]; weekLabel: string; classNames?: string[] } | null
 validation: { valid: boolean; [key: string]: unknown } | null
}
type Summary = Pick<SchoolExperiment, 'id' | 'periodStart' | 'status' | 'createdAt'>
type Collection = { schoolId: string; packageHash: string; draftRevision: number; latest: SchoolExperiment | null; candidates: Summary[] }
type Command = { periodStart: string; expectedDraftRevision: number; expectedPackageHash: string; requestId: string; useWorkingAssumptions: true }
type Failure = Error & { status?: number }
const endpoint = '/api/planning/experimental-school'
const statuses: Status[] = ['queued', 'running', 'feasible', 'optimal', 'unknown', 'infeasible', 'failed', 'stale']
const statusLabels: Record<Status, string> = { queued: 'В очереди', running: 'Расчёт выполняется', feasible: 'Вариант найден', optimal: 'Вариант найден', unknown: 'Расчёт не завершён', infeasible: 'Условия несовместимы', failed: 'Расчёт не выполнен', stale: 'Источник изменился' }
const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 16000
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 2000 && value.every(text)
const isoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const experimentId = (value: unknown): value is string => typeof value === 'string' && /^exp_[a-f0-9]{32}$/.test(value)
const validStatus = (value: unknown): value is Status => statuses.includes(value as Status)
const array = (value: unknown, max = 20000): value is unknown[] => Array.isArray(value) && value.length <= max
function validSummary(value: unknown): boolean {
 return object(value) && experimentId(value.id) && isoDate(value.periodStart) && validStatus(value.status) && text(value.createdAt)
}
function validExperiment(value: unknown): value is SchoolExperiment {
 if (!validSummary(value) || !object(value) || !text(value.schoolId) || !value.schoolId || value.mode !== 'working_assumptions' || !text(value.message) || !text(value.updatedAt) || !object(value.sourceBinding)) return false
 if (!object(value.coverage) || !['sourceCells', 'coveredCells', 'eventCount', 'classes', 'teachers'].every(key => integer(value.coverage && (value.coverage as Record<string, unknown>)[key]))) return false
 if (Number(value.coverage.coveredCells) > Number(value.coverage.sourceCells)) return false
 if (!array(value.assumptions, 4000) || !value.assumptions.every(item => object(item) && text(item.id) && text(item.category) && text(item.label) && text(item.basis) && item.status === 'working_assumption' && (item.sourceCells === undefined || strings(item.sourceCells)))) return false
 if (!array(value.warnings) || !array(value.provenance, 20000) || (value.deferredLoads !== undefined && !array(value.deferredLoads, 4000))) return false
 if (value.validation !== null && (!object(value.validation) || typeof value.validation.valid !== 'boolean')) return false
 if (value.projection === null) return true
 if (!object(value.projection) || !text(value.projection.weekLabel) || !array(value.projection.issues) || !array(value.projection.weekDays, 6) || !value.projection.weekDays.every(day => integer(day) && Number(day) <= 5) || (value.projection.classNames !== undefined && !strings(value.projection.classNames)) || !array(value.projection.lessons, 30000)) return false
 return value.projection.lessons.every(item => object(item) && text(item.id) && text(item.eventId) && text(item.className) && text(item.subject) && integer(item.day) && Number(item.day) <= 5 && integer(item.slot) && Number(item.slot) > 0 && typeof item.start === 'string' && /^\d{2}:\d{2}$/.test(item.start) && typeof item.end === 'string' && /^\d{2}:\d{2}$/.test(item.end) && (item.date === undefined || isoDate(item.date)) && strings(item.teachers) && strings(item.rooms) && strings(item.sourceCells) && strings(item.groupLabels) && item.assumed === true)
}
function validCollection(value: unknown): value is Collection {
 return object(value) && text(value.schoolId) && !!value.schoolId && hash(value.packageHash) && integer(value.draftRevision) && (value.latest === null || validExperiment(value.latest)) && (value.latest === null || value.latest.schoolId === value.schoolId) && array(value.candidates, 1000) && value.candidates.every(validSummary)
}
function validCommand(value: unknown): value is Command {
 return object(value) && isoDate(value.periodStart) && hash(value.expectedPackageHash) && integer(value.expectedDraftRevision) && value.useWorkingAssumptions === true && typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/.test(value.requestId)
}
const storageKey = (schoolId: string) => `school-experiment-command:${apiUrl(endpoint)}:${schoolId}`
const readCommand = (schoolId: string): Command | null => {
 try { const raw = sessionStorage.getItem(storageKey(schoolId)); const value: unknown = raw ? JSON.parse(raw) : null; return validCommand(value) ? value : null } catch { return null }
}
const valueLabels: Record<string, string> = {
 weeklyCount: 'Уроков в неделю', raw: 'Запись в источнике', rawCount: 'Запись в источнике', subject: 'Предмет',
 activeFrom: 'Действует с', activeUntil: 'Действует до', periodStart: 'Начало недели', periodEnd: 'Конец недели', cycleAnchor: 'Начало чередования',
 weekType: 'Фаза недели', teachingDays: 'Учебные дни', holidayExceptions: 'Календарные исключения', phase: 'Календарная фаза',
 wholeSize: 'Учеников в классе', subgroupSizes: 'Учеников в подгруппах', stableDisjointPartition: 'Постоянные подгруппы без пересечений',
 maxDaily: 'Не более уроков в день', maxWeekly: 'Не более уроков в неделю', maxConsecutive: 'Не более уроков подряд',
 classes: 'Классы', classNames: 'Классы', teacher: 'Педагог', teacherNames: 'Педагоги', sourceClass: 'Обозначение в источнике', targetClass: 'Принятое обозначение',
 slot: 'Номер урока', start: 'Начало урока', end: 'Конец урока', day: 'Учебный день', date: 'Дата', sourceCells: 'Исходные ячейки',
 room: 'Кабинет', rooms: 'Кабинеты', capacity: 'Вместимость', size: 'Численность', reason: 'Причина', label: 'Описание', message: 'Пояснение',
 weekdaySlot: 'Последний урок будней', saturdaySlot: 'Последний урок субботы', synchronousSubgroups: 'Подгруппы занимаются одновременно',
 currentPhase: 'Текущая фаза', sourceAverage: 'Средняя нагрузка в источнике', activeThisWeek: 'Активно на этой неделе', activeWeeklyCount: 'Уроков на активной неделе', displayTeacher: 'Педагог для отображения',
}
const categoryLabels: Record<string, string> = { calendar: 'Календарь', bells: 'Звонки', class_alias: 'Обозначения классов', group_membership: 'Состав групп', weekly_count: 'Количество уроков', subject_split: 'Разделение предметов', teacher_assignment: 'Назначения педагогов', module_phase: 'Календарные фазы', room_capacity: 'Вместимость кабинетов', room_eligibility: 'Подходящие кабинеты', group_assignment: 'Участники занятий', teacher_limits: 'Пределы нагрузки педагогов', availability: 'Доступное время', algorithm: 'Правила расчёта' }
const categoryLabel = (value: string) => categoryLabels[value] || (/[а-яё]/i.test(value) ? value : 'Другие предположения')
const readableDate = (value: unknown) => isoDate(value) ? new Date(value + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : null
function showValue(value: unknown, depth = 0): string {
 if (value === undefined || value === null) return 'Не задано'
 if (typeof value === 'string') return value
 if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Не задано'
 if (typeof value === 'boolean') return value ? 'Да' : 'Нет'
 if (depth > 4) return 'Подробности приведены в основании.'
 if (Array.isArray(value)) {
  if (!value.length) return 'Не заданы'
  if (value.every(item => Array.isArray(item) && item.length === 2 && item.every(part => typeof part === 'string' && /^\d{2}:\d{2}$/.test(part)))) return value.map((item, index) => `${index + 1} урок: ${item[0]}–${item[1]}`).join('\n')
  return value.map(item => showValue(item, depth + 1)).join(value.every(item => item === null || typeof item !== 'object') ? ', ' : '\n')
 }
 if (object(value)) {
  const entries = Object.entries(value).filter(([key]) => key in valueLabels || /^[0-9]{1,2}[А-ЯA-Z]$/u.test(key)).map(([key, item]) => {
   const temporal = ['activeFrom', 'activeUntil', 'periodStart', 'periodEnd', 'cycleAnchor', 'date'].includes(key) ? readableDate(item) : null
   const dayValue = key === 'teachingDays' && Array.isArray(item) && item.every(day => integer(day) && Number(day) <= 5) ? item.map(day => days[Number(day)]).join(', ') : key === 'day' && integer(item) && Number(item) <= 5 ? days[Number(item)] : null
   const code = key === 'reason' && item === 'alternate_module_phase' ? 'Другая фаза чередования' : (key === 'reason' && item === 'second_half_year') || (key === 'phase' && item === 'second_half') ? 'Второе полугодие' : null
   return `${valueLabels[key] || `Класс ${key}`}: ${temporal || dayValue || code || showValue(item, depth + 1)}`
  })
  return entries.length ? entries.join('\n') : 'Подробности приведены в основании.'
 }
 return 'Подробности приведены в основании.'
}
const warningLabel = (value: unknown) => object(value) && text(value.message) ? value.message : object(value) && text(value.label) ? value.label : showValue(value)
function dateLabel(start: string, day: number) {
 const date = new Date(start + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + day)
 return `${days[day]}, ${date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })}`
}
async function request(path = '', body?: Command): Promise<unknown> {
 const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
 try {
  const response = await apiFetch(endpoint + path, { signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  let value: unknown
  try { value = await response.json() } catch { throw new Error('Сервер вернул неполный ответ. Последний просмотр и запрос сохранены.') }
  if (!response.ok) { const error: Failure = new Error(object(value) && text(value.detail) ? value.detail : response.status === 409 ? 'Исходные данные изменились. Обновите просмотр перед новым расчётом.' : 'Экспериментальный расчёт временно недоступен. Повторите запрос.'); error.status = response.status; throw error }
  return value
 } catch (cause) { if ((cause as Error)?.name === 'AbortError') throw new Error('Ответ не получен вовремя. Повтор использует тот же запрос; новый расчёт автоматически не запускается.'); throw cause }
 finally { clearTimeout(timer) }
}

/** An isolated experimental candidate. It never activates or publishes a school plan. */
export default function ExperimentalSchoolPlan({ disabled = false, periodStart = '2026-10-26', experimentId: requestedId }: { disabled?: boolean; periodStart?: string; experimentId?: string }) {
 const [collection, setCollection] = useState<Collection | null>(null), [experiment, setExperiment] = useState<SchoolExperiment | null>(null)
 const displayPeriod = requestedId && experiment ? experiment.periodStart : periodStart
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState(false), [staleCommand, setStaleCommand] = useState(false), [pollPaused, setPollPaused] = useState(false)
 const alive = useRef(true), lock = useRef(false), command = useRef<Command | null>(null), school = useRef(''), selected = useRef(''), pollCount = useRef(0), pollDeadline = useRef(0), viewVersion = useRef(0)
 const acceptExperiment = (value: unknown, expectedSchool: string, expectedId?: string, version = viewVersion.current) => {
  if (!validExperiment(value) || value.schoolId !== expectedSchool || (expectedId && value.id !== expectedId)) throw new Error('Сервер вернул некорректный экспериментальный черновик. Последний просмотр сохранён.')
  if (alive.current && version === viewVersion.current) { selected.current = value.id; setExperiment(value) }
  return value
 }
 const load = async () => {
  if (lock.current) return
  const version = viewVersion.current
  lock.current = true; setBusy(true); setError(''); setPollPaused(false); pollCount.current = 0; pollDeadline.current = Date.now() + 60000
  try {
   const value = await request()
   if (!validCollection(value)) throw new Error('Сервер вернул некорректный список черновиков. Последний просмотр сохранён.')
   if (!alive.current || version !== viewVersion.current) return
   if (school.current !== value.schoolId) { command.current = readCommand(value.schoolId); setPending(!!command.current); selected.current = ''; setExperiment(null) }
   school.current = value.schoolId; setCollection(value); setStaleCommand(false)
   const candidate = value.candidates.find(item => item.id === selected.current && item.periodStart === displayPeriod) || value.candidates.find(item => item.periodStart === displayPeriod)
   if (requestedId && (!selected.current || selected.current === requestedId)) {
    if (!experimentId(requestedId)) throw new Error('Некорректный идентификатор экспериментального черновика.')
    acceptExperiment(await request('/' + requestedId), value.schoolId, requestedId, version)
   }
   else if (value.latest?.periodStart === displayPeriod && (!selected.current || selected.current === value.latest.id)) acceptExperiment(value.latest, value.schoolId, undefined, version)
   else if (candidate) acceptExperiment(await request('/' + candidate.id), value.schoolId, candidate.id, version)
   else { selected.current = ''; setExperiment(null) }
  } catch (cause) { if (alive.current && version === viewVersion.current) setError((cause as Error).message) }
  finally { lock.current = false; if (alive.current) setBusy(false) }
 }
 useEffect(() => {
  alive.current = true; viewVersion.current += 1; selected.current = ''; setExperiment(null)
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => { if (lock.current) return; if (timer) clearInterval(timer); void load() }
  if (lock.current) timer = setInterval(start, 50); else start()
  return () => { alive.current = false; viewVersion.current += 1; if (timer) clearInterval(timer) }
 }, [periodStart, requestedId])
 const select = async (id: string) => {
  if (lock.current || !collection || !experimentId(id)) return
  const version = viewVersion.current
  lock.current = true; setBusy(true); setError(''); setPollPaused(false); pollCount.current = 0; pollDeadline.current = Date.now() + 60000
  try { acceptExperiment(await request('/' + id), collection.schoolId, id, version) } catch (cause) { if (alive.current && version === viewVersion.current) setError((cause as Error).message) }
  finally { lock.current = false; if (alive.current) setBusy(false) }
 }
 const compose = async () => {
  if (!collection || lock.current || disabled || staleCommand || !isoDate(displayPeriod)) return
  const version = viewVersion.current
  lock.current = true; setBusy(true); setError(''); setPollPaused(false); pollCount.current = 0; pollDeadline.current = Date.now() + 60000
  const body: Command = command.current || { periodStart: displayPeriod, expectedDraftRevision: collection.draftRevision, expectedPackageHash: collection.packageHash, requestId: crypto.randomUUID(), useWorkingAssumptions: true }
  command.current = body; setPending(true)
  try { sessionStorage.setItem(storageKey(collection.schoolId), JSON.stringify(body)) } catch { /* An in-memory receipt still protects this mounted screen. */ }
  try {
   acceptExperiment(await request('', body), collection.schoolId, undefined, version)
   command.current = null; setPending(false)
   try { sessionStorage.removeItem(storageKey(collection.schoolId)) } catch { /* No credentials or source facts are stored here. */ }
  } catch (cause) {
   const failure = cause as Failure
   if (failure.status && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
    command.current = null; setPending(false); setStaleCommand(true)
    try { sessionStorage.removeItem(storageKey(collection.schoolId)) } catch { /* A rejected command is not retried automatically. */ }
   }
   if (alive.current && version === viewVersion.current) setError(failure.message)
  } finally { lock.current = false; if (alive.current) setBusy(false) }
 }
 useEffect(() => {
  if (!experiment || !['queued', 'running'].includes(experiment.status) || pollPaused) return
  let cancelled = false
  const id = experiment.id, expectedSchool = experiment.schoolId
  const timer = setTimeout(async () => {
   if (lock.current) return
   if (pollCount.current >= 40 || Date.now() >= pollDeadline.current) { setPollPaused(true); return }
   pollCount.current += 1; lock.current = true
   try {
    const value = await request('/' + id)
    if (!cancelled && alive.current && selected.current === id) acceptExperiment(value, expectedSchool, id)
   } catch (cause) { if (!cancelled && alive.current) { setError((cause as Error).message); setPollPaused(true) } }
   finally { lock.current = false }
  }, 1500)
  return () => { cancelled = true; clearTimeout(timer) }
 }, [experiment, pollPaused])
 const groups = useMemo(() => {
  const map = new Map<string, Assumption[]>()
  for (const item of experiment?.assumptions || []) { const items = map.get(item.category) || []; items.push(item); map.set(item.category, items) }
  return [...map.entries()]
 }, [experiment])
 const projection = experiment?.projection
 const classes = useMemo(() => projection?.classNames || [...new Set(projection?.lessons.map(item => item.className) || [])].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [projection])
 const labels = days.map((_, day) => dateLabel(experiment?.periodStart || periodStart, day))
 const stillRunning = experiment && ['queued', 'running'].includes(experiment.status)
 const bindingStale = !!experiment && (!!collection && typeof experiment.sourceBinding.packageHash === 'string' && experiment.sourceBinding.packageHash !== collection.packageHash || typeof experiment.sourceBinding.draftRevision === 'number' && !!collection && experiment.sourceBinding.draftRevision !== collection.draftRevision)
 if (experiment && projection?.lessons.length) return <>
  {error && <p role="alert" className="sp-json-error">{error}</p>}
  <ExperimentalDraftWorkspace key={`${experiment.schoolId}:${experiment.id}`} experiment={experiment} disabled={disabled || busy || bindingStale || experiment.status === 'stale'} controls={blocked => <>
   <button className="sg-control esp-action" disabled={blocked || !collection || staleCommand || !!stillRunning} onClick={() => void compose()}>{pending ? 'Проверить запрос расчёта' : 'Новый расчёт'}</button>
     {collection && collection.candidates.filter(item => item.periodStart === displayPeriod).length > 1 && <label className="esp-variant"><span className="sr-only">Сохранённые экспериментальные варианты</span><select aria-label="Сохранённые экспериментальные варианты" value={experiment.id} disabled={blocked} onChange={event => void select(event.target.value)}>{collection.candidates.filter(item => item.periodStart === displayPeriod).map(item => <option key={item.id} value={item.id}>Вариант {item.id.slice(-6)} · {new Date(item.createdAt).toLocaleString('en-GB')}</option>)}</select></label>}
</>} conditions={<>
   <p>Каждое значение ниже остаётся рабочим предположением. Согласование версии не делает эти сведения подтверждёнными школьными данными.</p>
   {groups.map(([category, items]) => <details key={category}><summary>{categoryLabel(category)} · {items.length}</summary>{items.map(item => <article key={item.id} className="esp-assumption"><strong>{item.label}</strong><p className="esp-value">{showValue(item.value)}</p><p>Основание: {item.basis}</p>{item.sourceCells?.length ? <p>Исходные ячейки: {item.sourceCells.join(', ')}</p> : null}</article>)}</details>)}
   {!!experiment.deferredLoads?.length && <details><summary>Нагрузка в другой календарной фазе · {experiment.deferredLoads.length}</summary><ul>{experiment.deferredLoads.map((item,index) => <li key={index}>{warningLabel(item)}</li>)}</ul></details>}
   {!!experiment.warnings.length && <details><summary>Предупреждения · {experiment.warnings.length}</summary><ul>{experiment.warnings.map((item,index) => <li key={index}>{warningLabel(item)}</li>)}</ul></details>}
  </>}/>
 </>
 return <section className="experimental-school-plan cp-stack" aria-label="Экспериментальный черновик всей школы">
  <section className="sg-panel esp-panel">
   <div className="sp-section-heading esp-heading"><div><h2>Экспериментальный черновик</h2><p>{dateLabel(displayPeriod, 0)} — {dateLabel(displayPeriod, 5)}</p></div><span className="tt-badge amber">Не опубликован</span></div>
   <div className="esp-banner"><strong>ЭКСПЕРИМЕНТАЛЬНЫЙ ЧЕРНОВИК</strong><p>Неизвестные данные заменены рабочими предположениями. Этот вариант не является согласованным расписанием и не меняет действующую сетку школы.</p></div>
   <div className="sp-action-row esp-actions"><button type="button" className="sg-control sg-primary esp-action" disabled={disabled || busy || !collection || staleCommand || !!stillRunning || !isoDate(displayPeriod)} onClick={() => void compose()}>{pending ? 'Повторить тот же запрос расчёта' : 'Составить черновик с предположениями'}</button><button type="button" className="sg-control esp-action" disabled={busy} onClick={() => void load()}>Обновить черновик</button></div>
   {pending && <p role="status" className="esp-note">Ответ предыдущего запроса не подтверждён. Повтор отправит тот же запрос с исходными версиями данных{command.current?.periodStart ? ` на ${command.current.periodStart}` : ''}; новый расчёт автоматически не запускается.</p>}
   {!collection && !error && <p role="status">Загружаем экспериментальные черновики…</p>}
   {error && <p role="alert" className="sp-json-error">{error}</p>}
   {staleCommand && <p role="status">Обновите просмотр, чтобы получить актуальные версии перед новым запросом.</p>}
   {collection && !experiment && !busy && <div className="sp-empty"><h3>Черновика на эту неделю пока нет</h3><p>Расчёт сохранит отдельный экспериментальный вариант и список использованных предположений.</p></div>}
   {collection && collection.candidates.filter(item => item.periodStart === displayPeriod).length > 1 && <label className="sp-field"><span>Сохранённые экспериментальные варианты</span><select value={experiment?.id || ''} disabled={busy} onChange={event => void select(event.target.value)}>{!experiment && <option value="">Выберите вариант</option>}{collection.candidates.filter(item => item.periodStart === displayPeriod).map(item => <option key={item.id} value={item.id}>{item.createdAt} · {statusLabels[item.status]} · {item.id.slice(-6)}</option>)}</select></label>}
   {experiment && <div className="esp-status" role="status"><strong>{statusLabels[experiment.status]}</strong><p>{experiment.message}</p><small>Вариант {experiment.id} · {experiment.updatedAt}</small>{stillRunning && <p>Расчёт идёт отдельно от действующего расписания. Проверяем только его статус.</p>}{pollPaused && <p>Автоматическое ожидание остановлено. Нажмите «Обновить черновик» — это проверит результат без повторного запуска.</p>}{(bindingStale || experiment.status === 'stale') && <p>Источники или исходная сетка изменились. Этот вариант сохранён для просмотра; для актуального расчёта нужен новый запрос.</p>}</div>}
  </section>
  {experiment && <>
   <section className="sg-panel esp-panel"><h3>Покрытие исходных назначений</h3><div className="sp-result-stats"><div><strong>{experiment.coverage.coveredCells} / {experiment.coverage.sourceCells}</strong><span>исходных ячеек учтено в эксперименте</span></div><div><strong>{experiment.coverage.eventCount}</strong><span>событий с учётом общих занятий</span></div><div><strong>{experiment.coverage.classes} / {experiment.coverage.teachers}</strong><span>классов / педагогов</span></div></div><p className="esp-note">Покрытие включает активную нагрузку и явно отложенные календарём занятия. Оно не подтверждает правильность предположений и не означает, что вся нагрузка проводится на этой неделе.</p>{experiment.validation && <p>{experiment.validation.valid ? 'Машинная проверка варианта пройдена в рамках принятых предположений.' : 'Машинная проверка выявила проблемы. Вариант требует исправления.'}</p>}{experiment.warnings.length > 0 && <details><summary>Предупреждения · {experiment.warnings.length}</summary><ul>{experiment.warnings.map((item, index) => <li key={index}>{warningLabel(item)}</li>)}</ul></details>}</section>
   <section className="sg-panel esp-panel"><h3>Рабочие предположения · {experiment.assumptions.length}</h3><p>Каждое значение остаётся предположением. Основание и исходные ячейки доступны ниже.</p>{groups.length ? groups.map(([category, items]) => <details key={category}><summary>{categoryLabel(category)} · {items.length}</summary>{items.map(item => <article key={item.id} className="esp-assumption"><strong>{item.label}</strong><p className="esp-value">{showValue(item.value)}</p><p>Основание: {item.basis}</p>{item.sourceCells?.length ? <p>Исходные ячейки: {item.sourceCells.join(', ')}</p> : null}<small>Рабочее предположение</small></article>)}</details>) : <p>Список предположений пока не получен.</p>}{!!experiment.deferredLoads?.length && <details><summary>Нагрузка в другой календарной фазе · {experiment.deferredLoads.length}</summary><p>Эти занятия учтены в покрытии источников, но предполагаются вне выбранной недели. Это отличается от неразмещённого активного урока.</p><ul>{experiment.deferredLoads.map((item, index) => <li key={index}>{warningLabel(item)}</li>)}</ul></details>}<p className="esp-note">Связей происхождения: {experiment.provenance.length}. Реестр источников и действующее расписание сохраняются отдельно.</p></section>
   <section className="sg-panel esp-panel"><div className="sp-section-heading esp-heading"><div><h3>Общая сетка · {projection?.weekLabel || experiment.periodStart}</h3><p>Все занятия показаны оранжевым как предложения. Общие занятия показаны во всех участвующих классах.</p></div><span className="tt-badge amber">Предложения</span></div>{projection?.lessons.length ? <div className="tt-workspace esp-grid"><WholeSchoolTimetable lessons={projection.lessons} classes={classes} dayNames={labels} filtered={false} viewLabel="Общая экспериментальная сетка всех классов" renderLesson={lesson => <article className="tt-lesson tt-was-edited esp-lesson" data-experiment-event={lesson.eventId} data-experiment-class={lesson.className}><span className="tt-lesson-top"><b>{lesson.className}</b><span>Предположение</span></span><strong>{lesson.subject}</strong><span>{lesson.teachers.join(', ') || 'Педагог не указан'}</span><span>{lesson.rooms.join(', ') || 'Кабинет не указан'}</span>{lesson.groupLabels.length > 0 && <span>{lesson.groupLabels.join(', ')}</span>}<small>{lesson.sourceCells.join(', ')}</small></article>}/></div> : <div className="sp-empty"><h4>Сетка пока не получена</h4><p>{stillRunning ? 'Она появится после завершения расчёта.' : 'Сохранены статус, предположения и диагностика расчёта.'}</p></div>}{projection && projection.issues.length > 0 && <details><summary>Диагностика сетки · {projection.issues.length}</summary><ul>{projection.issues.map((issue, index) => <li key={index}>{warningLabel(issue)}</li>)}</ul></details>}</section>
  </>}
 </section>
}
