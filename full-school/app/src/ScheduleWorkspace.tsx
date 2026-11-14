import { apiFetch,SESSION_EXPIRED_EVENT } from './api'
import { useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from 'react'
import { AlertCircle, ArrowRight, Bot, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, FileSpreadsheet, LoaderCircle, RefreshCw, Search, ShieldCheck, Upload, Users, X } from 'lucide-react'
import './timetable.css'
import './schedule-gloss.css'
import SchedulingPlanner from './SchedulingPlanner'
import TextEditAgent,{type AgentPlanningNavigation} from './TextEditAgent'
import ExperimentalSchoolPlan from './ExperimentalSchoolPlan'
import ShortWeekDraft from './ShortWeekDraft'
import SchoolRequests from './SchoolRequests'
import WholeSchoolTimetable from './WholeSchoolTimetable'
import {type RunProjection,validRunProjection,ProjectionBanner,ProjectionShelf,ProjectionRoute} from './PlanningProjection'

type EditableLesson = { className: string; day: number; slot: number; start: string; end: string; subject: string; teachers: string[]; rooms: string[] }
type Lesson = EditableLesson & { id: string; sourceCell: string; raw: string; edited: boolean }
type Issue = { id: string; kind: 'teacher' | 'room' | 'class' | 'missing_room' | 'ambiguous'; severity: 'error' | 'warning'; message: string; lessonIds: string[] }
type Draft = { effectiveDate?:string; weekDays?: number[]; weekLabel?: string; sourceFilename?: string; revision: number; sourceName: string; lessons: Lesson[]; issues: Issue[]; updatedAt: string | null }
type LessonProposal = { lessonId: string; expectedRevision: number; lesson: EditableLesson; configRevision?: number; replacementTeacherId?: string }
type Proposal = LessonProposal | { kind: 'planning'; runId: string; expectedRevision: number; configRevision: number; hash: string }
type AgentTask = { id: string; status: 'completed' | 'awaiting_approval' | 'needs_configuration' | 'rejected' | 'stale' | 'failed'; message: string; revision: number; issues: Issue[]; proposal?: Proposal }
type SubstituteResult = { candidates: { teacherId: string; name: string; available: boolean; reasons: string[]; dailyLoad: number; weeklyLoad: number; proposal: LessonProposal | null }[]; blockers: { code: string; message: string; entityIds: string[] }[]; notice: string }
type AgentStatus = { engine: string; modelConfigured: boolean; mode: string; requestsEnabled?: boolean; provider?: string; keyPresent?: boolean; model?: string }
type Editor = { id: string; revision: number; className: string; day: number; slot: string; start: string; end: string; subject: string; teachers: string; rooms: string }
const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const shortDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const countText = (count: number, one: string, few: string, many: string) => `${count} ${count % 100 >= 11 && count % 100 <= 14 ? many : count % 10 === 1 ? one : count % 10 >= 2 && count % 10 <= 4 ? few : many}`
const taskKey = 'school-schedule-agent-task'
export function proposalSourceLesson(draft:Draft|null,proposal:Proposal|undefined):Lesson|null{if(!draft||!proposal||!('lessonId' in proposal)||draft.revision!==proposal.expectedRevision)return null;return draft.lessons.find(lesson=>lesson.id===proposal.lessonId)??null}
function LessonReview({label,lesson,changed=false}:{label:string;lesson:EditableLesson|null;changed?:boolean}){return <div className={'tt-review-card'+(changed?' tt-review-card--changed':'')}><strong>{label}</strong>{changed&&<span className="tt-change-mark">Изменение</span>}{lesson?<><b>{lesson.className} · {lesson.subject}</b><span>{days[lesson.day]} · {lesson.start}–{lesson.end} · {lesson.slot} урок</span><span>Учитель: {lesson.teachers.join(', ')||'не указан'}</span><span>Кабинет: {lesson.rooms.join(', ')||'не указан'}</span></>:<span>Исходная версия недоступна. Обновите расписание и подготовьте правку заново.</span>}</div>}
const editable = (lesson: EditableLesson): EditableLesson => ({ className: lesson.className, day: lesson.day, slot: lesson.slot, start: lesson.start, end: lesson.end, subject: lesson.subject, teachers: [...lesson.teachers], rooms: [...lesson.rooms] })
const canonical = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru')
const splitNames = (value: string) => { const seen = new Set<string>(); return value.split(/[,\n\r]+/u).map(part => part.trim()).filter(part => { const key = canonical(part); if (!part || seen.has(key)) return false; seen.add(key); return true }) }
const candidate = (editor: Editor): EditableLesson => ({ className: editor.className.trim(), day: Number(editor.day), slot: Number(editor.slot), start: editor.start, end: editor.end, subject: editor.subject.trim(), teachers: splitNames(editor.teachers), rooms: splitNames(editor.rooms) })
const makeEditor = (lesson: Lesson, revision: number): Editor => ({ id: lesson.id, revision, className: lesson.className, day: lesson.day, slot: String(lesson.slot), start: lesson.start, end: lesson.end, subject: lesson.subject, teachers: lesson.teachers.join(', '), rooms: lesson.rooms.join(', ') })
function validation(lesson: EditableLesson) {
 const errors: string[] = []
 if (!lesson.className || lesson.className.length > 80) errors.push('Укажите класс — до 80 символов.')
 if (!lesson.subject || lesson.subject.length > 160) errors.push('Укажите предмет — до 160 символов.')
 if (!Number.isInteger(lesson.day) || lesson.day < 0 || lesson.day > 5) errors.push('Выберите учебный день.')
 if (!Number.isInteger(lesson.slot) || lesson.slot < 1 || lesson.slot > 20) errors.push('Номер урока должен быть от 1 до 20.')
 if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(lesson.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(lesson.end) || lesson.start >= lesson.end) errors.push('Время окончания должно быть позже начала.')
 if (lesson.teachers.length > 8 || lesson.rooms.length > 8 || lesson.teachers.some(value => value.length > 120) || lesson.rooms.some(value => value.length > 80)) errors.push('До 8 учителей и кабинетов: имя до 120 символов, кабинет до 80.')
 return errors
}
function localIssues(lessons: Lesson[]): Issue[] {
 const result: Issue[] = []
 for (const lesson of lessons) {
  if (!lesson.rooms.length) result.push({ id: `local-room-${lesson.id}`, kind: 'missing_room', severity: 'warning', message: `${lesson.className}: не указан кабинет.`, lessonIds: [lesson.id] })
  if (lesson.rooms.length > 1 || lesson.teachers.length > 1) result.push({ id: `local-group-${lesson.id}`, kind: 'ambiguous', severity: 'warning', message: `${lesson.className}: несколько учителей или кабинетов — уточните распределение групп.`, lessonIds: [lesson.id] })
 }
 for (let i = 0; i < lessons.length; i++) for (let j = i + 1; j < lessons.length; j++) {
  const a = lessons[i], b = lessons[j]
  if (a.day !== b.day || a.start >= b.end || b.start >= a.end) continue
  const ids = [a.id, b.id]
  if (canonical(a.className) === canonical(b.className)) result.push({ id: `local-class-${i}-${j}`, kind: 'class', severity: 'error', message: `${a.className}: занятия пересекаются по времени.`, lessonIds: ids })
  if (a.teachers.some(name => b.teachers.some(other => canonical(name) === canonical(other)))) result.push({ id: `local-teacher-${i}-${j}`, kind: 'teacher', severity: 'warning', message: 'Учитель указан в пересекающихся занятиях. Возможно, это совместная группа.', lessonIds: ids })
  if (a.rooms.some(room => b.rooms.some(other => canonical(room) === canonical(other)))) result.push({ id: `local-room-${i}-${j}`, kind: 'room', severity: 'warning', message: 'Кабинет указан в пересекающихся занятиях. Требуется уточнение.', lessonIds: ids })
 }
 return result
}
class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }
async function request<T>(url: string, options?: RequestInit): Promise<T> {
 let response: Response
 try { response = await apiFetch(url, options) } catch { throw new ApiError('Нет связи с сервером. Данные в форме сохранены, повторите действие.', 0) }
 let data: unknown
 try { data = await response.json() } catch { data = undefined }
 if (!response.ok) {
  const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : null
  const message = typeof detail === 'string' ? detail : response.status === 409 ? 'Расписание уже изменилось. Обновите версию и проверьте свои поля.' : response.status === 403 ? 'Расписание доступно только директору и завучу.' : 'Не удалось выполнить действие. Попробуйте ещё раз.'
  throw new ApiError(message, response.status)
 }
 return data as T
}
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
function ErrorNotice({ message, children }: { message: string; children?: React.ReactNode }) { return <div className="tt-error" role="alert"><AlertCircle size={17} /><div><p>{message}</p>{children}</div></div> }
function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: string }) { return <span className={`tt-badge ${tone}`}>{children}</span> }

