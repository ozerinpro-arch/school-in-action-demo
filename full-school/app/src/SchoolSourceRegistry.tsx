import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'

type Binding = { packageHash: string; draftRevision: number; draftHash: string }
type Teacher = { id: string; name: string; subjectsObserved: unknown[]; maxDaily: null; maxWeekly: null; maxConsecutive: null; qualifications: null }
type Registry = {
 schoolId: string; version: 1; revision: number; mode: 'source_only'; asOf: string; binding: Binding
 teachers: Teacher[]; classes: { id: string; label: string; size: null }[]
 rooms: { id: string; name: string; capacity: null; status: 'observed_only' }[]
 assignments: { sourceCell: string; classLabel: string; rawSubject: string; teacher: string; rawCount: number | string }[]
 classAliases: { sourceClass: string; targetClass: string; status: 'tentative'; requiresConfirmation: true }[]
 sharedGroups: { sourceCells: string[]; size: null; memberIds: null; evidence?: { part?: string } }[]
 countHypotheses: { sourceCell: string; rawCount: number | string; weeklyCount: number; status: 'hypothesis'; requiresConfirmation: true; reason: string }[]
 unknowns: { code: string; label: string }[]
}
type Result = { saved: boolean; registry: Registry | null; preview?: Registry; binding: Binding; revision: number; stale: boolean }
type Command = Binding & { expectedRegistryRevision: number; requestId: string }
type Failure = Error & { status?: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown) => Number.isInteger(value) && Number(value) >= 0
const binding = (value: unknown): value is Binding => object(value) && typeof value.packageHash === 'string' && /^[a-f0-9]{64}$/.test(value.packageHash) && typeof value.draftHash === 'string' && /^[a-f0-9]{64}$/.test(value.draftHash) && integer(value.draftRevision)
const sameBinding = (left: Binding, right: Binding) => left.packageHash === right.packageHash && left.draftRevision === right.draftRevision && left.draftHash === right.draftHash
function validRegistry(value: unknown): value is Registry {
 if (!object(value) || value.version !== 1 || value.mode !== 'source_only' || typeof value.schoolId !== 'string' || !integer(value.revision) || !binding(value.binding)) return false
 for (const key of ['teachers', 'classes', 'rooms', 'assignments', 'classAliases', 'sharedGroups', 'countHypotheses', 'unknowns']) if (!Array.isArray(value[key]) || value[key].length > 2000 || !value[key].every(object)) return false
 const entries = value as unknown as Registry
 return entries.teachers.every(item => typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.subjectsObserved) && item.maxDaily === null && item.maxWeekly === null && item.maxConsecutive === null && item.qualifications === null)
  && entries.classes.every(item => typeof item.id === 'string' && typeof item.label === 'string' && item.size === null)
  && entries.rooms.every(item => typeof item.id === 'string' && typeof item.name === 'string' && item.capacity === null && item.status === 'observed_only')
  && entries.assignments.every(item => typeof item.sourceCell === 'string' && typeof item.classLabel === 'string' && typeof item.rawSubject === 'string' && typeof item.teacher === 'string' && ['string', 'number'].includes(typeof item.rawCount))
  && entries.classAliases.every(item => typeof item.sourceClass === 'string' && typeof item.targetClass === 'string' && item.status === 'tentative' && item.requiresConfirmation === true)
  && entries.sharedGroups.every(item => Array.isArray(item.sourceCells) && item.sourceCells.every(cell => typeof cell === 'string') && item.size === null && item.memberIds === null && (item.evidence === undefined || (object(item.evidence) && (item.evidence.part === undefined || typeof item.evidence.part === 'string'))))
  && entries.countHypotheses.every(item => typeof item.sourceCell === 'string' && ['string', 'number'].includes(typeof item.rawCount) && typeof item.reason === 'string' && Number.isInteger(item.weeklyCount) && item.weeklyCount > 0 && item.status === 'hypothesis' && item.requiresConfirmation === true)
  && entries.unknowns.every(item => typeof item.code === 'string' && typeof item.label === 'string')
}
async function request(body?: Command): Promise<Result> {
 const response = await apiFetch('/api/planning/school-source-registry', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
 let value: unknown
 try { value = await response.json() } catch { throw new Error('Сервер вернул неполный ответ реестра. Повтор сохранения использует тот же запрос.') }
 if (!response.ok) {
  const error: Failure = new Error(object(value) && typeof value.detail === 'string' ? value.detail : response.status === 409 ? 'Источник или версия реестра изменились. Обновите просмотр перед сохранением.' : 'Исходный реестр временно недоступен. Повторите запрос.')
  error.status = response.status; throw error
 }
 if (!object(value) || typeof value.saved !== 'boolean' || typeof value.stale !== 'boolean' || !integer(value.revision) || !binding(value.binding) || (value.registry !== null && !validRegistry(value.registry)) || (value.preview !== undefined && !validRegistry(value.preview)) || (!value.registry && !value.preview)) throw new Error('Сервер вернул некорректный исходный реестр. Последний просмотр сохранён; повторите запрос.')
 const result = value as unknown as Result
 if (result.saved !== !!result.registry || (result.stale && !result.saved)
  || (result.preview && (result.preview.revision !== result.revision || !sameBinding(result.preview.binding, result.binding)))
  || (result.registry && (result.registry.revision !== result.revision || (!result.stale && !sameBinding(result.registry.binding, result.binding))
   || (result.preview && result.preview.schoolId !== result.registry.schoolId)))) throw new Error('Сервер вернул несогласованные версии исходного реестра. Последний просмотр сохранён; обновите его перед сохранением.')
 return value as unknown as Result
}
const storageKey = (value: Result) => 'school-source-registry-command:' + (value.preview || value.registry)?.schoolId
const readCommand = (value: Result): Command | null => {
 try { const raw = sessionStorage.getItem(storageKey(value)); if (!raw) return null; const parsed: unknown = JSON.parse(raw); return object(parsed) && integer(parsed.expectedRegistryRevision) && typeof parsed.requestId === 'string' && binding(parsed) ? parsed as Command : null } catch { return null }
}

/** Saves source observations only. Normative activation is a separate workflow. */
export default function SchoolSourceRegistry({ disabled = false }: { disabled?: boolean }) {
 const [data, setData] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(false)
 const alive = useRef(true), lock = useRef(false), command = useRef<Command | null>(null)
 const load = async () => {
  if (lock.current) return
  lock.current = true; setBusy(true); setError('')
  try { const next = await request(); if (!alive.current) return; setData(next); command.current ||= readCommand(next); setPending(!!command.current) }
  catch (cause) { if (alive.current) setError((cause as Error).message) }
  finally { lock.current = false; if (alive.current) setBusy(false) }
 }
 useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
 const save = async () => {
  if (!data || disabled || lock.current) return
  lock.current = true; setBusy(true); setError(''); setNotice('')
  const body = command.current || { expectedRegistryRevision: data.revision, ...data.binding, requestId: crypto.randomUUID() }
  command.current = body; setPending(true)
  try { sessionStorage.setItem(storageKey(data), JSON.stringify(body)) } catch { /* Memory still protects retry in this page. */ }
  try {
   const result = await request(body)
   if (!alive.current) return
   command.current = null; setPending(false)
   try { sessionStorage.removeItem(storageKey(data)) } catch { /* No credentials are stored here. */ }
   setData({ ...result, preview: result.registry || undefined })
   setNotice('Исходный реестр сохранён. Неизвестные значения и гипотезы отмечены; нормативный план требует отдельной подготовки.')
   try { const current = await request(); if (alive.current) setData(current) } catch { if (alive.current) setNotice('Исходный реестр сохранён. Для актуального просмотра повторите обновление.') }
  } catch (cause) {
   const failure = cause as Failure
   if (failure.status && failure.status >= 400 && failure.status < 500) {
    command.current = null; setPending(false)
    try { sessionStorage.removeItem(storageKey(data)) } catch { /* The rejected command did not save. */ }
   }
   if (alive.current) setError(failure.message)
  } finally { lock.current = false; if (alive.current) setBusy(false) }
 }
 const current = data?.preview || data?.registry
 return <section className="sp-details" aria-label="Исходный реестр школы">
  <div className="sp-section-heading"><div><h4>Исходный реестр школы</h4><p>Найденные факты сохраняются отдельно от нормативного плана. Численность групп, вместимость и пределы педагогов остаются неизвестными.</p></div><button className="sp-btn sp-secondary" disabled={busy} onClick={() => void load()}>Обновить исходный реестр</button></div>
  {!data && !error && <p role="status">Исходный реестр загружается…</p>}
  {current && <>
   <p>Педагогов: {current.teachers.length} · классов: {current.classes.length} · наблюдаемых кабинетов: {current.rooms.length} · исходных назначений: {current.assignments.length}.</p>
   <p role="status">{data?.saved ? `Сохранённая версия реестра: ${data.revision}.` : 'Исходный реестр ещё не сохранён.'} {data?.stale && 'Пакет или исходная сетка изменились. Ниже показан новый просмотр; сохраните его после проверки.'}</p>
   <details><summary>Педагоги и классы</summary><p>{current.teachers.map(item => item.name).join('; ')}.</p><p>Классы: {current.classes.map(item => item.label).join(', ')}. Численность не указана.</p><p>Назначенные в источнике предметы сохранены как наблюдения. Квалификация и пределы нагрузки не подтверждены.</p></details>
   <details><summary>Кабинеты · {current.rooms.length}</summary><p>{current.rooms.map(item => item.name).join(', ') || 'Названия кабинетов ещё не найдены.'}</p><p>Вместимость неизвестна; кабинет не становится автоматически разрешённым для курса.</p></details>
   <details><summary>Связи общих занятий · {current.sharedGroups.length}</summary>{current.sharedGroups.map((item, index) => <p key={index}>{item.sourceCells.join(', ')}{item.evidence?.part && <> · {item.evidence.part}</>}<br/>Состав и численность группы не установлены.</p>)}</details>
   <details><summary>Гипотезы часов · {current.countHypotheses.length}</summary><p>Это предположения для дальнейшего расчёта. Они сохраняются с отметкой «гипотеза» и требуют проверки.</p>{current.countHypotheses.map(item => <p key={item.sourceCell}><strong>{item.sourceCell}: {String(item.rawCount)} → {item.weeklyCount} ч/нед.</strong><br/>{item.reason}</p>)}</details>
   {current.classAliases.length > 0 && <details><summary>Неподтверждённые обозначения классов · {current.classAliases.length}</summary><p>{current.classAliases.map(item => `${item.sourceClass} → ${item.targetClass}`).join('; ')}.</p></details>}
   <details><summary>Что ещё неизвестно · {current.unknowns.length}</summary>{current.unknowns.map(item => <p key={item.code}>{item.label}</p>)}</details>
   {pending && <p role="status">Результат предыдущего сохранения не подтверждён. Повтор отправит тот же запрос, включая его исходную версию.</p>}
   <button className="sp-btn sp-secondary" disabled={disabled || busy} onClick={() => void save()}>{pending ? 'Повторить сохранение реестра' : 'Сохранить исходный реестр'}</button>
  </>}
  {error && <p className="sp-json-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
 </section>
}
