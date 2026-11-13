import { useState, type FormEvent } from 'react'
import { api, type Mutation, type State } from './api'

type Program = State['clubs']['programs'][number]
type Student = State['students'][number]
type ChargeInput = { programId: string; studentId: string; period: string }
type ChargePreview = ChargeInput & { amountCents: number }

const BASE = '/api/clubs'
const formatCents = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
const formatFee = (cents: number) => `$${formatCents(cents)}`
const enrollmentUrl = (programId: string) => `${BASE}/programs/${programId}/enrollments`

function ProgramEditor({ program, busy, mutate }: { program?: Program; busy: boolean; mutate: Mutation }) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const details = form.closest('details')
    const values = new FormData(form)
    const [whole, decimal = ''] = String(values.get('fee')).split('.')
    const body = {
      name: String(values.get('name')).trim(),
      description: String(values.get('description')).trim(),
      meetingTime: String(values.get('meetingTime')).trim(),
      capacity: Number(values.get('capacity')),
      feeCents: Number(whole) * 100 + Number(decimal.padEnd(2, '0')),
    }
    const saved = await mutate(
      program ? `${BASE}/programs/${program.id}` : `${BASE}/programs`,
      body,
      program ? 'PATCH' : 'POST',
    )
    if (saved && details?.isConnected) {
      if (!program) form.reset()
      details.open = false
      details.querySelector('summary')?.focus()
    }
  }

  return <details>
    <summary onClick={event => {
      const details = event.currentTarget.closest('details')
      if (!details?.open) details?.querySelector('form')?.reset()
    }}>{program ? 'Edit club' : 'New club'}</summary>
    <form className="form" onSubmit={save}>
      <label>Club name <input name="name" required maxLength={120} defaultValue={program?.name} /></label>
      <label>Description <textarea name="description" maxLength={1000} defaultValue={program?.description} /></label>
      <label>Meeting time <input name="meetingTime" required maxLength={120} defaultValue={program?.meetingTime} /></label>
      <label>Capacity <input name="capacity" type="number" required min={1} max={100} defaultValue={program?.capacity} /></label>
      <label>Demo fee (USD) <input name="fee" inputMode="decimal" pattern="[0-9]{1,4}(\.[0-9]{1,2})?|10000(\.0{1,2})?" title="Enter up to 10000.00 with no more than two decimal places" defaultValue={program ? formatCents(program.feeCents) : '0.00'} /></label>
      <button className="primary" disabled={busy}>{program ? 'Save club' : 'Create club'}</button>
    </form>
  </details>
}

function Roster({ program, members, students, busy, mutate }: {
  program: Program; members: Student[]; students: Student[]; busy: boolean; mutate: Mutation
}) {
  async function addStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const studentId = new FormData(form).get('studentId')
    if (await mutate(enrollmentUrl(program.id), { studentId, status: 'enrolled' })) form.reset()
  }

  return <div className="stack inset">
    <h3>Members</h3>
    {members.length ? <ul className="stack">{members.map(student => <li key={student.id} className="row">
      <span>{student.name} · {student.className}</span>
      <button type="button" disabled={busy} aria-label={`Remove ${student.name}`} onClick={() => void mutate(
        enrollmentUrl(program.id), { studentId: student.id, status: 'withdrawn' },
      )}>Remove</button>
    </li>)}</ul> : <p className="muted">No students enrolled.</p>}
    {!program.archived && members.length < program.capacity && students.length > 0 && <form className="form" onSubmit={addStudent}>
      <label>Student <select name="studentId" defaultValue="" required>
        <option value="" disabled>Choose a student</option>
        {students.map(student => <option value={student.id} key={student.id}>{student.name} · {student.className}</option>)}
      </select></label>
      <button disabled={busy}>Add member</button>
    </form>}
  </div>
}

