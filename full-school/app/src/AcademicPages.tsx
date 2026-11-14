import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, CheckCheck, ChevronRight, ClipboardCheck, Clock3, Download, FileText, GraduationCap, LibraryBig, MapPin, Medal, Route, Search, Send, Sparkles, Target, TrendingUp, UsersRound, X } from 'lucide-react'
import type { AcademicProps, Assignment, Lesson, Material } from './types'
import './academic.css'

type AcademicModal = { kind: 'material'; item: Material } | { kind: 'assignment' | 'review'; item: Assignment } | { kind: 'absence'; item: Lesson } | { kind: 'class'; name: string } | { kind: 'catchup' }
type AssignmentFilter = 'all' | Assignment['status']
type ReturnFocus = { element: HTMLElement; key?: string } | null
const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница']
const demoDayLabel = 'Понедельник, 12 октября'
const statusLabels = { todo: 'К выполнению', submitted: 'Отправлено', reviewed: 'Проверено' }
const lessonDay = (day: number) => days[day] || 'Учебный день'
const initials = (name: string) => name.split(' ').slice(0, 2).map(value => value[0]).join('')
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const formatNumber = (value: number | null) => value === null ? '—' : value.toLocaleString('en-GB', { maximumFractionDigits: 1 })

function Modal({ title, children, onClose, busy, returnFocus }: { title: string; children: ReactNode; onClose: () => void; busy: boolean; returnFocus: ReturnFocus }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = returnFocus?.element || document.activeElement as HTMLElement | null
    const previousFocusKey = returnFocus?.key || previous?.dataset.acFocus
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const node = dialog.current
    const controls = () => [...(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || [])]
    ;(controls()[0] || node)?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if (event.key !== 'Tab') return
      const elements = controls()
      if (!elements.length) { event.preventDefault(); node?.focus(); return }
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || !node?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !node?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', handleKey)
      const returnTarget = previous?.isConnected ? previous : previousFocusKey ? document.querySelector<HTMLElement>(`[data-ac-focus="${CSS.escape(previousFocusKey)}"]`) : null
      returnTarget?.focus()
    }
  }, [onClose, busy, returnFocus])
  return createPortal(<div className="academic ac-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialog} className="ac-modal" role="dialog" aria-modal="true" aria-labelledby="academic-modal-title" tabIndex={-1}>
      <header className="ac-modal-head"><div className="ac-icon lilac"><BookOpen size={21} /></div><h2 id="academic-modal-title">{title}</h2><button className="ac-icon-button" onClick={onClose} disabled={busy} aria-label="Закрыть окно"><X size={20} /></button></header>
      {children}
    </div>
  </div>, document.body)
}

