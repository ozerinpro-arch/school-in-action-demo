/// <reference types="vite/client" />

export const APP_BASE = import.meta.env.BASE_URL
export const PORTAL_MODE = import.meta.env.VITE_PORTAL_MODE === 'true'
export const STAFF_MODE = import.meta.env.VITE_STAFF_MODE === 'true'
export const PORTAL_HOME = '/school-staff/'
export const PORTAL_LOGIN = '/client/login'
export const SESSION_EXPIRED_EVENT = 'school-portal-session-expired'

export const appUrl = (path: string) => `${APP_BASE}${path.replace(/^\/+/, '')}`

export function apiUrl(path: string): string {
 const relative = path.replace(/^\//, '')
 const url = new URL(relative, `https://school.invalid${APP_BASE}`)
 if (!relative.startsWith('api/') || url.origin !== 'https://school.invalid' || !url.pathname.startsWith(`${APP_BASE}api/`)) {
  throw new Error('API школы должен находиться внутри базового пути приложения.')
 }
 return `${url.pathname}${url.search}`
}

let csrfToken: string | undefined
let csrfRequest: Promise<string> | undefined
let loginStarted = false

/** Session rotation invalidates the cached CSRF credential. */
export function resetApiSession() {
 csrfToken = undefined
 csrfRequest = undefined
 loginStarted = false
}

function checkSession(response: Response) {
 if (!PORTAL_MODE || ![401, 403].includes(response.status)) return
 csrfToken = undefined
 csrfRequest = undefined
 if (response.status !== 401 || typeof window === 'undefined') return
 window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  if (STAFF_MODE) return
 if (!loginStarted && window.location.pathname !== PORTAL_LOGIN) {
  loginStarted = true
  try { window.location.assign(PORTAL_LOGIN) } catch { /* Keep the sign-in link available if navigation is blocked. */ }
 }
}

async function portalCsrfToken(): Promise<string> {
 if (csrfToken) return csrfToken
 if (csrfRequest) return csrfRequest
 const pending = (async () => {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000)
  try {
   const response = await fetch(apiUrl('/api/portal-session'), { credentials: 'same-origin', signal: controller.signal })
   checkSession(response)
   if (!response.ok) throw new Error(response.status === 401 ? 'Войдите в личный кабинет, чтобы продолжить.' : 'Не удалось подтвердить доступ к школьному кабинету. Повторите действие.')
   const session: unknown = await response.json()
   if (!session || typeof session !== 'object' || !('csrfToken' in session) || typeof session.csrfToken !== 'string' || !session.csrfToken) {
    throw new Error('Портал не подтвердил защиту запроса. Повторите действие.')
   }
   csrfToken = session.csrfToken
   return csrfToken
  }
  finally { clearTimeout(timeout) }
 })()
 csrfRequest = pending
 try { return await pending }
 finally { if (csrfRequest === pending) csrfRequest = undefined }
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
 if (!signal) return pending
 if (signal.aborted) return Promise.reject(signal.reason)
 return new Promise((resolve, reject) => {
  const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason) }
  signal.addEventListener('abort', cancel, { once: true })
  pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
 })
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
 const url = apiUrl(path)
 const headers = new Headers(options.headers)
 if (PORTAL_MODE) {
  headers.delete('X-CSRF-Token')
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) {
   if (options.signal?.aborted) throw options.signal.reason
   headers.set('X-CSRF-Token', await abortable(portalCsrfToken(), options.signal))
  }
 }
 const response = await fetch(url, { ...options, headers, credentials: 'same-origin' })
 checkSession(response)
 return response
}
