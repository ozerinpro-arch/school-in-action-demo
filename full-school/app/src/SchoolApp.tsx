import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, ArrowLeftRight, ArrowRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, CircleHelp, FileSpreadsheet, FileText, GraduationCap, Grid2X2, History, House, Layers3, ListTodo, LoaderCircle, MoreHorizontal, NotebookPen, RefreshCw, School, Search, Settings2, ShieldCheck, Sparkles, Telescope, UserRound, Users, X } from 'lucide-react'
import { apiFetch, PORTAL_HOME } from './api'
import type { AppState } from './types'
import ScheduleWorkspace from './ScheduleWorkspace'
import SchoolModules from './SchoolModules'
import SchoolClubs from './SchoolClubs'
import SchoolAutomations from './SchoolAutomations'
import StaffAccess from './StaffAccess'
import SchoolCalendar from './SchoolCalendar'
import SchoolIntegrations from './SchoolIntegrations'
import SchoolPublications from './SchoolPublications'
import DirectorDashboard from './DirectorDashboard'
import SchoolPageHelp from './SchoolPageHelp'
import SchoolReplacements from './SchoolReplacements'
import './school-gloss.css'
import './cloud-porcelain.css'

type TimetableLesson = { id: string; className: string; subject: string; teachers: string[]; rooms: string[] }
type Timetable = { revision: number; sourceName: string; lessons: TimetableLesson[]; issues: { id: string; severity: string; message: string }[]; updatedAt: string | null }
type Version = { revision: number; action: string; createdAt: string | null; lessonCount: number }
const navigation = [
 { id: 'publications', label: 'Публикация расписания', icon: ShieldCheck, group: 'Школьный день', detail: 'Проверенные версии и согласованные изменения' },
 { id: 'staff-access', label: 'Доступы сотрудников', icon: ShieldCheck, group: 'О школе', detail: 'Личные приглашения и роли сотрудников' },
 { id: 'school-calendar', label: 'Календарь школы', icon: CalendarDays, group: 'Школьный день', detail: 'Учебные даты и исключения' },
 { id: 'integrations', label: 'ИИ и MAX', icon: Sparkles, group: 'О школе', detail: 'Готовность подключений и задачи' },
 { id: 'overview', label: 'Главная', icon: House, group: 'Школьный день', detail: 'Уроки, задания и всё важное на сегодня' },
 { id: 'schedule', label: 'Расписание', icon: CalendarDays, group: 'Школьный день', detail: 'Когда урок и в какой кабинет идти' },
 { id: 'replacements', label: 'Замены', icon: ArrowLeftRight, group: 'Школьный день', detail: 'Что изменилось в расписании уроков' },
 { id: 'tasks', label: 'Задачи', icon: ListTodo, group: 'Учителю', detail: 'Что подготовить и о чём не забыть' },
 { id: 'students', label: 'Ученики', icon: Users, group: 'Учителю', detail: 'Ученики школы и их классы' },
 { id: 'teachers', label: 'Учителя', icon: UserRound, group: 'Учителю', detail: 'Преподаватели, предметы и уроки' },
 { id: 'classes', label: 'Классы', icon: School, group: 'Учёба и открытия', detail: 'Классы школы и их расписание' },
 { id: 'assignments', label: 'Задания', icon: NotebookPen, group: 'Учёба и открытия', detail: 'Учебные работы, ответы и обратная связь' },
 { id: 'materials', label: 'Материалы', icon: BookOpen, group: 'Учёба и открытия', detail: 'Прочитать, посмотреть, разобраться' },
 { id: 'clubs', label: 'Кружки', icon: Telescope, group: 'Учёба и открытия', detail: 'Найти занятие по интересам' },
 { id: 'documents', label: 'Документы', icon: FileText, group: 'О школе', detail: 'Школьные документы и согласование' },
 { id: 'analytics', label: 'Аналитика', icon: BarChart3, group: 'О школе', detail: 'Как устроена учебная неделя' },
 { id: 'notifications', label: 'Уведомления', icon: Bell, group: 'Школьный день', detail: 'Школьные сообщения и напоминания' },
 { id: 'assistant', label: 'Помощник', icon: Sparkles, group: 'Учителю', detail: 'Вопросы и изменения расписания' },
 { id: 'automations', label: 'Автоматизации', icon: Sparkles, group: 'Учителю', detail: 'Готовые инструменты и идеи для школы' },
 { id: 'school-data', label: 'Данные школы', icon: School, group: 'О школе', detail: 'Классы, кабинеты и источник расписания' },
 { id: 'history', label: 'История', icon: History, group: 'О школе', detail: 'Что менялось в расписании' },
 { id: 'settings', label: 'Настройки', icon: Settings2, group: 'О школе', detail: 'Сведения о школе и личный кабинет' },
] as const
type Page = (typeof navigation)[number]['id']
type ScheduleAction = 'lesson' | 'planning' | 'text' | 'checks'
const navigationGroups = ['Школьный день', 'Учёба и открытия', 'Учителю', 'О школе'] as const
const primaryPages: Page[] = ['overview', 'schedule', 'assignments']
const isPage = (value: string): value is Page => navigation.some(item => item.id === value)
const roleLabels: Record<string, string> = { director: 'Директор', admin: 'Завуч', teacher: 'Учитель', student: 'Ученик', accountant: 'Бухгалтер' }
const currentPage = (): Page => isPage(location.hash.slice(1)) ? location.hash.slice(1) as Page : 'overview'
const formatDate = (value: string | null) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : 'Дата не сохранена'
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))

