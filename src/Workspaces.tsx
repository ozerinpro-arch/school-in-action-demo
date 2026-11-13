import { formValues, type Mutation, type State } from './api'

type Workspace = { state: State; busy: boolean; mutate: Mutation }

export function Materials({ state, busy, mutate }: Workspace) {
  const lessons = state.schedule.filter(lesson => lesson.teacherId === state.profile.userId)
  return <div className="stack">
    {state.role === 'teacher' && !!lessons.length && <details className="card">
      <summary>Share lesson material</summary>
      <form className="form" onSubmit={async event => {
        event.preventDefault()
        const form = event.currentTarget
        if (await mutate('/api/materials', formValues(form))) {
          form.reset()
          form.closest('details')?.removeAttribute('open')
        }
      }}>
        <label>Lesson<select name="lessonId">{lessons.map(lesson => <option key={lesson.id} value={lesson.id}>
          {lesson.day} · {lesson.className} · {lesson.topic}
        </option>)}</select></label>
        <label>Material title<input name="title" required maxLength={120}/></label>
        <label>Material text<textarea name="content" required rows={4} maxLength={4000}/></label>
        <div className="actions"><button className="primary" disabled={busy}>Share material</button></div>
      </form>
    </details>}
    {state.materials.map(item => <article className="card stack" key={item.id}>
      <h2>{item.title}</h2><p className="prewrap">{item.content}</p>
    </article>)}
    {!state.materials.length && <p className="card muted">No lesson materials have been shared.</p>}
  </div>
}

export function Tasks({ state, busy, mutate }: Workspace) {
  return <div className="stack">
    <details className="card"><summary>New school task</summary>
      <form className="form" onSubmit={async event => {
        event.preventDefault()
        const form = event.currentTarget
        if (await mutate('/api/tasks', formValues(form))) {
          form.reset()
          form.closest('details')?.removeAttribute('open')
        }
      }}>
        <label>Task title<input name="title" required maxLength={120}/></label>
        <label>Description<textarea name="description" maxLength={1000} rows={2}/></label>
        <div className="actions"><button className="primary" disabled={busy}>Create task</button></div>
      </form>
    </details>
    {state.tasks.map(item => <article className="card stack" key={item.id}>
      <h2>{item.title}</h2><p className="muted">{item.owner}</p><p className="prewrap">{item.description}</p>
      <label>Task status<select disabled={busy} value={item.status} onChange={event =>
        void mutate('/api/tasks/' + item.id + '/status', { status: event.target.value })}>
        <option value="open">Open</option><option value="in progress">In progress</option><option value="done">Done</option>
      </select></label>
    </article>)}
    {!state.tasks.length && <p className="card muted">No school tasks yet.</p>}
  </div>
}

export function Documents({ state, busy, mutate }: Workspace) {
  return <div className="stack">{state.documents.map(item => <article className="card stack" key={item.id}>
    <div className="card-title"><h2>{item.title}</h2><span className="badge">{item.status === 'approved' ? 'Approved' : 'In review'}</span></div>
    <p>{item.content}</p>
    {item.status !== 'approved' && <div className="actions"><button className="primary" disabled={busy}
      onClick={() => void mutate('/api/documents/' + item.id + '/approve')}>Approve document</button></div>}
  </article>)}</div>
}

export function Directory({ state }: Workspace) {
  return <div className="grid">
    <section className="card stack"><h2>Teachers</h2>{state.teachers.map(person =>
      <div className="row" key={person.id}><strong>{person.name}</strong><span className="muted">{person.subject}</span></div>)}</section>
    <section className="card stack"><h2>Students</h2>{state.students.map(person =>
      <div className="row" key={person.id}><strong>{person.name}</strong><span className="muted">{person.className}</span></div>)}</section>
  </div>
}

export function Activity({ state, busy, mutate }: Workspace) {
  const format = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  return <div className="stack">
    {state.activity.some(item => item.unread) && <div className="actions"><button disabled={busy}
      onClick={() => void mutate('/api/activity/read')}>Mark all as read</button></div>}
    {state.activity.map(item => <article className="card row" key={item.id}>
      <div><h2>{item.title}</h2><p className="muted">{item.actor} · {format.format(new Date(item.at))}</p></div>
      {item.unread && <span className="badge">New</span>}
    </article>)}
    {!state.activity.length && <p className="card muted">No activity yet.</p>}
  </div>
}

export function Overview({ state }: Workspace) {
  const pending = state.replacements.filter(item => item.status === 'pending').length
  const submitted = state.assignments.filter(item => item.status === 'submitted').length
  const total = state.assignments.length
  return <div className="stack">
    <div className="stats">
      {[
        ['Scheduled lessons', state.schedule.length],
        ['Pending substitutions', pending],
        ['Assignments to review', submitted],
        ['Active club programs', state.clubs.programs.filter(item => !item.archived).length],
      ].map(([label, value]) => <article className="card metric" key={label}><strong>{value}</strong><h2>{label}</h2></article>)}
    </div>
    <section className="card stack"><h2>Assignment progress</h2>
      {total ? ['open', 'submitted', 'reviewed'].map(status => {
        const count = state.assignments.filter(item => item.status === status).length
        return <div className="metric-row" key={status}>
          <span>{status[0].toUpperCase() + status.slice(1)}</span>
          <progress aria-label={status + ' assignments'} value={count} max={total}/>
          <span>{count} / {total}</span>
        </div>
      }) : <p className="muted">No assignment records yet.</p>}
    </section>
  </div>
}

const integrations = [
  ['AI assistance', 'NanoGPT and automatic material generation are disconnected. Teachers can share lesson materials manually.'],
  ['MAX notifications', 'The MAX bot and outbound messages are disconnected. Activity is recorded in the demo.'],
  ['School identity and data imports', 'Live sign-in, staff invitations, school data connectors and timetable imports are outside this demo. The demo uses fictional roles and built-in records.'],
  ['Payment processing', 'Club fees are simulated accounting records. Sample PDFs are available in Receipts. Live payment services are disconnected.'],
  ['School planning and publication', 'Constraint solver, dated calendar, daily planning brief, timetable revision history and formal publishing are outside this demo. Edits and substitutions appear directly in the relevant workspaces.'],
  ['Extended school workspaces', 'The demo covers the director, teacher and student workflows. The legacy accountant workspace, school-wide search, attendance records, assignment drafts, discussion threads and practice activities are outside the demo.'],
]

export function Integrations() {
  return <div className="stack">{integrations.map(([name, description]) => <article className="card stack" key={name}>
    <div className="card-title"><h2>{name}</h2><span className="badge neutral">Unavailable in demo</span></div>
    <p className="muted">{description}</p>
  </article>)}</div>
}
