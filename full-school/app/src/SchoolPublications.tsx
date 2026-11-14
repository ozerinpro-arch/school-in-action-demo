import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { RefreshCw, AlertCircle } from 'lucide-react'
import { publicationRequest, PublicationError, type PublicationStatus, type PublicationPreview, type PublicationArgs, type PublicationCommand, type PublicationReceipt, type PublishedLesson, type PublicationBlocker } from './school-publications-api'
import './school-publications.css'

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const roleLabels: Record<string, string> = { director: 'Директор', planner: 'Завуч' }
function Blockers({ rows }: { rows: PublicationBlocker[] }) { return rows.length ? <ul>{rows.map((row, index) => <li key={index}>{row.message}</li>)}</ul> : null }
function Lesson({ value }: { value: PublishedLesson | null }) {
 if (!value) return <span>Занятия нет</span>
 return <div className="sp-lesson"><strong>{value.className} · {days[value.day]} · {value.slot}</strong><span>{value.start}–{value.end} · {value.subject}</span><span>{value.teachers.join(', ')} · {value.rooms.join(', ') || 'Без кабинета'}</span></div>
}

export default function SchoolPublications() {
 const [data, setData] = useState<PublicationStatus | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
 const [error, setError] = useState(''), [runId, setRunId] = useState(''), [preview, setPreview] = useState<PublicationPreview | null>(null)
 const [previewArgs, setPreviewArgs] = useState<PublicationArgs | null>(null), [reviewed, setReviewed] = useState(false), [pending, setPending] = useState<PublicationCommand | null>(null), [receipt, setReceipt] = useState<PublicationReceipt | null>(null)
 const mounted = useRef(true), previewHeading = useRef<HTMLHeadingElement>(null), controllers = useRef(new Set<AbortController>())
 const load = useCallback(async () => {
  const controller = new AbortController(); controllers.current.add(controller)
  try { const result = await publicationRequest<PublicationStatus>('', undefined, controller.signal); if (mounted.current) { setData(result); setRunId(current => result.approvedRuns.some(row => row.runId === current) ? current : result.approvedRuns[0]?.runId ?? '') } }
  catch (cause) { if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить версии.') }
  finally { controllers.current.delete(controller); if (mounted.current) setLoading(false) }
 }, [])
 useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()) } }, [load])
 useEffect(() => { if (preview) previewHeading.current?.focus() }, [preview])
 const makePreview = async (event: FormEvent) => {
  event.preventDefault(); if (!data || !runId || pending) return
  setBusy(true); setError(''); setReceipt(null); setPreview(null); setReviewed(false)
  const args = { runId, expectedActiveVersion: data.activeVersion, expectedDraftRevision: data.draftRevision }
  const controller = new AbortController(); controllers.current.add(controller)
  try { const result = await publicationRequest<PublicationPreview>('/preview', args, controller.signal); if (mounted.current) { setPreview(result); setPreviewArgs(args) } }
  catch (cause) { if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось проверить кандидата.') }
  finally { controllers.current.delete(controller); if (mounted.current) setBusy(false) }
 }
 const publish = async () => {
  if (!data?.canManage) return
  const command = pending ?? (preview?.ready && preview.previewHash && reviewed && previewArgs ? { ...previewArgs, previewHash: preview.previewHash, requestId: 'publish_' + crypto.randomUUID().replaceAll('-', '') } : null)
  if (!command) return
  setPending(command); setBusy(true); setError('')
  const controller = new AbortController(); controllers.current.add(controller)
  try { const result = await publicationRequest<PublicationReceipt>('/publish', command, controller.signal); if (mounted.current) { setReceipt(result); setPending(null); setPreview(null); setReviewed(false); await load() } }
  catch (cause) {
   if (!controller.signal.aborted && mounted.current) {
    const status = cause instanceof PublicationError ? cause.status : 0
    setError(cause instanceof Error ? cause.message : 'Результат публикации не подтверждён.')
    if (status >= 400 && status < 500) { setPending(null); setPreview(null); setReviewed(false); await load() }
   }
  } finally { controllers.current.delete(controller); if (mounted.current) setBusy(false) }
 }
 const refresh = async () => { if (busy) return; setError(''); if (!pending) { setPreview(null); setReviewed(false) }; setLoading(true); await load() }
 return <div className="sp-page cp-stack">
  <header className="sg-page-header"><div><h1>Опубликованные версии</h1><p>Внутренняя версия школы хранится отдельно от редактируемого черновика.</p></div><button type="button" className="sg-control" aria-label="Обновить опубликованные версии" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={16}/><span>Обновить</span></button></header>
  {error && <div className="sg-settings-error" role="alert"><AlertCircle size={18}/><div><p>{error}</p>{pending && <p>Не создавайте новое действие. Повтор использует тот же идентификатор и восстановит исходную квитанцию, если версия уже записана.</p>}</div></div>}
  {loading && !data ? <section className="sg-panel" role="status">Загружаем опубликованные версии…</section> : !data ? <button type="button" className="sg-control" onClick={() => void refresh()}>Повторить загрузку</button> : <>
   <section className="sg-panel"><h2>Активная школьная версия</h2>{data.active ? <><p>Версия {data.active.version} · неделя {data.active.periodStart} · черновик {data.active.draftRevision} · занятий {data.active.lessons.length}</p><p>Опубликовано: <time dateTime={data.active.publishedAt}>{data.active.publishedAt}</time></p><details><summary>Состав активной версии</summary><div className="sp-lessons">{data.active.lessons.map(value => <Lesson key={value.id} value={value}/>)}</div></details></> : <p>Опубликованной версии пока нет. Учителя не получают черновик вместо неё.</p>}</section>
   <section className="sg-panel"><h2>Проверить и опубликовать</h2><p>Публикация требует подтверждённых нормативов и календаря, утверждённого расчёта и точного совпадения всей текущей сетки. Черновик при публикации не меняется.</p><Blockers rows={data.readiness.blockers}/>
    <form className="sg-settings-form" onSubmit={makePreview}><label className="sg-settings-field">Утверждённый расчёт<select className="sg-control sp-select" value={runId} disabled={busy || !!pending || !data.approvedRuns.length} onChange={event => { setRunId(event.target.value); setPreview(null); setReviewed(false) }}><option value="">Выберите расчёт</option>{data.approvedRuns.map(row => <option key={row.runId} value={row.runId}>Неделя {row.periodStart} · черновик {row.draftRevision} · нормативы {row.configRevision}</option>)}</select></label><p>Текущий черновик {data.draftRevision} · активная версия {data.activeVersion}</p><button className="sg-control" type="submit" disabled={busy || !!pending || !runId}>Полный предпросмотр публикации</button></form>
    {pending && <div className="sg-settings-conflict" role="status"><p>Результат действия пока не подтверждён. Идентификатор: <code>{pending.requestId}</code></p><button type="button" className="sg-control" disabled={busy} onClick={() => void publish()}>{busy ? 'Проверяем…' : 'Повторить и получить квитанцию'}</button></div>}
   </section>
   {preview && <section className="sg-panel"><h2 ref={previewHeading} tabIndex={-1}>Полный предпросмотр</h2><Blockers rows={preview.blockers}/>{preview.evidence && <><p>Неделя {preview.evidence.periodStart} · нормативы {preview.evidence.configRevision} · календарь {preview.evidence.calendarBinding.calendarRevision}</p><p>Источник: {preview.evidence.draftSourceName || 'Нормативный расчёт'} · утвердил {preview.evidence.approvedBy.displayName} ({roleLabels[preview.evidence.approvedBy.role] || 'Уполномоченный сотрудник'})</p><details><summary>Проверяемые ссылки и хеши</summary><dl className="sp-evidence">{Object.entries({ 'Расчёт': preview.evidence.runId, 'Квитанция согласования': preview.evidence.appliedTaskId, 'Утвердивший сотрудник': preview.evidence.approvedBy.userId, 'Хеш расчёта': preview.evidence.runHash, 'Нормативы': preview.evidence.normativeInputHash, 'Календарь': preview.evidence.calendarBinding.inputHash, 'Результирующая сетка': preview.evidence.materializedHash, 'Код независимого валидатора': preview.evidence.validatorSourceHash, 'Предпросмотр': preview.previewHash }).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details></>}
    <p>Изменений относительно активной версии: {preview.diff.length}. Показан весь список добавлений, удалений и изменений.</p><div className="sp-diff" tabIndex={0} role="region" aria-label="Полный список изменений публикации"><table><thead><tr><th>Изменение</th><th>Активная версия</th><th>Публикуемый черновик</th></tr></thead><tbody>{preview.diff.map((row, index) => <tr key={row.lessonId}><th scope="row">{index + 1}. {row.before === null ? 'Добавление' : row.after === null ? 'Удаление' : 'Правка'}</th><td><Lesson value={row.before}/></td><td><Lesson value={row.after}/></td></tr>)}</tbody></table></div>
    {preview.ready && data.canManage && <><label className="sp-check"><input type="checkbox" checked={reviewed} disabled={busy || !!pending} onChange={event => setReviewed(event.target.checked)}/>Проверены весь список изменений, период и источники. Подтверждаю внутреннюю школьную публикацию.</label><button type="button" className="sg-control" disabled={!reviewed || busy || !!pending} onClick={() => void publish()}>{busy ? 'Публикуем…' : 'Опубликовать внутреннюю версию'}</button></>}{!data.canManage && <p>У текущего доступа нет права публикации.</p>}
   </section>}
   {receipt && <section className="sg-panel" role="status"><h2>Версия {receipt.publication.version} опубликована</h2><p>{receipt.notice}</p><p>Идентификатор версии: {receipt.publication.publicationId}</p></section>}
   <section className="sg-panel"><h2>Внешняя доставка</h2><p>Доставка заблокирована. Сообщения не отправляются, подтверждения получения нет.</p><Blockers rows={data.deliveryReadiness.blockers}/></section>
   <section className="sg-panel"><h2>История школьных версий</h2><p>Всего {data.totalCount}. Показаны последние {Math.min(data.totalCount, data.historyLimit)}.</p>{data.history.length ? <ol>{data.history.map(row => <li key={row.id}>Версия {row.version} · черновик {row.draft_revision} · {row.created_at} · {row.actor_id}</li>)}</ol> : <p>История пуста.</p>}</section>
  </>}
 </div>
}
