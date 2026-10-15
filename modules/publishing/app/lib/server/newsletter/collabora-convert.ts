import { env } from '$env/dynamic/private'

function getCollaboraInternalUrl(): string {
  const url = env.COLLABORA_INTERNAL_URL
  if (!url) throw new Error('COLLABORA_INTERNAL_URL is not configured')
  return url.replace(/\/$/, '')
}

/**
 * Converts an .odt binary buffer to HTML via Collabora's convert-to endpoint.
 * Uses the Docker-internal Collabora URL (not the browser-facing one).
 */
export async function convertOdtToHtml(odtBuffer: ArrayBuffer): Promise<string> {
  const baseUrl = getCollaboraInternalUrl()
  const formData = new FormData()
  formData.append(
    'data',
    new Blob([odtBuffer], { type: 'application/vnd.oasis.opendocument.text' }),
    'document.odt'
  )
  const res = await fetch(`${baseUrl}/lool/convert-to/html`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200)).catch(() => '')
    throw new Error(`Collabora convert-to/html failed: ${res.status} ${snippet}`)
  }
  return res.text()
}

/**
 * Creates a new empty .odt by asking Collabora to convert an empty HTML document.
 * Returns the .odt as an ArrayBuffer.
 */
export async function createEmptyOdt(): Promise<ArrayBuffer> {
  const baseUrl = getCollaboraInternalUrl()
  const formData = new FormData()
  formData.append(
    'data',
    new Blob(['<html><body><p></p></body></html>'], { type: 'text/html' }),
    'empty.html'
  )
  const res = await fetch(`${baseUrl}/lool/convert-to/odt`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200)).catch(() => '')
    throw new Error(`Collabora convert-to/odt failed: ${res.status} ${snippet}`)
  }
  return res.arrayBuffer()
}
