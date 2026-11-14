import { apiFetch } from './api'

export type PublicationBlocker = { code: string; message: string }
export type PublishedLesson = { id: string; className: string; day: number; slot: number; start: string; end: string; subject: string; teachers: string[]; rooms: string[]; planningEventId?: string; planningGroups?: unknown[] }
export type PublishedSnapshot = { publicationId: string; schoolId: string; version: number; draftRevision: number; runId: string; periodStart: string; calendarRevision: number; calendarHash: string; lessons: PublishedLesson[]; publishedAt: string }
export type PublicationDelivery = { ready: false; liveEligible: false; status: 'blocked_not_configured'; blockers: PublicationBlocker[] }
export type PublicationStatus = { active: PublishedSnapshot | null; activeVersion: number; draftRevision: number; history: { id: string; version: number; draft_revision: number; run_id: string; created_at: string; actor_id: string }[]; totalCount: number; historyLimit: number; approvedRuns: { runId: string; status: string; configRevision: number; draftRevision: number; periodStart: string; createdAt: string }[]; readiness: { ready: boolean; blockers: PublicationBlocker[] }; canManage: boolean; deliveryReadiness: PublicationDelivery }
export type PublicationArgs = { runId: string; expectedActiveVersion: number; expectedDraftRevision: number }
export type PublicationPreview = { ready: boolean; blockers: PublicationBlocker[]; activeVersion: number; previewHash: string | null; diff: { lessonId: string; before: PublishedLesson | null; after: PublishedLesson | null }[]; evidence?: { runId: string; runHash: string; appliedTaskId: string; approvedBy: { userId: string; displayName: string; role: string; domainRole: string; membershipId: string; membershipRevision: number }; configRevision: number; normativeInputHash: string; calendarBinding: { schoolId: string; calendarRevision: number; inputHash: string; weekStart: string }; effectiveInputHash: string; materializedHash: string; validator: string; validatorSourceHash: string; independentValidation: { valid: boolean }; draftSourceName: string; periodStart: string; draftRevision: number } }
export type PublicationCommand = PublicationArgs & { previewHash: string; requestId: string }
export type PublicationReceipt = { publication: PublishedSnapshot; notice: string; deliveryReadiness: PublicationDelivery }
export class PublicationError extends Error { constructor(message: string, public status: number) { super(message) } }
export async function publicationRequest<T>(path = '', body?: unknown, signal?: AbortSignal): Promise<T> {
 const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
 if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
 const timeout = setTimeout(() => controller.abort(), 20000)
 try {
  let response: Response
  try { response = await apiFetch('/api/school/publications' + path, body === undefined ? { signal: controller.signal } : { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
  catch (error) { if (signal?.aborted) throw error; throw new PublicationError('Связь прервалась или истекло время ожидания. Результат действия пока не подтверждён.', 0) }
  let value: unknown; try { value = await response.json() } catch { value = null }
  if (!response.ok || value === null) {
   const detail = value && typeof value === 'object' && 'detail' in value ? value.detail : null
   throw new PublicationError(typeof detail === 'string' ? detail : 'Не удалось подтвердить результат действия.', response.status)
  }
  return value as T
 } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
