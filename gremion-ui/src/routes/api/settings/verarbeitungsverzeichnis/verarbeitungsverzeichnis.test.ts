// @vitest-environment node
//
// TRD-162: /api/settings/verarbeitungsverzeichnis. Real config.ts against real
// per-tenant files; only the tenant resolver and the role check are stubbed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hasRole: vi.fn(),
  tenant: { current: null as null | { id: string; configPath: string } },
}))
vi.mock('$lib/auth', () => ({ hasRole: h.hasRole, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$lib/server/tenant/context', () => ({
  requireTenant: () => {
    if (!h.tenant.current) throw new Error('no tenant')
    return h.tenant.current
  },
}))

const dir = mkdtempSync(join(tmpdir(), 'vvt-'))
const A = { id: 'a', configPath: join(dir, 'a.json') }
const B = { id: 'b', configPath: join(dir, 'b.json') }
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const locals = { auth: async () => ({ user: { roles: ['x'] } }) }
async function get() {
  const { GET } = await import('./+server')
  // @ts-expect-error partial event
  return GET({ locals })
}
async function patch(body: unknown) {
  const { PATCH } = await import('./+server')
  const request = new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals })
}

beforeEach(() => {
  writeFileSync(A.configPath, JSON.stringify({ compliance: { controller_name: 'Kunde A' } }))
  writeFileSync(B.configPath, JSON.stringify({ compliance: { controller_name: 'Kunde B' } }))
  h.tenant.current = A
  h.hasRole.mockReset().mockReturnValue(true)
})

describe('/api/settings/verarbeitungsverzeichnis', () => {
  it('GET returns the generated document and activities for an admin', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.document).toContain('Kunde A')
    expect(body.data.activities.length).toBeGreaterThan(0)
  })

  it('non-admin gets 403 on GET and PATCH and nothing is written', async () => {
    h.hasRole.mockReturnValue(false)
    expect((await get()).status).toBe(403)
    expect((await patch({ overrides: { core: { purpose: 'Eigener Zweck' } } })).status).toBe(403)
    h.hasRole.mockReturnValue(true)
    const doc = (await (await get()).json()).data.document
    expect(doc).not.toContain('Eigener Zweck')
  })

  it('unauthenticated gets 403', async () => {
    const { GET } = await import('./+server')
    // @ts-expect-error partial event
    expect((await GET({ locals: { auth: async () => null } })).status).toBe(403)
  })

  it('PATCH persists overrides, which then show up in GET', async () => {
    const res = await patch({ overrides: { core: { purpose: 'Eigener Zweck', data_categories: ['X'] } } })
    expect(res.status).toBe(200)
    const body = await (await get()).json()
    expect(body.data.document).toContain('Eigener Zweck')
    const core = body.data.activities.find((a: { moduleId: string }) => a.moduleId === 'core')
    expect(core.overridden).toBe(true)
  })

  it('PATCH leaves the Löschkonzept compliance fields untouched', async () => {
    await patch({ overrides: { core: { purpose: 'Eigener Zweck' } } })
    const { readConfig } = await import('$lib/server/config')
    expect(readConfig(A).compliance.controller_name).toBe('Kunde A')
  })

  it('rejects an unknown module id, oversized input and unknown fields', async () => {
    expect((await patch({ overrides: { nope: { purpose: 'x' } } })).status).toBe(400)
    expect((await patch({ overrides: { core: { purpose: 'x'.repeat(3000) } } })).status).toBe(400)
    expect((await patch({ overrides: { core: { bogus: 'x' } } })).status).toBe(400)
  })

  it('tenant A cannot read or influence tenant B', async () => {
    await patch({ overrides: { core: { purpose: 'Nur Kunde A' } } })
    h.tenant.current = B
    const body = await (await get()).json()
    expect(body.data.document).toContain('Kunde B')
    expect(body.data.document).not.toContain('Nur Kunde A')
    expect(body.data.document).not.toContain('Kunde A')
  })
})
