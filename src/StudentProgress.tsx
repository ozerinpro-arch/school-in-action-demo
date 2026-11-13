import { formatDate, type State } from './api'

type StudentView = { state: State }

export function Grades({ state }: StudentView) {
  const graded = state.assignments.flatMap(assignment =>
    assignment.score === null ? [] : [{ ...assignment, score: assignment.score }])
  if (!graded.length) {
    return <p className="card muted">No grades yet. Scores and teacher feedback appear after review.</p>
  }

  const average = graded.reduce((sum, item) => sum + item.score, 0) / graded.length
  const formattedAverage = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(average)

  return <div className="stack">
    <article className="card metric">
      <h2>Average assignment score</h2><strong>{formattedAverage}/100</strong>
    </article>
    {graded.map(assignment => <article className="card stack" key={assignment.id}>
      <div className="card-title">
        <div><h2>{assignment.title}</h2>
          <p className="muted">{assignment.subject} · Due {formatDate(assignment.dueDate)}</p></div>
        <span className="badge">{assignment.score}/100</span>
      </div>
      {assignment.feedback && <div className="inset">
        <h3>Teacher feedback</h3><p className="prewrap">{assignment.feedback}</p>
      </div>}
    </article>)}
  </div>
}

export function Progress({ state }: StudentView) {
  const { assignments } = state
  if (!assignments.length) return <p className="card muted">Progress appears when a teacher publishes an assignment.</p>

  const open = assignments.filter(item => item.status === 'open').length
  const awaitingReview = assignments.filter(item => item.status === 'submitted').length
  const reviewed = assignments.length - open - awaitingReview
  const subjects = [...new Set(assignments.map(item => item.subject))].sort((a, b) => a.localeCompare(b, 'en'))

  return <div className="stack">
    <div className="stats">
      <article className="card metric"><h2>To submit</h2><strong>{open}</strong></article>
      <article className="card metric"><h2>Awaiting review</h2><strong>{awaitingReview}</strong></article>
      <article className="card metric"><h2>Reviewed</h2><strong>{reviewed}</strong></article>
    </div>
    <section className="card stack">
      <h2>Assignment submissions by subject</h2>
      {subjects.map(subject => {
        const items = assignments.filter(item => item.subject === subject)
        const sent = items.filter(item => item.status !== 'open').length
        return <div className="metric-row" key={subject}>
          <span>{subject}</span><progress aria-label={`${subject} assignments submitted`} value={sent} max={items.length}/>
          <span>{sent} / {items.length}</span>
        </div>
      })}
    </section>
  </div>
}
