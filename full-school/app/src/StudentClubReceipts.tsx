import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { saveReceipt } from './club-receipt-api'
import type { useLearningClient } from './student-learning-api'

const PATH = '/api/student/clubs/receipts'
type Receipt = { id: string; programTitle: string; period: string; amountKopeks: number }
type Receipts = { receipts: Receipt[] }

function validReceipts(value: unknown): value is Receipts {
  if (!value || typeof value !== 'object' || !('receipts' in value) || !Array.isArray(value.receipts)) return false
  return value.receipts.length <= 10000 && value.receipts.every(row => row && typeof row.id === 'string' &&
    /^charge-[a-f0-9]{32}$/.test(row.id) && typeof row.programTitle === 'string' && row.programTitle.length <= 320 &&
    typeof row.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.period) &&
    Number.isSafeInteger(row.amountKopeks) && row.amountKopeks >= 0 && row.amountKopeks <= 10_000_000_000)
}

export default function StudentClubReceipts({ client, ownerId }: { client: ReturnType<typeof useLearningClient>; ownerId: string }) {
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const download = useRef<AbortController | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; download.current?.abort() }
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const result = await client.request(PATH, validReceipts)
      if (alive.current) setReceipts(result.receipts)
    } catch {
      if (alive.current) {
        setReceipts(null)
        setError('Could not load your club receipts. Try again.')
      }
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  async function save(id: string) {
    if (download.current) return
    const controller = new AbortController()
    download.current = controller
    setDownloading(id)
    setError('')
    try {
      await saveReceipt(`${PATH}/${id}/receipt.pdf`, id, { ownerId, signal: controller.signal })
    } catch {
      if (alive.current) setError('Could not download the PDF. Refresh your receipt list and try again.')
    } finally {
      download.current = null
      if (alive.current) setDownloading(null)
    }
  }

  return <section className="sg-panel" aria-labelledby="student-club-receipts-title">
    <div className="sg-section-heading">
      <h2 id="student-club-receipts-title">Club receipts</h2>
      <button type="button" className="sg-control" disabled={loading || downloading !== null || client.authority !== 'current'} onClick={() => void load()}>
        <RefreshCw size={16} aria-hidden="true"/>{loading ? 'Loading receipts…' : receipts ? 'Refresh receipts' : 'Show receipts'}
      </button>
    </div>
    <p className="sl-muted">Confirmed demo charges. No payment is processed.</p>
    {error && <p className="sl-error" role="alert">{error}</p>}
    {receipts?.length === 0 && <p>You have no confirmed club receipts.</p>}
    {!!receipts?.length && <ul className="sl-list">{receipts.map(row => <li key={row.id}>
      <div className="sl-actions"><strong>{row.programTitle}</strong><span>{row.period} · {Math.trunc(row.amountKopeks / 100).toLocaleString('en-GB')}.{String(row.amountKopeks % 100).padStart(2, '0')} RUB</span>
        <button type="button" className="sg-control" disabled={loading || downloading !== null || client.authority !== 'current'} onClick={() => void save(row.id)}>
          <Download size={16} aria-hidden="true"/>{downloading === row.id ? 'Downloading…' : 'Download PDF'}
        </button>
      </div>
    </li>)}</ul>}
  </section>
}
