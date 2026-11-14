import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, BookOpen, LockKeyhole, Plus, Undo2 } from 'lucide-react'
import WholeSchoolTimetable, { type WholeSchoolLesson } from './WholeSchoolTimetable'
import './timetable.css'
import './planning.css'

export type CandidateGridAssignment = { eventId: string; slotId: string; roomId: string }
export type CandidateGridPlan = {
 slots: { id: string; day: number; slot: number; start: string; end: string }[]
 groups: { id: string; className: string; name: string }[]
 teachers: { id: string; name: string }[]
 rooms: { id: string; name: string }[]
 demands: { id: string; subject: string; groupIds: string[]; teacherIds: string[]; roomIds: string[]; weeklyCount: number; allowedSlotIds?: string[] }[]
 pins: CandidateGridAssignment[]
}
export type CandidateGridIssue = { eventIds: string[]; message: string }
export type CandidateSchoolGridProps = {
 plan: CandidateGridPlan
 assignments: CandidateGridAssignment[]
 originalAssignments: CandidateGridAssignment[]
 disabled?: boolean
 candidateKey: string
 onChange: (assignments: CandidateGridAssignment[]) => void
 onPin: (assignment: CandidateGridAssignment) => void
 onAddDemand: (className?: string) => void
 issues?: CandidateGridIssue[]
}
type Projection = WholeSchoolLesson & { assignment: CandidateGridAssignment; subject: string; teacherNames: string[]; classNames: string[] }
const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const shortDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const copy = (value: CandidateGridAssignment[]) => value.map(assignment => ({ ...assignment }))
const equal = (first: CandidateGridAssignment[], second: CandidateGridAssignment[]) => first.length === second.length && first.every((assignment, index) => assignment.eventId === second[index].eventId && assignment.slotId === second[index].slotId && assignment.roomId === second[index].roomId)

/** Controlled event editing: projections never become independent lessons.
 * All edits still require the parent's whole-candidate validator and saving.
 */
