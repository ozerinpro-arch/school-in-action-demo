import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'

export type SchoolRecordKind = 'students' | 'teacherProfiles' | 'tasks' | 'documents' | 'assignments' | 'materials' | 'absences' | 'notifications'
export type SchoolRecord = { id: string; createdAt: string; updatedAt: string; archived: boolean; [field: string]: string | number | boolean | null }
export type SchoolTeacherLabel = { key: string; name: string; lessonCount: number; classNames: string[]; subjects: string[] }
export type SchoolWorkspace = {
 revision: number
 school: { name: string }
 source: { sourceName: string; revision: number; lessonCount: number; issueCount: number }
 directory: { teachers: SchoolTeacherLabel[]; classes: { name: string; lessonCount: number }[]; rooms: { name: string; lessonCount: number }[] }
 records: Record<SchoolRecordKind, SchoolRecord[]> & { [kind: string]: SchoolRecord[] }
 history: { id: string; at: string; actor: string; action: string; kind: string; recordId: string; title: string }[]
 settings: { schoolName: string; academicYear: string; note: string }
}
export class SchoolApiError extends Error {
 constructor(message: string, public status: number) { super(message); this.name = 'SchoolApiError' }
}
export const jsonBody = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export async function schoolRequest<T>(path: string, options?: RequestInit): Promise<T> {
 let response: Response
 try { response = await apiFetch(path, options) }
 catch (cause) {
  if (options?.signal?.aborted) throw cause
  throw new SchoolApiError('Нет связи с сервером. Ваш ввод сохранён. Повторите действие.', 0)
 }
 let data: unknown
 try { data = await response.json() } catch { data = undefined }
 if (!response.ok) {
  const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : null
  throw new SchoolApiError(typeof detail === 'string' ? detail : response.status === 409 ? 'Данные уже изменились. Обновите версию и проверьте свой ввод.' : response.status === 403 ? 'Этот раздел доступен директору и завучу.' : response.status === 401 ? 'Войдите в школьный кабинет.' : 'Не удалось выполнить действие. Повторите попытку.', response.status)
 }
 if (data === undefined) throw new SchoolApiError('Сервер вернул неполный ответ. Повторите загрузку.', 0)
 return data as T
}
export function useSchoolWorkspace() {
 const [data, setData] = useState<SchoolWorkspace | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
 const controller = useRef<AbortController | null>(null)
 const reload = useCallback(async (): Promise<SchoolWorkspace | null> => {
  controller.current?.abort()
  const next = new AbortController(); controller.current = next
  setLoading(true); setError('')
  try {
   const result = await schoolRequest<SchoolWorkspace>('/api/school/workspace', { signal: next.signal })
   if (!result || !Number.isInteger(result.revision) || !result.source || !result.directory || !Array.isArray(result.directory.teachers) || !Array.isArray(result.directory.classes) || !Array.isArray(result.directory.rooms) || !result.records || (['students', 'teacherProfiles', 'tasks', 'documents', 'assignments', 'materials', 'absences', 'notifications'] as const).some(kind => !Array.isArray(result.records[kind])) || !Array.isArray(result.history) || !result.settings) throw new Error('Школьные данные не удалось прочитать. Повторите загрузку.')
   if (next.signal.aborted) return null
   setData(result); return result
  } catch (cause) {
   if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить школьные данные.')
   return null
  } finally { if (!next.signal.aborted) setLoading(false) }
 }, [])
 useEffect(() => {
  void reload()
  const changed = () => { void reload() }
  window.addEventListener('school-ops-updated', changed)
  window.addEventListener('school-timetable-updated', changed)
  return () => { controller.current?.abort(); window.removeEventListener('school-ops-updated', changed); window.removeEventListener('school-timetable-updated', changed) }
 }, [reload])
 return { data, loading, error, reload }
}
export const activeSchoolRecords = (records: SchoolRecord[]) => records.filter(record => !record.archived)
export const schoolRecordText = (record: SchoolRecord, key: string) => typeof record[key] === 'string' ? record[key] as string : ''
export const schoolCanonical = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru')
