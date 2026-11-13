import { useState, type FormEvent } from 'react'
import { Clock3, MapPin } from 'lucide-react'
import { formValues, type Lesson, type Mutation, type State } from './api'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

function LessonForm({ lesson, state, busy, mutate, close }: {
  lesson?: Lesson; state: State; busy: boolean; mutate: Mutation; close: () => void
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await mutate(lesson ? '/api/schedule/' + lesson.id : '/api/schedule',
      formValues(event.currentTarget), lesson ? 'PATCH' : 'POST')) close()
  }
  return <form className="form" onSubmit={save}>
    <div className="grid">
      <label>Day<select name="day" defaultValue={lesson?.day}>{days.map(day => <option key={day}>{day}</option>)}</select></label>
      <label>Class<select name="className" defaultValue={lesson?.className}><option>Grade 7A</option><option>Grade 7B</option></select></label>
      <label>Start time<input name="start" type="time" required defaultValue={lesson?.start}/></label>
      <label>End time<input name="end" type="time" required defaultValue={lesson?.end}/></label>
      <label>Teacher<select name="teacherId" defaultValue={lesson?.teacherId}>{state.teachers.map(person =>
        <option key={person.id} value={person.id}>{person.name} · {person.subject}</option>)}</select></label>
      <label>Room<input name="room" required maxLength={40} defaultValue={lesson?.room}/></label>
    </div>
    <label>Lesson topic<input name="topic" required maxLength={100} defaultValue={lesson?.topic}/></label>
    <div className="actions"><button className="primary" disabled={busy}>Save lesson</button><button type="button" onClick={close}>Cancel</button></div>
  </form>
}

export function Schedule({ state, busy, mutate }: { state: State; busy: boolean; mutate: Mutation }) {
  const [group, setGroup] = useState('')
  const [day, setDay] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)
  const director = state.role === 'director'
  const lessons = state.schedule.filter(lesson => (!group || lesson.className === group) && (!day || lesson.day === day))
  return <div className="stack">
    <div className="toolbar">
      <label>Day filter<select value={day} onChange={event => setDay(event.target.value)}>
        <option value="">All weekdays</option>{days.map(item => <option key={item}>{item}</option>)}
      </select></label>
      {director && <label>Class filter<select value={group} onChange={event => setGroup(event.target.value)}>
        <option value="">All classes</option><option>Grade 7A</option><option>Grade 7B</option>
      </select></label>}
      {director && editing !== 'new' && <button className="primary" onClick={() => setEditing('new')}>Add lesson</button>}
    </div>
    {editing === 'new' && <section className="card stack"><h2>New lesson</h2>
      <LessonForm state={state} busy={busy} mutate={mutate} close={() => setEditing(null)}/></section>}
    {!lessons.length && <p className="card muted">No lessons match this view.</p>}
    {days.filter(item => lessons.some(lesson => lesson.day === item)).map(item => <section className="stack" key={item} aria-label={item}>
      <h2 className="day-heading">{item}</h2>
      <div className="lesson-list">{lessons.filter(lesson => lesson.day === item).sort((a, b) => a.start.localeCompare(b.start)).map(lesson => {
        const substitute = state.replacements.find(entry => entry.lessonId === lesson.id)
        const owns = state.profile.userId === lesson.teacherId
        return <article className="card lesson stack" key={lesson.id}>
          <div className="card-title"><div><h3>{lesson.subject}</h3><p className="muted">{lesson.className} · {lesson.topic}</p></div>
            {(lesson.status !== 'normal' || substitute) && <span className="badge">{
              lesson.status === 'completed' ? 'Substitute lesson completed' :
              lesson.status === 'replacement' ? 'Substitute assigned' : 'Substitution requested'
            }</span>}
          </div>
          <div className="metadata"><span><Clock3 size={15} aria-hidden="true"/> {lesson.start}–{lesson.end}</span>
            <span><MapPin size={15} aria-hidden="true"/> {lesson.room}</span><span>{lesson.teacherName}</span></div>
          <div className="actions">
            {director && !substitute && editing !== lesson.id && <button onClick={() => setEditing(lesson.id)}>Edit lesson</button>}
            {(director || owns) && state.role !== 'student' && !substitute && requesting !== lesson.id &&
              <button onClick={() => setRequesting(lesson.id)}>Request substitution</button>}
            {(director || owns) && state.role !== 'student' && lesson.status === 'replacement' &&
              <button className="primary" disabled={busy} onClick={() => void mutate('/api/lessons/' + lesson.id + '/complete')}>Mark lesson complete</button>}
          </div>
          {editing === lesson.id && <LessonForm lesson={lesson} state={state} busy={busy} mutate={mutate} close={() => setEditing(null)}/>}
          {requesting === lesson.id && !substitute && <form className="form" onSubmit={async event => {
            event.preventDefault()
            const values = formValues(event.currentTarget)
            if (await mutate('/api/replacements', { ...values, lessonId: lesson.id })) setRequesting(null)
          }}>
            <label>Reason<textarea name="reason" required maxLength={500} rows={2}/></label>
            <div className="actions"><button className="primary" disabled={busy}>Send request</button>
              <button type="button" onClick={() => setRequesting(null)}>Cancel</button></div>
          </form>}
        </article>
      })}</div>
    </section>)}
  </div>
}

export function Substitutions({ state, busy, mutate }: { state: State; busy: boolean; mutate: Mutation }) {
  if (!state.replacements.length) return <p className="card muted">No substitution requests yet.</p>
  return <div className="stack">{state.replacements.map(item => <article className="card stack" key={item.id}>
    <div className="card-title"><div><h2>{item.lesson.subject} · {item.lesson.className}</h2>
      <p className="muted">{item.lesson.day} · {item.lesson.start}–{item.lesson.end} · {item.lesson.teacherName}</p></div>
      <span className="badge">{{ pending: 'Pending', approved: 'Approved', completed: 'Completed' }[item.status]}</span></div>
    <p>{item.reason}</p>
    {state.role === 'director' && item.status === 'pending' && <>
      {item.candidates.filter(person => person.conflict).map(person => <p key={person.id} className="muted">{person.conflict}</p>)}
      {item.candidates.some(person => !person.conflict) ? <form className="form" onSubmit={event => {
        event.preventDefault()
        void mutate('/api/replacements/' + item.id + '/approve', formValues(event.currentTarget))
      }}>
        <label>Substitute teacher<select name="teacherId" required defaultValue="">
          <option value="" disabled>Select a teacher</option>
          {item.candidates.filter(person => !person.conflict).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label>
        <div className="actions"><button className="primary" disabled={busy}>Approve substitution</button></div>
      </form> : <p className="notice">No qualified teacher is available for this time.</p>}
    </>}
  </article>)}</div>
}