export default function CandidateSchoolGrid({ plan, assignments, originalAssignments, disabled = false, candidateKey, onChange, onPin, onAddDemand, issues = [] }: CandidateSchoolGridProps) {
 const [selectedId, setSelectedId] = useState(''), [newSlot, setNewSlot] = useState(''), [newRoom, setNewRoom] = useState(''), [swapId, setSwapId] = useState('')
 const [history, setHistory] = useState<CandidateGridAssignment[][]>([]), [message, setMessage] = useState(''), [actionError, setActionError] = useState(''), [addClass, setAddClass] = useState('')
 const slots = useMemo(() => new Map(plan.slots.map(slot => [slot.id, slot])), [plan.slots])
 const rooms = useMemo(() => new Map(plan.rooms.map(room => [room.id, room])), [plan.rooms])
 const groups = useMemo(() => new Map(plan.groups.map(group => [group.id, group])), [plan.groups])
 const teachers = useMemo(() => new Map(plan.teachers.map(teacher => [teacher.id, teacher.name])), [plan.teachers])
 const eventDemands = useMemo(() => new Map<string, CandidateGridPlan['demands'][number]>(plan.demands.flatMap(demand => Array.from({ length: Math.max(0, Math.min(40, demand.weeklyCount)) }, (_, occurrence) => [`${demand.id}_${occurrence}`, demand] as const))), [plan.demands])
 const original = useMemo(() => new Map(originalAssignments.map(assignment => [assignment.eventId, assignment])), [originalAssignments])
 const classes = useMemo(() => [...new Set(plan.groups.map(group => group.className))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [plan.groups])
 const selected = assignments.find(assignment => assignment.eventId === selectedId)
 const selectedDemand = selected && eventDemands.get(selected.eventId)
 const selectedPin = selected && plan.pins.find(pin => pin.eventId === selected.eventId)
 useEffect(() => { setSelectedId(''); setSwapId(''); setAddClass(''); setHistory([]); setMessage(''); setActionError('') }, [candidateKey])
 useEffect(() => { setNewSlot(selected?.slotId || ''); setNewRoom(selected?.roomId || ''); setSwapId('') }, [selected?.eventId, selected?.slotId, selected?.roomId])
 const classNames = (eventId: string) => [...new Set((eventDemands.get(eventId)?.groupIds || []).flatMap(groupId => groups.get(groupId)?.className || []))]
 const eventLabel = (eventId: string) => `${classNames(eventId).join(' + ')} · ${eventDemands.get(eventId)?.subject || eventId}`
 const placeLabel = (assignment: CandidateGridAssignment) => {
  const slot = slots.get(assignment.slotId)
  return `${slot ? `${shortDays[slot.day] || `День ${slot.day + 1}`} · ${slot.slot} урок · ${slot.start}–${slot.end}` : assignment.slotId} · каб. ${rooms.get(assignment.roomId)?.name || assignment.roomId}`
 }
 const structuralIssues = useMemo(() => {
  const found: CandidateGridIssue[] = [], seen = new Set<string>()
  for (const assignment of assignments) {
   if (seen.has(assignment.eventId)) found.push({ eventIds: [assignment.eventId], message: `Событие ${assignment.eventId} имеет два назначения.` })
   seen.add(assignment.eventId)
   const demand = eventDemands.get(assignment.eventId)
   if (!demand) found.push({ eventIds: [assignment.eventId], message: `Событие ${assignment.eventId} отсутствует в нагрузке.` })
   else if (!demand.groupIds.length || demand.groupIds.some(groupId => !groups.has(groupId))) found.push({ eventIds: [assignment.eventId], message: `У события ${assignment.eventId} не подтверждены участвующие группы.` })
   if (!slots.has(assignment.slotId)) found.push({ eventIds: [assignment.eventId], message: `У события ${assignment.eventId} неизвестный интервал ${assignment.slotId}.` })
   if (!rooms.has(assignment.roomId)) found.push({ eventIds: [assignment.eventId], message: `У события ${assignment.eventId} неизвестный кабинет ${assignment.roomId}.` })
  }
  return found
 }, [assignments, eventDemands, slots, rooms, groups])
 const allIssues = [...issues, ...structuralIssues]
 const projections = useMemo(() => assignments.flatMap((assignment): Projection[] => {
  const demand = eventDemands.get(assignment.eventId), slot = slots.get(assignment.slotId)
  if (!demand || !slot) return []
  const names = [...new Set(demand.groupIds.flatMap(groupId => groups.get(groupId)?.className || []))]
  return names.map(className => ({ id: assignment.eventId, className, day: slot.day, slot: slot.slot, start: slot.start, end: slot.end,
   assignment, subject: demand.subject, classNames: names, teacherNames: demand.teacherIds.map(id => teachers.get(id) || id) }))
 }), [assignments, eventDemands, slots, groups, teachers])
 function commit(next: CandidateGridAssignment[], description: string) {
  if (disabled || equal(assignments, next)) return
  if (next.length !== assignments.length || new Set(next.map(assignment => assignment.eventId)).size !== next.length || next.some(assignment => !assignments.some(previous => previous.eventId === assignment.eventId))) {
   setActionError('Перестановка должна сохранить все события кандидата без повторов.'); return
  }
  for (const assignment of next) {
   const previous = assignments.find(value => value.eventId === assignment.eventId)!
   if (previous.slotId === assignment.slotId && previous.roomId === assignment.roomId) continue
   const demand = eventDemands.get(assignment.eventId), pin = plan.pins.find(value => value.eventId === assignment.eventId)
   if (!demand || !slots.has(assignment.slotId) || !rooms.has(assignment.roomId)) { setActionError('Неизвестное событие, время или кабинет. Перестановка не применена.'); return }
   if (!demand.roomIds.includes(assignment.roomId) || (demand.allowedSlotIds?.length && !demand.allowedSlotIds.includes(assignment.slotId))) { setActionError(`Выбранные время или кабинет не разрешены нагрузкой: ${eventLabel(assignment.eventId)}.`); return }
   if (pin && (pin.slotId !== assignment.slotId || pin.roomId !== assignment.roomId)) { setActionError('Закреплённое событие нельзя перенести. Измените закрепление в условиях.'); return }
  }
  setHistory(previous => [...previous.slice(-19), copy(assignments)]); setActionError(''); setMessage(description); onChange(copy(next))
 }
 function move() {
  if (!selected || !newSlot || !newRoom) return
  commit(assignments.map(assignment => assignment.eventId === selected.eventId ? { ...assignment, slotId: newSlot, roomId: newRoom } : assignment), 'Событие перенесено во всех классах. Изменение требует проверки и сохранения кандидата.')
 }
 function swap() {
  if (!selected) return
  const other = assignments.find(assignment => assignment.eventId === swapId)
  if (!other) return
  commit(assignments.map(assignment => assignment.eventId === selected.eventId ? { ...assignment, slotId: other.slotId, roomId: other.roomId }
   : assignment.eventId === other.eventId ? { ...assignment, slotId: selected.slotId, roomId: selected.roomId } : assignment), 'Два события обменялись временем и кабинетами во всех классах. Требуется проверка кандидата.')
 }
 function undo() {
  if (disabled || !history.length) return
  const previous = history[history.length - 1]
  if (plan.pins.some(pin => previous.some(assignment => assignment.eventId === pin.eventId && (assignment.slotId !== pin.slotId || assignment.roomId !== pin.roomId)))) {
   setActionError('Отмена затронула бы закреплённое событие. Измените закрепление в условиях.'); return
  }
  setHistory(value => value.slice(0, -1)); setActionError(''); setMessage('Последняя локальная перестановка отменена.'); onChange(copy(previous))
 }
 function renderLesson(lesson: Projection) {
  const before = original.get(lesson.id), changed = !before || before.slotId !== lesson.assignment.slotId || before.roomId !== lesson.assignment.roomId
  const eventIssues = allIssues.filter(issue => issue.eventIds.includes(lesson.id)), pinned = plan.pins.some(pin => pin.eventId === lesson.id)
  return <button type="button" className={`tt-lesson ${selectedId === lesson.id ? 'tt-selected' : ''} ${changed ? 'tt-was-edited' : ''} ${eventIssues.length ? 'tt-has-error' : ''}`}
   style={eventIssues.length ? { background: '#fff3f4', borderColor: '#d77987' } : undefined}
   aria-label={`Выбрать событие: ${lesson.className} · ${lesson.subject}`} aria-pressed={selectedId === lesson.id}
   data-candidate-event={lesson.id} data-candidate-class={lesson.className} data-candidate-changed={changed ? 'true' : undefined}
   onClick={() => { setSelectedId(lesson.id); setActionError('') }}>
   <span className="tt-subject-mark" aria-hidden="true"><BookOpen size={14}/></span>
   <span className="tt-lesson-top"><b>{lesson.className}</b>{pinned && <LockKeyhole size={12} aria-label="Закреплено"/>}{eventIssues.length > 0 && <span className="tt-issue-dot error"><AlertCircle size={12}/><span className="sr-only">Проблема</span></span>}</span>
   <strong>{lesson.subject}</strong><small>{lesson.teacherNames.join(', ')}</small><span>Каб. {rooms.get(lesson.assignment.roomId)?.name || lesson.assignment.roomId}</span>
   {lesson.classNames.length > 1 && <small>Общее событие: {lesson.classNames.join(' + ')}</small>}
   {changed && <span data-candidate-route="true">{before ? <>Было: {placeLabel(before)}<br/></> : <>Новое в кандидате<br/></>}Стало: {placeLabel(lesson.assignment)}</span>}
   {eventIssues.map((issue, index) => <span key={index} className="tt-issue-dot error">{issue.message}</span>)}
  </button>
 }
 return <section className="tt-workspace tt-school" aria-label="Общая сетка кандидата" style={{ minWidth: 0, maxWidth: '100%' }}>
  <div className="sp-action-row" style={{ marginBottom: 12, minWidth: 0 }}><label className="sp-field" style={{ flex: '1 1 180px' }}><span>Класс для добавления урока</span><select aria-label="Класс для добавления урока" value={addClass} disabled={disabled} onChange={event => setAddClass(event.target.value)}><option value="">Выбрать в нагрузке</option>{classes.map(name => <option key={name}>{name}</option>)}</select></label><button type="button" className="sp-btn sp-secondary" disabled={disabled} onClick={() => onAddDemand(addClass || undefined)}><Plus size={15}/>Добавить урок</button><button type="button" className="sp-btn sp-secondary" disabled={disabled || !history.length} onClick={undo}><Undo2 size={15}/>Отменить последнее изменение</button></div>
  <p className="sp-caption">Общие занятия показаны в каждом участвующем классе. Перенос, обмен и закрепление изменяют всё событие. Оранжевым — изменения кандидата; красным — подтверждённые проблемы.</p>
  {allIssues.length > 0 && <div className="sp-error" role="alert" style={{ margin: '12px 0' }}><AlertCircle size={16}/><div>{allIssues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div></div>}
  {assignments.length === 0 ? <div className="sp-empty"><BookOpen size={25}/><h3>Кандидат ещё не составлен</h3><p>Запустите расчёт по подтверждённой нагрузке. Новый урок добавляется через условия планирования.</p></div>
   : <div className="tt-calendar" style={{ minWidth: 0, maxWidth: '100%' }}><WholeSchoolTimetable lessons={projections} classes={classes} dayNames={days} renderLesson={renderLesson} filtered={false} viewLabel="Общая сетка кандидата всех классов"/></div>}
  {selected && selectedDemand && <div style={{ marginTop: 16, minWidth: 0 }} aria-label="Редактирование выбранного события"><h4 style={{ overflowWrap: 'anywhere' }}>{eventLabel(selected.eventId)}</h4><p className="sp-caption">Сейчас: {placeLabel(selected)}{selectedPin ? ' · Закреплено в условиях' : ''}</p>
   <div className="sp-fields-pair"><label className="sp-field"><span>Новое время события</span><select aria-label="Новое время события" value={newSlot} disabled={disabled} onChange={event => setNewSlot(event.target.value)}>{plan.slots.filter(slot => !selectedDemand.allowedSlotIds?.length || selectedDemand.allowedSlotIds.includes(slot.id)).map(slot => <option key={slot.id} value={slot.id}>{shortDays[slot.day]} · {slot.slot} урок · {slot.start}–{slot.end}</option>)}</select></label><label className="sp-field"><span>Кабинет события</span><select aria-label="Кабинет события" value={newRoom} disabled={disabled} onChange={event => setNewRoom(event.target.value)}>{plan.rooms.filter(room => selectedDemand.roomIds.includes(room.id)).map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label></div>
   <div className="sp-action-row" style={{ marginTop: 10 }}><button type="button" className="sp-btn sp-secondary" disabled={disabled || !newSlot || !newRoom || (newSlot === selected.slotId && newRoom === selected.roomId)} onClick={move}>Перенести событие</button><button type="button" className="sp-btn sp-secondary" disabled={disabled} onClick={() => { if (!disabled) onPin({ ...selected }) }}><LockKeyhole size={14}/>Закрепить в условиях</button></div>
   <div className="sp-fields-pair" style={{ marginTop: 12 }}><label className="sp-field"><span>Второе событие для обмена</span><select aria-label="Второе событие для обмена" value={swapId} disabled={disabled} onChange={event => setSwapId(event.target.value)}><option value="">Выберите событие</option>{assignments.filter(assignment => assignment.eventId !== selected.eventId).map(assignment => <option key={assignment.eventId} value={assignment.eventId}>{eventLabel(assignment.eventId)} · {placeLabel(assignment)}</option>)}</select></label><div className="sp-action-row"><button type="button" className="sp-btn sp-secondary" disabled={disabled || !swapId} onClick={swap}>Поменять события местами</button></div></div>
  </div>}
  {actionError && <div className="sp-error" role="alert" style={{ margin: '12px 0' }}><AlertCircle size={16}/><p>{actionError}</p></div>}
  {message && <p className="sp-caption" role="status">{message}</p>}
 </section>
}
