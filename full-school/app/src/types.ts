export type Role = 'director' | 'admin' | 'teacher' | 'student' | 'accountant'
export type Lesson = { id: string; day: number; slot: number; time: string; subject: string; className: string; room: string; teacherId: string; teacherName: string; status: 'normal' | 'replacement' | 'completed'; materialId: string }
export type Teacher = { id: string; name: string; initials: string; subject: string; color: string; weeklyHours: number; available: boolean; conflict: string | null }
export type Student = { id: string; name: string; className: string; attendance: number; average: number; progress: number }
export type Task = { id: string; title: string; description: string; category: string; status: 'todo' | 'progress' | 'done'; due: string; owner: string }
export type SchoolDocument = { id: string; title: string; type: string; author: string; date: string; status: 'review' | 'approved' | 'draft'; content: string }
export type Notification = { id: string; title: string; text: string; time: string; read: boolean }
export type HistoryItem = { id: string; title: string; detail: string; time: string; actor: string }
export type Replacement = { id: string; lessonId: string; absentTeacherId: string; teacherId: string | null; reason: string; status: 'pending' | 'approved' | 'completed'; candidates: string[]; candidateDetails?: Teacher[] }
export type Assignment = { id: string; subject: string; title: string; description: string; due: string; status: 'todo' | 'submitted' | 'reviewed'; answer: string; feedback: string; grade: number | null }
export type Material = { id: string; title: string; subject: string; type: string; content: string }
export type AppState = { workspaceMode?: "school" | "demo"; role: Role; profile: { name: string; title: string; initials: string; userId: string }; school: { name: string; students: number; classes: number; teachers: number }; schedule: Lesson[]; teachers: Teacher[]; students: Student[]; tasks: Task[]; documents: SchoolDocument[]; notifications: Notification[]; history: HistoryItem[]; replacements: Replacement[]; assignments: Assignment[]; materials: Material[] }
export type AcademicProps = { state: AppState; page: string; mutate: (path: string, body?: unknown) => Promise<void>; toast: (text: string) => void; navigate: (page: string) => void }
