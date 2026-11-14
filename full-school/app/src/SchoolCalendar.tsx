import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CalendarDays, RefreshCw, Plus, AlertCircle } from 'lucide-react'
import { calendarRequest, CalendarError, type CalendarData, type CalendarKind, type CalendarRecord, type CalendarConfig, type CalendarPreview, type CalendarEffective } from './school-calendar-api'
import './school-calendar.css'

const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
const titles: Record<CalendarKind, string> = { weeks: 'Учебные недели', days: 'Отдельные дни', exceptions: 'Исключения', rules: 'Конечные повторения' }
const kinds = Object.keys(titles) as CalendarKind[]
const types = { school: 'Учебный день', closed: 'Неучебный день', teacher_unavailable: 'Недоступность учителя', room_unavailable: 'Недоступность кабинета' }
function ErrorNotice({ error, children }: { error: string; children?: ReactNode }) { return error ? <div className="sg-settings-error" role="alert"><AlertCircle size={18}/><div><p>{error}</p>{children}</div></div> : null }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="sg-settings-field">{label}{children}</label> }
function ChoiceDays({ value, change, legend }: { value: number[]; change: (days: number[]) => void; legend: string }) { return <fieldset className="sc-days"><legend>{legend}</legend>{dayNames.map((name, day) => <label key={day}><input type="checkbox" checked={value.includes(day)} onChange={event => change(event.target.checked ? [...value, day].sort() : value.filter(item => item !== day))}/>{name}</label>)}</fieldset> }
function RecordSummary({ row, kind }: { row: CalendarRecord; kind: CalendarKind }) {
 const text = (key: string) => typeof row[key] === 'string' ? row[key] as string : ''
 if (kind === 'weeks') return <>{text('weekStart')}{text('type') && ` · Тип ${text('type')}`} · {(row.schoolDays as number[]).map(day => dayNames[day]).join(', ') || 'Нет учебных дней'}</>
 if (kind === 'days') return <>{text('date')} · {types[text('status') as keyof typeof types]}</>
 return <>{text('startDate')} — {text('endDate')} · {types[text('kind') as keyof typeof types]}{text('targetId') && ` · ${text('targetId')}`}{text('startTime') && ` · ${text('startTime')}–${text('endTime')}`}</>
}