function Panel({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  const Icon = /урок/i.test(title) ? CalendarDays : /задани|работ/i.test(title) ? ClipboardCheck : /прогресс/i.test(title) ? TrendingUp : /класс/i.test(title) ? UsersRound : BookOpen
  return <section className={`ac-card ${className}`}><div className="ac-card-head"><div className="ac-card-title"><Icon size={22} aria-hidden="true" /><h2>{title}</h2></div>{action}</div>{children}</section>
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="ac-empty"><BookOpen size={30} /><strong>{title}</strong><p>{text}</p></div> }
function ProgressBar({ value, label }: { value: number; label: string }) { return <div className="ac-progress-track" role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div> }
function Ring({ value, label }: { value: number; label: string }) { const radius = 45, circumference = 2 * Math.PI * radius; return <div className="ac-ring"><svg viewBox="0 0 110 110" role="img" aria-label={`${label}: ${Math.round(value)}%`}><circle cx="55" cy="55" r={radius} className="ac-ring-base" /><circle cx="55" cy="55" r={radius} className="ac-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, value)) / 100)} /></svg><strong>{Math.round(value)}<small>%</small></strong></div> }

export default function AcademicPages({ state, page, mutate, toast, navigate }: AcademicProps) {
  const [modal, setModal] = useState<AcademicModal | null>(null)
  const modalReturnFocus = useRef<ReturnFocus>(null)
  const [filter, setFilter] = useState<AssignmentFilter>('all')
  const [query, setQuery] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('Все предметы')
  const [dayFilter, setDayFilter] = useState<number | null>(null)
  const [answer, setAnswer] = useState('')
  const [grade, setGrade] = useState(5)
  const [feedback, setFeedback] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const sortedLessons = useMemo(() => [...state.schedule].sort((a, b) => a.day - b.day || a.slot - b.slot), [state.schedule])
  // Учебный день демонстрации: 12 октября 2026, 09:10.
  const currentDay = 0
  const currentMinutes = 9 * 60 + 10
  const lessonMinutes = (lesson: Lesson) => { const matches = [...lesson.time.matchAll(/(\d{1,2}):(\d{2})/g)]; return matches.map(match => Number(match[1]) * 60 + Number(match[2])) }
  const activeLessons = sortedLessons.filter(lesson => lesson.status !== 'completed')
  const currentLesson = activeLessons.find(lesson => { const [start, end] = lessonMinutes(lesson); return lesson.day === currentDay && start <= currentMinutes && end > currentMinutes })
  const futureLessons = activeLessons.filter(lesson => lesson !== currentLesson && (lesson.day > currentDay || lesson.day === currentDay && (lessonMinutes(lesson)[0] ?? 0) > currentMinutes))
  const nearestLessons = [...(currentLesson ? [currentLesson] : []), ...futureLessons, ...activeLessons.filter(lesson => lesson !== currentLesson && !futureLessons.includes(lesson))]
  const nextLesson = nearestLessons[0]
  const reviewed = state.assignments.filter(item => item.status === 'reviewed')
  const pending = state.assignments.filter(item => item.status === 'todo')
  const submitted = state.assignments.filter(item => item.status === 'submitted')
  const average = mean(reviewed.flatMap(item => item.grade === null ? [] : [item.grade]))
  const completion = state.assignments.length ? Math.round((state.assignments.length - pending.length) / state.assignments.length * 100) : 0
  const progress = state.students.length === 1 ? state.students[0].progress : completion
  const materialSubjects = [...new Set(state.materials.map(item => item.subject))]
  const subjects = [...new Set(state.assignments.map(item => item.subject))]
  const filteredMaterials = state.materials.filter(item => (subjectFilter === 'Все предметы' || item.subject === subjectFilter) && `${item.title} ${item.subject} ${item.content}`.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')))
  const classes = [...new Set([...state.students.map(item => item.className), ...state.schedule.map(item => item.className)])].sort((a, b) => a.localeCompare(b, 'ru-RU'))
  const closeModal = useCallback(() => { setModal(null); setError('') }, [])
  const openModal = (value: AcademicModal) => {
    if (!modal && document.activeElement instanceof HTMLElement) modalReturnFocus.current = { element: document.activeElement, key: document.activeElement.dataset.acFocus }
    setError(''); setModal(value)
    if (value.kind === 'assignment') setAnswer(value.item.answer)
    if (value.kind === 'review') { setGrade(value.item.grade || 5); setFeedback(value.item.feedback) }
    if (value.kind === 'absence') setReason('')
  }
  const perform = async (key: string, path: string, body: unknown, success: string, onSuccess?: () => void) => {
    if (busy) return
    setError(''); setBusy(key)
    try { await mutate(path, body); toast(success); onSuccess?.() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось сохранить. Попробуйте ещё раз.') }
    finally { setBusy('') }
  }
  useEffect(() => { setModal(null); setError(''); setQuery(''); setSubjectFilter('Все предметы'); setFilter('all'); setDayFilter(null) }, [page, state.role])
  const openLessonMaterial = (lesson: Lesson) => { const material = state.materials.find(item => item.id === lesson.materialId); if (material) openModal({ kind: 'material', item: material }); else { toast('К этому уроку материалы пока не добавлены'); navigate(state.role === 'student' ? 'library' : 'materials') } }
  const downloadMaterial = (material: Material) => { const blob = new Blob([`${material.title}\n${material.subject}\n\n${material.content}`], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${material.title.replace(/[\\/:*?"<>|]/g, '-')}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Учебный материал скачан') }
  const linkButton = (label: string, target: string) => <button className="ac-link" onClick={() => navigate(target)}>{label}<ArrowUpRight size={15} /></button>
  const subjectIcon = (subject: string) => <span className={`ac-icon ${subject.length % 3 === 0 ? 'mint' : subject.length % 2 === 0 ? 'lilac' : 'blue'}`}><BookOpen size={20} /></span>

  function Welcome({ teacher = false }: { teacher?: boolean }) {
    return <section className={`ac-welcome ${teacher ? 'ac-welcome-teacher' : ''}`}>
      <div className="ac-welcome-copy">
        <h1>{teacher ? 'Добрый день' : 'Привет'}, {teacher ? state.profile.name.split(' ').slice(0, 2).join(' ') : state.profile.name.split(' ')[0]}!</h1>
        <p>{teacher ? 'Меньше рутины. Больше времени для хорошего урока.' : 'Уроки, задания и помощь — всё рядом. Давай начнём!'}</p>
        <div className="ac-welcome-actions"><button className="ac-btn ac-primary" onClick={() => navigate(teacher ? 'materials' : 'assignments')}>{teacher ? 'Материалы к урокам' : 'Открыть задания'}<ArrowRight size={18} /></button><span className="ac-welcome-meta"><CalendarDays size={15} />{teacher ? demoDayLabel : `${state.students[0]?.className || 'Твой кабинет'} · ${demoDayLabel}`}</span></div>
      </div>
      <div className="ac-welcome-art" aria-hidden="true" />
    </section>
  }

  function FeatureTiles({ teacher = false }: { teacher?: boolean }) {
    const features = teacher ? [
      { title: 'Мои уроки', detail: `${activeLessons.length} в расписании`, icon: CalendarDays, tone: 'blue', action: () => navigate('schedule') },
      { title: 'Материалы', detail: `Готовые материалы: ${state.materials.length}`, icon: BookOpen, tone: 'lilac', action: () => navigate('materials') },
      { title: 'Проверка работ', detail: `Ожидают проверки: ${submitted.length}`, icon: ClipboardCheck, tone: 'rose', action: () => navigate('review') },
      { title: 'Мои классы', detail: `Учебные группы: ${classes.length}`, icon: UsersRound, tone: 'mint', action: () => navigate('classes') },
    ] : [
      { title: 'Мои уроки', detail: 'Расписание и материалы', icon: CalendarDays, tone: 'blue', action: () => navigate('my-lessons') },
      { title: 'Разобрать тему', detail: 'Объяснения и конспекты', icon: BookOpen, tone: 'lilac', action: () => navigate('library') },
      { title: 'Мои задания', detail: `${pending.length} к выполнению`, icon: ClipboardCheck, tone: 'mint', action: () => navigate('assignments') },
      { title: 'Мой прогресс', detail: `${progress}% учебного маршрута`, icon: TrendingUp, tone: 'amber', action: () => navigate('progress') },
    ]
    return <div className="ac-feature-grid">{features.map(({ title, detail, icon: Icon, tone, action }) => <button className={`ac-feature-tile ${tone}`} key={title} onClick={action}><span className={`ac-icon ${tone}`}><Icon size={25} strokeWidth={2.3} /></span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={16} /></button>)}</div>
  }

  function LessonCard({ lesson, isNext = false }: { lesson: Lesson; isNext?: boolean }) {
    const replacement = lesson.status === 'replacement'
    const portrait = ({ t1: 0, t2: 1, t3: 2 } as Record<string, number>)[lesson.teacherId]
    const canComplete = replacement && lesson.teacherId === state.profile.userId && state.replacements.some(item => item.lessonId === lesson.id && item.status === 'approved' && item.teacherId === state.profile.userId)
    return <article className={`ac-lesson-card ${isNext ? 'ac-lesson-next' : ''} ${replacement ? 'ac-lesson-replacement' : ''}`}>
      <div className="ac-lesson-top"><span className="ac-eyebrow"><CalendarDays size={15} />{isNext ? 'Следующий урок' : lesson.id === currentLesson?.id ? 'Текущий урок' : 'Ближайший урок'}</span><span className={`ac-tag ${replacement ? 'amber' : 'mint'}`}><span className="ac-status-dot" />{replacement ? 'Замена учителя' : lesson.id === currentLesson?.id ? 'Идёт сейчас' : lessonDay(lesson.day)}</span></div>
      <div className="ac-lesson-content"><div className="ac-lesson-subject"><p className="ac-lesson-time"><Clock3 size={15} />{lesson.time}</p><h3>{lesson.subject}</h3><div className="ac-lesson-meta"><span><UsersRound size={15} />{lesson.className}</span><span><MapPin size={15} />Кабинет {lesson.room}</span></div></div><span className="ac-lesson-emblem" aria-hidden="true"><BookOpen size={34} strokeWidth={2.2} /></span></div>
      <div className="ac-teacher"><span className={`ac-avatar avatar ${portrait !== undefined ? `portrait-${portrait}` : ''}`} aria-hidden="true">{portrait === undefined ? initials(lesson.teacherName) : ''}</span><div><strong>{lesson.teacherName}</strong><small>{replacement ? 'Учитель на замене' : 'Учитель'}</small></div><span className="ac-lesson-slot">{lesson.slot} урок</span></div>
      <div className="ac-button-row"><button className="ac-btn ac-primary" data-ac-focus={`lesson-material-${lesson.id}`} onClick={() => openLessonMaterial(lesson)}><BookOpen size={16} />Открыть материалы</button>{state.role === 'student' ? <button className="ac-btn ac-secondary" onClick={() => navigate('my-lessons')}><CalendarDays size={16} />Расписание</button> : canComplete ? <button className="ac-btn ac-secondary" disabled={Boolean(busy)} onClick={() => perform(`complete-${lesson.id}`, `/api/lessons/${lesson.id}/complete`, {}, 'Проведение урока подтверждено')}><Check size={16} />{busy === `complete-${lesson.id}` ? 'Сохраняем…' : 'Урок проведён'}</button> : replacement ? <button className="ac-btn ac-secondary" onClick={() => navigate('replacements')}>Статус замены<ChevronRight size={15} /></button> : <button className="ac-btn ac-secondary" data-ac-focus={`absence-${lesson.id}`} onClick={() => openModal({ kind: 'absence', item: lesson })}>Сообщить об отсутствии</button>}</div>
    </article>
  }
  function AssignmentRow({ item, teacher = false }: { item: Assignment; teacher?: boolean }) {
    return <div className="ac-assignment-row">{subjectIcon(item.subject)}<div className="ac-row-main"><small>{item.subject}</small><strong>{item.title}</strong><span>{item.due}</span></div><span className={`ac-tag ${item.status === 'reviewed' ? 'mint' : item.status === 'submitted' ? 'blue' : 'rose'}`}>{item.status === 'reviewed' && item.grade !== null ? `Оценка ${item.grade}` : statusLabels[item.status]}</span><button className={`ac-btn ${item.status === 'todo' && !teacher ? 'ac-primary' : 'ac-secondary'}`} data-ac-focus={`assignment-${item.id}`} onClick={() => openModal({ kind: teacher ? 'review' : 'assignment', item })}>{teacher ? item.status === 'reviewed' ? 'Открыть' : 'Проверить' : item.status === 'todo' ? 'Выполнить' : 'Открыть'}<ChevronRight size={15} /></button></div>
  }
  function MaterialCard({ item }: { item: Material }) { return <article className="ac-material-card"><div className="ac-material-cover"><FileText size={35} /><span>{item.type}</span><div className="ac-paper-lines"><i /><i /><i /></div></div><div className="ac-material-info"><span className="ac-tag lilac">{item.subject}</span><h3>{item.title}</h3><p>{item.content.slice(0, 110)}{item.content.length > 110 ? '…' : ''}</p><div className="ac-button-row"><button className="ac-btn ac-secondary" data-ac-focus={`material-${item.id}`} onClick={() => openModal({ kind: 'material', item })}>Открыть<ArrowUpRight size={15} /></button><button className="ac-icon-button" aria-label={`Скачать ${item.title}`} onClick={() => downloadMaterial(item)}><Download size={18} /></button></div></div></article> }
  function MiniProgress() { return <div className="ac-mini-progress"><Ring value={progress} label="Личный прогресс" /><div><h3>Шаг за шагом — к цели</h3><p>Выполнено {state.assignments.length - pending.length} из {state.assignments.length} заданий</p><button className="ac-link" onClick={() => navigate('progress')}>Посмотреть прогресс<ArrowRight size={15} /></button></div></div> }
  function StudentHome() {
    return <>
      <Welcome />
      <FeatureTiles />
      <div className="ac-home-grid">
        <div className="ac-home-main">
          <Panel title="Всё готово к уроку" action={linkButton('Мои уроки', 'my-lessons')}>
            {nextLesson ? <LessonCard lesson={nextLesson} /> : <Empty title="На сегодня уроков нет" text="Расписание появится здесь, когда школа добавит занятия." />}
          </Panel>
          <Panel title="Мои задания" action={linkButton('Все задания', 'assignments')}>
            <div className="ac-inline-tabs"><span className="selected">К выполнению <b>{pending.length}</b></span><span>Отправлено <b>{submitted.length}</b></span><span>Проверено <b>{reviewed.length}</b></span></div>
            {state.assignments.slice(0, 3).map(item => <AssignmentRow key={item.id} item={item} />)}
            {!state.assignments.length && <Empty title="Можно выдохнуть" text="Новых заданий пока нет. Возвращайтесь после урока." />}
          </Panel>
        </div>
        <aside className="ac-home-aside">
          <Panel title="Твой прогресс"><MiniProgress /></Panel>
          <section className="ac-catchup">
            <div className="ac-catchup-header"><div className="ac-catchup-icon"><Route size={27} /></div><span className="ac-eyebrow">ПОНЯТНЫЙ ПЛАН</span></div>
            <h2>Пропустил тему?<br />Наверстаем вместе.</h2><p>Разберём материал небольшими шагами — в твоём темпе.</p>
            <div className="ac-catchup-art" aria-hidden="true"><span>1</span><i /><span>2</span><i /><span><Check size={17} /></span></div>
            <button className="ac-btn ac-primary" data-ac-focus="catchup" onClick={() => openModal({ kind: 'catchup' })}>Открыть учебный маршрут<ArrowRight size={16} /></button>
          </section>
          <Panel title="Под рукой" action={<LibraryBig size={19} />}>
            <div className="ac-resource-list">{state.materials.slice(0, 2).map(item => <button key={item.id} data-ac-focus={`resource-${item.id}`} onClick={() => openModal({ kind: 'material', item })}>{subjectIcon(item.subject)}<span><strong>{item.title}</strong><small>{item.subject} · {item.type}</small></span><ChevronRight size={15} /></button>)}</div>
            {!state.materials.length && <p className="ac-subtle">Учебных материалов пока нет.</p>}
            <button className="ac-full-link" onClick={() => navigate('library')}>Открыть библиотеку<ArrowRight size={16} /></button>
          </Panel>
        </aside>
      </div>
    </>
  }
  function Schedule() { const dayValues = [...new Set(sortedLessons.map(item => item.day))]; const visible = sortedLessons.filter(item => dayFilter === null || item.day === dayFilter); return <><div className="ac-page-heading"><div><h1>Мои уроки</h1><p>Актуальное расписание и материалы к каждому занятию.</p></div><span className="ac-tag blue"><CalendarDays size={15} />Учебная неделя</span></div><div className="ac-filter-tabs" role="group" aria-label="День недели"><button className={dayFilter === null ? 'active' : ''} onClick={() => setDayFilter(null)}>Вся неделя</button>{dayValues.map(day => <button key={day} className={dayFilter === day ? 'active' : ''} onClick={() => setDayFilter(day)}>{lessonDay(day)}</button>)}</div>{visible.length ? <div className="ac-schedule-list">{visible.map(lesson => <article className="ac-schedule-row" key={lesson.id}><div className="ac-schedule-time"><small>{lessonDay(lesson.day)}</small><strong>{lesson.time}</strong><span>{lesson.slot} урок</span></div>{subjectIcon(lesson.subject)}<div className="ac-row-main"><h3>{lesson.subject}</h3><span>{lesson.teacherName}</span><div className="ac-lesson-meta"><span>{lesson.className}</span><span>Кабинет {lesson.room}</span></div></div><span className={`ac-tag ${lesson.status === 'replacement' ? 'amber' : lesson.status === 'completed' ? 'mint' : 'blue'}`}>{lesson.status === 'replacement' ? 'Замена' : lesson.status === 'completed' ? 'Проведён' : 'По расписанию'}</span><button className="ac-btn ac-secondary" onClick={() => openLessonMaterial(lesson)}><BookOpen size={16} />Материалы</button></article>)}</div> : <Empty title="Уроков пока нет" text="Для выбранного дня занятий не найдено." />}</> }
  function Assignments({ teacher = false }: { teacher?: boolean }) { const visible = state.assignments.filter(item => filter === 'all' || item.status === filter); return <><div className="ac-page-heading"><div><h1>{teacher ? 'Проверка работ' : 'Мои задания'}</h1><p>{teacher ? 'Ответы учеников, оценки и обратная связь.' : 'Чёткие сроки, понятные задания и обратная связь учителя.'}</p></div><span className="ac-tag lilac"><ClipboardCheck size={15} />{teacher ? `${submitted.length} на проверке` : `${pending.length} к выполнению`}</span></div><div className="ac-filter-tabs" role="group" aria-label="Статус задания">{(['all', 'todo', 'submitted', 'reviewed'] as AssignmentFilter[]).map(value => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'Все задания' : statusLabels[value]}<b>{value === 'all' ? state.assignments.length : state.assignments.filter(item => item.status === value).length}</b></button>)}</div><div className="ac-card ac-assignments-full">{visible.map(item => <AssignmentRow key={item.id} item={item} teacher={teacher} />)}{!visible.length && <Empty title={teacher ? 'Все работы просмотрены' : 'Здесь пока пусто'} text="Задания с таким статусом не найдены. Попробуйте другой фильтр." />}</div><p className="ac-help-line"><CheckCheck size={16} />{teacher ? 'Оценка и комментарий появятся в кабинете ученика после сохранения.' : 'Отправленные ответы сохраняются. Проверенные работы можно открыть и посмотреть комментарий учителя.'}</p></> }
  function Grades() { return <><div className="ac-page-heading"><div><h1>Мои оценки</h1><p>Результаты заданий и комментарии, которые помогают двигаться вперёд.</p></div><div className="ac-average-pill"><Medal size={21} /><span><small>Средний балл</small><strong>{formatNumber(average)}</strong></span></div></div><div className="ac-card ac-table-card"><table className="ac-table"><thead><tr><th>Предмет и задание</th><th>Срок</th><th>Оценка</th><th>Комментарий</th></tr></thead><tbody>{state.assignments.map(item => <tr key={item.id}><td><strong>{item.subject}</strong><button className="ac-table-link" data-ac-focus={`grade-${item.id}`} onClick={() => openModal({ kind: 'assignment', item })}>{item.title}<ArrowUpRight size={13} /></button></td><td>{item.due}</td><td>{item.grade !== null ? <span className={`ac-grade ${item.grade >= 4 ? 'good' : ''}`}>{item.grade}</span> : <span className="ac-tag blue">{statusLabels[item.status]}</span>}</td><td>{item.feedback || 'Комментарий появится после проверки'}</td></tr>)}</tbody></table>{!state.assignments.length && <Empty title="Оценки впереди" text="Здесь появятся результаты ваших первых заданий." />}</div><section className="ac-note ac-wide-note"><Target size={24} /><p><strong>Оценка — ориентир для следующего шага</strong><span>Открывай работу, читай комментарий учителя и возвращайся к материалам сложной темы.</span></p><button className="ac-btn ac-secondary" onClick={() => navigate('library')}>К материалам<ArrowRight size={16} /></button></section></> }
  function Progress() { return <><div className="ac-page-heading"><div><h1>Мой прогресс</h1><p>Посмотри, сколько уже получилось. И выбери следующий шаг.</p></div><span className="ac-tag mint"><TrendingUp size={15} />По текущим заданиям</span></div><div className="ac-stats-grid"><div className="ac-stat"><span className="ac-icon blue"><ClipboardCheck size={21} /></span><small>Выполнено заданий</small><strong>{state.assignments.length - pending.length}<em> / {state.assignments.length}</em></strong></div><div className="ac-stat"><span className="ac-icon lilac"><Medal size={21} /></span><small>Средний балл</small><strong>{formatNumber(average)}<em> / 5</em></strong></div><div className="ac-stat"><span className="ac-icon mint"><CheckCheck size={21} /></span><small>Проверено учителем</small><strong>{reviewed.length}<em> работ</em></strong></div></div><div className="ac-two-col"><Panel title="Учебный маршрут"><div className="ac-progress-overview"><Ring value={progress} label="Учебный прогресс" /><div><h3>{progress >= 80 ? 'Отличный темп!' : 'Ты на верном пути'}</h3><p>{pending.length ? `Осталось ${pending.length} заданий. Выбери одно и начни с малого.` : 'Все задания отправлены. Можно повторить изученные темы.'}</p><button className="ac-btn ac-primary" onClick={() => navigate('assignments')}>Перейти к заданиям<ArrowRight size={16} /></button></div></div></Panel><Panel title="Результаты по предметам"><div className="ac-subject-progress">{subjects.map(subject => { const items = state.assignments.filter(item => item.subject === subject); const done = items.filter(item => item.status !== 'todo').length; return <div key={subject}><div><strong>{subject}</strong><span>{done} из {items.length}</span></div><ProgressBar value={done / items.length * 100} label={`Выполнено по предмету ${subject}`} /></div> })}{!subjects.length && <Empty title="Пока нет данных" text="Прогресс появится после добавления заданий." />}</div></Panel></div><Panel title="Следующий шаг" className="ac-next-step">{pending[0] ? <AssignmentRow item={pending[0]} /> : <section className="ac-note"><GraduationCap size={27} /><p><strong>Всё выполнено</strong><span>Закрепи знания: выбери материал в библиотеке.</span></p><button className="ac-btn ac-secondary" onClick={() => navigate('library')}>В библиотеку<ArrowRight size={16} /></button></section>}</Panel></> }
  function Materials({ teacher = false }: { teacher?: boolean }) { return <><div className="ac-page-heading"><div><h1>{teacher ? 'Мои материалы' : 'Библиотека'}</h1><p>{teacher ? 'Всё необходимое для урока: объяснения, конспекты и рабочие материалы.' : 'Объяснения и конспекты, к которым всегда можно вернуться.'}</p></div><span className="ac-tag lilac"><LibraryBig size={15} />{state.materials.length} материалов</span></div><div className="ac-library-toolbar"><label className="ac-search"><Search size={18} /><input aria-label="Поиск учебных материалов" placeholder="Найти тему или материал…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Очистить поиск материалов" onClick={() => setQuery('')}><X size={15} /></button>}</label><label className="ac-select-label"><span className="ac-sr-only">Предмет</span><select value={subjectFilter} onChange={event => setSubjectFilter(event.target.value)}><option>Все предметы</option>{materialSubjects.map(subject => <option key={subject}>{subject}</option>)}</select></label></div><div className="ac-material-grid">{filteredMaterials.map(item => <MaterialCard key={item.id} item={item} />)}</div>{!filteredMaterials.length && <Empty title="Материалы не найдены" text={query || subjectFilter !== 'Все предметы' ? 'Попробуйте другую тему или выберите все предметы.' : 'Учебные материалы появятся здесь после добавления учителем.'} />}</> }
  function TeacherHome() {
    const weekCounts = days.map((_, day) => state.schedule.filter(item => item.day === day).length)
    const maxCount = Math.max(1, ...weekCounts)
    return <>
      <Welcome teacher />
      <FeatureTiles teacher />
      <div className="ac-teacher-lesson-grid">
        {nextLesson ? <LessonCard lesson={nextLesson} /> : <Panel title="Ближайший урок"><Empty title="Уроков пока нет" text="Новые занятия появятся в расписании." /></Panel>}
        {nearestLessons[1] ? <LessonCard lesson={nearestLessons[1]} isNext /> : <Panel title="Следующий урок"><Empty title="Можно подготовиться спокойно" text="Других запланированных занятий пока нет." /></Panel>}
      </div>
      {error && !modal && <p className="ac-error" role="alert"><AlertCircle size={17} />{error}</p>}
      <div className="ac-home-grid">
        <div className="ac-home-main">
          <Panel title="Работы на проверку" action={linkButton('Все работы', 'review')}>
            <div className="ac-inline-tabs"><span className="selected">Ожидают проверки <b>{submitted.length}</b></span><span>Проверено <b>{reviewed.length}</b></span></div>
            {submitted.slice(0, 4).map(item => <AssignmentRow key={item.id} item={item} teacher />)}
            {!submitted.length && <Empty title="Все работы проверены" text="Новые ответы учеников появятся здесь." />}
          </Panel>
          <Panel title="Мои классы" action={linkButton('Открыть классы', 'classes')}>
            <div className="ac-class-mini-grid">{classes.slice(0, 3).map(name => { const students = state.students.filter(item => item.className === name); return <button className="ac-class-mini" key={name} data-ac-focus={`class-mini-${name}`} onClick={() => openModal({ kind: 'class', name })}><span className="ac-class-letter">{name}</span><strong>{students.length ? `${students.length} учеников` : 'Список пока пуст'}</strong><small>{state.schedule.filter(item => item.className === name).length} уроков в расписании</small><ChevronRight size={15} /></button> })}</div>
            {!classes.length && <Empty title="Нет доступных классов" text="Назначенные классы появятся здесь." />}
          </Panel>
        </div>
        <aside className="ac-home-aside">
          <Panel title="Обзор учебной работы">
            <div className="ac-teacher-overview"><Ring value={state.assignments.length ? reviewed.length / state.assignments.length * 100 : 0} label="Проверенные работы" /><div><strong>{formatNumber(average)}<small> / 5</small></strong><span>средний балл по проверенным работам</span></div></div>
            <div className="ac-overview-row"><span><i className="ac-key rose" />На проверке</span><b>{submitted.length}</b></div>
            <div className="ac-overview-row"><span><i className="ac-key blue" />Задания ученикам</span><b>{pending.length}</b></div>
            <div className="ac-week-chart" role="img" aria-label={`Уроки за неделю: ${days.map((day, index) => `${day} — ${weekCounts[index]}`).join(', ')}`}><span className="ac-eyebrow">УРОКИ НА ЭТОЙ НЕДЕЛЕ</span><div>{weekCounts.map((count, index) => <div key={days[index]}><span>{count}</span><i style={{ height: `${Math.max(4, count / maxCount * 66)}px` }} /><small>{days[index].slice(0, 2)}</small></div>)}</div></div>
          </Panel>
          <section className="ac-teacher-tip"><div className="ac-icon lilac"><BookOpen size={24} /></div><div><h2>Хороший урок начинается с подготовки</h2><p>Конспекты и материалы к вашим занятиям собраны в библиотеке.</p></div><button className="ac-btn ac-secondary" onClick={() => navigate('materials')}>Мои материалы<ArrowRight size={16} /></button></section>
        </aside>
      </div>
    </>
  }
  function Classes() { return <><div className="ac-page-heading"><div><h1>Мои классы</h1><p>Учебные группы, расписание и доступные списки учеников.</p></div><span className="ac-tag blue"><UsersRound size={15} />{classes.length} доступных классов</span></div><div className="ac-class-grid">{classes.map(name => { const students = state.students.filter(item => item.className === name), attendance = mean(students.map(item => item.attendance)), classAverage = mean(students.map(item => item.average)); return <article className="ac-card ac-class-card" key={name}><div className="ac-class-card-top"><span className="ac-class-letter">{name}</span><span className="ac-tag blue">{students.length} учеников</span></div><h2>{name} класс</h2><p>{state.schedule.filter(item => item.className === name).length} уроков в вашем расписании</p><div className="ac-class-metrics"><div><small>Средний балл</small><strong>{formatNumber(classAverage)}</strong></div><div><small>Посещаемость</small><strong>{attendance === null ? '—' : `${formatNumber(attendance)}%`}</strong></div></div><button className="ac-btn ac-secondary" data-ac-focus={`class-${name}`} onClick={() => openModal({ kind: 'class', name })}>Открыть список учеников<ChevronRight size={16} /></button></article> })}</div>{!classes.length && <Empty title="Нет назначенных классов" text="Классы появятся после назначения уроков." />}</> }

  const renderModal = () => {
    if (!modal) return null
    const title = modal.kind === 'material' ? modal.item.title : modal.kind === 'assignment' ? modal.item.title : modal.kind === 'review' ? 'Проверка работы' : modal.kind === 'absence' ? 'Сообщить об отсутствии' : modal.kind === 'class' ? `Ученики ${modal.name} класса` : 'Твой учебный маршрут'
    const errorBlock = error && <p className="ac-error" role="alert"><AlertCircle size={16} />{error}</p>
    const submitForm = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (modal.kind === 'assignment') { if (!answer.trim()) { setError('Добавьте ответ перед отправкой.'); return } void perform(`submit-${modal.item.id}`, `/api/assignments/${modal.item.id}/submit`, { answer: answer.trim() }, 'Ответ отправлен учителю', closeModal) }
      if (modal.kind === 'review') { if (!feedback.trim()) { setError('Добавьте комментарий для ученика.'); return } void perform(`review-${modal.item.id}`, `/api/assignments/${modal.item.id}/review`, { grade, feedback: feedback.trim() }, 'Оценка и комментарий сохранены', closeModal) }
      if (modal.kind === 'absence') { if (!reason.trim()) { setError('Укажите причину отсутствия.'); return } void perform('absence', '/api/replacements', { lessonId: modal.item.id, reason: reason.trim() }, 'Заявка на замену создана', () => { closeModal(); navigate('replacements') }) }
    }
    return <Modal title={title} onClose={closeModal} busy={Boolean(busy)} returnFocus={modalReturnFocus.current}>
      {modal.kind === 'material' && <div className="ac-modal-content"><div className="ac-modal-meta"><span className="ac-tag lilac">{modal.item.subject}</span><span>{modal.item.type}</span></div><div className="ac-material-text">{modal.item.content}</div><div className="ac-modal-footer"><button className="ac-btn ac-secondary" onClick={closeModal}>Закрыть</button><button className="ac-btn ac-primary" onClick={() => downloadMaterial(modal.item)}><Download size={16} />Скачать материал</button></div></div>}
      {(modal.kind === 'assignment' || modal.kind === 'review') && <form className="ac-modal-content" onSubmit={submitForm}><div className="ac-modal-meta"><span className="ac-tag lilac">{modal.item.subject}</span><span className="ac-tag blue">{statusLabels[modal.item.status]}</span><span><Clock3 size={14} />{modal.item.due}</span></div>{modal.kind === 'review' && <h3>{modal.item.title}</h3>}<p className="ac-assignment-description">{modal.item.description}</p>{modal.kind === 'assignment' ? modal.item.status === 'todo' ? <label className="ac-field">Твой ответ<textarea required minLength={1} maxLength={5000} rows={6} value={answer} onChange={event => setAnswer(event.target.value)} placeholder="Напиши решение или ответ на задание…" disabled={Boolean(busy)} /><span>До 5 000 символов. Ответ будет отправлен учителю.</span></label> : <div className="ac-answer-box"><strong>Твой ответ</strong><p>{modal.item.answer || 'Ответ не добавлен'}</p></div> : <><div className="ac-answer-box"><strong>Ответ ученика</strong><p>{modal.item.answer || 'Ученик ещё не отправил ответ.'}</p></div>{modal.item.status !== 'todo' && <><label className="ac-field">Оценка<select aria-label="Оценка" value={grade} onChange={event => setGrade(Number(event.target.value))} disabled={Boolean(busy)}>{[5, 4, 3, 2].map(value => <option value={value} key={value}>{value}</option>)}</select></label><label className="ac-field">Комментарий ученику<textarea required minLength={1} value={feedback} onChange={event => setFeedback(event.target.value)} rows={4} maxLength={1000} placeholder="Что получилось и что стоит повторить?" disabled={Boolean(busy)} /></label></>}</>}{modal.item.status === 'reviewed' && modal.kind === 'assignment' && <div className="ac-feedback-box"><span className="ac-grade good">{modal.item.grade}</span><div><strong>Комментарий учителя</strong><p>{modal.item.feedback || 'Учитель не добавил комментарий.'}</p></div></div>}{errorBlock}<div className="ac-modal-footer"><button type="button" className="ac-btn ac-secondary" onClick={closeModal} disabled={Boolean(busy)}>Закрыть</button>{modal.kind === 'assignment' && modal.item.status === 'todo' && <button className="ac-btn ac-primary" disabled={Boolean(busy) || !answer.trim()}><Send size={16} />{busy ? 'Отправляем…' : 'Отправить ответ'}</button>}{modal.kind === 'review' && modal.item.status !== 'todo' && <button className="ac-btn ac-primary" disabled={Boolean(busy)}><Check size={16} />{busy ? 'Сохраняем…' : 'Сохранить оценку'}</button>}</div></form>}
      {modal.kind === 'absence' && <form className="ac-modal-content" onSubmit={submitForm}><div className="ac-absence-summary"><CalendarDays size={22} /><div><strong>{modal.item.subject} · {modal.item.className}</strong><span>{lessonDay(modal.item.day)}, {modal.item.time} · кабинет {modal.item.room}</span></div></div><p className="ac-subtle">Школа получит заявку и подберёт учителя на замену.</p><label className="ac-field">Причина отсутствия<textarea required maxLength={500} rows={4} placeholder="Укажите причину, чтобы администратор мог оформить замену" value={reason} onChange={event => setReason(event.target.value)} disabled={Boolean(busy)} /></label>{errorBlock}<div className="ac-modal-footer"><button type="button" className="ac-btn ac-secondary" disabled={Boolean(busy)} onClick={closeModal}>Отмена</button><button className="ac-btn ac-primary" disabled={Boolean(busy) || !reason.trim()}>{busy ? 'Отправляем…' : 'Создать заявку'}<ArrowRight size={16} /></button></div></form>}
      {modal.kind === 'class' && <div className="ac-modal-content"><p className="ac-subtle">Доступные ученики и их текущие учебные показатели.</p><div className="ac-roster">{state.students.filter(item => item.className === modal.name).map(item => <div key={item.id}><span className="ac-avatar">{initials(item.name)}</span><div><strong>{item.name}</strong><small>Прогресс {item.progress}% · посещаемость {item.attendance}%</small></div><span className="ac-grade good">{formatNumber(item.average)}</span></div>)}</div>{!state.students.some(item => item.className === modal.name) && <Empty title="Список учеников пока пуст" text="Школа ещё не добавила доступных учеников этого класса." />}<div className="ac-modal-footer"><button className="ac-btn ac-secondary" onClick={closeModal}>Закрыть</button></div></div>}
      {modal.kind === 'catchup' && <div className="ac-modal-content"><p className="ac-subtle">Выбери тему, прочитай материал и закрепи знания заданием. Маршрут построен по доступным материалам.</p><ol className="ac-route-steps"><li><span>1</span><div><strong>Найди нужную тему</strong><p>Выбери материал, который хочешь повторить.</p></div></li><li><span>2</span><div><strong>Разберись в своём темпе</strong><p>Прочитай объяснение и сохрани конспект.</p></div></li><li><span>3</span><div><strong>Попробуй самостоятельно</strong><p>Открой задания и отправь ответ учителю.</p></div></li></ol><div className="ac-resource-list">{state.materials.slice(0, 3).map(item => <button key={item.id} data-ac-focus={`resource-${item.id}`} onClick={() => openModal({ kind: 'material', item })}>{subjectIcon(item.subject)}<span><strong>{item.title}</strong><small>{item.subject}</small></span><ChevronRight size={16} /></button>)}</div><div className="ac-modal-footer"><button className="ac-btn ac-secondary" onClick={() => { closeModal(); navigate('library') }}>Вся библиотека</button><button className="ac-btn ac-primary" onClick={() => { closeModal(); navigate('assignments') }}>К заданиям<ArrowRight size={16} /></button></div></div>}
    </Modal>
  }
  return <div className={`academic ${state.role === 'student' ? 'ac-view-student' : 'ac-view-teacher'}`}>{page === 'student-home' ? StudentHome() : page === 'my-lessons' ? Schedule() : page === 'assignments' ? Assignments({}) : page === 'grades' ? Grades() : page === 'progress' ? Progress() : page === 'library' ? Materials({}) : page === 'teacher-home' ? TeacherHome() : page === 'review' ? Assignments({ teacher: true }) : page === 'classes' ? Classes() : page === 'materials' ? Materials({ teacher: true }) : <Empty title="Раздел пока недоступен" text="Выберите доступную страницу в меню." />}{renderModal()}</div>
}
