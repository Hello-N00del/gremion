// @vitest-environment node
//
// TRD-092 / PRD-OPS-006: the settings page "Zugriffsprotokoll des Betreibers" is
// council-admin only and shows the request tenant's rows; a read problem is
// shown as a problem, never as an empty list.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ slugs: [] as unknown[], configured: true, fail: false }))

vi.mock('$lib/server/access-records-db', () => {
  class AccessLogNotConfigured extends Error {}
  const sql = (_s: TemplateStringsArray, slug: unknown) => {
    h.slugs.push(slug)
    if (h.fail) return Promise.reject(new Error('boom'))
    return Promise.resolve(slug === 'tenant-a' ? [{ access_id: 'id-1', at: new Date('2026-10-02T10:00:00Z'), origin: 'panel', actor: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', action: 'panel_request', what: 'A eins', why: 'Betreiber-Anforderung im Control-Panel' }] : [])
  }
  return {
    getAccessDb: () => {
      if (!h.configured) throw new AccessLogNotConfigured('x')
      return sql
    },
    AccessLogNotConfigured,
  }
})

const load = async (isAdmin: boolean, slug = 'tenant-a') => {
  const { load } = await import('./+page.server')
  return (load as unknown as (e: unknown) => Promise<{ records: { what: string }[]; problem: string | null }>)({
    parent: async () => ({ isAdmin }),
    locals: { tenant: { slug } },
  })
}

beforeEach(() => {
  h.slugs.length = 0
  h.configured = true
  h.fail = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('settings/zugriffsprotokoll load', () => {
  it("lists the request tenant's records for a council admin", async () => {
    const d = await load(true)
    expect(d.records.map((r) => r.what)).toEqual(['A eins'])
    expect(d.problem).toBeNull()
    expect(h.slugs).toEqual(['tenant-a'])
  })

  it('another tenant sees none of tenant-a rows', async () => {
    expect((await load(true, 'tenant-b')).records).toEqual([])
  })

  it('a non-admin is redirected to /settings and nothing is read', async () => {
    await expect(load(false)).rejects.toMatchObject({ status: 302, location: '/settings' })
    expect(h.slugs).toHaveLength(0)
  })

  it('not configured and a read failure are reported as problems, in German', async () => {
    h.configured = false
    expect((await load(true)).problem).toMatch(/nicht eingerichtet/)
    h.configured = true
    h.fail = true
    expect((await load(true)).problem).toMatch(/nicht gelesen/)
  })
})
