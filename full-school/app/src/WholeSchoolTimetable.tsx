import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import './whole-school-timetable.css'

export type WholeSchoolLesson = { id: string; className: string; day: number; slot: number; start: string; end: string }
type Props<T extends WholeSchoolLesson> = {
 lessons: T[]
 classes: string[]
 dayNames: string[]
 renderLesson: (lesson: T) => ReactNode
 filtered: boolean
 viewLabel?:string
 compactTime?: boolean
}
const rowKey = (lesson: WholeSchoolLesson) => `${lesson.day}|${lesson.start}|${lesson.end}|${lesson.slot}`

/** A view of the existing draft. No merging, invented assignments or write API. */
export default function WholeSchoolTimetable<T extends WholeSchoolLesson>({ lessons, classes, dayNames, renderLesson, filtered,viewLabel, compactTime = false }: Props<T>) {
 const scroll = useRef<HTMLDivElement>(null), hint = useId()
 const [edges, setEdges] = useState({ start: true, end: false })
 const rows = useMemo(() => {
  const groups = new Map<string, { day: number; slot: number; start: string; end: string; cells: Map<string, T[]> }>()
  for (const lesson of lessons) {
   const key = rowKey(lesson)
   let row = groups.get(key)
   if (!row) { row = { day: lesson.day, slot: lesson.slot, start: lesson.start, end: lesson.end, cells: new Map() }; groups.set(key, row) }
   const entries = row.cells.get(lesson.className) || []
   entries.push(lesson); row.cells.set(lesson.className, entries)
  }
  return [...groups.entries()].sort(([, a], [, b]) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.slot - b.slot)
 }, [lessons])
 const updateEdges = () => { const node = scroll.current; if (node) setEdges({ start: node.scrollLeft <= 1, end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 1 }) }
 useEffect(() => {
  updateEdges()
  const node = scroll.current
  if (!node) return
  const observer = new ResizeObserver(updateEdges); observer.observe(node)
  return () => observer.disconnect()
 }, [classes, rows])
 const move = (direction: number) => {
  const node = scroll.current
  if (node) node.scrollBy({ left: direction * Math.max(160, node.clientWidth - 112), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
 }
 return <div className={`wst-view${compactTime ? ' wst-compact-time' : ''}`}>
  <div className="wst-navigation"><p id={hint} className="tt-caption">{filtered ? 'Поиск фильтрует занятия; колонки всех классов сохранены. ' : ''}{compactTime ? 'Другие классы — по горизонтали. Клавиатура: Tab, затем стрелки.' : 'Прокрутите таблицу вправо, чтобы увидеть остальные классы. С клавиатуры: Tab к таблице, затем стрелки.'}</p><div className="wst-scroll-actions"><button type="button" className="tt-icon-btn" aria-label="К предыдущим классам" disabled={edges.start} onClick={() => move(-1)}><ChevronLeft size={18}/></button><button type="button" className="tt-icon-btn" aria-label="К следующим классам" disabled={edges.end} onClick={() => move(1)}><ChevronRight size={18}/></button></div></div>
  <div ref={scroll} className="wst-scroll" role="region" aria-label={viewLabel||'Общая сетка всех классов'} aria-describedby={hint} tabIndex={0} onScroll={updateEdges}>
   <table className="wst-table"><caption className="sr-only">{viewLabel||'Расписание всех классов'}: строки — день и точное время, столбцы — классы. Несколько занятий в ячейке показаны отдельно.</caption><thead><tr><th scope="col" className="wst-time">День / время</th>{classes.map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead>
    <tbody>{rows.map(([key, row], index) => {
     const dayStart = index === 0 || rows[index - 1][1].day !== row.day
     const dayName = dayNames[row.day] || `День ${row.day + 1}`
     return <tr key={key} className={dayStart ? 'wst-day-start' : ''}><th scope="row" className="wst-time" aria-label={compactTime ? `${dayName}, ${row.slot} урок, ${row.start}–${row.end}` : undefined}>{compactTime ? <>{dayStart && <span className="wst-date">{dayName}</span>}<strong>{row.slot} урок</strong><span>{row.start}–{row.end}</span></> : <><strong>{dayName}</strong><span>{row.start}–{row.end}</span><small>{row.slot} урок</small></>}</th>{classes.map(name => <td key={name} data-class={name}><div className="wst-entries">{(row.cells.get(name) || []).map((lesson, occurrence) => <div className="wst-entry" key={`${lesson.id}:${occurrence}`} data-whole-school-entry={lesson.id}>{renderLesson(lesson)}</div>)}</div></td>)}</tr>
    })}</tbody>
   </table>
  </div>
 </div>
}