// A native modal keeps keyboard navigation in the active task. Its content stays
// mounted while closed, so dismissing a sheet never discards an unfinished form.
function WorkspaceSheet({ enabled, open, title, onClose, children, wide = false }: { enabled: boolean; open: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
 const dialog = useRef<HTMLDialogElement>(null), closeRef = useRef(onClose)
 closeRef.current = onClose
 useEffect(() => {
  if (!enabled || !open || !dialog.current) return
  const node = dialog.current, previous = document.activeElement as HTMLElement | null
  if (!node.open) node.showModal()
  const previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  return () => { node.close(); document.body.style.overflow = previousOverflow; if (previous?.isConnected && previous.closest('dialog')?.open !== false) previous.focus({ preventScroll: true }) }
 }, [enabled, open])
 if (!enabled) return <>{children}</>
 return <dialog ref={dialog} className={`tt-sheet ${wide ? 'tt-sheet-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); closeRef.current() }} onClick={event => { if (event.target === event.currentTarget) closeRef.current() }}>
  <div className="tt-sheet-content"><div className="tt-sheet-head"><strong>{title}</strong><button className="tt-icon-btn" autoFocus aria-label={`Закрыть: ${title}`} onClick={onClose}><X size={20} /></button></div>{children}</div>
 </dialog>
}

export default function ScheduleWorkspace({ schoolMode = false, active = true, requestedAction, requestedLessonId, requestedRunId, requestedPlanningSection, requestedDailyDate, onRequestHandled, onOpenDailyPlanning }: { schoolMode?: boolean; active?: boolean; requestedAction?: 'lesson' | 'planning' | 'text' | 'checks'; requestedLessonId?: string; requestedRunId?:string; requestedPlanningSection?:'sources'|'data'|'runs'; requestedDailyDate?:string; onRequestHandled?: () => void; onOpenDailyPlanning?:()=>void } = {}) {
 const [plannerNavigation,setPlannerNavigation]=useState<(AgentPlanningNavigation&{version:number;dailyTargetDate?:string})|null>(null)
 const [sheet, setSheet] = useState<'editor' | 'checks' | 'approval' | 'planning' | 'text' | 'experiment' | null>(null)
 const [experimentVisited,setExperimentVisited]=useState(false),[experimentId,setExperimentId]=useState<string|undefined>()
 const [schoolDraftView,setSchoolDraftView]=useState<'dated'|'experiment'>('dated')
 function openExperiment(id?:string){setExperimentId(id);setSchoolDraftView(id?'experiment':'dated');setExperimentVisited(true);setSheet('experiment')}
 const defaultViewOpened = useRef(false)
 const loadedDraftRevision = useRef<number|null>(null)
 const [viewMode, setViewMode] = useState<'day' | 'week' | null>(null)
 const [searchOpen, setSearchOpen] = useState(false)
 const [plannerVisited, setPlannerVisited] = useState(false), [textVisited, setTextVisited] = useState(false)
 const [restoringTask, setRestoringTask] = useState(true)
 const [compact, setCompact] = useState(() => window.matchMedia(schoolMode ? '(max-width: 767px)' : '(max-width: 600px)').matches)
 const [plannerOpen, setPlannerOpen] = useState(() => { if (schoolMode) return false; try { return sessionStorage.getItem('school-schedule-view') === 'planning' } catch { return false } })
 const [textOpen, setTextOpen] = useState(() => { if (schoolMode) return false; try { return sessionStorage.getItem('school-schedule-view') === 'text' } catch { return false } })
 const [draft, setDraft] = useState<Draft | null>(null), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('')
 const [projection,setProjection]=useState<RunProjection|null>(null),[projectionLoading,setProjectionLoading]=useState(false),[projectionStale,setProjectionStale]=useState(false),[projectionError,setProjectionError]=useState('')
 const projectionSequence=useRef(0),projectionRequest=useRef<AbortController|null>(null),projectionLock=useRef(false),projectionRestore=useRef<{classFilter:string;dayFilter:string;query:string;viewMode:'day'|'week'|null}|null>(null),projectionFocus=useRef<HTMLDivElement>(null),calendarFocus=useRef<HTMLElement>(null)
 const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<Draft | null>(null), [uploadBusy, setUploadBusy] = useState(''), [uploadError, setUploadError] = useState(''), [importOpen, setImportOpen] = useState(false)
 const [classFilter, setClassFilter] = useState(''), [dayFilter, setDayFilter] = useState(''), [query, setQuery] = useState('')
 const [editor, setEditor] = useState<Editor | null>(null), [editorError, setEditorError] = useState(''), [conflict, setConflict] = useState(false), [editBusy, setEditBusy] = useState(false), [notice, setNotice] = useState('')
 const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null), [agentStatusError, setAgentStatusError] = useState(''), [agentTask, setAgentTask] = useState<AgentTask | null>(null), [agentError, setAgentError] = useState(''), [agentBusy, setAgentBusy] = useState(false), [lastDecision, setLastDecision] = useState<'approve' | 'reject'>('approve')
 const [replacementBinding, setReplacementBinding] = useState<{ configRevision: number; replacementTeacherId: string } | null>(null), [substituteConfigRevision, setSubstituteConfigRevision] = useState<number | null>(null)
 const [substitutes, setSubstitutes] = useState<SubstituteResult | null>(null), [substituteBusy, setSubstituteBusy] = useState(false), [substituteError, setSubstituteError] = useState('')
 const editorRef = useRef<HTMLElement>(null), subjectRef = useRef<HTMLInputElement>(null), fileSequence = useRef(0), alive = useRef(true), initializedFilter = useRef(false), taskInFlight = useRef(false), taskVersion = useRef(0)
 const initialLesson = draft?.lessons.find(lesson => lesson.id === editor?.id)
 const currentCandidate = editor ? candidate(editor) : null
 const candidateErrors = currentCandidate ? validation(currentCandidate) : []
 const dirty = !!editor && !!initialLesson && JSON.stringify(currentCandidate) !== JSON.stringify(editable(initialLesson))
 const proposedIssues = useMemo(() => {
  if (!draft || !editor || !currentCandidate || candidateErrors.length) return []
  return localIssues(draft.lessons.map(lesson => lesson.id === editor.id ? { ...lesson, ...currentCandidate } : lesson)).filter(issue => issue.lessonIds.includes(editor.id))
 }, [draft, editor, currentCandidate?.className, currentCandidate?.day, currentCandidate?.slot, currentCandidate?.start, currentCandidate?.end, currentCandidate?.subject, editor?.teachers, editor?.rooms, candidateErrors.length])
 async function loadDraft(rebase = false) {
  setLoading(true); setLoadError('')
  try {
   const next = await request<Draft>('/api/timetable')
   if (!alive.current) return
   const sourceChanged=loadedDraftRevision.current!==null&&loadedDraftRevision.current!==next.revision
   loadedDraftRevision.current=next.revision
   setDraft(next)
   if (schoolMode&&sourceChanged) window.dispatchEvent(new Event('school-timetable-updated'))
   if (!initializedFilter.current) { initializedFilter.current = true; if (schoolMode) { const available = next.weekDays?.length ? next.weekDays : [...new Set(next.lessons.map(lesson => lesson.day))].sort(); const today = (new Date().getDay() + 6) % 7; setDayFilter(String(available.includes(today) ? today : available[0] ?? 0)) }; setClassFilter(schoolMode ? '' : [...new Set(next.lessons.map(lesson => lesson.className))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))[0] || '') }
   if (rebase) { setEditor(value => value && next.lessons.some(lesson => lesson.id === value.id) ? { ...value, revision: next.revision } : value); setConflict(false); setEditorError(''); setNotice('Версия обновлена. Ваши поля сохранены — проверьте их перед повторной отправкой.') }
  } catch (error) { if (alive.current) setLoadError((error as Error).message) } finally { if (alive.current) setLoading(false) }
 }
 async function loadAgentStatus() {
  setAgentStatusError('')
  try { const next = await request<AgentStatus>('/api/schedule-agent/status'); if (alive.current) setAgentStatus(next) } catch (error) { if (alive.current) setAgentStatusError((error as Error).message) }
 }
 function rememberTask(task: AgentTask) {
  taskVersion.current++; setAgentTask(task)
  try { sessionStorage.setItem(taskKey, task.id) } catch { /* Server persistence remains authoritative. */ }
 }
 useEffect(() => {
  const media = window.matchMedia(schoolMode ? '(max-width: 767px)' : '(max-width: 600px)'); const change = () => setCompact(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change)
 }, [schoolMode])
 useEffect(() => {
  alive.current = true
  void loadDraft(); void loadAgentStatus()
  let saved: string | null = null
  try { saved = sessionStorage.getItem(taskKey) } catch { /* Storage can be disabled. */ }
  if (saved) void request<AgentTask>(`/api/schedule-agent/tasks/${encodeURIComponent(saved)}`).then(task => { if (alive.current && taskVersion.current === 0) setAgentTask(task) }).catch(() => { try { sessionStorage.removeItem(taskKey) } catch { /* Nothing to clear. */ } }).finally(() => { if (alive.current) setRestoringTask(false) })
  else setRestoringTask(false)
  return () => { alive.current = false; fileSequence.current++;projectionSequence.current++;projectionRequest.current?.abort() }
 }, [])
 useEffect(() => {
  if (!dirty || agentTask?.status === 'awaiting_approval') return
  const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
  window.addEventListener('beforeunload', leave)
  return () => window.removeEventListener('beforeunload', leave)
 }, [dirty, agentTask?.status])
 const displayLessons=useMemo<Lesson[]>(()=>projection?(projection.candidateAvailable?projection.proposedLessons!:projection.baseLessons).map(lesson=>({...lesson,sourceCell:'',raw:'',edited:false})):draft?.lessons??[],[projection,draft])
 const projectionChanges=useMemo(()=>new Map(projection?.changes.filter(change=>change.after).map(change=>[change.after!.id,change])??[]),[projection])
 const projectionUnplaced=useMemo(()=>new Map(projection?.unplacedCards.filter(card=>card.before).map(card=>[card.before!.id,card])??[]),[projection])
 const classes = useMemo(() => [...new Set([...displayLessons.map(lesson => lesson.className),...(projection?.unplacedCards.flatMap(card=>card.classNames)??[])])].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [displayLessons,projection])
 const weekDays = useMemo(() => { const available = projection?[0,1,2,3,4,...(displayLessons.some(l=>l.day===5)?[5]:[])]:draft?.weekDays?.length ? draft.weekDays : [...new Set(displayLessons.map(lesson => lesson.day))]; return available.length ? available.filter(day => Number.isInteger(day) && day >= 0 && day < days.length).sort((a, b) => a - b) : days.map((_, index) => index) }, [draft,projection,displayLessons])
 const dayView = schoolMode && (viewMode === 'day' || (!viewMode && compact))
 const selectedDay = dayFilter !== '' && weekDays.includes(Number(dayFilter)) ? Number(dayFilter) : weekDays[0] ?? 0
 const visible = useMemo(() => displayLessons.filter(lesson => (!classFilter || lesson.className === classFilter) && (schoolMode ? !dayView || lesson.day === selectedDay : !dayFilter || lesson.day === Number(dayFilter)) && `${lesson.className} ${lesson.subject} ${lesson.teachers.join(' ')} ${lesson.rooms.join(' ')}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))).sort((a, b) => a.start.localeCompare(b.start) || a.slot - b.slot || a.className.localeCompare(b.className, 'ru', { numeric: true })), [displayLessons, classFilter, dayFilter, query, schoolMode, dayView, selectedDay])
 const visibleDays = schoolMode ? dayView ? [selectedDay] : weekDays : dayFilter ? [Number(dayFilter)] : [0, 1, 2, 3, 4,...(displayLessons.some(l=>l.day===5)?[5]:[])]
 const slots = [...new Set(visible.map(lesson => `${lesson.start}|${lesson.end}|${lesson.slot}`))].sort()
 const errors = projection?[]:draft?.issues.filter(issue => issue.severity === 'error') || [], warnings = projection?[]:draft?.issues.filter(issue => issue.severity === 'warning') || []
 const pending = agentTask?.status === 'awaiting_approval'
 const proposalBefore = proposalSourceLesson(draft,agentTask?.proposal)
 const runtimeBusy = agentBusy || editBusy || restoringTask || substituteBusy || projectionLoading
 async function fetchProjection(runId:string,expectedRevision:number){
  projectionRequest.current?.abort();const controller=new AbortController();projectionRequest.current=controller
  const timer=setTimeout(()=>controller.abort(),20000)
  try{const response=await apiFetch('/api/planning/runs/'+encodeURIComponent(runId)+'/projection?expectedDraftRevision='+expectedRevision,{signal:controller.signal});if([401,403,404].includes(response.status)){projectionSequence.current++;projectionRequest.current?.abort();projectionLock.current=false;projectionRestore.current=null;setProjectionLoading(false);setProjection(null);setDraft(null);setEditor(null);setAgentTask(null);setPlannerVisited(false);setTextVisited(false);setSheet(null);setClassFilter('');setDayFilter('');setQuery('');setFile(null);setPreview(null);setNotice('');setAgentError('');setEditorError('');setLoadError('Доступ к расчёту не подтверждён. Приватные сведения очищены. Обновите исходное расписание или войдите снова.');throw new ApiError('Доступ к расчёту не подтверждён. Приватные сведения очищены.',response.status)}if(!response.ok)throw new Error(response.status===409?'Черновик, условия или календарь изменились. Этот расчёт нужно перепроверить.':response.status===404?'Этот расчёт недоступен.':'Не удалось получить предпросмотр расчёта.');const value:unknown=await response.json();if(!validRunProjection(value)||value.runId!==runId||value.currentDraftRevision!==expectedRevision)throw new Error('Сервер не подтвердил целостность предпросмотра. Исходные занятия сохранены.');return value}finally{clearTimeout(timer)}
 }
 async function showCandidatePreview(runId:string){
  if(projectionLock.current||!draft||runtimeBusy||dirty||pending)throw new Error('Сначала завершите или отмените текущую правку урока. Ввод сохранён.')
  const sequence=++projectionSequence.current;projectionLock.current=true;setProjectionLoading(true);setProjectionError('')
  try{const value=await fetchProjection(runId,draft.revision);if(!alive.current||sequence!==projectionSequence.current)return;if(!projectionRestore.current)projectionRestore.current={classFilter,dayFilter,query,viewMode};setProjection(value);setProjectionStale(false);setClassFilter('');setDayFilter('');setQuery('');setViewMode('week');setEditor(null);setEditorError('');setSheet(null);setImportOpen(false);setTextOpen(false);setPlannerOpen(false);setNotice('');requestAnimationFrame(()=>projectionFocus.current?.focus())}finally{if(sequence===projectionSequence.current){projectionLock.current=false;if(alive.current)setProjectionLoading(false)}}
 }
 async function recheckProjection(){
  if(!projection||projectionLock.current)return;const sequence=++projectionSequence.current;projectionLock.current=true;setProjectionLoading(true)
  try{const value=await fetchProjection(projection.runId,projection.currentDraftRevision);if(alive.current&&sequence===projectionSequence.current){setProjection(value);setProjectionStale(false);setProjectionError('')}}catch(cause){if(alive.current&&sequence===projectionSequence.current){setProjectionStale(true);setProjectionError((cause as Error).message)}}finally{if(sequence===projectionSequence.current){projectionLock.current=false;if(alive.current)setProjectionLoading(false)}}
 }
 function exitProjection(sourceId?:string){
  projectionSequence.current++;projectionRequest.current?.abort();projectionLock.current=false;setProjection(null);setProjectionStale(false);setProjectionError('');setProjectionLoading(false);setEditor(null);setEditorError('');setSheet(null)
  const restore=projectionRestore.current;projectionRestore.current=null;if(projectionStale)void loadDraft();if(restore){setClassFilter(restore.classFilter);setDayFilter(restore.dayFilter);setQuery(restore.query);setViewMode(restore.viewMode)}
  const source=sourceId?draft?.lessons.find(l=>l.id===sourceId):undefined;if(source){setClassFilter(source.className);setDayFilter(String(source.day));setQuery('');setViewMode('day')}
  requestAnimationFrame(()=>{if(source){const node=calendarFocus.current?.querySelector<HTMLButtonElement>('[data-lesson-id="'+CSS.escape(source.id)+'"]');node?.scrollIntoView({block:'center'});node?.focus()}else calendarFocus.current?.focus({preventScroll:true})})
 }
 function findProjectionSource(id:string,returnToBase=false){if(returnToBase){exitProjection(id);return}setClassFilter('');setDayFilter('');setQuery('');setViewMode('week');requestAnimationFrame(()=>{const node=calendarFocus.current?.querySelector<HTMLElement>('[data-lesson-id="'+CSS.escape(id)+'"]');node?.scrollIntoView({block:'center'});node?.focus()})}
 function returnToProjectionApproval(){if(!projection||projectionStale||projectionLoading)return;exitProjection();setPlannerVisited(true);setSheet('planning')}
 useEffect(()=>{if(!projection)return;const check=()=>{if(typeof document==='undefined'||document.visibilityState==='visible')void recheckProjection()};const expired=()=>{projectionSequence.current++;projectionRequest.current?.abort();setProjection(null);setDraft(null);setEditor(null)};window.addEventListener('focus',check);window.addEventListener(SESSION_EXPIRED_EVENT,expired);if(typeof document!=='undefined')document.addEventListener('visibilitychange',check);return()=>{window.removeEventListener('focus',check);window.removeEventListener(SESSION_EXPIRED_EVENT,expired);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',check)}},[projection?.runId,projection?.currentDraftRevision])
 function openLesson(lesson: Lesson) {
  if (runtimeBusy || projection) return
  if (schoolMode) setSheet('editor')
  if (dirty && editor?.id !== lesson.id) { setEditorError('Сначала согласуйте или отмените текущую правку. Введённые поля сохранены.'); editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); subjectRef.current?.focus(); return }
  if (editor?.id !== lesson.id) { setEditor(makeEditor(lesson, draft!.revision)); setEditorError(''); setConflict(false); setNotice('') }
  requestAnimationFrame(() => { editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); subjectRef.current?.focus() })
 }
 function showIssue(issue: Issue) {
  const lesson = draft?.lessons.find(item => item.id === issue.lessonIds[0])
  if (lesson && dirty && editor?.id !== lesson.id) { openLesson(lesson); return }
  if (lesson) { if (schoolMode) setViewMode('day'); setClassFilter(lesson.className); setDayFilter(String(lesson.day)); setQuery(''); openLesson(lesson) }
 }
 useEffect(() => {
  if (!active) { defaultViewOpened.current = false; return }
  if (!schoolMode || defaultViewOpened.current) return
  // Consume this entry even for a direct action; clearing it must not reopen the overview.
  if (requestedAction || requestedLessonId) { defaultViewOpened.current = true; return }
  if (loading || restoringTask || !draft) return
  defaultViewOpened.current = true
  if (draft.effectiveDate) return
  if (dirty || pending || projection) return
  setExperimentVisited(true); setSheet('experiment')
 }, [active, schoolMode, loading, restoringTask, draft, requestedAction, requestedLessonId, dirty, pending, projection])
 useEffect(() => {
  if (!schoolMode || !requestedAction || runtimeBusy || !draft || projection) return
  if (requestedAction === 'lesson') {
   const lesson = draft.lessons.find(item => item.id === requestedLessonId)
   if (lesson) {
    if (!dirty || editor?.id === lesson.id) { setViewMode('day'); setClassFilter(lesson.className); setDayFilter(String(lesson.day)); setQuery('') }
    openLesson(lesson)
   } else setNotice('Урок не найден в текущей версии. Обновите список занятий.')
  } else if (requestedAction === 'checks') setSheet('checks')
  else if (dirty || pending) {
   setSheet(dirty ? 'editor' : 'approval')
   if (dirty) setEditorError('Сначала согласуйте или отмените текущую правку. Введённые поля сохранены.')
  } else if (requestedAction === 'planning') openAgentPlanning({runId:requestedRunId,section:requestedPlanningSection||'runs',dailyTargetDate:requestedDailyDate})
  else selectTextWorkspace()
  onRequestHandled?.()
 }, [schoolMode, requestedAction, requestedLessonId, requestedRunId, requestedPlanningSection, requestedDailyDate, runtimeBusy, draft, dirty, pending, onRequestHandled,projection])
 function changeFile(next: File | null) {
  fileSequence.current++; setFile(next); setPreview(null); setUploadError(''); setNotice(''); setUploadBusy('')
  if (next && (!next.name.toLowerCase().endsWith('.xlsx') || next.size > 2 * 1024 * 1024)) setUploadError('Выберите файл .xlsx размером до 2 МБ.')
 }
 async function upload(confirm: boolean) {
  if (!file || uploadBusy) return
  const selectedFile = file, sequence = fileSequence.current
  setUploadBusy(confirm ? 'import' : 'preview'); setUploadError('')
  try {
   const url = `/api/timetable/${confirm ? 'import' : 'preview'}?filename=${encodeURIComponent(selectedFile.name)}${confirm ? `&expectedRevision=${draft?.revision || 0}` : ''}`
   const next = await request<Draft>(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: selectedFile })
   if (!alive.current || sequence !== fileSequence.current) return
   if (confirm) { setDraft(next); setClassFilter(schoolMode ? '' : [...new Set(next.lessons.map(lesson => lesson.className))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))[0] || ''); setDayFilter(''); setQuery(''); setPreview(null); setFile(null); setEditor(null); setNotice('Черновик импортирован. Изменения не опубликованы.'); setImportOpen(false); if (schoolMode) window.dispatchEvent(new Event('school-timetable-updated')) } else setPreview(next)
  } catch (error) { if (alive.current && sequence === fileSequence.current) setUploadError((error as Error).message) } finally { if (alive.current && sequence === fileSequence.current) setUploadBusy('') }
 }
 async function propose(event: FormEvent) {
  event.preventDefault()
  if (restoringTask || taskInFlight.current || agentBusy || editBusy || !editor || !currentCandidate || candidateErrors.length || !dirty || pending) return
  taskInFlight.current = true
  setEditBusy(true); setEditorError(''); setConflict(false); setAgentError('')
  try {
   const task = await request<AgentTask>('/api/schedule-agent/tasks', jsonPost({ message: 'Проверь изменение урока и запроси согласование', proposal: { lessonId: editor.id, expectedRevision: editor.revision, lesson: currentCandidate, ...(replacementBinding || {}) } }))
   rememberTask(task)
   if (schoolMode && task.status === 'awaiting_approval') setSheet('approval')
   if (task.status === 'stale') { setConflict(true); setEditorError(task.message) }
   else if (['failed', 'needs_configuration', 'blocked', 'needs_clarification'].includes(task.status)) setEditorError(task.message)
   else setNotice('Предложение подготовлено. Проверьте изменение и подтвердите его в блоке согласования.')
  } catch (error) { setEditorError((error as Error).message); setConflict(error instanceof ApiError && error.status === 409) } finally { taskInFlight.current = false; setEditBusy(false) }
 }
 async function checkSchedule() {
  const message = 'Проверь расписание'
  if (restoringTask || taskInFlight.current || editBusy || agentBusy || pending || !message.trim()) return
  taskInFlight.current = true
  setAgentBusy(true); setAgentError('')
  try { rememberTask(await request<AgentTask>('/api/schedule-agent/tasks', jsonPost({ message: message.trim() }))); } catch (error) { setAgentError((error as Error).message) } finally { taskInFlight.current = false; setAgentBusy(false) }
 }
 async function decide(decision: 'approve' | 'reject') {
  if (restoringTask || taskInFlight.current || editBusy || !agentTask || agentBusy) return
  taskInFlight.current = true
  setAgentBusy(true); setAgentError(''); setLastDecision(decision)
  try {
   const next = await request<AgentTask>(`/api/schedule-agent/tasks/${encodeURIComponent(agentTask.id)}/decision`, jsonPost({ decision }))
   rememberTask(next)
   if (next.status === 'completed' && decision === 'approve') {
    const latest = await request<Draft>('/api/timetable'); setDraft(latest); if (schoolMode) window.dispatchEvent(new Event('school-timetable-updated'))
    if (editor && next.proposal && 'lessonId' in next.proposal && next.proposal.lessonId === editor.id) { const saved = latest.lessons.find(lesson => lesson.id === editor.id); if (saved) setEditor(makeEditor(saved, latest.revision)) }
    setNotice('Изменение согласовано и сохранено только в черновике. Сотрудники увидят его после отдельной публикации.'); setEditorError(''); setConflict(false)
   } else if (next.status === 'stale') { setConflict(true); setEditorError(next.message) }
   else if (next.status === 'rejected') setNotice('Предложение отклонено. Поля редактора сохранены.')
  } catch (error) { setAgentError((error as Error).message); if (error instanceof ApiError && error.status === 409) { setConflict(true); setEditorError('Версия изменилась. Введённые поля сохранены.'); try { rememberTask(await request<AgentTask>(`/api/schedule-agent/tasks/${encodeURIComponent(agentTask.id)}`)) } catch { /* Preserve the previous proposal if status lookup is unavailable. */ } } } finally { taskInFlight.current = false; setAgentBusy(false) }
 }
 useEffect(() => { setSubstitutes(null); setSubstituteError(''); setReplacementBinding(null); setSubstituteConfigRevision(null) }, [editor?.id])
 async function findSubstitute() {
  if (!editor || dirty || runtimeBusy || pending) return
  const selected = editor
  setSubstituteBusy(true); setSubstituteError(''); setSubstitutes(null)
  try {
   const config = await request<{ revision: number }>('/api/planning/config')
   const result = await request<SubstituteResult>('/api/planning/substitutions', jsonPost({ lessonId: selected.id, expectedDraftRevision: selected.revision, configRevision: config.revision }))
   if (alive.current) { setSubstitutes(result); setSubstituteConfigRevision(config.revision) }
  } catch (error) { if (alive.current) setSubstituteError((error as Error).message) } finally { if (alive.current) setSubstituteBusy(false) }
 }
 function updateEditor(field: keyof Omit<Editor, 'id' | 'revision'>, value: string | number) { setReplacementBinding(null); setSubstitutes(null); setEditor(current => current ? { ...current, [field]: value } : null); setNotice('') }

 function lessonButton(lesson: Lesson) {
  const lessonIssues=projection?[]:draft!.issues.filter(issue=>issue.lessonIds.includes(lesson.id)),hasError=lessonIssues.some(issue=>issue.severity==='error'),change=projectionChanges.get(lesson.id),unplaced=projectionUnplaced.get(lesson.id)
  const className=`tt-lesson tt-tone-${lesson.slot%3} ${!projection&&editor?.id===lesson.id?'tt-selected':''} ${hasError?'tt-has-error':''} ${lesson.edited?'tt-was-edited':''} ${projection?'tt-projection-card':''} ${change?.kind==='changed'?'tt-projection-changed':''} ${unplaced?'tt-projection-unplaced-source':''}`
  const contents=<>{schoolMode&&<span className="tt-subject-mark" aria-hidden="true"><BookOpen size={14}/></span>}<span className="tt-lesson-top"><b>{lesson.className}</b>{lessonIssues.length>0&&<span className={`tt-issue-dot ${hasError?'error':''}`} title={hasError?'Пересечение класса':'Требует проверки'}><AlertCircle size={11}/><span className="sr-only">{hasError?'Ошибка класса':'Предупреждение'}</span></span>}</span><strong>{lesson.subject}</strong><span className="tt-lesson-room">{lesson.rooms.length?`Каб. ${lesson.rooms.join(', ')}`:'Без кабинета'}</span><small>{lesson.teachers.join(', ')||'Учитель не указан'}</small>{lesson.edited&&<span className="tt-edited"><Check size={10}/>Изменено</span>}{projection&&change&&<ProjectionRoute change={change}/>} {projection&&!projection.candidateAvailable&&!unplaced&&<span className="pp-base-note">Исходная сетка · не результат расчёта</span>}{unplaced&&<span className="pp-unplaced-label"><strong>Не размещено в варианте · исходное место</strong><span>{unplaced.reason.message}</span></span>}</>
  return projection?<div key={lesson.id} data-testid="projection-lesson" data-lesson-id={lesson.id} className={className} tabIndex={0} role="group" aria-label={`${lesson.className}, ${lesson.subject}, ${days[lesson.day]}, ${lesson.start}. ${unplaced?'Исходное место неразмещённого занятия':'Предпросмотр без сохранения'}`}>{contents}</div>:<button key={lesson.id} data-testid="timetable-lesson" data-lesson-id={lesson.id} className={className} aria-label={`${lesson.className}, ${lesson.subject}, ${days[lesson.day]}, ${lesson.start}. Редактировать урок`} aria-pressed={editor?.id===lesson.id} disabled={runtimeBusy} onClick={()=>openLesson(lesson)}>{contents}</button>
 }

 function selectWorkspace(open: boolean) { if (schoolMode) { if (open) setPlannerVisited(true); setImportOpen(false); setSheet(open ? 'planning' : null); return }; setTextOpen(false); setPlannerOpen(open); try { sessionStorage.setItem('school-schedule-view', open ? 'planning' : 'schedule') } catch { /* Keep the local view usable without storage. */ } }
 function selectTextWorkspace() { if (schoolMode) { setTextVisited(true); setImportOpen(false); setSheet('text'); return }; setPlannerOpen(false); setTextOpen(true); try { sessionStorage.setItem('school-schedule-view', 'text') } catch { /* Server dialogue survives disabled storage. */ } }
 function openAgentPlanning(navigation:AgentPlanningNavigation&{dailyTargetDate?:string}){if(runtimeBusy||pending||dirty||projection){setNotice('Сначала завершите текущую правку или предпросмотр. Диалог сохранён.');return}setPlannerNavigation(previous=>({...navigation,version:(previous?.version||0)+1}));selectWorkspace(true)}
 useEffect(() => { const refresh = () => { void loadDraft(); void loadAgentStatus() }; window.addEventListener('timetable-changed', refresh); return () => window.removeEventListener('timetable-changed', refresh) }, [])
 return <div className={`tt-workspace ${schoolMode ? 'tt-school' : ''}`} data-testid="timetable-workspace" data-run-projection={projection?projection.runId:undefined}>
  {schoolMode ? <>
   <div className="tt-school-title"><div className="tt-liquid-title"><img src={`${import.meta.env.BASE_URL}assets/school-calendar-glass.png`} alt="" width="54" height="54"/><div><h1>{projection?'Предпросмотр расчёта':'Расписание'}</h1><p>{projection?'Неделя с '+new Date(projection.periodStart+'T12:00:00Z').toLocaleDateString('en-GB',{timeZone:'UTC'}):draft?.weekLabel || (draft?.effectiveDate?'Сетка с '+new Date(draft.effectiveDate+'T12:00:00Z').toLocaleDateString('en-GB',{timeZone:'UTC'}):'Уроки на учебную неделю')} <span className="tt-school-divider">·</span> <span>{projection?'Предпросмотр · не сохранено':'Рабочий черновик'}</span></p></div></div><button className="tt-btn tt-secondary" aria-expanded={importOpen} disabled={!!projection||projectionLoading} onClick={() => { setSheet(null); setImportOpen(true) }}><Upload size={16} /> Импорт XLSX</button></div>
   <div className="tt-school-actions" role="group" aria-label="Инструменты расписания">
    {!projection&&<button className="tt-btn tt-secondary" aria-label="Проверки расписания" disabled={!draft} onClick={() => setSheet('checks')}><ShieldCheck size={16} /><span className="tt-action-label">Проверки</span><span className={`tt-action-count ${errors.length ? 'error' : warnings.length ? 'warning' : ''}`}>{draft?.issues.length ?? '—'}</span></button>}
    <button className="tt-btn tt-secondary" disabled={runtimeBusy || !!pending || dirty || !!projection} aria-label={onOpenDailyPlanning?"Составить на день":"Автосоставление"} onClick={() => onOpenDailyPlanning?onOpenDailyPlanning():selectWorkspace(true)}><CalendarDays size={16} /><span className="tt-action-label-desktop">{onOpenDailyPlanning?"Составить на день":"Автосоставление"}</span><span className="tt-action-label-mobile">Составить</span></button>{onOpenDailyPlanning&&<button className="tt-btn tt-secondary" disabled={runtimeBusy||!!pending||dirty||!!projection} onClick={()=>{setPlannerNavigation(previous=>({section:'data',version:(previous?.version||0)+1}));selectWorkspace(true)}}>Планировщик недели</button>}
    <button className="tt-btn tt-secondary" disabled={runtimeBusy || !!pending || dirty || !!projection} aria-label="Текстовые правки" onClick={selectTextWorkspace}><Bot size={16} /><span className="tt-action-label-desktop">Текстовые правки</span><span className="tt-action-label-mobile">Агент</span></button>
    <button className="tt-btn tt-secondary" disabled={!draft||dirty||!!projection} aria-label="Открыть расписание всех классов" onClick={()=>openExperiment()}><FileSpreadsheet size={16}/><span>Расписание всех классов</span></button>
    <button className={`tt-btn ${pending ? 'tt-pending-action' : 'tt-secondary'}`} aria-label={pending ? 'Ждёт согласования' : 'Согласование'} disabled={!draft || !!projection} onClick={() => setSheet('approval')}><CheckCircle2 size={16} /><span className="tt-action-label-desktop">{pending ? 'Ждёт согласования' : 'Согласование'}</span><span className="tt-action-label-mobile">Согласовать{pending ? ' •' : ''}</span></button>
    {editor && dirty && <button className="tt-btn tt-secondary tt-resume-editor" onClick={() => setSheet('editor')}>Вернуться к уроку{dirty ? ' •' : ''}</button>}
   </div>
   <WorkspaceSheet enabled open={sheet === 'planning'} title="Автосоставление расписания" onClose={() => setSheet(null)} wide>{plannerNavigation?.section==='data'&&plannerNavigation.dailyTargetDate&&<p className="tt-caption" role="status">Данные школы для расчёта на {new Date(plannerNavigation.dailyTargetDate+'T12:00:00Z').toLocaleDateString('en-GB',{timeZone:'UTC'})}. Заполните группы, кабинеты, преподавателей и нагрузку; затем вернитесь к брифу.</p>}{plannerVisited && <SchedulingPlanner schoolMode={schoolMode} onCandidatePreview={showCandidatePreview} initialRunId={plannerNavigation?.runId} initialSection={plannerNavigation?.section} navigationVersion={plannerNavigation?.version}/>}</WorkspaceSheet>
   <WorkspaceSheet enabled open={sheet === 'text'} title="Помощник расписания" onClose={() => setSheet(null)} wide>{textVisited && <><SchoolRequests onApplied={() => void loadDraft()}/><details><summary>Диалог с агентом расписания</summary><TextEditAgent onOpenPlanning={openAgentPlanning} onOpenExperiment={openExperiment}/></details></>}</WorkspaceSheet>
  </> : <div className="tt-mode-switch" role="group" aria-label="Режим работы с расписанием"><button className={`tt-btn ${!plannerOpen && !textOpen ? 'tt-primary' : 'tt-secondary'}`} aria-pressed={!plannerOpen && !textOpen} disabled={runtimeBusy} onClick={() => selectWorkspace(false)}><CalendarDays size={15} /> Расписание</button><button className={`tt-btn ${plannerOpen ? 'tt-primary' : 'tt-secondary'}`} aria-pressed={plannerOpen} disabled={runtimeBusy || !!pending || dirty || !!projection} onClick={() => selectWorkspace(true)}><Bot size={15} /> Автосоставление</button><button className={`tt-btn ${textOpen ? 'tt-primary' : 'tt-secondary'}`} aria-pressed={textOpen} disabled={runtimeBusy || !!pending || dirty || !!projection} onClick={selectTextWorkspace}><Bot size={15} /> Текстовые правки</button></div>}
  {!schoolMode && textOpen ? <TextEditAgent onOpenPlanning={openAgentPlanning} onOpenExperiment={openExperiment}/> : !schoolMode && plannerOpen ? <SchedulingPlanner initialRunId={plannerNavigation?.runId} initialSection={plannerNavigation?.section} navigationVersion={plannerNavigation?.version}/> : <>
  {!schoolMode && <div className="tt-topline"><div className="tt-draft-state"><span className="tt-state-icon"><CalendarDays size={19} /></span><div><strong>Рабочий черновик</strong><p>{draft?.sourceName || 'Загрузите школьное расписание из XLSX'}</p></div><Badge tone="blue">Не опубликовано</Badge></div><button className="tt-btn tt-secondary" aria-expanded={importOpen} disabled={!!projection||projectionLoading} onClick={() => setImportOpen(value => !value)}><Upload size={15} /> Импорт XLSX <ChevronDown size={13} /></button></div>}
  {projection&&<div ref={projectionFocus} tabIndex={-1}><ProjectionBanner value={projection} stale={projectionStale} error={projectionError} checking={projectionLoading} onExit={()=>exitProjection()} onRefresh={()=>void recheckProjection()} onApproval={returnToProjectionApproval}/></div>}
  {notice && <div className="tt-notice" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button className="tt-icon-btn" aria-label="Закрыть сообщение" onClick={() => setNotice('')}><X size={15} /></button></div>}
  {(importOpen || (!schoolMode && !loading && !displayLessons.length && !loadError)) && <WorkspaceSheet enabled={schoolMode} open={importOpen} title="Импорт расписания" onClose={() => setImportOpen(false)}><section className="tt-import tt-panel" aria-labelledby="tt-import-heading"><div className="tt-section-heading"><span className="tt-soft-icon"><FileSpreadsheet size={21} /></span><div><h2 id="tt-import-heading">Импорт расписания</h2><p>Сначала просмотр файла, затем отдельное подтверждение.</p></div></div><div className="tt-import-controls"><label className="tt-file-picker"><Upload size={17} /><span>{file?.name || 'Выбрать файл .xlsx'}</span><input aria-label="Файл расписания XLSX" type="file" accept=".xlsx" disabled={uploadBusy === 'import' || runtimeBusy} onClick={event => { event.currentTarget.value = '' }} onChange={event => changeFile(event.target.files?.[0] || null)} /></label><button className="tt-btn tt-secondary" disabled={!file || !!uploadBusy || file.size > 2 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.xlsx')} onClick={() => void upload(false)}>{uploadBusy === 'preview' ? <LoaderCircle size={15} className="tt-spin" /> : <Search size={15} />} Проверить файл</button></div><p className="tt-caption">XLSX до 2 МБ · лист «Расписание» · импорт создаёт только черновик</p>{uploadError && <ErrorNotice message={uploadError}><button className="tt-link" disabled={!!uploadBusy} onClick={() => void loadDraft()}>Обновить текущую версию</button></ErrorNotice>}{preview && <div className="tt-preview" aria-label="Предпросмотр импорта"><div><Badge tone="blue">Предпросмотр</Badge><strong>{preview.sourceName || file?.name}</strong><p>{preview.lessons.length} занятий · {new Set(preview.lessons.map(lesson => lesson.className)).size} классов · {preview.issues.length} замечаний</p><small>Текущая версия черновика: {draft?.revision || 0}. Файл пока не сохранён.</small></div><div className="tt-preview-sample">{preview.lessons.slice(0, 3).map(lesson => <div key={lesson.id}><span>{shortDays[lesson.day]} {lesson.start}</span><strong>{lesson.className} · {lesson.subject}</strong><small>{lesson.rooms.join(', ') || 'Кабинет не указан'}</small></div>)}</div><button className="tt-btn tt-primary" disabled={!!uploadBusy || dirty || !!pending || runtimeBusy} onClick={() => void upload(true)}>{uploadBusy === 'import' ? <LoaderCircle size={15} className="tt-spin" /> : <Check size={15} />} Импортировать черновик</button>{(dirty || pending) && <p className="tt-caption">Завершите текущую правку перед новым импортом.</p>}</div>}</section></WorkspaceSheet>}
  {loadError && <ErrorNotice message={loadError}><button className="tt-link" onClick={() => void loadDraft()}>Повторить загрузку расписания</button></ErrorNotice>}
  {loading && !draft && <div className="tt-panel tt-empty" role="status"><LoaderCircle size={24} className="tt-spin" /><h2>Загружаем расписание…</h2><p>Проверяем текущую версию черновика.</p></div>}
  {draft && <>{schoolMode ? <div className="tt-controls-and-signal"><div className="tt-school-controls">
    <div className="tt-toolbar"><div className="tt-filters"><label className="tt-class-filter"><span>Класс</span><select aria-label="Класс расписания" value={classFilter} onChange={event => setClassFilter(event.target.value)}><option value="">Все классы — общая сетка</option>{classes.map(name => <option key={name}>{name}</option>)}</select></label><div className="tt-view-toggle" role="group" aria-label="Вид расписания"><button aria-pressed={dayView} onClick={() => setViewMode('day')}>День</button><button aria-pressed={!dayView} onClick={() => setViewMode('week')}>Неделя</button></div></div><button className="tt-icon-btn" aria-label="Открыть поиск по расписанию" aria-expanded={searchOpen} onClick={() => setSearchOpen(value => !value)}><Search size={18} /></button><button className="tt-icon-btn tt-refresh" aria-label="Обновить расписание" disabled={loading||!!projection} onClick={() => void loadDraft()}><RefreshCw size={17} className={loading ? 'tt-spin' : ''} /></button></div>
    {(searchOpen || query) && <div className="tt-search"><Search size={17} /><input autoFocus aria-label="Поиск по расписанию" value={query} onChange={event => setQuery(event.target.value)} placeholder="Предмет, учитель, кабинет…" /><button className="tt-icon-btn" aria-label="Очистить поиск расписания" onClick={() => { setQuery(''); setSearchOpen(false) }}><X size={17} /></button></div>}
    {dayView && <div className="tt-day-tabs" role="group" aria-label="День расписания" style={{ '--tt-day-index': Math.max(0, weekDays.indexOf(selectedDay)), '--tt-day-count': Math.max(1, weekDays.length) } as CSSProperties}>{weekDays.map(day => <button key={day} aria-pressed={selectedDay === day} aria-label={days[day]} onClick={() => setDayFilter(String(day))}><strong>{shortDays[day]}</strong><span>{(draft.lessons.filter(lesson => lesson.day === day && (!classFilter || lesson.className === classFilter))).length}</span></button>)}</div>}
   </div>{!projection&&<button className={`tt-signal-summary ${errors.length ? 'error' : warnings.length ? 'warning' : ''}`} onClick={() => setSheet('checks')}><ShieldCheck size={16} /><span>{!displayLessons.length ? 'Нужны исходные данные' : errors.length || warnings.length ? `${errors.length} ошибок · ${warnings.length} предупреждений` : 'Пересечений не найдено'}</span><ArrowRight size={16} /></button>}</div> : <div className="tt-toolbar"><div className="tt-filters"><label><span className="sr-only">Класс расписания</span><select aria-label="Класс расписания" value={classFilter} onChange={event => setClassFilter(event.target.value)}><option value="">Все классы</option>{classes.map(name => <option key={name}>{name}</option>)}</select></label><label><span className="sr-only">День расписания</span><select aria-label="День расписания" value={dayFilter} onChange={event => setDayFilter(event.target.value)}><option value="">Вся неделя</option>{days.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label><div className="tt-search"><Search size={15} /><input aria-label="Поиск по расписанию" value={query} onChange={event => setQuery(event.target.value)} placeholder="Предмет, учитель, кабинет…" />{query && <button className="tt-icon-btn" aria-label="Очистить поиск расписания" onClick={() => setQuery('')}><X size={14} /></button>}</div></div><button className="tt-icon-btn tt-refresh" aria-label="Обновить расписание" title="Обновить расписание" disabled={loading||!!projection} onClick={() => void loadDraft()}><RefreshCw size={17} className={loading ? 'tt-spin' : ''} /></button></div>}<div className="tt-layout cp-grid"><section ref={calendarFocus} tabIndex={-1} className="tt-calendar tt-panel" aria-labelledby="tt-calendar-heading"><div className="tt-calendar-heading"><div><h2 id="tt-calendar-heading">{projection?(projection.candidateAvailable?'Предпросмотр варианта · '+(classFilter||'все классы'):'Исходная основа · вариант не размещён'):schoolMode && !classFilter ? dayView ? `Все классы · ${days[selectedDay]}` : 'Все классы · Учебная неделя' : dayView ? days[selectedDay] : schoolMode && classFilter ? `${classFilter} · Учебная неделя` : 'Учебная неделя'}</h2><p>{projection ? `В сетке ${visible.length} из ${displayLessons.length} занятий · ${projection.candidateAvailable?'вариант':'исходные места, не результат расчёта'}` : schoolMode ? countText(visible.length, 'занятие', 'занятия', 'занятий') : <>{visible.length} из {displayLessons.length} занятий <span>·</span> {classes.length} классов</>}</p></div><Badge>{projection?'Не сохранено':'Версия '+draft.revision}</Badge></div>{projection&&<ProjectionShelf value={projection} onSource={findProjectionSource}/ >}{!displayLessons.length ? <div className="tt-empty"><span className="tt-empty-calendar"><CalendarDays size={30} /></span><h3>Расписание ещё не загружено</h3><p>Выберите XLSX и проверьте результат до импорта.</p><button className="tt-btn tt-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> Выбрать файл</button></div> : !visible.length ? <div className="tt-empty"><Search size={27} /><h3>Занятий по запросу нет</h3><p>Измените класс, день или поисковую строку.</p><button className="tt-btn tt-secondary" onClick={() => { setClassFilter(''); setDayFilter(''); setQuery('') }}>Сбросить фильтры</button></div> : schoolMode && !classFilter ? <WholeSchoolTimetable lessons={visible} classes={classes} dayNames={days} renderLesson={lessonButton} filtered={Boolean(query.trim())} viewLabel={projection?'Предпросмотр общей сетки · не сохранено':undefined}/> : (schoolMode ? dayView : compact) ? <div className="tt-agenda" key={schoolMode ? `${classFilter}:${selectedDay}` : 'agenda'}>{visibleDays.filter(day => visible.some(lesson => lesson.day === day)).map(day => <section className="tt-agenda-day" key={day}><div className="tt-agenda-heading"><h3>{days[day]}</h3><small>{schoolMode ? countText(visible.filter(lesson => lesson.day === day).length, 'занятие', 'занятия', 'занятий') : `${visible.filter(lesson => lesson.day === day).length} занятий`}</small></div>{visible.filter(lesson => lesson.day === day).map(lesson => <div className="tt-agenda-row" key={lesson.id}><div className="tt-time"><strong>{lesson.start}</strong><span>{lesson.end}</span><small>{lesson.slot} урок</small></div>{lessonButton(lesson)}</div>)}</section>)}</div> : <div className="tt-grid-scroll"><div className="tt-week" data-week-view={schoolMode ? 'true' : undefined} style={{ gridTemplateColumns: `67px repeat(${visibleDays.length}, minmax(0, 1fr))` }}><div className="tt-week-corner">Время</div>{visibleDays.map(day => <div className="tt-day-heading" key={day}><strong>{shortDays[day]}</strong><span>{days[day]}</span><small>{schoolMode ? countText(visible.filter(lesson => lesson.day === day).length, 'занятие', 'занятия', 'занятий') : `${visible.filter(lesson => lesson.day === day).length} занятий`}</small></div>)}{slots.map(slot => { const [start, end, number] = slot.split('|'); return <div className="tt-week-row" key={slot}><div className="tt-time"><strong>{start}</strong><span>{end}</span><small>{number} урок</small></div>{visibleDays.map(day => <div className="tt-day-cell" data-day={days[day]} key={`${slot}-${day}`}>{visible.filter(lesson => lesson.day === day && lesson.start === start && lesson.end === end && String(lesson.slot) === number).map(lessonButton)}</div>)}</div> })}</div></div>}<div className="tt-calendar-foot">{schoolMode ? <><FileSpreadsheet size={13} /><span>{projection?'Расчёт '+projection.runId+' · предпросмотр без записи':(draft.sourceName || draft.sourceFilename || 'Источник пока не загружен')+' · Черновик'}</span></> : <><ShieldCheck size={13} /><span>Черновик для проверки. Публикация и отправка не выполняются.</span></>}</div></section><aside className="tt-aside" aria-label="Проверка и редактирование расписания">

  {editor && <WorkspaceSheet enabled={schoolMode} open={sheet === 'editor'} title="Карточка занятия" onClose={() => setSheet(null)}><section className="tt-panel tt-editor" aria-labelledby="tt-editor-heading" ref={editorRef}><div className="tt-section-head"><div><span className="tt-eyebrow">Карточка занятия</span><h2 id="tt-editor-heading">{editor.className} · {days[editor.day]}</h2></div>{!schoolMode && <button className="tt-icon-btn" aria-label="Закрыть редактор урока" disabled={runtimeBusy || !!pending} onClick={() => { setEditor(null); setEditorError(''); setConflict(false) }}><X size={17} /></button>}</div><div className="tt-editor-status"><Badge tone={dirty ? 'amber' : 'blue'}>{dirty ? 'Не сохранено' : 'Сохранено в черновике'}</Badge><small>Версия {editor.revision}</small></div><form onSubmit={event => void propose(event)}><div className="tt-form-pair"><label>Класс<input aria-label="Класс урока" maxLength={80} value={editor.className} onChange={event => updateEditor('className', event.target.value)} disabled={!!pending || runtimeBusy} /></label><label>Номер урока<input aria-label="Номер урока" type="number" min={1} max={20} value={editor.slot} onChange={event => updateEditor('slot', event.target.value)} disabled={!!pending || runtimeBusy} /></label></div><label>День<select aria-label="День урока" value={editor.day} onChange={event => updateEditor('day', Number(event.target.value))} disabled={!!pending || runtimeBusy}>{days.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label><div className="tt-form-pair"><label>Начало<input aria-label="Начало урока" type="time" value={editor.start} onChange={event => updateEditor('start', event.target.value)} disabled={!!pending || runtimeBusy} /></label><label>Окончание<input aria-label="Окончание урока" type="time" value={editor.end} onChange={event => updateEditor('end', event.target.value)} disabled={!!pending || runtimeBusy} /></label></div><label>Предмет<input aria-label="Предмет урока" ref={subjectRef} maxLength={160} value={editor.subject} onChange={event => updateEditor('subject', event.target.value)} disabled={!!pending || runtimeBusy} /></label><label>Учителя<textarea aria-label="Учителя урока" rows={2} value={editor.teachers} onChange={event => updateEditor('teachers', event.target.value)} disabled={!!pending || runtimeBusy} /></label><label>Кабинеты<textarea aria-label="Кабинеты урока" rows={2} value={editor.rooms} onChange={event => updateEditor('rooms', event.target.value)} disabled={!!pending || runtimeBusy} /></label><p className="tt-caption">Учителей и кабинеты разделяйте запятой или новой строкой. Соответствие групп не определяется автоматически.</p>{candidateErrors.length > 0 && <ErrorNotice message={candidateErrors.join(' ')} />}{dirty && !candidateErrors.length && <div className="tt-local-check"><strong>Предварительная проверка · не сохранено</strong><p>{proposedIssues.length ? `${proposedIssues.filter(issue => issue.severity === 'error').length} ошибок класса, ${proposedIssues.filter(issue => issue.severity === 'warning').length} предупреждений` : 'Для этой правки пересечений не найдено.'}</p>{proposedIssues.slice(0, 3).map(issue => <p key={issue.id} className={issue.severity === 'error' ? 'tt-red-text' : ''}>{issue.message}</p>)}<small>Сервер повторит проверку перед согласованием.</small></div>}{editorError && <ErrorNotice message={editorError} />}{conflict && <button type="button" className="tt-btn tt-secondary" disabled={loading} onClick={() => void loadDraft(true)}><RefreshCw size={14} /> Обновить версию, сохранив поля</button>}<div className="tt-editor-actions"><button type="submit" className="tt-btn tt-primary" disabled={!dirty || candidateErrors.length > 0 || runtimeBusy || !!pending}>{editBusy ? <LoaderCircle size={15} className="tt-spin" /> : <ArrowRight size={15} />} На согласование</button><button type="button" className="tt-link" disabled={!dirty || runtimeBusy || !!pending} onClick={() => { if (initialLesson) setEditor(makeEditor(initialLesson, draft.revision)); setReplacementBinding(null); setEditorError(''); setConflict(false) }}>Отменить правку</button></div></form><div className="tt-substitutes"><div className="tt-section-head"><div><span className="tt-eyebrow">Отсутствие преподавателя</span><h3>Кандидаты на замену</h3></div></div><p className="tt-caption">По подтверждённому плану, квалификации, доступности и текущей нагрузке. Выбор заполняет форму; назначение — после согласования.</p><button className="tt-btn tt-secondary tt-full" disabled={runtimeBusy || dirty || !!pending} onClick={() => void findSubstitute()}>{substituteBusy ? <LoaderCircle size={15} className="tt-spin" /> : <Users size={15} />} Подобрать замену</button>{substituteError && <ErrorNotice message={substituteError} />}{substitutes && <div className="tt-substitute-list" aria-live="polite"><p className="tt-caption">{substitutes.notice}</p>{substitutes.blockers.map(blocker => <p className="tt-caption" key={blocker.code}>{blocker.message}</p>)}{!substitutes.candidates.length && !substitutes.blockers.length && <p className="tt-caption">Квалифицированных кандидатов в подтверждённом справочнике нет.</p>}{substitutes.candidates.map(person => <div className="tt-substitute" key={person.teacherId}><strong>{person.name}</strong><small>{person.dailyLoad} занятий в день · {person.weeklyLoad} за неделю</small>{person.reasons.map(reason => <p key={reason}>{reason}</p>)}<button className="tt-btn tt-secondary" disabled={!person.available || !person.proposal || substituteConfigRevision === null || runtimeBusy || dirty || !!pending} onClick={() => { if (person.proposal && substituteConfigRevision !== null) { setReplacementBinding({ configRevision: substituteConfigRevision, replacementTeacherId: person.teacherId }); setEditor(makeEditor({ ...initialLesson!, ...person.proposal.lesson }, person.proposal.expectedRevision)); setNotice('Кандидат выбран в форме. Проверьте правку и отправьте на согласование.'); setSubstitutes(null); subjectRef.current?.focus() } }}>Выбрать {person.name}</button></div>)}</div>}</div>{initialLesson && <details className="tt-source"><summary>Исходная ячейка {initialLesson.sourceCell}</summary><pre>{initialLesson.raw}</pre></details>}</section></WorkspaceSheet>}
  <WorkspaceSheet enabled={schoolMode} open={sheet === 'checks'} title="Контроль расписания" onClose={() => setSheet(null)}><section className="tt-panel tt-checks" aria-labelledby="tt-checks-heading"><div className="tt-section-head"><div><span className="tt-eyebrow">Контроль расписания</span><h2 id="tt-checks-heading">Требует внимания</h2></div><span className="tt-soft-icon"><ShieldCheck size={19} /></span></div><div className="tt-check-counts"><div className={errors.length ? 'tt-count-error' : ''}><strong>{errors.length}</strong><span>ошибок класса</span></div><div className={warnings.length ? 'tt-count-warning' : ''}><strong>{warnings.length}</strong><span>предупреждений</span></div></div><p className="tt-caption">Один класс не может вести два занятия одновременно. Общие учителя и кабинеты требуют проверки групп.</p>{draft.issues.length ? <div className="tt-issue-list">{[...errors, ...warnings].map(issue => <button key={issue.id} className={`tt-issue ${issue.severity}`} onClick={() => showIssue(issue)} aria-label={`${issue.severity === 'error' ? 'Ошибка класса' : 'Предупреждение'}: ${issue.message}`}><AlertCircle size={14} /><span><b>{issue.severity === 'error' ? 'Ошибка класса' : issue.kind === 'ambiguous' ? 'Уточните группы' : 'Проверить'}</b>{issue.message}</span><ArrowRight size={12} /></button>)}</div> : <div className="tt-check-ok"><CheckCircle2 size={17} /><span>{displayLessons.length ? 'Пересечений в черновике не найдено.' : 'Проверки появятся после импорта.'}</span></div>}</section></WorkspaceSheet>
  <WorkspaceSheet enabled={schoolMode} open={sheet === 'approval'} title="Проверка и согласование" onClose={() => setSheet(null)}><section className="tt-panel tt-agent" aria-labelledby="tt-agent-heading"><div className="tt-section-head"><div className="tt-agent-title"><span className="tt-soft-icon tt-purple"><Bot size={20} /></span><div><span className="tt-eyebrow">Помощник расписания</span><h2 id="tt-agent-heading">Проверка и согласование</h2></div></div></div>{agentStatus ? <p className="tt-agent-model"><span className={`tt-model-dot ${agentStatus.modelConfigured && agentStatus.requestsEnabled ? 'configured' : ''}`} />{!agentStatus.modelConfigured ? 'ИИ-модель не подключена' : agentStatus.requestsEnabled ? 'Модель настроена' : 'Внешние запросы выключены'}<small>{agentStatus.modelConfigured && agentStatus.requestsEnabled ? 'Модель предлагает — сотрудник подтверждает.' : 'Доступны проверки по правилам и согласование ручных правок.'}</small></p> : agentStatusError ? <ErrorNotice message={agentStatusError}><button className="tt-link" onClick={() => void loadAgentStatus()}>Проверить подключение снова</button></ErrorNotice> : <p className="tt-caption" role="status">Проверяем подключение модели…</p>}<button className="tt-btn tt-secondary tt-full" disabled={runtimeBusy || !!pending || !!projection || !displayLessons.length} onClick={() => void checkSchedule()}>{agentBusy ? <LoaderCircle size={15} className="tt-spin" /> : <ShieldCheck size={15} />} Проверить расписание</button>{agentTask && <div className={`tt-agent-result ${pending ? 'tt-approval' : ''}`} aria-live="polite"><Badge tone={pending ? 'amber' : agentTask.status === 'completed' ? 'green' : ''}>{pending ? 'Ждёт вашего решения' : agentTask.status === 'completed' ? 'Выполнено' : agentTask.status === 'rejected' ? 'Отклонено' : agentTask.status === 'stale' ? 'Версия изменилась' : agentTask.status === 'needs_configuration' ? 'Нужна настройка' : 'Не выполнено'}</Badge><p>{agentTask.message}</p>{pending && agentTask.proposal && 'lesson' in agentTask.proposal && <><div className="tt-proposal"><div className="tt-review-grid cp-grid"><LessonReview label="Было в исходном черновике" lesson={proposalBefore}/><LessonReview label="Станет после согласования" lesson={agentTask.proposal.lesson} changed={!!proposalBefore&&JSON.stringify(editable(proposalBefore))!==JSON.stringify(editable(agentTask.proposal.lesson))}/></div><p className="tt-caption">Это правка недельного черновика. Конкретная календарная дата здесь не назначается; для разовой замены используйте раздел «Замены». Опубликованная версия изменится только после отдельной публикации.</p><small>Основание: версия {agentTask.proposal.expectedRevision}. Сохранение только после подтверждения.</small>{agentTask.proposal.configRevision !== undefined && <small>Кандидат проверен по условиям v{agentTask.proposal.configRevision}; перед записью условия проверятся повторно.</small>}</div><div className="tt-decision"><button className="tt-btn tt-primary" disabled={runtimeBusy || !proposalBefore} onClick={() => void decide('approve')}><Check size={14} /> Согласовать изменение</button><button className="tt-btn tt-secondary" disabled={runtimeBusy} onClick={() => void decide('reject')}>Отклонить</button></div></>}{!pending && agentTask.issues?.length > 0 && <small>{agentTask.issues.length} замечаний. Подробности — в блоке контроля.</small>}</div>}{agentError && <ErrorNotice message={agentError}><button className="tt-link" disabled={runtimeBusy} onClick={() => pending ? void decide(lastDecision) : void checkSchedule()}>Повторить действие</button></ErrorNotice>}<div className="tt-agent-query"><button className="tt-btn tt-secondary tt-full" disabled={runtimeBusy || !!pending || dirty || !!projection} onClick={selectTextWorkspace}><Bot size={15} /> Открыть диалог агента</button><p className="tt-caption">Текстовые правки и уточнения доступны в диалоге с полным предпросмотром.</p></div><div className="tt-agent-foot"><ShieldCheck size={13} /><span>Решение остаётся за сотрудником. Изменяется только черновик.</span></div></section></WorkspaceSheet>
 </aside></div></>}
 </>}
   <WorkspaceSheet enabled open={active && !requestedAction && !requestedLessonId && sheet === 'experiment'} title="Расписание всех классов" onClose={()=>setSheet(null)} wide>{experimentVisited&&<><div className="tt-day-tabs" aria-label="Вариант общей таблицы" style={{'--tt-day-count':2,'--tt-day-index':schoolDraftView==='dated'?0:1} as CSSProperties}><button aria-pressed={schoolDraftView==='dated'} onClick={()=>setSchoolDraftView('dated')}>26–28 октября · короткая неделя</button><button aria-pressed={schoolDraftView==='experiment'} onClick={()=>setSchoolDraftView('experiment')}>Прежний расчёт · без каникул</button></div><div hidden={schoolDraftView!=='dated'}><ShortWeekDraft sourceRevision={draft?.revision??0} disabled={!active || !!requestedAction || !!requestedLessonId || sheet!=='experiment' || schoolDraftView!=='dated'}/></div><div hidden={schoolDraftView!=='experiment'}><p className="tt-caption">Этот прежний расчёт не учитывает каникулы с 29 октября и содержит выявленные ошибки исходных данных. Используйте его только для сравнения; новый вариант находится во вкладке «26–28 октября».</p><ExperimentalSchoolPlan experimentId={experimentId} disabled={!active || !!requestedAction || !!requestedLessonId || sheet!=='experiment' || schoolDraftView!=='experiment'}/></div></>}</WorkspaceSheet>
 </div>
}
