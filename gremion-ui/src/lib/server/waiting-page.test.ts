import { describe, expect, it } from 'vitest'
import { waitingResponse } from './waiting-page'

describe('German waiting page', () => {
  it('booting: a 503 HTML page in German that reloads itself and keeps Retry-After', async () => {
    const res = waitingResponse('booting')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    const html = await res.text()
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('Die Anwendung startet gerade')
    expect(html).toMatch(/<meta http-equiv="refresh" content="5">/)
    expect(html).not.toContain('Service Unavailable')
  })

  it('tenant: names the tenant case, no English, no em dash', async () => {
    const html = await waitingResponse('tenant').text()
    expect(html).toContain('Ihr Bereich wird vorbereitet')
    expect(html).not.toContain('Service Unavailable')
    expect(html).not.toContain('—')
  })
})