async function readApi<T>(path: string, signal: AbortSignal): Promise<T> {
 let response: Response
 try { response = await apiFetch(path, { signal }) }
 catch (error) { if (signal.aborted) throw error; throw new Error('Нет связи с сервером. Повторите загрузку.') }
 if (!response.ok) throw new Error(response.status === 403 ? 'У этой учётной записи нет доступа к школьному пространству.' : response.status === 401 ? 'Войдите в личный кабинет, чтобы продолжить.' : 'Не удалось загрузить данные. Попробуйте ещё раз.')
 try { return await response.json() as T }
 catch { throw new Error('Сервер вернул неполные данные. Повторите загрузку.') }
}

function useTimetable() {
 const [data, setData] = useState<Timetable | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
 const controller = useRef<AbortController | null>(null)
 const reload = useCallback(async () => {
  controller.current?.abort()
  const next = new AbortController(); controller.current = next
  setLoading(true); setError('')
  try {
   const result = await readApi<Timetable>('/api/timetable', next.signal)
   if (!result || !Number.isInteger(result.revision) || typeof result.sourceName !== 'string' || !Array.isArray(result.lessons) || !Array.isArray(result.issues) || result.lessons.some(lesson => !lesson || typeof lesson.className !== 'string' || !Array.isArray(lesson.teachers) || lesson.teachers.some(value => typeof value !== 'string') || !Array.isArray(lesson.rooms) || lesson.rooms.some(value => typeof value !== 'string')) || result.issues.some(issue => !issue || typeof issue.message !== 'string' || typeof issue.id !== 'string')) throw new Error('Данные расписания не удалось прочитать. Повторите загрузку.')
   if (!next.signal.aborted) setData(result)
  } catch (cause) { if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить расписание.') }
  finally { if (!next.signal.aborted) setLoading(false) }
 }, [])
 useEffect(() => {
  void reload()
  const changed = () => { void reload() }
  window.addEventListener('school-timetable-updated', changed)
  return () => { controller.current?.abort(); window.removeEventListener('school-timetable-updated', changed) }
 }, [reload])
 return { data, loading, error, reload }
}

function Medallion({ children, sky = false }: { children: ReactNode; sky?: boolean }) { return <span aria-hidden="true" className={`sg-medallion${sky ? ' sg-medallion-sky' : ''}`}>{children}</span> }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="sg-error" role="alert"><AlertCircle size={21}/><div><strong>Не удалось получить данные</strong><p>{message}</p><button className="sg-control" onClick={retry}><RefreshCw size={16}/>Повторить загрузку</button></div></div> }
function LoadingState({ children }: { children: ReactNode }) { return <div className="sg-loading" role="status"><LoaderCircle size={22} className="sg-spin"/><span>{children}</span></div> }
function PageHeading({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) { const art=title.includes('История')?'school-documents-glass.png':title.includes('Данные')?'class-community-glass.png':'teacher-desk-glass.png'; return <div className="sg-page-heading"><div className="sg-illustrated-heading"><div><h1>{title}</h1><p>{detail}</p></div><img src={`${import.meta.env.BASE_URL}assets/${art}`} width="76" height="76" alt="" decoding="async"/></div>{children}</div> }

function SchoolData({ data, loading, error, reload, openHelp, navigate }: ReturnType<typeof useTimetable> & { openHelp: () => void; navigate: (page: Page) => void }) {
 const [query, setQuery] = useState('')
 if (error) return <><PageHeading title="Данные школы" detail="Классы, кабинеты и файл расписания."/><ErrorState message={error} retry={() => void reload()}/></>
 if (!data) return <LoadingState>Загружаем данные расписания…</LoadingState>
 const classes = unique(data.lessons.map(lesson => lesson.className)), teachers = unique(data.lessons.flatMap(lesson => lesson.teachers)), rooms = unique(data.lessons.flatMap(lesson => lesson.rooms))
 const missingTeachers = data.lessons.filter(lesson => !lesson.teachers.length).length, missingRooms = data.lessons.filter(lesson => !lesson.rooms.length).length
 const visibleClasses = classes.filter(name => name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
 const issueMessages = new Set<string>()
 const visibleIssues = data.issues.filter(issue => {
  const message = issue.message.trim()
  if (issueMessages.has(message)) return false
  issueMessages.add(message)
  return true
 })
 return <div className="sg-page cp-stack" aria-busy={loading}>
  <PageHeading title="Данные школы" detail="Сведения из текущего расписания."><button className="sg-control" aria-label="Обновить данные школы" disabled={loading} onClick={() => void reload()}><RefreshCw size={16} className={loading ? 'sg-spin' : undefined}/><span>{loading ? 'Обновляем…' : 'Обновить'}</span></button></PageHeading>
  {!data.lessons.length ? <section className="sg-panel sg-data-empty"><Medallion><FileSpreadsheet size={24}/></Medallion><div><h2>{data.sourceName ? 'В источнике нет занятий' : 'Подключите расписание школы'}</h2><p>{data.sourceName ? `Файл «${data.sourceName}» не содержит распознанных занятий. Проверьте его в расписании или импортируйте другой .xlsx.` : 'Импортируйте файл .xlsx. После проверки здесь появятся источник, классы и сведения о заполненности.'}</p><div className="sg-actions"><button className="sg-control sg-primary" onClick={() => navigate('schedule')}>Открыть расписание<ArrowRight size={16}/></button><button className="sg-text-button" onClick={openHelp}>Как подготовить файл</button></div></div></section> : <>
   <div className="sg-data-grid cp-grid">
    <section className="sg-source-card"><div className="sg-source-head"><Medallion><FileSpreadsheet size={20}/></Medallion><div className="sg-source-title"><span>Источник расписания</span><h2>{data.sourceName || 'Расписание школы'}</h2></div><button className="sg-icon-button sg-source-open" aria-label="Открыть рабочую версию" title="Открыть рабочую версию" onClick={() => navigate('schedule')}><ArrowRight size={18}/></button></div><dl><div><dt>Версия</dt><dd>{data.revision}</dd></div><div><dt>Обновлено</dt><dd>{formatDate(data.updatedAt)}</dd></div></dl></section>
    <section className="sg-panel sg-overview"><div className="sg-section-heading"><h2>Уроки и участники</h2></div><div className="sg-fact-grid">{[[data.lessons.length, 'Занятия'], [classes.length, 'Классы'], [teachers.length, 'Преподаватели'], [rooms.length, 'Кабинеты']].map(([value, label]) => <div className="sg-fact" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div></section>
   </div>
   <div className="sg-data-grid sg-data-grid-lower cp-grid">
    <section className="sg-panel"><div className="sg-section-heading"><div className="sg-heading-with-icon"><Medallion sky><Layers3 size={17}/></Medallion><h2>Классы школы</h2></div><span className="sg-badge">{classes.length}</span></div><label className="sg-search"><span className="sg-sr-only">Найти класс</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти класс…"/>{query && <button aria-label="Очистить поиск классов" onClick={() => setQuery('')}><X size={16}/></button>}</label><div className="sg-class-list" aria-live="polite">{visibleClasses.length ? visibleClasses.map(name => <span className="sg-class" key={name}>{name}</span>) : <p className="sg-muted">Классов по этому запросу нет.</p>}</div></section>
    <section className="sg-panel"><div className="sg-section-heading"><h2>Что требует внимания</h2><Medallion sky>{missingTeachers || missingRooms || data.issues.length ? <AlertCircle size={17}/> : <Check size={17}/>}</Medallion></div><div className="sg-completeness"><div><span>Занятия без учителя</span><strong>{missingTeachers}</strong></div><div><span>Занятия без кабинета</span><strong>{missingRooms}</strong></div></div>{data.issues.length ? <div className="sg-issue-list">{visibleIssues.slice(0, 5).map(issue => <p key={issue.id}><span className={issue.severity === 'error' ? 'sg-dot sg-dot-error' : 'sg-dot sg-dot-warning'}/>{issue.message}</p>)}{visibleIssues.length > 5 && <p className="sg-muted">Остальные замечания доступны в расписании.</p>}</div> : <p className="sg-muted">{missingTeachers || missingRooms ? 'Откройте занятия с пропусками и проверьте недостающие значения.' : 'Проверка текущей версии не вернула замечаний.'}</p>}<button className="sg-text-button" onClick={() => navigate('schedule')}>Проверить в расписании<ArrowRight size={15}/></button></section>
   </div>
  </>}
 </div>
}

function HistoryPage({ navigate }: { navigate: (page: Page) => void }) {
 const [versions, setVersions] = useState<Version[] | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0)
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void readApi<Version[]>('/api/timetable/history', controller.signal).then(result => {
   if (!Array.isArray(result) || result.some(item => !Number.isInteger(item.revision) || typeof item.action !== 'string' || typeof item.lessonCount !== 'number')) throw new Error('Историю не удалось прочитать. Повторите загрузку.')
   if (!controller.signal.aborted) setVersions(result)
  }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить историю.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [attempt])
 const labels: Record<string, string> = { current: 'Текущая версия', before_edit: 'До изменения урока', before_import: 'До импорта файла', before_planning: 'До применения плана', before_text_edit: 'До текстовой правки', before_restore: 'До восстановления версии' }
 return <div className="sg-page cp-stack" aria-busy={loading}><PageHeading title="История расписания" detail="Сохранённые версии и время изменений."><button className="sg-control" aria-label="Обновить историю расписания" disabled={loading} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} className={loading ? 'sg-spin' : undefined}/><span>Обновить</span></button></PageHeading>{error ? <ErrorState message={error} retry={() => setAttempt(value => value + 1)}/> : loading && !versions ? <LoadingState>Загружаем историю…</LoadingState> : <section className="sg-panel sg-history-panel">{versions?.length ? <><div className="sg-section-heading"><h2>Как менялось расписание</h2><span className="sg-badge">{versions.length}</span></div><ol className="sg-history-list">{versions.map((version, index) => <li key={`${version.revision}-${version.action}-${index}`}><Medallion sky={index !== 0}>{version.action === 'current' ? <CalendarDays size={19}/> : <History size={19}/>}</Medallion><div className="sg-history-description"><div><h3>{labels[version.action] || 'Сохранённая версия'}</h3>{version.action === 'current' && <span className="sg-badge">Актуальная</span>}</div><p>Версия {version.revision}<span aria-hidden="true"> · </span>{version.lessonCount} занятий</p></div><time dateTime={version.createdAt || undefined}>{formatDate(version.createdAt)}</time></li>)}</ol><p className="sg-history-note">Здесь показаны сохранённые версии. Состав текущей версии можно проверить в расписании.</p></> : <div className="sg-empty"><Medallion sky><History size={22}/></Medallion><h2>История пока пуста</h2><p>После загрузки файла или изменения уроков здесь появятся версии расписания.</p><button className="sg-control" onClick={() => navigate('schedule')}>Открыть расписание<ArrowRight size={16}/></button></div>}</section>}</div>
}

type SchoolSettings = { schoolName: string; academicYear: string; note: string }
type SettingsSnapshot = { revision: number; settings: SchoolSettings }
function validSettings(value: unknown): value is SchoolSettings {
 return !!value && typeof value === 'object' && ['schoolName', 'academicYear', 'note'].every(key => typeof (value as Record<string, unknown>)[key] === 'string')
}
async function readSettings(signal: AbortSignal): Promise<SettingsSnapshot> {
 const result = await readApi<SettingsSnapshot>('/api/school/workspace', signal)
 if (!Number.isInteger(result?.revision) || !validSettings(result?.settings)) throw new Error('Сведения о школе не удалось прочитать. Повторите загрузку.')
 return { revision: result.revision, settings: result.settings }
}
function SchoolSettingsForm({ onChanged }: { onChanged: () => void }) {
 const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null), [draft, setDraft] = useState<SchoolSettings | null>(null)
 const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0)
 const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<SettingsSnapshot | null>(null)
 const saveController = useRef<AbortController | null>(null)
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void readSettings(controller.signal).then(result => {
   if (!controller.signal.aborted) { setSnapshot(result); setDraft(current => current ?? result.settings); if (conflict) setLatest(result) }
  }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сведения.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [attempt])
 useEffect(() => () => saveController.current?.abort(), [])
 async function save() {
  if (!draft || !snapshot || saving || loading || (conflict && !latest)) return
  const controller = new AbortController(); saveController.current = controller
  setSaving(true); setError(''); setMessage('')
  try {
   const response = await apiFetch('/api/school/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: (latest ?? snapshot).revision, settings: draft }), signal: controller.signal })
   if (response.status === 409) {
    setConflict(true); setLatest(null)
    setError('Сведения изменились в другом окне. Сравните актуальные значения со своим вводом.')
    const current = await readSettings(controller.signal)
    if (!controller.signal.aborted) setLatest(current)
    return
   }
   if (!response.ok) {
    let detail = response.status === 403 ? 'Недостаточно прав для изменения сведений.' : response.status === 422 ? 'Проверьте заполненные поля.' : 'Не удалось сохранить сведения. Повторите действие.'
    try { const body = await response.json(); if (typeof body.detail === 'string') detail = body.detail } catch { /* Keep the status-specific message. */ }
    throw new Error(detail)
   }
   const result: unknown = await response.json().catch(() => null)
   if (!result || typeof result !== 'object' || !('revision' in result) || !Number.isInteger(result.revision) || !('settings' in result) || !validSettings(result.settings)) throw new Error('Сервер не подтвердил сохранение. Обновите сведения перед повторной правкой.')
   if (!controller.signal.aborted) {
    const saved = { revision: result.revision as number, settings: result.settings }
    setSnapshot(saved); setDraft(saved.settings); setConflict(false); setLatest(null); setMessage('Сведения о школе сохранены.'); window.dispatchEvent(new Event('school-ops-updated')); onChanged()
   }
  } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof TypeError ? 'Нет связи с сервером. Ваш ввод сохранён. Повторите действие.' : cause instanceof Error ? cause.message : 'Не удалось сохранить сведения. Ваш ввод сохранён.') }
  finally { if (!controller.signal.aborted) setSaving(false) }
 }
 if (!draft || !snapshot) return <section className="sg-panel sg-settings-panel"><h2>Сведения о школе</h2>{error ? <ErrorState message={error} retry={() => setAttempt(value => value + 1)}/> : <LoadingState>Загружаем сведения о школе…</LoadingState>}</section>
 const changed = JSON.stringify(draft) !== JSON.stringify(snapshot.settings)
 return <section className="sg-panel sg-settings-panel" aria-busy={saving || loading}><div className="sg-section-heading"><div className="sg-heading-with-icon"><Medallion sky><BookOpen size={19}/></Medallion><h2>Сведения о школе</h2></div><span className="sg-badge">{changed ? 'Есть изменения' : 'Сохранено'}</span></div><p className="sg-settings-intro">Название, учебный год и важные сведения о школе.</p><form className="sg-settings-form" onSubmit={event => { event.preventDefault(); void save() }}>
  <div className="sg-settings-field"><label htmlFor="school-setting-name">Название школы</label><input id="school-setting-name" maxLength={200} value={draft.schoolName} disabled={saving} onChange={event => { setDraft({ ...draft, schoolName: event.target.value }); setMessage('') }} autoComplete="organization"/></div>
  <div className="sg-settings-field"><label htmlFor="school-setting-year">Учебный год</label><input id="school-setting-year" maxLength={40} value={draft.academicYear} disabled={saving} onChange={event => { setDraft({ ...draft, academicYear: event.target.value }); setMessage('') }} placeholder="Например, 2026 / 2027"/></div>
  <div className="sg-settings-field"><label htmlFor="school-setting-note">Примечание</label><textarea id="school-setting-note" rows={4} maxLength={4000} value={draft.note} disabled={saving} onChange={event => { setDraft({ ...draft, note: event.target.value }); setMessage('') }} placeholder="Важная информация о школе"/></div>
  {error && <div className="sg-settings-error" role="alert"><AlertCircle size={17}/><p>{error}</p></div>}
  {conflict && <div className="sg-settings-conflict"><h3>Актуальные сведения</h3>{latest ? <><dl><div><dt>Название</dt><dd>{latest.settings.schoolName || 'Не указано'}</dd></div><div><dt>Учебный год</dt><dd>{latest.settings.academicYear || 'Не указан'}</dd></div><div><dt>Примечание</dt><dd>{latest.settings.note || 'Нет примечания'}</dd></div></dl><button type="button" className="sg-control" onClick={() => { setSnapshot(latest); setDraft(latest.settings); setConflict(false); setLatest(null); setError(''); setMessage('Загружены актуальные сведения.') }}>Использовать актуальные</button></> : <button type="button" className="sg-control" disabled={loading || saving} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16}/>Загрузить актуальные сведения</button>}</div>}
  <div className="sg-settings-actions"><button type="submit" className="sg-control sg-primary" disabled={saving || loading || (!changed && !conflict) || (conflict && !latest)}>{saving ? <LoaderCircle size={16} className="sg-spin"/> : <Check size={16}/>}<span>{saving ? 'Сохраняем…' : conflict ? 'Сохранить мой вариант' : 'Сохранить сведения'}</span></button>{!conflict && changed && <button type="button" className="sg-control" disabled={saving || loading} onClick={() => { setDraft(snapshot.settings); setError(''); setMessage('Изменения отменены.') }}>Отменить изменения</button>}</div>
  <p className="sg-settings-status" role="status" aria-live="polite">{message}</p>
 </form></section>
}
function Cabinet({ state, openHelp, onChanged }: { state: AppState; openHelp: () => void; onChanged: () => void }) {
 return <div className="sg-page cp-stack"><PageHeading title="Настройки" detail="Сведения о школе и текущая учётная запись."/><div className="sg-cabinet-grid cp-grid"><SchoolSettingsForm onChanged={onChanged}/><div className="sg-cabinet-aside cp-stack"><section className="sg-panel"><div className="sg-section-heading"><div className="sg-heading-with-icon"><Medallion><UserRound size={19}/></Medallion><h2>Учётная запись</h2></div></div><dl className="sg-account-details"><div><dt>Пользователь</dt><dd>{state.profile.name || 'Имя не указано'}</dd></div><div><dt>Роль</dt><dd>{roleLabels[state.role] || state.profile.title || 'Роль не указана'}</dd></div>{state.school.name && <div><dt>Школа</dt><dd>{state.school.name}</dd></div>}</dl><a className="sg-control" href={PORTAL_HOME}><ArrowLeft size={16}/>Staff and student sign-in</a><div className="sg-access-note"><ShieldCheck size={16}/><span>Use Staff access to manage local school accounts.</span></div></section><section className="sg-panel sg-help-card"><Medallion sky><CircleHelp size={21}/></Medallion><h2>Расписание без путаницы</h2><p>Загрузите расписание, проверьте уроки и согласуйте изменения перед началом недели.</p><button className="sg-control" onClick={openHelp}>Как работать<ArrowRight size={16}/></button></section></div></div></div>
}