function ConfigForm({ data, reload }: { data: CalendarData; reload: () => Promise<CalendarData | null> }) {
 const initial = (config: CalendarConfig | null): CalendarConfig => config ? { ...config, bells: (config.bells ?? []).map(bell => ({ ...bell })) } : { timezone: '', periodStart: '', periodEnd: '', source: '', confirmed: false, note: '', requiresTravel: false, bells: [] }
 const [value, setValue] = useState<CalendarConfig>(() => initial(data.config))
 const [revision, setRevision] = useState(data.revision), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false)
 const request = useRef<AbortController | null>(null)
 useEffect(() => () => request.current?.abort(), [])
 useEffect(() => { if (!dirty && data.revision >= revision) { setRevision(data.revision); setValue(initial(data.config)) } }, [data.config, data.revision, dirty, revision])
 const change = (patch: Partial<CalendarConfig>, confirmation = false) => { setValue(previous => ({ ...previous, ...patch, ...(!confirmation ? { confirmed: false } : {}) })); setDirty(true); setSaved(false) }
 const bells = value.bells ?? []
 const bellChange = (index: number, patch: Partial<NonNullable<CalendarConfig['bells']>[number]>) => change({ bells: bells.map((bell, current) => current === index ? { ...bell, ...patch } : bell) })
 const submit = async (event: FormEvent) => {
  event.preventDefault(); setError(''); setBusy(true); setSaved(false)
  const controller = new AbortController(); request.current = controller
  try { const result = await calendarRequest<CalendarData>('/config', { expectedRevision: revision, config: value }, 'PATCH', controller.signal); setValue(initial(result.config)); setRevision(result.revision); setDirty(false); setConflict(false); setSaved(true); await reload() }
  catch (cause) { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройки.'); setConflict(cause instanceof CalendarError && cause.status === 409) } }
  finally { if (!controller.signal.aborted) setBusy(false) }
 }
 return <section className="sg-panel"><h2>Период и часовой пояс</h2><p>Пустой календарь не предполагает учебную неделю или праздники. Период — не более 366 дней.</p><form className="sg-settings-form sc-form" onSubmit={submit}>
  <fieldset disabled={busy} className="sc-fields"><Field label="Часовой пояс IANA"><input required aria-label="Часовой пояс IANA" value={value.timezone} onChange={event => change({ timezone: event.target.value })} placeholder="Выберите, например Europe/Moscow"/></Field>
   <Field label="Начало календарного периода"><input type="date" required value={value.periodStart} onChange={event => change({ periodStart: event.target.value })}/></Field>
   <Field label="Конец календарного периода"><input type="date" required min={value.periodStart || undefined} value={value.periodEnd} onChange={event => change({ periodEnd: event.target.value })}/></Field>
   <Field label="Источник параметров календаря"><input required maxLength={500} value={value.source ?? ''} onChange={event => change({ source: event.target.value })}/></Field>
   <Field label="Примечание"><textarea aria-label="Примечание" value={value.note ?? ''} maxLength={2000} onChange={event => change({ note: event.target.value })}/></Field>
   <div style={{ gridColumn: '1 / -1', minWidth: 0 }}><h3>Расписание звонков</h3><p>Введите подтверждённые времена для каждого учебного дня, включая субботу. Если звонки не заданы, сохраняются времена слотов в условиях планирования.</p>
    {bells.length > 0 ? <div role="region" aria-label="Прокручиваемая таблица звонков" tabIndex={0} style={{ overflowX: 'auto' }}><table aria-label="Расписание звонков" style={{ width: '100%', borderSpacing: '0 8px' }}><thead><tr><th scope="col">День</th><th scope="col">Урок</th><th scope="col">Начало</th><th scope="col">Конец</th><th scope="col">Действия</th></tr></thead><tbody>{bells.map((bell, index) => <tr key={index}>
     <td><select className="sg-control" aria-label={`День звонка ${index + 1}`} value={bell.day} onChange={event => bellChange(index, { day: Number(event.target.value) })}>{dayNames.slice(0, 6).map((day, number) => <option value={number} key={day}>{day}</option>)}</select></td>
     <td><input aria-label={`Номер урока звонка ${index + 1}`} type="number" min={1} max={20} required value={bell.slot} onChange={event => bellChange(index, { slot: Number(event.target.value) })} style={{ minWidth: 70 }}/></td>
     <td><input aria-label={`Начало звонка ${index + 1}`} type="time" required value={bell.start} onChange={event => bellChange(index, { start: event.target.value })} style={{ minWidth: 110 }}/></td>
     <td><input aria-label={`Конец звонка ${index + 1}`} type="time" required value={bell.end} onChange={event => bellChange(index, { end: event.target.value })} style={{ minWidth: 110 }}/></td>
     <td><button type="button" className="sg-control" aria-label={`Удалить звонок ${index + 1}`} onClick={() => change({ bells: bells.filter((_, current) => current !== index) })}>Удалить</button></td>
    </tr>)}</tbody></table></div> : <p>Звонки пока не заданы.</p>}
    <button type="button" className="sg-control" disabled={bells.length >= 100} onClick={() => change({ bells: [...bells, { day: 0, slot: 1, start: '', end: '' }] })}><Plus size={16}/>Добавить звонок</button>
   </div>
   <label className="sc-check"><input type="checkbox" checked={value.requiresTravel} onChange={event => change({ requiresTravel: event.target.checked })}/>Нужны правила переходов между корпусами (решатель пока их не поддерживает)</label>
   <label className="sc-check"><input type="checkbox" checked={value.confirmed} onChange={event => change({ confirmed: event.target.checked }, true)}/>Параметры календаря и звонки подтверждены по указанному источнику</label>
  </fieldset>
  <ErrorNotice error={error}>{conflict && <button type="button" className="sg-control" onClick={async () => { const latest = await reload(); if (latest) { setRevision(latest.revision); change({ confirmed: false }, true); setError('Версия обновлена. Ваши поля сохранены; проверьте и подтвердите их перед повторным сохранением.'); setConflict(false) } }}>Обновить версию, сохранив ввод</button>}</ErrorNotice>
  <div className="sg-settings-actions"><button className="sg-control" disabled={busy} type="submit">{busy ? 'Сохраняем…' : 'Сохранить параметры календаря'}</button><span className="sg-settings-status" role="status">{saved ? `Сохранено · версия ${revision}` : `Версия формы ${revision}`}</span></div>
 </form></section>
}

