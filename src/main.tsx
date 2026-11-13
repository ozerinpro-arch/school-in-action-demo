import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity as ActivityIcon, BarChart3, BookOpen, CalendarDays, ClipboardList, FileCheck,
  GraduationCap, Layers3, ListTodo, Plug, ReceiptText, Replace, TrendingUp, Users,
} from 'lucide-react'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import { api, ApiError, type Mutation, type Role, type State } from './api'
import { Schedule, Substitutions } from './Schedule'
import Assignments from './Assignments'
import Clubs from './Clubs'
import Receipts from './Receipts'
import { Grades, Progress } from './StudentProgress'
import { Activity, Directory, Documents, Integrations, Materials, Overview, Tasks } from './Workspaces'
import './styles.css'

const all: Role[] = ['director', 'teacher', 'student']
const staff: Role[] = ['director', 'teacher']
const pages = [
  { id: 'schedule', title: 'Schedule', icon: CalendarDays, roles: all, component: Schedule },
  { id: 'substitutions', title: 'Substitutions', icon: Replace, roles: staff, component: Substitutions },
  { id: 'assignments', title: 'Assignments', icon: ClipboardList, roles: all, component: Assignments },
  { id: 'grades', title: 'Grades', icon: FileCheck, roles: ['student'] as Role[], component: Grades },
  { id: 'progress', title: 'Progress', icon: TrendingUp, roles: ['student'] as Role[], component: Progress },
  { id: 'materials', title: 'Materials', icon: BookOpen, roles: all, component: Materials },
  { id: 'clubs', title: 'Clubs', icon: Layers3, roles: ['director', 'student'] as Role[], component: Clubs },
  { id: 'receipts', title: 'Receipts', icon: ReceiptText, roles: ['director', 'student'] as Role[], component: Receipts },
  { id: 'tasks', title: 'School tasks', icon: ListTodo, roles: staff, component: Tasks },
  { id: 'documents', title: 'Documents', icon: FileCheck, roles: ['director'] as Role[], component: Documents },
  { id: 'directory', title: 'Directory', icon: Users, roles: ['director'] as Role[], component: Directory },
  { id: 'overview', title: 'Overview', icon: BarChart3, roles: ['director'] as Role[], component: Overview },
  { id: 'activity', title: 'Activity', icon: ActivityIcon, roles: all, component: Activity },
  { id: 'integrations', title: 'Integrations', icon: Plug, roles: all, component: Integrations },
]
const profiles = [
  ['director', 'Director'],
  ['t1', 'Teacher · Maya Brooks'],
  ['t2', 'Teacher · Owen Reed'],
  ['t3', 'Teacher · Nora Finch'],
  ['t4', 'Teacher · Alex Vale'],
  ['student', 'Student · Jamie Lane'],
]

