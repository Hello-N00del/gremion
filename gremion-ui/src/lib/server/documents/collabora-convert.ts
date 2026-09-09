// src/lib/server/documents/collabora-convert.ts
// boundary rule A3a-2: the protocol Collabora conversion helpers, extracted verbatim
// out of protocols/protocol-wopi.ts so the protocol routes can import the
// converters without dragging in $lib/server/files. These render an .odt buffer
// to HTML / PDF via Collabora's convert-to endpoint on COLLABORA_URL (the
// /cool/convert-to/* contract — distinct from the newsletter leaf's
// /lool/convert-to/* on COLLABORA_INTERNAL_URL).
import { env } from '$env/dynamic/private'

export async function convertOdtToHtml(odtBuffer: Buffer): Promise<string> {
  const collaboraUrl = (env.COLLABORA_URL ?? 'http://collabora:9980').replace(/\/$/, '')
  const formData = new FormData()
  formData.append('data', new Blob([new Uint8Array(odtBuffer)], { type: 'application/vnd.oasis.opendocument.text' }), 'doc.odt')
  const res = await fetch(`${collaboraUrl}/cool/convert-to/html`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`Collabora convert failed: ${res.status}`)
  return res.text()
}

export async function convertOdtToPdf(odtBuffer: Buffer): Promise<Buffer> {
  const collaboraUrl = (env.COLLABORA_URL ?? 'http://collabora:9980').replace(/\/$/, '')
  const formData = new FormData()
  formData.append('data', new Blob([new Uint8Array(odtBuffer)], { type: 'application/vnd.oasis.opendocument.text' }), 'doc.odt')
  const res = await fetch(`${collaboraUrl}/cool/convert-to/pdf`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`Collabora convert failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