function RecordEditor({ kind, row, restoring, revision: initialRevision, reload, close }: { kind: CalendarKind; row?: CalendarRecord; restoring?: boolean; revision: number; reload: () => Promise<CalendarData | null>; close: () => void }) {
 const initial = () => ({ weekStart: '', type: '', schoolDays: [] as number[], date: '', status: 'closed', startDate: '', endDate: '', weekdays: [] as number[], kind: 'closed', targetId: '', startTime: '', endTime: '', source: '', note: '', confirmed: false, ...row })
 const [value, setValue] = useState(initial), [revision, setRevision] = useState(initialRevision), [preview, setPreview] = useState<CalendarPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false)
 const request = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null)
 useEffect(() => { const previous = document.activeElement as HTMLElement; heading.current?.focus(); return () => { request.current?.abort(); previous?.isConnected && previous.focus() } }, [])
 const change = (patch: Record<string, unknown>, confirmation = false) => { setValue(previous => ({ ...previous, ...patch, ...(!confirmation ? { confirmed: false } : {}) })); setPreview(null) }
 const payload = () => {
  const base = { source: value.source, note: value.note, confirmed: value.confirmed }
  if (kind === 'weeks') return { ...base, weekStart: value.weekStart, schoolDays: value.schoolDays, type: value.type }
  if (kind === 'days') return { ...base, date: value.date, status: value.status }
  const resource = String(value.kind).endsWith('_unavailable')
  return { ...base, startDate: value.startDate, endDate: value.endDate, kind: value.kind, targetId: resource ? value.targetId : '', startTime: resource && value.startTime ? value.startTime : null, endTime: resource && value.endTime ? value.endTime : null, ...(kind === 'rules' ? { weekdays: value.weekdays } : {}) }
 }
 const execute = async (action: 'preview' | 'save') => {
  setBusy(true); setError(''); setConflict(false); const controller = new AbortController(); request.current = controller
  try {
   if (action === 'preview') { setPreview(await calendarRequest<CalendarPreview>('/preview', { expectedRevision: revision, record: payload(), ...(row ? { recordId: row.id } : {}) }, 'POST', controller.signal)); return }
   const body = { expectedRevision: revision, record: payload(), ...(preview ? { previewHash: preview.previewHash } : {}) }
   if (restoring && row) await calendarRequest(`/records/${kind}/${row.id}/restore`, { expectedRevision: revision, ...(preview ? { previewHash: preview.previewHash } : {}) }, 'POST', controller.signal)
   else await calendarRequest(`/records/${kind}${row ? '/' + row.id : ''}`, body, row ? 'PATCH' : 'POST', controller.signal)
   await reload(); close()
  } catch (cause) { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить запись.'); setConflict(cause instanceof CalendarError && cause.status === 409) } }
  finally { if (!controller.signal.aborted) setBusy(false) }
 }
 return <section className="sg-panel" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); close() } }}><h2 ref={heading} tabIndex={-1}>{restoring ? 'Восстановить запись' : row ? 'Изменить запись' : 'Новая запись'} · {titles[kind]}</h2><form className="sg-settings-form sc-form" onSubmit={event => { event.preventDefault(); void execute('save') }}>
  <fieldset disabled={busy || restoring} className="sc-fields">
   {kind === 'weeks' ? <><Field label="Понедельник учебной недели"><input type="date" required value={String(value.weekStart)} onChange={event => change({ weekStart: event.target.value })}/></Field><Field label="Тип недели"><input aria-label="Тип недели" maxLength={80} value={String(value.type)} onChange={event => change({ type: event.target.value })} placeholder="A, B или принятая в школе метка"/><small>Указывается явно для чередования нагрузки.</small></Field><ChoiceDays legend="Учебные дни этой недели" value={value.schoolDays as number[]} change={schoolDays => change({ schoolDays })}/></> : kind === 'days' ? <><Field label="Дата отдельного дня"><input type="date" required value={String(value.date)} onChange={event => change({ date: event.target.value })}/></Field><Field label="Статус дня"><select className="sg-control" value={String(value.status)} onChange={event => change({ status: event.target.value })}><option value="school">Учебный</option><option value="closed">Неучебный</option></select></Field></> : <>
    <Field label="Первая дата"><input type="date" required value={String(value.startDate)} onChange={event => change({ startDate: event.target.value })}/></Field><Field label="Последняя дата (включительно)"><input type="date" required min={String(value.startDate) || undefined} value={String(value.endDate)} onChange={event => change({ endDate: event.target.value })}/></Field>
    {kind === 'rules' && <ChoiceDays legend="Дни конечного повторения" value={value.weekdays as number[]} change={weekdays => change({ weekdays })}/>}
    <Field label="Действие календаря"><select className="sg-control" value={String(value.kind)} onChange={event => change({ kind: event.target.value })}>{Object.entries(types).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
    {String(value.kind).endsWith('_unavailable') && <><Field label="Точный ID из нормативной модели"><input required maxLength={160} value={String(value.targetId)} onChange={event => change({ targetId: event.target.value })}/></Field><Field label="Начало недоступности (пусто — весь день)"><input type="time" value={value.startTime ? String(value.startTime) : ''} onChange={event => change({ startTime: event.target.value })}/></Field><Field label="Конец недоступности"><input type="time" value={value.endTime ? String(value.endTime) : ''} onChange={event => change({ endTime: event.target.value })}/></Field></>}
   </>}
   <Field label="Источник записи"><input required maxLength={500} value={String(value.source ?? '')} onChange={event => change({ source: event.target.value })}/></Field><Field label="Примечание к записи"><textarea aria-label="Примечание к записи" maxLength={2000} value={String(value.note ?? '')} onChange={event => change({ note: event.target.value })}/></Field>
   <label className="sc-check"><input type="checkbox" checked={Boolean(value.confirmed)} onChange={event => change({ confirmed: event.target.checked }, true)}/>Сведения подтверждены по указанному источнику</label>
  </fieldset>
  {preview && <div className="sg-settings-conflict" role="status"><strong>Предпросмотр: {preview.occurrenceCount} вхождений · версия {preview.calendarRevision}</strong><ol className="sc-preview">{preview.occurrences.map((item, index) => <li key={index}>{item.date}{item.startTime && ` · ${item.startTime}–${item.endTime}`}</li>)}</ol><p>Предпросмотр не сохраняет правило. Подтвердите запись отдельной кнопкой.</p></div>}
  <ErrorNotice error={error}>{conflict && <button className="sg-control" type="button" onClick={async () => { const latest = await reload(); if (latest) { setRevision(latest.revision); if (!restoring) change({ confirmed: false }, true); setPreview(null); setConflict(false); setError('Версия обновлена, ваши поля сохранены. Проверьте и подтвердите их; для повторений нужен новый предпросмотр.') } }}>Обновить версию, сохранив ввод</button>}</ErrorNotice>
  <div className="sg-settings-actions">{kind === 'rules' && <button type="button" className="sg-control" disabled={busy} onClick={() => void execute('preview')}>Показать повторения</button>}<button className="sg-control" type="submit" disabled={busy || (kind === 'rules' && !preview)}>{busy ? 'Сохраняем…' : restoring ? 'Восстановить запись' : 'Сохранить календарную запись'}</button><button className="sg-control" type="button" disabled={busy} onClick={close}>Отмена</button></div>
 </form></section>
}

