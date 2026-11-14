import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Bell, BookOpen, Bot, CalendarDays, Check, ChevronDown, ClipboardCheck, FileSpreadsheet, GitBranch, History, LoaderCircle, MessageSquare, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Users, X } from 'lucide-react'
import { jsonBody, SchoolApiError, schoolRequest, useSchoolWorkspace, type SchoolWorkspace } from './school-ops-api'
import './school-automations.css'

type Status = 'ready' | 'setup' | 'idea'
type ScheduleAction = 'lesson' | 'planning' | 'text' | 'checks'
type Props = { navigate: (page: string) => void; openSchedule: (action: ScheduleAction, lessonId?: string) => void }
type ModelStatus = { modelConfigured: boolean; requestsEnabled: boolean; provider?: string }
type Automation = { id: string; title: string; description: string; status: Status; icon: typeof Bot; how: string; trigger: string; needs: string; limits: string; action?: { label: string; page?: string; schedule?: ScheduleAction } }
const labels: Record<Status, string> = { ready: 'Работает', setup: 'Нужна настройка / данные', idea: 'Предложение' }
const catalog: Automation[] = [
 { id: 'excel', title: 'Расписание из Excel', description: 'Проверить файл до импорта и перенести занятия в школьное расписание.', status: 'ready', icon: FileSpreadsheet, how: 'Сначала школа выбирает файл и смотрит результат разбора. Импорт выполняется отдельным действием.', trigger: 'Сотрудник школы в разделе «Расписание».', needs: 'Файл Excel с расписанием и проверенный предварительный просмотр.', limits: 'Загрузка не происходит сама. Неоднозначные ячейки и распределение групп нужно проверить.', action: { label: 'Открыть расписание', page: 'schedule' } },
 { id: 'conflicts', title: 'Проверка пересечений', description: 'Найти накладки у классов, учителей и кабинетов перед согласованием.', status: 'ready', icon: ShieldCheck, how: 'Проверка по правилам находит пересекающиеся занятия, пустые кабинеты и неоднозначности.', trigger: 'Сотрудник нажимает «Проверить расписание».', needs: 'Загруженные занятия с временем, классами, учителями и кабинетами.', limits: 'Проверка не исправляет расписание и не заменяет проверку всех учебных ограничений.', action: { label: 'Открыть проверку', schedule: 'checks' } },
 { id: 'approval', title: 'Правки через согласование', description: 'Сначала увидеть предложение, затем отдельно подтвердить изменение.', status: 'ready', icon: ClipboardCheck, how: 'Редактор готовит предложение. Школа проверяет его и принимает отдельным действием; версия сверяется повторно.', trigger: 'Сотрудник редактирует выбранный урок.', needs: 'Актуальная версия расписания и конкретная правка урока.', limits: 'Предложение не меняет урок автоматически. При изменении версии нужно проверить его заново.', action: { label: 'Открыть редактор', schedule: 'lesson' } },
 { id: 'history', title: 'История версий расписания', description: 'Вернуться к тому, какие изменения были внесены и согласованы.', status: 'ready', icon: History, how: 'Сохранённые изменения доступны в истории расписания для просмотра.', trigger: 'Сотрудник открывает историю расписания.', needs: 'Сохранённые версии расписания.', limits: 'Каталог не запускает восстановление версии. Решение о дальнейшей правке принимает школа.', action: { label: 'Открыть историю', page: 'history' } },
 { id: 'planning', title: 'Собрать вариант расписания', description: 'Движок расчёта готов. Перед запуском школа подтверждает учебный план и ограничения.', status: 'setup', icon: CalendarDays, how: 'После проверки готовности локальный расчёт ищет допустимый вариант. Его можно отправить на отдельное согласование.', trigger: 'Сотрудник запускает расчёт в планировании.', needs: 'Нагрузка, группы, интервалы, квалификации учителей, доступность, кабинеты, лимиты и связи с уроками.', limits: 'Полнота плана здесь не проверена. Сетка Excel сама по себе не подтверждает ограничения. Автозапуск не настроен.', action: { label: 'Проверить план', schedule: 'planning' } },
 { id: 'substitution', title: 'Подобрать учителя на замену', description: 'Предложить кандидатов с учётом предмета, доступности и нагрузки.', status: 'setup', icon: Users, how: 'Для выбранного урока проверяются кандидаты из подтверждённого плана. Выбор заполняет форму правки.', trigger: 'Сотрудник открывает урок и нажимает «Подобрать замену».', needs: 'Подтверждённый план, квалификации, доступность и однозначная связь исходного урока с нагрузкой.', limits: 'Наличие имён в справочнике не доказывает готовность подбора. Назначение проходит отдельное согласование.', action: { label: 'Выбрать урок', schedule: 'lesson' } },
 { id: 'text', title: 'Изменить расписание словами', description: 'Описать нужную правку и разобрать предложение до применения.', status: 'setup', icon: MessageSquare, how: 'Текстовый помощник уточняет запрос и готовит структурированное предложение для согласования.', trigger: 'Сотрудник отправляет запрос в текстовом помощнике.', needs: 'Для свободного текста — подключённый NanoGPT и разрешённые внешние запросы.', limits: 'Модель не применяет изменение сама. Локальные точные команды могут работать и без модели.', action: { label: 'Открыть помощника', schedule: 'text' } },
 { id: 'morning', title: 'Утренняя проверка учебного дня', description: 'Перед первым уроком собрать накладки и вопросы, которые требуют внимания.', status: 'idea', icon: Sparkles, how: 'Можно добавить запуск проверки по времени и сводку для ответственного сотрудника.', trigger: 'Нужно определить время проверки и ответственного.', needs: 'Актуальное расписание, учебный календарь, часовой пояс и правила сводки.', limits: 'Периодический запуск и утренняя сводка пока не реализованы.' },
 { id: 'absence', title: 'Если учитель заболел', description: 'Связать отметку об отсутствии, подбор замены и решение завуча в один сценарий.', status: 'idea', icon: GitBranch, how: 'Можно находить затронутые уроки после отметки об отсутствии и готовить предложения для завуча.', trigger: 'Нужно согласовать, кто отмечает отсутствие и кто принимает замену.', needs: 'Учёт отсутствий, подтверждённые квалификации и доступность, правила согласования.', limits: 'Отдельные инструменты уже есть. Сквозной автоматический сценарий ещё не связан.' },
 { id: 'reminders', title: 'Напомнить о школьных задачах', description: 'Подсказать ответственному, что подходит срок подготовки или согласования.', status: 'idea', icon: Bell, how: 'Можно проверять сроки задач и формировать напоминания по согласованным правилам.', trigger: 'Нужно выбрать время, получателей и канал.', needs: 'Сроки и ответственные в задачах, правила повторов и выбранный канал доставки.', limits: 'Журнал уведомлений хранит записи. Автоматические напоминания и доставка не подключены.' },
 { id: 'materials', title: 'Подготовить материалы к уроку', description: 'Получать черновик объяснения или задания с проверкой учителем.', status: 'setup', icon: BookOpen, how: 'В личном кабинете учителя можно готовить черновик по теме, возрасту класса и целям урока, затем сохранять после проверки.', trigger: 'Учитель выбирает тему и подтверждает результат.', needs: 'Тема, класс, цели урока, требования к материалу и согласованное подключение модели.', limits: 'Личная подготовка доступна в кабинете учителя. Генерация требует включённого подключения ИИ; текст проверяет учитель. Общий раздел «Материалы» хранит записи отдельно.' },
 { id: 'max', title: 'Сообщить об изменении в MAX', description: 'После согласования расписания отправлять нужное сообщение выбранным получателям.', status: 'idea', icon: Bot, how: 'Можно добавить отдельную доставку сообщения о подтверждённом изменении.', trigger: 'Нужно определить событие отправки и проверку получателей.', needs: 'Подключение MAX, разрешение на отправку, получатели и согласованный шаблон.', limits: 'MAX не подключён. Ни добавление в план, ни запись в журнале уведомлений не отправляют сообщение.' },
]
const taskTitle = (item: Automation) => `Автоматизация: ${item.title}`
const hasTask = (workspace: SchoolWorkspace | null, item: Automation) => workspace?.records.tasks.some(task => !task.archived && task.title === taskTitle(item)) ?? false

