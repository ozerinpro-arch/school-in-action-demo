import { apiFetch } from './api'

export type CalendarKind = 'weeks' | 'days' | 'exceptions' | 'rules'
export type CalendarRecord = { id: string; archived: boolean; confirmed: boolean; source?: string; note?: string; [key: string]: unknown }
export type CalendarBell = { day: number; slot: number; start: string; end: string }
export type CalendarConfig = { timezone: string; periodStart: string; periodEnd: string; source?: string; confirmed: boolean; note?: string; requiresTravel: boolean; bells?: CalendarBell[] }
export type CalendarData = { revision: number; config: CalendarConfig | null; records: Record<CalendarKind, CalendarRecord[]>; canWrite: boolean; bindingReady?: boolean; bindingBlockers?: { code: string; message: string }[] }
export type CalendarPreview = { calendarRevision: number; previewHash: string; occurrenceCount: number; occurrences: { date: string; startTime: string | null; endTime: string | null }[] }
export type CalendarEffective = { calendarRevision: number; inputHash: string; weekStart: string; weekType?: string; bells?: CalendarBell[]; timezone: string | null; days: { date: string; weekday: number; status: 'school' | 'closed' | 'unknown' }[]; unavailable: { date: string; kind: string; targetId: string; startTime: string | null; endTime: string | null }[]; readiness: { ready: boolean; blockers: { code: string; message: string }[] }; notice: string }
export class CalendarError extends Error {
 constructor(message: string, public status: number) { super(message) }
}
export async function calendarRequest<T>(path = '', body?: unknown, method = 'POST', signal?: AbortSignal): Promise<T> {
 let response: Response
 try {
  response = await apiFetch('/api/school/calendar' + path, body === undefined ? { signal } : { method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
 } catch (error) {
  if (signal?.aborted) throw error
  throw new CalendarError('Нет связи с сервером. Введённые значения сохранены на экране.', 0)
 }
 let data: unknown
 try { data = await response.json() } catch { data = null }
 if (!response.ok) {
  const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : null
  throw new CalendarError(typeof detail === 'string' ? detail : response.status === 409 ? 'Календарь изменился. Обновите версию и проверьте свой ввод.' : 'Не удалось выполнить действие с календарём.', response.status)
 }
 if (data === null) throw new CalendarError('Сервер вернул неполный ответ.', 0)
 return data as T
}