function ClubCharges({ state, busy, mutate }: { state: State; busy: boolean; mutate: Mutation }) {
  const [quote, setQuote] = useState<ChargePreview>()
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')
  const isDirector = state.role === 'director'
  const { programs, enrollments, charges } = state.clubs
  const eligible = enrollments.flatMap(({ programId, studentId, status }) => {
    const program = programs.find(item => item.id === programId)
    const student = state.students.find(item => item.id === studentId)
    return status === 'enrolled' && program && !program.archived && program.feeCents > 0 && student
      ? [{ value: `${programId}:${studentId}`, label: `${program.name} · ${student.name}` }]
      : []
  })
  const visibleCharges = isDirector ? charges : charges.filter(charge => charge.studentId === state.profile.userId)

  async function submitCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const [programId, studentId] = String(values.get('enrollment')).split(':')
    const period = String(values.get('period'))
    const input = { programId, studentId, period }
    setError('')
    if (quote && quote.programId === programId && quote.studentId === studentId && quote.period === period) {
      if (await mutate(`${BASE}/charges`, { ...input, expectedAmountCents: quote.amountCents })) form.reset()
      setQuote(undefined)
      return
    }
    setPreviewing(true)
    setQuote(undefined)
    try {
      const result = await api<{ amountCents: number }>(`${BASE}/charges/preview`, input)
      setQuote({ ...input, amountCents: result.amountCents })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not preview the demo fee. Try again.')
    } finally {
      setPreviewing(false)
    }
  }

  const locked = busy || previewing
  return <section className="card stack" aria-labelledby="club-fees-title">
    <h2 id="club-fees-title">Demo fees</h2>
    <p className="muted">All amounts are fictional. <a href="#receipts">View sample and confirmed receipts</a>.</p>
    {isDirector && (eligible.length ? <form className="form" onSubmit={submitCharge} onChange={() => { setQuote(undefined); setError('') }}>
      <label>Enrollment <select name="enrollment" defaultValue="" required disabled={locked}>
        <option value="" disabled>Choose an enrollment</option>
        {eligible.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}
      </select></label>
      <label>Billing month <input name="period" type="month" required disabled={locked}
        pattern="[0-9]{4}-(0[1-9]|1[0-2])" placeholder="YYYY-MM" /></label>
      {quote && <p role="status">Estimated fee {formatFee(quote.amountCents)}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <button className="primary" disabled={locked}>{previewing ? 'Checking fee…' : quote ? 'Save fee draft' : 'Preview fee'}</button>
    </form> : <p className="muted">An enrolled student and a club fee are required to draft a charge.</p>)}
    {visibleCharges.length === 0 && <p className="muted">No demo charges yet.</p>}
    {visibleCharges.length > 0 && <ul className="stack">{visibleCharges.map(charge => <li className="row" key={charge.id}>
      <p>{charge.programName ?? programs.find(program => program.id === charge.programId)?.name ?? 'Club'} · {charge.period} · {formatFee(charge.amountCents)}
        {isDirector && ` · ${state.students.find(student => student.id === charge.studentId)?.name ?? 'Student'}`}</p>
      <span className={`badge${charge.status === 'cancelled' ? ' neutral' : ''}`}>{charge.status === 'draft' ? 'Draft' : charge.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</span>
      {isDirector && charge.status !== 'cancelled' && <div className="actions">
        {charge.status === 'draft' && <button type="button" disabled={locked} onClick={() => void mutate(`${BASE}/charges/${charge.id}/confirm`, {})}>Confirm fee</button>}
        <button type="button" disabled={locked} onClick={() => void mutate(`${BASE}/charges/${charge.id}/cancel`, {})}>Cancel fee</button>
      </div>}
    </li>)}</ul>}
  </section>
}

export default function Clubs({ state, busy, mutate }: { state: State; busy: boolean; mutate: Mutation }) {
  const isDirector = state.role === 'director'
  const isStudent = state.role === 'student'
  const { programs, enrollments } = state.clubs
  const visiblePrograms = isDirector ? programs : programs.filter(program => !program.archived)

  return <div className="stack">
    {isDirector && <section className="card"><ProgramEditor busy={busy} mutate={mutate} /></section>}
    {visiblePrograms.length === 0 && <p className="card muted">No clubs are available yet.</p>}
    <div className="grid">
      {visiblePrograms.map(program => {
        const enrolled = enrollments.filter(entry => entry.programId === program.id && entry.status === 'enrolled')
        const ownStatus = enrollments.find(entry => entry.programId === program.id && entry.studentId === state.profile.userId)?.status
        const joined = ownStatus === 'enrolled'
        const members = state.students.filter(student => enrolled.some(entry => entry.studentId === student.id))
        const otherStudents = state.students.filter(student => !members.some(member => member.id === student.id))
        const isFull = program.enrolledCount >= program.capacity
        return <article className="card stack lesson" key={program.id}>
          <div className="card-title"><h2>{program.name}</h2>{program.archived && <span className="badge neutral">Archived</span>}</div>
          {program.description && <p>{program.description}</p>}
          <div className="metadata">
            <span>{program.meetingTime}</span>
            {typeof program.feeCents === 'number' && <span>{program.feeCents ? `${formatFee(program.feeCents)} demo fee` : 'Free'}</span>}
            <span>{program.enrolledCount} of {program.capacity} enrolled</span>
          </div>
          {isStudent && <div className="actions">
            {ownStatus && <span className="badge">{joined ? 'Enrolled' : 'Withdrawn'}</span>}
            <button type="button" className={joined ? undefined : 'primary'} disabled={busy || (!joined && isFull)} onClick={() => void mutate(
              enrollmentUrl(program.id), { status: joined ? 'withdrawn' : 'enrolled' },
            )}>{joined ? 'Leave club' : isFull ? 'Club full' : 'Join club'}</button>
          </div>}
          {isDirector && <>
            <Roster program={program} members={members} students={otherStudents} busy={busy} mutate={mutate} />
            {!program.archived && <ProgramEditor program={program} busy={busy} mutate={mutate} />}
            <div className="actions"><button type="button" disabled={busy} onClick={() => void mutate(
              `${BASE}/programs/${program.id}/${program.archived ? 'restore' : 'archive'}`, {},
            )}>{program.archived ? 'Restore club' : 'Archive club'}</button></div>
          </>}
        </article>
      })}
    </div>
    {(isDirector || isStudent) && <ClubCharges state={state} busy={busy} mutate={mutate} />}
  </div>
}