export default function SchoolAutomations({ navigate, openSchedule }: Props) {
 const { data, loading, error, reload } = useSchoolWorkspace()
 const [model, setModel] = useState<ModelStatus | null>(null), [modelLoading, setModelLoading] = useState(true), [modelError, setModelError] = useState('')
 const [filter, setFilter] = useState<Status | 'all'>('all'), [query, setQuery] = useState(''), [expanded, setExpanded] = useState<string | null>(null)
 const [saving, setSaving] = useState<string | null>(null), [saved, setSaved] = useState<Set<string>>(new Set()), [feedback, setFeedback] = useState<{ id: string; message: string; error?: boolean; uncertain?: boolean } | null>(null)
 const [review, setReview] = useState<string | null>(null), [refreshing, setRefreshing] = useState(false)
 const lock = useRef(false), alive = useRef(true), modelController = useRef<AbortController | null>(null)
 const loadModel = useCallback(async () => {
  modelController.current?.abort()
  const controller = new AbortController(); modelController.current = controller
  setModelLoading(true); setModelError(''); setModel(null)
  try {
   const result = await schoolRequest<ModelStatus>('/api/schedule-agent/status', { signal: controller.signal })
   if (typeof result?.modelConfigured !== 'boolean' || typeof result?.requestsEnabled !== 'boolean') throw new Error('Ответ о подключении не удалось прочитать.')
   if (!controller.signal.aborted) setModel(result)
  } catch (cause) { if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : 'Не удалось проверить подключение.') }
  finally { if (!controller.signal.aborted) setModelLoading(false) }
 }, [])
 useEffect(() => { alive.current = true; void loadModel(); return () => { alive.current = false; modelController.current?.abort() } }, [loadModel])
 const items = catalog.map(item => item.id === 'text' && model?.modelConfigured && model.requestsEnabled && model.provider === 'nanogpt' ? { ...item, status: 'ready' as Status } : item)
 const counts = { ready: items.filter(item => item.status === 'ready').length, setup: items.filter(item => item.status === 'setup').length, idea: items.filter(item => item.status === 'idea').length }
 const normalizedQuery = query.trim().toLocaleLowerCase('ru')
 const visible = items.filter(item => (filter === 'all' || item.status === filter) && `${item.title} ${item.description} ${item.needs}`.toLocaleLowerCase('ru').includes(normalizedQuery))
 async function addToPlan(item: Automation) {
  if (!data || loading || lock.current || saved.has(item.id) || hasTask(data, item)) return
  lock.current = true; setSaving(item.id); setFeedback(null)
  try {
   const result = await schoolRequest<{ revision: number; record: { id: string; title: string } }>('/api/school/records/tasks', jsonBody({ expectedRevision: data.revision, record: { title: taskTitle(item), description: `Идея автоматизации школы.\n\nКак работает: ${item.how}\nКто запускает: ${item.trigger}\nЧто нужно: ${item.needs}\nОграничения: ${item.limits}\n\nСогласовать требования, ответственного и способ реализации. Создание задачи не запускает автоматизацию.`, status: 'todo', due: '', owner: '' } }))
   if (!result?.record?.id || !Number.isInteger(result.revision)) throw new SchoolApiError('Не удалось подтвердить сохранение задачи.', 0)
   if (!alive.current) return
   setSaved(previous => new Set(previous).add(item.id)); setReview(null)
   setFeedback({ id: item.id, message: 'Идея сохранена в задачах. Автоматизация не запущена.' })
   await reload()
   window.dispatchEvent(new Event('school-ops-updated'))
  } catch (cause) {
   if (!alive.current) return
   const fresh = await reload()
   if (!alive.current) return
   if (hasTask(fresh, item)) {
    setSaved(previous => new Set(previous).add(item.id)); setReview(null)
    setFeedback({ id: item.id, message: 'Идея уже есть в задачах. Повторная задача не создана.' })
   } else if (cause instanceof SchoolApiError && cause.status === 409) {
    setReview(item.id)
    setFeedback({ id: item.id, error: true, uncertain: !fresh, message: fresh ? 'Данные изменились. Версия обновлена, выбранная идея сохранена. Проверьте её и нажмите «Добавить повторно».' : 'Данные изменились. Выбранная идея сохранена. Обновите данные перед повторным добавлением.' })
   } else {
    const uncertain = !(cause instanceof SchoolApiError) || cause.status === 0
    setReview(uncertain ? item.id : null)
    setFeedback({ id: item.id, error: true, uncertain, message: uncertain ? 'Не удалось подтвердить сохранение. Проверьте задачи перед повтором, чтобы не создать дубликат.' : cause instanceof Error ? cause.message : 'Не удалось добавить идею в задачи.' })
   }
  } finally { lock.current = false; if (alive.current) setSaving(null) }
 }
 async function verifySave(item: Automation) {
  if (refreshing || lock.current) return
  setRefreshing(true)
  const fresh = await reload()
  if (alive.current) {
   if (hasTask(fresh, item)) { setSaved(previous => new Set(previous).add(item.id)); setReview(null); setFeedback({ id: item.id, message: 'Идея найдена в задачах. Повторная задача не создана.' }) }
   else if (fresh) setFeedback({ id: item.id, error: true, message: 'В актуальном списке такой задачи нет. Можно явно добавить идею повторно.' })
   setRefreshing(false)
  }
 }
 const act = (item: Automation) => { if (item.action?.schedule) openSchedule(item.action.schedule); else if (item.action?.page) navigate(item.action.page) }
 return <div className="sa-root">
  <header className="sa-heading"><img src={`${import.meta.env.BASE_URL}assets/school-automation-glass.png`} alt="" width="88" height="88" onError={event => { event.currentTarget.style.visibility = 'hidden' }} /><div><p className="sa-eyebrow">Меньше рутины — больше времени на школу</p><h1>Автоматизации школы</h1><p>Что уже помогает в работе, что требует данных и что можно сделать следующим.</p></div><button className="sa-icon-button" aria-label="Обновить данные автоматизаций" disabled={loading || modelLoading || !!saving} onClick={() => { void reload(); void loadModel() }}><RefreshCw size={18} className={loading || modelLoading ? 'sa-spin' : ''} /></button></header>
  <div className="sa-summary" aria-label="Возможности школы">{(['ready', 'setup', 'idea'] as Status[]).map(status => <div className={`sa-summary-item sa-${status}`} key={status}><span className="sa-summary-icon" aria-hidden="true">{status === 'ready' ? <Check size={18} /> : status === 'setup' ? <SlidersHorizontal size={18} /> : <Sparkles size={18} />}</span><div><strong>{counts[status]}</strong><span>{labels[status]}</span></div></div>)}</div>
  <p className="sa-status-note"><ShieldCheck size={15} aria-hidden="true" />«Работает» — инструмент доступен по нажатию. Самостоятельных запусков по времени здесь нет.</p>
  {(error || (loading && !data)) && <div className={`sa-notice ${error ? 'sa-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <AlertCircle size={18} /> : <LoaderCircle size={18} className="sa-spin" />}<div><p>{error || 'Загружаем школьные данные и сохранённые идеи…'}</p>{error && <button className="sa-text-button" disabled={loading || !!saving} onClick={() => void reload()}>Повторить загрузку</button>}</div></div>}
  <div className="sa-toolbar"><div className="sa-filters" role="group" aria-label="Статус автоматизации">{(['all', 'ready', 'setup', 'idea'] as const).map(status => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status === 'all' ? 'Все' : status === 'setup' ? 'Нужны данные' : status === 'idea' ? 'Предложения' : labels[status]}<span>{status === 'all' ? items.length : counts[status]}</span></button>)}</div><label className="sa-search"><Search size={16} aria-hidden="true" /><span className="sa-sr-only">Найти автоматизацию</span><input type="search" placeholder="Найти сценарий…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={16} /></button>}</label></div>
  <div className="sa-results-head"><h2>{filter === 'all' ? 'Инструменты и идеи' : labels[filter]}</h2><span aria-live="polite">Найдено: {visible.length}</span></div>
  <section className="sa-grid cp-grid" aria-label="Каталог автоматизаций">{visible.map(item => {
   const Icon = item.icon, inPlan = saved.has(item.id) || hasTask(data, item), open = expanded === item.id, itemFeedback = feedback?.id === item.id ? feedback : null
   const needsVerification = !!itemFeedback?.uncertain, isReview = review === item.id
   return <article className={`sa-card sa-card-${item.status}`} key={item.id} aria-labelledby={`sa-title-${item.id}`}>
    <div className="sa-card-top"><span className="sa-medallion" aria-hidden="true"><Icon size={20} /></span><span className={`sa-badge sa-${item.status}`}><span />{labels[item.status]}</span></div>
    <h3 id={`sa-title-${item.id}`}>{item.title}</h3><p className="sa-description">{item.description}</p>
    {item.id === 'text' && <div className="sa-runtime">{modelLoading ? <span role="status"><LoaderCircle size={13} className="sa-spin" />Проверяем подключение…</span> : modelError ? <><span>Подключение не проверено.</span><button className="sa-text-button" onClick={() => void loadModel()}>Проверить снова</button></> : <span>{model?.provider === 'injected_test_model' ? 'Подключена тестовая модель; свободный текст не подтверждён.' : model?.modelConfigured && model.requestsEnabled ? 'Модель подключена · запрос запускает сотрудник' : model?.modelConfigured ? 'Модель настроена · внешние запросы выключены' : 'NanoGPT не подключён · доступны локальные команды'}</span>}</div>}
    <div className="sa-card-actions"><button className="sa-details-button" aria-expanded={open} aria-controls={`sa-details-${item.id}`} onClick={() => setExpanded(open ? null : item.id)}>Как это работает<ChevronDown size={15} className={open ? 'sa-rotated' : ''} /></button>{item.action ? <button className="sa-action" onClick={() => act(item)}>{item.action.label}<ArrowRight size={15} /></button> : inPlan ? <button className="sa-action sa-in-plan" onClick={() => navigate('tasks')}><Check size={15} />В задачах<ArrowRight size={15} /></button> : <button className="sa-action" disabled={!data || loading || !!saving || needsVerification} onClick={() => void addToPlan(item)}>{saving === item.id ? <LoaderCircle size={15} className="sa-spin" /> : <Plus size={15} />}{saving === item.id ? 'Сохраняем…' : isReview ? 'Добавить повторно' : 'Добавить в план'}</button>}</div>
    <div id={`sa-details-${item.id}`} hidden={!open} className="sa-details"><dl><div><dt>Как работает</dt><dd>{item.how}</dd></div><div><dt>Кто запускает</dt><dd>{item.trigger}</dd></div><div><dt>Что нужно</dt><dd>{item.needs}</dd></div><div><dt>Ограничения</dt><dd>{item.limits}</dd></div></dl>{item.status === 'idea' && <p className="sa-detail-note">«Добавить в план» создаёт школьную задачу. Срок и ответственного можно назначить в задачах.</p>}</div>
    {itemFeedback && <div className={`sa-card-feedback ${itemFeedback.error ? 'sa-error' : ''}`} role={itemFeedback.error ? 'alert' : 'status'}><p>{itemFeedback.message}</p>{!itemFeedback.error ? <button className="sa-text-button" onClick={() => navigate('tasks')}>Открыть задачи<ArrowRight size={14} /></button> : itemFeedback.uncertain ? <><button className="sa-text-button" disabled={refreshing || loading} onClick={() => void verifySave(item)}>{refreshing ? 'Проверяем…' : 'Обновить и проверить задачи'}</button><button className="sa-text-button" onClick={() => navigate('tasks')}>Открыть задачи<ArrowRight size={14} /></button></> : null}</div>}
   </article>
  })}</section>
  {!visible.length && <div className="sa-empty"><Search size={26} /><h3>Такой сценарий не найден</h3><p>Попробуйте другое название или снимите фильтр статуса.</p><button className="sa-action" onClick={() => { setQuery(''); setFilter('all') }}>Показать все сценарии</button></div>}
  <footer className="sa-footer"><Check size={15} />Идеи сохраняются в школьных задачах. Подключения и запуск согласуются отдельно.</footer>
 </div>
}