function EffectiveWeek({ revision }: { revision: number }) {
 const [week, setWeek] = useState(''), [data, setData] = useState<CalendarEffective | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
 const request = useRef<AbortController | null>(null)
 useEffect(() => () => request.current?.abort(), [])
 useEffect(() => { if (data && data.calendarRevision !== revision) { setData(null); setError('Календарь изменился. Повторите проверку снимка недели.') } }, [revision, data])
 const load = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); setData(null); const controller = new AbortController(); request.current = controller; try { setData(await calendarRequest<CalendarEffective>('/effective?weekStart=' + encodeURIComponent(week), undefined, 'GET', controller.signal)) } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось проверить неделю.') } finally { if (!controller.signal.aborted) setBusy(false) } }
 return <section className="sg-panel"><h2>Проверить календарь недели</h2><form className="sg-settings-form sc-form" onSubmit={load}><Field label="Понедельник проверяемой недели"><input type="date" required value={week} onChange={event => { setWeek(event.target.value); setData(null) }}/></Field><button className="sg-control" disabled={busy}>{busy ? 'Проверяем…' : 'Показать снимок недели'}</button></form><ErrorNotice error={error}/>{data && <div className="sc-effective"><p>Календарь: версия {data.calendarRevision} · {data.timezone || 'Часовой пояс не задан'}{data.weekType && ` · Тип ${data.weekType}`}{data.bells?.length ? ` · Звонков: ${data.bells.length}` : ''}</p>{data.readiness.blockers.length > 0 ? <ul>{data.readiness.blockers.map(item => <li key={item.code}><strong>{item.code}</strong>: {item.message}</li>)}</ul> : <p role="status">Календарные даты подтверждены. Нормативный план и кандидат проверяются отдельно.</p>}<ol>{data.days.map(day => <li key={day.date}>{day.date} · {dayNames[day.weekday]} · {day.status === 'school' ? 'Учебный' : day.status === 'closed' ? 'Неучебный' : 'Не задан'}</li>)}</ol>{data.unavailable.length > 0 && <><h3>Интервалы недоступности</h3><ul>{data.unavailable.map((row, index) => <li key={index}>{row.date} · {row.targetId} · {row.startTime ? `${row.startTime}–${row.endTime}` : 'Весь день'}</li>)}</ul></>}<p>{data.notice}</p></div>}</section>
}

