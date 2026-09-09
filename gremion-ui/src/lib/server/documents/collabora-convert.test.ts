import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'

// boundary rule A3a-2: the protocol Collabora conversion helpers (convert-to/html and
// convert-to/pdf against COLLABORA_URL) were extracted out of protocols/protocol-wopi
// into the shared documents/ leaf so the protocol routes can import the converters
// without dragging in $lib/server/files. This pins the wire contract verbatim:
//   - POST {COLLABORA_URL}/cool/convert-to/html  -> HTML text
//   - POST {COLLABORA_URL}/cool/convert-to/pdf   -> PDF buffer
//   - default base URL http://collabora:9980 when COLLABORA_URL is unset
//   - a non-ok response throws `Collabora convert failed: <status>`

vi.mock('$env/dynamic/private', () => ({
  env: { COLLABORA_URL: 'http://collabora:9980' }
}))

import { convertOdtToHtml, convertOdtToPdf } from './collabora-convert'

describe('documents/collabora-convert', () => {
  // Match the repo's fetch-mock pattern (vi.stubGlobal + a loose vi.fn()) so the
  // overloaded global fetch signature does not fight svelte-check.
  let fetchSpy: Mock

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('convertOdtToHtml POSTs to /cool/convert-to/html on COLLABORA_URL and returns the HTML body', async () => {
    fetchSpy.mockResolvedValue(new Response('<p>hi</p>', { status: 200 }))
    const html = await convertOdtToHtml(Buffer.from('odt'))
    expect(html).toBe('<p>hi</p>')
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://collabora:9980/cool/convert-to/html')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('convertOdtToPdf POSTs to /cool/convert-to/pdf and returns a Buffer', async () => {
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const pdf = await convertOdtToPdf(Buffer.from('odt'))
    expect(pdf).toBeInstanceOf(Buffer)
    expect([...pdf]).toEqual([1, 2, 3])
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe('http://collabora:9980/cool/convert-to/pdf')
  })

  it('throws "Collabora convert failed: <status>" when convert-to/html is not ok', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }))
    await expect(convertOdtToHtml(Buffer.from('odt'))).rejects.toThrow('Collabora convert failed: 503')
  })

  it('throws "Collabora convert failed: <status>" when convert-to/pdf is not ok', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(convertOdtToPdf(Buffer.from('odt'))).rejects.toThrow('Collabora convert failed: 500')
  })
})
