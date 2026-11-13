export type Role = 'director' | 'teacher' | 'student'
export type Profile = { role: Role; userId: string; name: string; title: string; initials: string }
export type Person = { id: string; name: string; className: string }
export type Teacher = { id: string; name: string; subject: string }
export type Lesson = {
  id: string; day: string; start: string; end: string; className: string
  teacherId: string; teacherName: string; subject: string; room: string; topic: string
  status: 'normal' | 'replacement' | 'completed'
}
export type Substitute = { id: string; name: string; room: string; conflict: string | null }
export type Substitution = {
  id: string; lessonId: string; lesson: Lesson; reason: string; absentTeacherId: string
  teacherId: string | null; status: 'pending' | 'approved' | 'completed'; candidates: Substitute[]
}
export type Assignment = {
  id: string; title: string; instructions: string; dueDate: string; studentId: string; subject: string
  status: 'open' | 'submitted' | 'reviewed'; answer: string; score: number | null; feedback: string
}
export type Program = {
  id: string; name: string; description: string; meetingTime: string
  capacity: number; enrolledCount: number; feeCents: number; archived: boolean
}
export type Enrollment = { programId: string; studentId: string; status: 'enrolled' | 'withdrawn' }
export type Charge = {
  id: string; programId: string; programName?: string; studentId: string; period: string; amountCents: number
  status: 'draft' | 'confirmed' | 'cancelled'
}
export type Receipt = {
  id: string; programName: string; studentName: string; period: string
  amountCents: number; confirmedOn: string | null; sample: boolean
}
export type State = {
  role: Role; profile: Profile; schedule: Lesson[]; students: Person[]; teachers: Teacher[]
  replacements: Substitution[]; assignments: Assignment[]
  assignmentTargets: { className: string; subject: string }[]
  materials: { id: string; lessonId: string; title: string; content: string }[]
  tasks: { id: string; title: string; description: string; status: string; owner: string }[]
  documents: { id: string; title: string; content: string; status: string }[]
  activity: { id: string; title: string; actor: string; at: string; unread: boolean }[]
  clubs: { programs: Program[]; enrollments: Enrollment[]; charges: Charge[]; receipts: Receipt[] }
}

export type Mutation = (path: string, body?: unknown, method?: string) => Promise<boolean>

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new ApiError(response.status, typeof result?.detail === 'string' ? result.detail : 'The server could not complete the request.')
  }
  return response.json()
}

export function formValues(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form))
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value))
}
