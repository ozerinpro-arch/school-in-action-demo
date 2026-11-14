import { apiFetch } from './api'

export async function saveReceipt(path: string, id: string, { ownerId, signal }: { ownerId?: string; signal?: AbortSignal } = {}) {
  const response = await apiFetch(path, { signal, headers: ownerId ? { 'X-Learning-Owner': ownerId } : undefined })
  if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf') {
    throw new Error('Could not download the PDF. Refresh the receipt list and try again.')
  }
  const blob = await response.blob()
  if (signal?.aborted) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `club-receipt-${id}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