function ModulesDialog({ page, close, navigate }: { page: Page; close: () => void; navigate: (page: string) => void }) {
 const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null)
 const [query, setQuery] = useState('')
 const normalized = query.trim().toLocaleLowerCase('ru')
 const visible = navigation.filter(item => `${item.label} ${item.detail} ${item.group}`.toLocaleLowerCase('ru').includes(normalized))
 useEffect(() => {
  const element = dialog.current, previous = document.activeElement as HTMLElement | null, previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'; element?.showModal(); search.current?.focus()
  const keyboard = (event: KeyboardEvent) => {
   if (event.key !== 'Tab') return
   const controls = [...(element?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') || [])].filter(control => control.getClientRects().length)
   const first = controls[0], last = controls[controls.length - 1]
   if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
   else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  element?.addEventListener('keydown', keyboard)
  return () => { element?.removeEventListener('keydown', keyboard); element?.close(); document.body.style.overflow = previousOverflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
 }, [])
 return <dialog ref={dialog} id="school-modules" className="sg-modules-dialog" aria-labelledby="school-modules-title" onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }}><div className="sg-modules-inner"><div className="sg-section-heading"><div><span className="sg-eyebrow">Школа.Действие</span><h2 id="school-modules-title">Все разделы</h2></div><button className="sg-icon-button" aria-label="Закрыть разделы" onClick={close}><X size={20}/></button></div><label className="sg-search sg-module-search"><Search size={18} aria-hidden="true"/><span className="sg-sr-only">Поиск по разделам</span><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти раздел…"/>{query && <button type="button" aria-label="Очистить поиск разделов" onClick={() => { setQuery(''); search.current?.focus() }}><X size={17}/></button>}</label><div className="sg-module-results" aria-live="polite">{!visible.length ? <div className="sg-empty"><Medallion><Search size={21}/></Medallion><h3>Раздел не найден</h3><p>Попробуйте другое название или очистите поиск.</p><button className="sg-control" onClick={() => { setQuery(''); search.current?.focus() }}>Показать все разделы</button></div> : <nav aria-label="Все разделы школы">{navigationGroups.map(group => { const items = visible.filter(item => item.group === group); return items.length ? <section className="sg-module-group" key={group}><h3>{group}</h3>{items.map(item => <a href={`#${item.id}`} key={item.id} className="sg-module-link" aria-current={page === item.id ? 'page' : undefined} onClick={event => { event.preventDefault(); close(); navigate(item.id) }}><Medallion><item.icon size={20}/></Medallion><span><strong>{item.label}</strong><small>{item.detail}</small></span>{page === item.id ? <Check size={17}/> : <ChevronRight size={17}/>}</a>)}</section> : null })}</nav>}</div></div></dialog>
}

function HelpDialog({ close, returnFocus }: { close: () => void; returnFocus: HTMLElement | null }) {
 const dialog = useRef<HTMLDivElement>(null), closeRef = useRef(close)
 closeRef.current = close
 useEffect(() => {
  const previous = returnFocus ?? document.activeElement as HTMLElement | null, previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'; dialog.current?.querySelector<HTMLElement>('button')?.focus()
  const keyboard = (event: KeyboardEvent) => {
   if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
   if (event.key !== 'Tab') return
   const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]') || [])].filter(control => control.getClientRects().length)
   const first = controls[0], last = controls[controls.length - 1]
   if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
   else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  document.addEventListener('keydown', keyboard)
  return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keyboard); previous?.focus() }
 }, [])
 return <div className="sg-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><div ref={dialog} className="sg-modal sg-panel" role="dialog" aria-modal="true" aria-labelledby="school-help-title" aria-describedby="school-help-description"><div className="sg-section-heading"><span className="sg-eyebrow">Школа.Действие</span><button className="sg-icon-button" onClick={close} aria-label="Закрыть помощь"><X size={20}/></button></div><div className="sg-help-intro"><h2 id="school-help-title">Как работать с расписанием</h2><p id="school-help-description">Проверьте результат каждого изменения перед подтверждением.</p></div><ol className="sg-help-steps"><li><span>1</span><div><h3>Загрузите файл .xlsx</h3><p>В расписании откройте импорт и выберите файл до 2 МБ. Проверьте предварительный результат перед подтверждением.</p></div></li><li><span>2</span><div><h3>Проверьте учебную неделю</h3><p>Выберите класс и день. Откройте занятие, чтобы уточнить предмет, время, учителя или кабинет.</p></div></li><li><span>3</span><div><h3>Согласуйте изменения</h3><p>Сравните исходные и новые значения, проверьте замечания и подтвердите правку. Сохранённые версии появятся в истории.</p></div></li></ol><button className="sg-control sg-primary sg-help-done" onClick={close}>Понятно<Check size={17}/></button></div></div>
}

