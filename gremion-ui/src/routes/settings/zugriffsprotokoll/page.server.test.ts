// @vitest-environment node
//
// TRD-092 / PRD-OPS-006: the settings page "Zugriffsprotokoll des Betreibers" is
// council-admin only and shows the request tenant's rows; a read problem is
// shown as a problem, never as an empty list.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ slugs: [] as unknown[], calls: [] as { limit: unknown; before: unknown }[], many: 0, configured: true, fail: false }))

vi.mock('$lib/server/access-records-db', () => {
  class AccessLogNotConfigured extends Error {}
  const sql = (_s: TemplateStringsArray, slug: unknown, limit: unknown, before: unknown) => {
    h.slugs.push(slug)
    h.calls.push({ limit, before })
    if (h.fail) return Promise.reject(new Error('boom'))
    if (h.many > 0) {
      const rows = Array.from({ length: h.many }, (_, i) => ({ access_id: `id-${i}`, at: new Date(Date.UTC(2026, 9, 20, 10, 0, 0) - i * 60_000), origin: 'host', actor: 'deploy', action: 'host_suspend', what: `W ${i}`, why: 'Anforderung der Gremienverwaltung' }))
      return Promise.resolve(rows.slice(0, limit as number))
    }
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

const load = async (isAdmin: boolean, slug = 'tenant-a', query = '') => {
  const { load } = await import('./+page.server')
  return (load as unknown as (e: unknown) => Promise<{ records: { what: string; at: string }[]; problem: string | null; older: string | null; limit: number }>)({
    parent: async () => ({ isAdmin }),
    locals: { tenant: { slug } },
    url: new URL(`http://localhost/settings/zugriffsprotokoll${query}`),
  })
}

beforeEach(() => {
  h.slugs.length = 0
  h.calls.length = 0
  h.many = 0
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

  // r33f MEDIUM: the view used to cut the record at the newest 100 rows with no
  // notice and no way to page; the API supported ?before= but the page never used it.
  it('more rows than one page: shows the newest page and offers the older entries', async () => {
    const { DEFAULT_LIMIT } = await import('$lib/server/access-records')
    h.many = DEFAULT_LIMIT + 5
    const d = await load(true)
    expect(h.calls[0]!.limit).toBe(DEFAULT_LIMIT + 1)
    expect(d.records).toHaveLength(DEFAULT_LIMIT)
    expect(d.limit).toBe(DEFAULT_LIMIT)
    expect(d.older).toBe(d.records[DEFAULT_LIMIT - 1]!.at)
  })

  it('a page that fits offers no older entries', async () => {
    const d = await load(true)
    expect(d.older).toBeNull()
  })

  it('?before= reads the page older than that time; a malformed before reads the newest page', async () => {
    await load(true, 'tenant-a', '?before=2026-10-02T10%3A00%3A00.000Z')
    expect(h.calls[0]!.before).toEqual(new Date('2026-10-02T10:00:00.000Z'))
    await load(true, 'tenant-a', '?before=gestern')
    expect(h.calls[1]!.before).toBeNull()
  })
})
