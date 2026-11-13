import { useState } from 'react'
import { formValues, formatDate, type Mutation, type State } from './api'

export default function Assignments({ state, busy, mutate }: { state: State; busy: boolean; mutate: Mutation }) {
  const [studentId, setStudentId] = useState(state.students[0]?.id ?? '')
  const className = state.students.find(person => person.id === studentId)?.className
  const subjects = state.assignmentTargets.filter(target => target.className === className).map(target => target.subject)
  return <div className="stack">
    {state.role === 'teacher' && (state.students.length ? <details className="card">
      <summary>New assignment</summary>
      <form className="form" onSubmit={async event => {
        event.preventDefault()
        const form = event.currentTarget
        if (await mutate('/api/assignments', formValues(form))) {
          form.reset()
          form.closest('details')?.removeAttribute('open')
        }
      }}>
        <label>Title<input name="title" required maxLength={120}/></label>
        <label>Instructions<textarea name="instructions" required maxLength={2000} rows={3}/></label>
        <div className="grid">
          <label>Student<select name="studentId" value={studentId} onChange={event => setStudentId(event.target.value)}>
            {state.students.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>
          <label>Subject<select key={studentId} name="subject" required>{subjects.map(subject => <option key={subject}>{subject}</option>)}</select></label>
          <label>Due date<input name="dueDate" type="date" required/></label>
        </div>
        <div className="actions"><button className="primary" disabled={busy || !subjects.length}>Publish assignment</button></div>
      </form>
    </details> : <p className="notice">A scheduled class is required to publish assignments.</p>)}
    {!state.assignments.length && <p className="card muted">No assignments yet.</p>}
    {state.assignments.map(item => <article key={item.id} className="card stack">
      <div className="card-title"><div><h2>{item.title}</h2><p className="muted">{item.subject} · Due {formatDate(item.dueDate)}
        {state.role !== 'student' && ' · ' + (state.students.find(person => person.id === item.studentId)?.name ?? 'Student')}</p></div>
        <span className="badge">{{ open: 'Open', submitted: 'Submitted', reviewed: 'Reviewed' }[item.status]}</span></div>
      <p className="prewrap">{item.instructions}</p>
      {state.role === 'student' && item.status !== 'reviewed' ? <form className="form" onSubmit={event => {
        event.preventDefault()
        void mutate('/api/assignments/' + item.id + '/submit', formValues(event.currentTarget))
      }}>
        <label>Your answer<textarea key={item.answer} name="answer" defaultValue={item.answer} required maxLength={5000} rows={3}/></label>
        <div className="actions"><button className="primary" disabled={busy}>{item.status === 'submitted' ? 'Update answer' : 'Submit answer'}</button></div>
      </form> : item.answer && <div className="inset"><h3>Submitted answer</h3><p className="prewrap">{item.answer}</p></div>}
      {item.status === 'reviewed' && <div className="inset"><h3>Score {item.score}/100</h3><p className="prewrap">{item.feedback}</p></div>}
      {state.role !== 'student' && item.status !== 'open' && <form className="form" onSubmit={event => {
        event.preventDefault()
        const values = formValues(event.currentTarget)
        void mutate('/api/assignments/' + item.id + '/review', { ...values, score: Number(values.score) })
      }}>
        <label>Score (0–100)<input name="score" type="number" min={0} max={100} step={1} required defaultValue={item.score ?? ''}/></label>
        <label>Feedback<textarea name="feedback" required maxLength={1500} defaultValue={item.feedback} rows={2}/></label>
        <div className="actions"><button className="primary" disabled={busy}>Save review</button></div>
      </form>}
    </article>)}
  </div>
}