export default function SchoolApp({ state }: { state: AppState }) {
 const [page, setPage] = useState<Page>(currentPage), [helpOpen, setHelpOpen] = useState(false), [modulesOpen, setModulesOpen] = useState(false)
 const [scheduleRequest, setScheduleRequest] = useState<{ action: ScheduleAction; lessonId?: string } | null>(null)
 const timetable = useTimetable()
 const main = useRef<HTMLElement>(null), sidebarNavigation = useRef<HTMLElement>(null), helpTrigger = useRef<HTMLElement | null>(null)
 const openHelp = useCallback(() => { helpTrigger.current = document.activeElement as HTMLElement | null; setHelpOpen(true) }, [])
 const focusMain = useCallback(() => requestAnimationFrame(() => { if (!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) main.current?.focus({ preventScroll: true }) }), [])
 const navigate = useCallback((next: string) => {
  if (!isPage(next)) return
  setPage(next); setModulesOpen(false); location.hash = next
  window.scrollTo({ top: 0, behavior: 'instant' })
  focusMain()
 }, [focusMain])
 const openSchedule = useCallback((action: ScheduleAction, lessonId?: string) => { setScheduleRequest({ action, lessonId }); navigate('schedule') }, [navigate])
 const handleScheduleRequest = useCallback(() => setScheduleRequest(null), [])
 const changed = useCallback(() => { void timetable.reload() }, [timetable.reload])
 useEffect(() => {
  const changed = () => { setPage(currentPage()); setModulesOpen(false); focusMain() }
  window.addEventListener('hashchange', changed)
  return () => window.removeEventListener('hashchange', changed)
 }, [focusMain])
 useEffect(() => {
  const container = sidebarNavigation.current, active = container?.querySelector<HTMLElement>('[aria-current="page"]')
  if (container && active && container.getClientRects().length) {
   const top = active.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
   if (top < container.scrollTop) container.scrollTop = top
   else if (top + active.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = top + active.offsetHeight - container.clientHeight
  }
 }, [page])
 useEffect(() => { if (page === 'school-data') void timetable.reload() }, [page, timetable.reload])
 useEffect(() => {
  const element = main.current, preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (!element || preference.matches || typeof element.animate !== 'function' || scheduleRequest || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
  const animation = element.animate([{ opacity: .55, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' })
  const stop = () => { if (preference.matches) animation.cancel() }
  preference.addEventListener('change', stop)
  return () => { animation.cancel(); preference.removeEventListener('change', stop) }
 }, [page])
 const selected = navigation.find(item => item.id === page)!
 const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', weekday: 'short' })
 const source = timetable.error ? 'Источник недоступен' : timetable.loading && !timetable.data ? 'Проверяем источник…' : timetable.data?.sourceName || (timetable.data?.lessons.length ? 'Расписание школы' : 'Файл ещё не загружен')
 const modulePage = !['schedule', 'school-data', 'history', 'settings', 'clubs', 'automations', 'staff-access', 'school-calendar', 'integrations', 'publications', 'replacements'].includes(page)
 const dockIndex = primaryPages.includes(page) ? primaryPages.indexOf(page) : 3
 return <div className="school-app cp-design"><div className="sg-shell" inert={helpOpen}>
  <a className="sg-skip-link" href="#school-main" onClick={event => { event.preventDefault(); main.current?.focus() }}>К содержимому страницы</a>
  <aside className="sg-sidebar"><a className="sg-brand" href="#overview" aria-label="Школа.Действие — главная" onClick={event => { event.preventDefault(); navigate('overview') }}><Medallion><GraduationCap size={23}/></Medallion><span>Школа.Действие<span>Школьное пространство</span></span></a>
   <nav ref={sidebarNavigation} className="sg-navigation" aria-label="Разделы школы">{navigationGroups.map(group => <div className="sg-nav-group" key={group}><div className="sg-nav-caption">{group}</div>{navigation.filter(item => item.group === group).map(item => <a key={item.id} href={`#${item.id}`} className="sg-nav-item" aria-current={page === item.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(item.id) }}><Medallion><item.icon size={18}/></Medallion><span>{item.label}</span>{page === item.id && <ChevronRight size={14}/>}</a>)}</div>)}</nav>
   <div className="sg-sidebar-bottom"><a className="sg-source-mini" href="#school-data" onClick={event => { event.preventDefault(); navigate('school-data') }}><div><FileSpreadsheet size={15}/><span>Расписание школы</span></div><p title={source}>{source}</p>{timetable.data && !timetable.error && <small>Версия {timetable.data.revision}</small>}</a><a className="sg-return" href={PORTAL_HOME}><ArrowLeft size={16}/><span>Staff and student sign-in</span></a><div className="sg-profile"><Medallion><UserRound size={18}/></Medallion><div><strong title={state.profile.name}>{state.profile.name || 'Учётная запись'}</strong><span>{roleLabels[state.role] || state.profile.title || 'Школьный кабинет'}</span></div></div></div>
  </aside>
  <div className="sg-workspace"><header className="sg-topbar"><div className="sg-breadcrumb"><span className="sg-topbar-mark" aria-hidden="true"><GraduationCap size={19}/></span><span className="sg-breadcrumb-parent">Школа.Действие<ChevronRight size={12}/></span><strong>{selected.label}</strong></div><div className="sg-topbar-actions"><time className="sg-today" dateTime={new Date().toISOString().slice(0, 10)}><CalendarDays size={15}/>{today}</time><button className="sg-icon-button sg-modules-trigger" aria-label="Все разделы школы" aria-controls="school-modules" aria-haspopup="dialog" aria-expanded={modulesOpen} onClick={() => setModulesOpen(true)}><Grid2X2 size={19}/></button><button className="sg-icon-button" aria-label="Как работать с расписанием" aria-haspopup="dialog" onClick={openHelp}><CircleHelp size={20}/></button></div></header>
   <main ref={main} id="school-main" className="sg-main cp-stack" data-page={page} tabIndex={-1} aria-label={selected.label}>
    <SchoolPageHelp page={page==='analytics'?(state.role==='director'?'analytics-director':'analytics-general'):page}/>
    {state.profile.userId === 'portal-preview' && <div className="sg-preview-banner" role="status"><ShieldCheck size={18}/><div><strong>Тестовый кабинет директора</strong><p>Это отдельная копия школы. Можно пробовать все доступные функции — рабочее расписание не изменится.</p></div></div>}
    <div hidden={page !== 'schedule'}><ScheduleWorkspace schoolMode active={page === 'schedule'} requestedAction={scheduleRequest?.action} requestedLessonId={scheduleRequest?.lessonId} onRequestHandled={handleScheduleRequest}/></div>
    {page==='analytics'&&state.role==='director'&&<DirectorDashboard actions={{schedule:()=>navigate('schedule'),publications:()=>navigate('publications'),requests:()=>openSchedule('text'),tasks:()=>navigate('tasks'),documents:()=>navigate('documents'),assignments:()=>navigate('assignments'),students:()=>navigate('students')}}/>}
    {modulePage&&!(page==='analytics'&&state.role==='director') && <SchoolModules page={page} navigate={navigate} openSchedule={openSchedule} onChanged={changed}/>}
    {page === 'replacements' && <><SchoolReplacements onOpenSchedule={lessonId=>openSchedule('lesson',lessonId)} onOpenPublications={()=>navigate('publications')}/><details className="sg-panel sg-page-help"><summary>Журнал отсутствий · прежние записи</summary><p>Записи этого журнала сохранены. Они отмечают отсутствие и сами по себе не назначают заменяющего учителя.</p><SchoolModules page="replacements" navigate={navigate} openSchedule={openSchedule} onChanged={changed}/></details></>}
    {page === 'publications' && <SchoolPublications/>}
    {page === 'staff-access' && <StaffAccess/>}
    {page === 'school-calendar' && <SchoolCalendar canWrite/>}
    {page === 'integrations' && <SchoolIntegrations/>}
    {page === 'clubs' && <SchoolClubs navigate={navigate}/>}
    {page === 'automations' && <SchoolAutomations navigate={navigate} openSchedule={openSchedule}/>}
    {page === 'school-data' && <SchoolData {...timetable} openHelp={openHelp} navigate={navigate}/>}
    {page === 'history' && <HistoryPage navigate={navigate}/>}
    {page === 'settings' && <Cabinet state={state} openHelp={openHelp} onChanged={changed}/>}
   </main>
  </div>
  <nav className="sg-bottom-nav" data-active-index={dockIndex} aria-label="Разделы школы на телефоне">{primaryPages.map(id => { const item = navigation.find(entry => entry.id === id)!; return <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(item.id) }}><span><item.icon size={20}/></span><span>{item.label}</span></a> })}<button type="button" data-current={!primaryPages.includes(page) || undefined} aria-controls="school-modules" aria-haspopup="dialog" aria-expanded={modulesOpen} onClick={() => setModulesOpen(true)}><span><MoreHorizontal size={23}/></span><span>Ещё</span></button></nav>
 </div>{modulesOpen && <ModulesDialog page={page} close={() => setModulesOpen(false)} navigate={navigate}/>} {helpOpen && <HelpDialog close={() => setHelpOpen(false)} returnFocus={helpTrigger.current}/>}</div>
}
