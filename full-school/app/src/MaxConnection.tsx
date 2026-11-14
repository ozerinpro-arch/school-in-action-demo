import { useEffect, useRef, useState } from 'react'
import { jsonBody, schoolRequest } from './school-ops-api'

type Status = { linked: boolean; canLink: boolean }
type Link = { url: string; expiresAt: number }

export default function MaxConnection() {
 const [status, setStatus] = useState<Status | null>(null), [link, setLink] = useState<Link | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
 const alive = useRef(true), sequence = useRef(0), writing = useRef(false)
 async function refresh() {
  const expected = ++sequence.current
  try {
   const value = await schoolRequest<Status>('/api/school/integrations/max/me')
   if (!alive.current || expected !== sequence.current) return
   setStatus(value); setError(''); if (value.linked) setLink(null)
  } catch { if (alive.current && expected === sequence.current) setError('Не удалось проверить личную связь MAX. Повторите проверку.') }
 }
 useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; sequence.current++ } }, [])
 useEffect(() => {
  if (!link) return
  const timer = setTimeout(() => setLink(null), Math.max(0, link.expiresAt - Date.now()))
  return () => clearTimeout(timer)
 }, [link])
 async function change(action: 'link' | 'revoke') {
  if (writing.current) return
  writing.current = true; sequence.current++; setBusy(true); setError('')
  try {
   if (action === 'link') {
    const value = await schoolRequest<Link>('/api/school/integrations/max/link', jsonBody({}))
    const url = new URL(value.url)
    if (url.origin !== 'https://max.ru' || !/^\/[A-Za-z0-9_]{3,80}$/.test(url.pathname) || url.hash || url.username || url.password || [...url.searchParams.keys()].join() !== 'start' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('start') || '') || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('Invalid personal link')
    if (alive.current) setLink(value)
   } else {
    await schoolRequest('/api/school/integrations/max/revoke', jsonBody({}))
    if (alive.current) { setLink(null); await refresh() }
   }
  } catch { if (alive.current) setError('Операция не подтверждена. Проверьте состояние связи перед повтором.') }
  finally { writing.current = false; if (alive.current) setBusy(false) }
 }
 // The current layout is unchanged until personal MAX connection is configured.
 if (!status?.canLink) return null
 return <section aria-label="Личная связь MAX">
  <p>{status.linked ? 'Ваш MAX связан со школьным кабинетом.' : 'Подтвердите свой MAX одноразовой ссылкой из личного кабинета.'}</p>
  {error && <p role="alert">{error}</p>}
  <div className="sg-actions">
   {!status.linked && <button className="sg-control" disabled={busy} onClick={() => void change('link')}>Получить личную ссылку MAX</button>}
   {status.linked && <button className="sg-control" disabled={busy} onClick={() => void change('revoke')}>Отключить мою связь MAX</button>}
   <button className="sg-control" disabled={busy} onClick={() => void refresh()}>Проверить связь MAX</button>
   {link && <a className="sg-control" href={link.url} target="_blank" rel="noreferrer noopener">Открыть бота MAX</a>}
  </div>
 </section>
}
