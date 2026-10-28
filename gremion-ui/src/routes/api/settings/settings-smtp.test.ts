// @vitest-environment node
//
// MED-4: PATCH /api/settings holds smtp.host / smtp.port to the same SSRF guard
// as /api/setup/test-smtp (internal names, private/loopback ranges, non-SMTP ports).
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  writeConfig: vi.fn(),
  readConfig: vi.fn(),
  env: {} as Record<string, string>,
  lookup: vi.fn(),
}))

vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig, writeConfig: h.writeConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$env/dynamic/private', () => ({ env: h.env }))
vi.mock('node:dns/promises', () => ({ lookup: h.lookup }))

import { PATCH } from './+server'

function patch(body: unknown) {
  const request = new Request('http://localhost/api/settings', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals: { auth: async () => ({ user: { id: 'u', roles: ['it-admin'] } }) } })
}

beforeEach(() => {
  h.writeConfig.mockReset()
  h.writeConfig.mockReturnValue({})
  h.readConfig.mockReturnValue({})
  h.lookup.mockReset()
  h.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

describe('PATCH /api/settings smtp guard', () => {
  it('400 for an internal service name on a non-SMTP port', async () => {
    const res = await patch({ smtp: { host: 'postgres', port: 5432 } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('400 for a bare port outside the SMTP set', async () => {
    const res = await patch({ smtp: { port: 5432 } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it.each(['localhost', '127.0.0.1', '169.254.169.254', 'postgres.internal'])('400 for blocked host %s', async (host) => {
    const res = await patch({ smtp: { host, port: 587 } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('400 for a name that resolves to a private address', async () => {
    h.lookup.mockResolvedValue([{ address: '172.18.0.5', family: 4 }])
    const res = await patch({ smtp: { host: 'postgres', port: 587 } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('accepts a public relay on a real SMTP port', async () => {
    const res = await patch({ smtp: { host: 'smtp.example.com', port: 587 } })
    expect(res.status).toBe(200)
    expect(h.writeConfig).toHaveBeenCalled()
  })

  it('accepts clearing the host', async () => {
    const res = await patch({ smtp: { host: '', configured: false } })
    expect(res.status).toBe(200)
  })

  // LOW: the guard runs on the MERGED {...stored, ...patch}; a host-only or
  // port-only PATCH cannot leave a bad stored counterpart in place.
  it('400 for a port-only PATCH when the stored host is internal', async () => {
    h.readConfig.mockReturnValue({ smtp: { host: 'localhost', port: 25 } })
    const res = await patch({ smtp: { port: 587 } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('400 for a host-only PATCH when the stored port is not an SMTP port', async () => {
    h.readConfig.mockReturnValue({ smtp: { host: 'smtp.example.com', port: 5432 } })
    const res = await patch({ smtp: { host: 'smtp.example.org' } })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('200 for a port-only PATCH over a good stored host', async () => {
    h.readConfig.mockReturnValue({ smtp: { host: 'smtp.example.com', port: 25 } })
    const res = await patch({ smtp: { port: 587 } })
    expect(res.status).toBe(200)
  })

  it('unrelated smtp field PATCH is not blocked by a legacy stored value', async () => {
    h.readConfig.mockReturnValue({ smtp: { host: 'localhost', port: 25 } })
    const res = await patch({ smtp: { from_name: 'X' } })
    expect(res.status).toBe(200)
  })
})