function errorText(error: unknown) {
  return error instanceof ApiError ? error.message : 'Could not connect to the demo.'
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [page, setPage] = useState(location.hash.slice(1) || 'schedule')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const main = useRef<HTMLElement>(null)
  const problem = useRef<HTMLDivElement>(null)

  async function load() {
    const result = await api<State>('/api/state')
    setState(result)
  }

  async function initialize() {
    setError('')
    try {
      await load()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        try {
          await api('/api/demo/session', { role: 'director' })
          await load()
          return
        } catch (sessionError) {
          setError(errorText(sessionError))
          return
        }
      }
      setError(errorText(cause))
    }
  }

  useEffect(() => {
    void initialize()
    const sync = () => setPage(location.hash.slice(1) || 'schedule')
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  useEffect(() => { if (error) problem.current?.focus() }, [error])

  const mutate: Mutation = async (path, body = {}, method = 'POST') => {
    setBusy(true)
    setError('')
    try {
      await api(path, body, method)
      await load()
      return true
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setState(null)
      setError(errorText(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  function navigate(id: string) {
    setPage(id)
    location.hash = id
    setError('')
    setConfirmReset(false)
    requestAnimationFrame(() => main.current?.focus())
  }

  async function changeRole(value: string) {
    const role = value.startsWith('t') ? 'teacher' : value as Role
    const body = role === 'teacher' ? { role, teacherId: value } : { role }
    if (await mutate('/api/demo/session', body)) {
      navigate(pages.some(item => item.id === page && item.roles.includes(role)) ? page : 'schedule')
    }
  }

  useEffect(() => {
    if (state && !pages.some(item => item.id === page && item.roles.includes(state.role))) {
      setPage('schedule')
      window.history.replaceState(null, '', '#schedule')
    }
  }, [state, page])

  if (!state) return <main className="startup">
    <span className="brand-icon"><GraduationCap aria-hidden="true"/></span><h1>School in Action</h1>
    {error ? <div ref={problem} tabIndex={-1} role="alert" className="notice stack"><p>{error}</p>
      <div className="actions"><button className="primary" onClick={() => void initialize()}>Retry</button></div></div>
      : <p role="status" className="muted">Loading the demo…</p>}
  </main>
  const available = pages.filter(item => item.roles.includes(state.role))
  const active = available.find(item => item.id === page) ?? available[0]
  const Page = active.component
  const unread = state.activity.filter(item => item.unread).length
  const choice = state.role === 'teacher' ? state.profile.userId : state.role

  return <div className="shell">
    <a className="skip" href="#main-content" onClick={event => { event.preventDefault(); main.current?.focus() }}>Skip to content</a>
    <aside className="sidebar">
      <a className="brand" href="#schedule" onClick={event => { event.preventDefault(); navigate('schedule') }}>
        <span className="brand-icon"><GraduationCap aria-hidden="true"/></span><strong>School in Action</strong>
      </a>
      <nav aria-label="Demo workspace">{available.map(item => <a key={item.id} href={'#' + item.id}
        aria-current={active.id === item.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(item.id) }}>
        <item.icon size={18} aria-hidden="true"/><span>{item.title}</span>
        {item.id === 'activity' && unread > 0 && <span className="unread" aria-label={unread + ' unread'}>{unread}</span>}
      </a>)}</nav>
      <div className="sidebar-footer">
        <span className="avatar" aria-hidden="true">{state.profile.initials}</span>
        <div><strong>{state.profile.name}</strong><small>{state.profile.title} workspace</small></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="demo-label"><span className="demo-dot"/> Fictional school data</div>
        <label className="role-choice">Demo role<select value={choice} disabled={busy} onChange={event => void changeRole(event.target.value)}>
          {profiles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      </header>
      <main id="main-content" ref={main} tabIndex={-1} aria-busy={busy}>
        <div className="heading"><h1>{active.title}</h1>
          {state.role === 'director' && active.id === 'overview' &&
            <button disabled={busy} onClick={() => setConfirmReset(value => !value)}>Reset demo</button>}
        </div>
        {active.id === 'schedule' && <details className="card">
          <summary>What can I try?</summary>
          <div className="stack demo-guide">
            <p><strong>Cover a lesson.</strong> Switch to Maya Brooks, request a substitute for Monday's Biology class, then approve Owen Reed as Director. Jamie's schedule shows the change.</p>
            <p><strong>Follow an assignment.</strong> Publish one as Maya, send an answer as Jamie, then switch back to Maya to review it.</p>
            {state.role !== 'teacher' && <p><strong>See a club receipt.</strong> Open <a href="#receipts" onClick={event => { event.preventDefault(); navigate('receipts') }}>Receipts</a> to download the Robotics club example.</p>}
          </div>
        </details>}
        {confirmReset && <div className="notice stack"><p>Restore the original fictional records? Demo changes will be removed.</p>
          <div className="actions"><button className="primary" disabled={busy} onClick={async () => {
            if (await mutate('/api/demo/reset')) setConfirmReset(false)
          }}>Restore demo records</button><button onClick={() => setConfirmReset(false)}>Cancel</button></div>
        </div>}
        {error && <div ref={problem} tabIndex={-1} role="alert" className="notice error row">
          <p>{error}</p><button onClick={() => setError('')}>Dismiss</button></div>}
        <Page key={active.id + ':' + choice} state={state} busy={busy} mutate={mutate}/>
      </main>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<App/>)
