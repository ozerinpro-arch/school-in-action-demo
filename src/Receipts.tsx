import { formatDate, type State } from './api'

export default function Receipts({ state }: { state: State }) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
  return <div className="stack">
    <p className="notice">These PDFs show fictional club charges. No payment was collected.</p>
    {!state.clubs.receipts.length && <p className="card muted">No confirmed club charges yet.</p>}
    {state.clubs.receipts.map(receipt => <article className="card stack" key={receipt.id}>
      <div className="card-title">
        <div><h2>{receipt.programName}</h2><p className="muted">{receipt.studentName}</p></div>
        <span className="badge">{receipt.sample ? 'Sample' : 'Confirmed charge'}</span>
      </div>
      <p>{month.format(Date.UTC(2000, Number(receipt.period.slice(5)) - 1, 1))} {receipt.period.slice(0, 4)} · {money.format(receipt.amountCents / 100)}</p>
      {receipt.confirmedOn && <p className="muted">Confirmed {formatDate(receipt.confirmedOn)}</p>}
      <div className="actions">
        <a className="download-link" href={`/api/clubs/receipts/${receipt.id}/pdf`} download>Download receipt (PDF)</a>
      </div>
    </article>)}
  </div>
}
