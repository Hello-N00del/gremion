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
    expect(html).toMatch(/<meta http-equiv="refresh" content="5">/)
  })

  // A tenant that failed its migration does not heal by waiting. A page that reloads itself every
  // few seconds (and starts a retry each time) would promise "a few seconds" forever, so the failed
  // case is honest German copy, no self-reload and a long Retry-After.
  it('tenant-failed: says so, does not reload itself, asks machine callers to wait longer', async () => {
    const res = waitingResponse('tenant-failed')
    expect(res.status).toBe(503)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(60)
    const html = await res.text()
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('Ihr Bereich ist gerade nicht verfügbar')
    expect(html).not.toContain('http-equiv="refresh"')
    expect(html).not.toContain('wenige Sekunden')
    expect(html).not.toContain('von selbst neu')
    expect(html).not.toContain('Service Unavailable')
    expect(html).not.toContain('—')
  })
})