function ResolveDate() {
 const [expression, setExpression] = useState(''), [timestamp, setTimestamp] = useState(''), [result, setResult] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
 return <section className="sg-panel"><h2>Дата из исходного сообщения</h2><p>Проверка «сегодня», «завтра» или ISO-даты. Используется исходное время, а не момент повторной доставки. Эта форма не делает текстовый агент календарным.</p><form className="sg-settings-form sc-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setResult(''); setError(''); try { const value = await calendarRequest<{ date: string; timezone: string; withinPeriod: boolean }>('/resolve-date', { expression, messageTimestamp: timestamp }); setResult(`${value.date} · ${value.timezone}${value.withinPeriod ? '' : ' · за пределами календарного периода'}`) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось определить дату.') } finally { setBusy(false) } }}><Field label="Выражение даты"><input required value={expression} onChange={event => setExpression(event.target.value)}/></Field><Field label="Исходное время сообщения (ISO со смещением)"><input required value={timestamp} onChange={event => setTimestamp(event.target.value)} placeholder="YYYY-MM-DDTHH:MM:SS+03:00"/></Field><button className="sg-control" disabled={busy}>Определить дату</button></form><ErrorNotice error={error}/><p role="status">{result}</p></section>
}

export default function SchoolCalendar({ canWrite = false }: { canWrite?: boolean }) {
 const [data, setData] = useState<CalendarData | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [kind, setKind] = useState<CalendarKind>('weeks'), [showArchive, setShowArchive] = useState(false), [editor, setEditor] = useState<{ row?: CalendarRecord; restoring?: boolean; key: number } | null>(null), [actionBusy, setActionBusy] = useState(false)
 const request = useRef<AbortController | null>(null), serial = useRef(0)
 const reload = useCallback(async () => { request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(''); try { const value = await calendarRequest<CalendarData>('', undefined, 'GET', controller.signal); if (!value || !Number.isInteger(value.revision) || !value.records || kinds.some(kind => !Array.isArray(value.records[kind]))) throw new Error('Календарь не удалось прочитать.'); if (!controller.signal.aborted) { setData(value); return value } } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить календарь.') } finally { if (!controller.signal.aborted) setLoading(false) } return null }, [])
 useEffect(() => { void reload(); return () => request.current?.abort() }, [reload])
 const writable = Boolean(canWrite && data?.canWrite)
 const archive = async (row: CalendarRecord) => { if (!data) return; if (row.archived && kind === 'rules') { setEditor({ row, restoring: true, key: ++serial.current }); return } setActionBusy(true); setError(''); try { await calendarRequest(`/records/${kind}/${row.id}/${row.archived ? 'restore' : 'archive'}`, { expectedRevision: data.revision }); await reload() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось изменить архив.') } finally { setActionBusy(false) } }
 return <div className="sg-page school-calendar cp-stack"><div className="sg-page-heading"><div><h1><CalendarDays size={26}/>Календарь школы</h1><p>Подтверждённые даты и исключения. Изменение календаря само по себе не перестраивает и не публикует расписание.</p></div><button className="sg-control" aria-label="Обновить календарь" onClick={() => void reload()} disabled={loading}><RefreshCw size={16}/><span>Обновить календарь</span></button></div>
  <ErrorNotice error={error}><button className="sg-control" onClick={() => void reload()} disabled={loading}>Повторить загрузку</button></ErrorNotice>{loading && <p role="status">Загружаем календарь…</p>}
  {data && <>{writable ? <ConfigForm data={data} reload={reload}/> : <section className="sg-panel"><h2>Календарь · личный просмотр</h2><p>{data.config ? `${data.config.periodStart} — ${data.config.periodEnd} · ${data.config.timezone}` : 'Период и часовой пояс ещё не выбраны составителем.'}</p>{data.bindingBlockers?.map(item => <p key={item.code} role="status">{item.message}. Показаны только общешкольные даты.</p>)}</section>}
   <section className="sg-panel"><div className="sg-actions">{kinds.map(item => <button className="sg-control" aria-pressed={kind === item} key={item} disabled={Boolean(editor)} onClick={() => setKind(item)}>{titles[item]}</button>)}</div><h2>{titles[kind]}</h2><div className="sg-actions"><label className="sc-check"><input type="checkbox" checked={showArchive} onChange={event => setShowArchive(event.target.checked)}/>Показать архив</label>{writable && <button className="sg-control" disabled={!data.config || Boolean(editor)} onClick={() => setEditor({ key: ++serial.current })}><Plus size={16}/>Добавить: {titles[kind]}</button>}</div>
    {!data.records[kind].some(row => showArchive || !row.archived) ? <p>Записей пока нет. {writable ? data.config ? 'Добавьте подтверждённые сведения или сохраните черновик.' : 'Сначала выберите период и часовой пояс.' : 'Сведения добавляет составитель.'}</p> : <ul className="sc-records">{data.records[kind].filter(row => showArchive || !row.archived).map(row => <li key={row.id}><div><strong><RecordSummary row={row} kind={kind}/></strong><p>{row.confirmed ? 'Подтверждено' : 'Черновик'}{row.archived ? ' · Архив' : ''}{row.source && ` · ${row.source}`}</p></div>{writable && <div className="sg-actions">{!row.archived && <button className="sg-control" disabled={actionBusy || Boolean(editor)} onClick={() => setEditor({ row, key: ++serial.current })}>Изменить запись</button>}<button className="sg-control" disabled={actionBusy || Boolean(editor)} onClick={() => void archive(row)}>{row.archived ? 'Восстановить' : 'В архив'}</button></div>}</li>)}</ul>}
   </section>{editor && <RecordEditor key={editor.key} kind={kind} row={editor.row} restoring={editor.restoring} revision={data.revision} reload={reload} close={() => setEditor(null)}/>}<EffectiveWeek revision={data.revision}/><ResolveDate/>
  </>}
 </div>
}
