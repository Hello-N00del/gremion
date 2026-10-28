// @vitest-environment node
//
// TRD-092 / PRD-OPS-006: the council administrator reads the record of vendor
// and operator access to THEIR council's data inside the product. The route is
// admin-only and tenant-scoped: the slug comes from the resolved request tenant
// (locals.tenant), never from the query; a non-admin gets 403 and the database
// is not asked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Row { access_id: string; at: Date; origin: string; actor: string; action: string; what: string; why: string }

const h = vi.hoisted(() => ({
  calls: [] as { slug: unknown; limit: unknown; before: unknown }[],
  data: {} as Record<string, unknown[]>,
  configured: true,
}))

// A stand-in for the reader role's pool: oac.list_access_records(slug, limit, before) returns that slug's rows only.
vi.mock('$lib/server/access-records-db', () => {
  const sql = (_s: TemplateStringsArray, slug: unknown, limit: unknown, before: unknown) => {
    h.calls.push({ slug, limit, before })
    return Promise.resolve((h.data[slug as string] ?? []).slice(0, limit as number))
  }
  class AccessLogNotConfigured extends Error {}
  return {
    getAccessDb: () => {
      if (!h.configured) throw new AccessLogNotConfigured('PLATFORM_ACCESS_DATABASE_URL not configured')
      return sql
    },
    AccessLogNotConfigured,
  }
})

const row = (n: number, what: string): Row => ({ access_id: `0192f0c4-0000-7000-8000-00000000000${n}`, at: new Date(`2026-10-0${n}T10:00:00Z`), origin: 'host', actor: 'deploy', action: 'host_suspend', what, why: 'Anforderung der Gremienverwaltung' })

function event(roles: string[] | null, slug = 'tenant-a', query = '') {
  return {
    locals: { auth: async () => (roles ? { user: { roles } } : null), tenant: { slug } },
    url: new URL(`http://localhost/api/settings/zugriffsprotokoll${query}`),
  } as never
}

beforeEach(() => {
  h.calls.length = 0
  h.configured = true
  h.data = {
    'tenant-a': [row(2, 'A zwei'), row(1, 'A eins')],
    'tenant-b': [row(3, 'B geheim')],
  }
})

describe('GET /api/settings/zugriffsprotokoll', () => {
  it("tenant A's council admin sees tenant A's records only, newest first, with who/when/what/why", async () => {
    const { GET } = await import('./+server')
    const res = await GET(event(['council-admin'], 'tenant-a'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.records.map((r: { what: string }) => r.what)).toEqual(['A zwei', 'A eins'])
    expect(body.data.records[0]).toMatchObject({ actor: 'deploy', origin: 'host', action: 'host_suspend', why: 'Anforderung der Gremienverwaltung', at: '2026-10-02T10:00:00.000Z' })
    expect(JSON.stringify(body)).not.toContain('B geheim')
    expect(h.calls.map((c) => c.slug)).toEqual(['tenant-a'])
  })

  it("tenant B's admin sees B's record and never A's", async () => {
    const { GET } = await import('./+server')
    const body = await (await GET(event(['it-admin'], 'tenant-b'))).json()
    expect(body.data.records.map((r: { what: string }) => r.what)).toEqual(['B geheim'])
  })

  it('a slug in the query string does not widen the scope: the request tenant decides', async () => {
    const { GET } = await import('./+server')
    const body = await (await GET(event(['council-admin'], 'tenant-a', '?slug=tenant-b&tenant=tenant-b'))).json()
    expect(h.calls.map((c) => c.slug)).toEqual(['tenant-a'])
    expect(JSON.stringify(body)).not.toContain('B geheim')
  })

  it.each([['a member', ['member']], ['a finance user', ['finance']], ['a guest', ['guest']], ['an auditor', ['auditor']]])('%s gets 403 and the database is not asked', async (_n, roles) => {
    const { GET } = await import('./+server')
    const res = await GET(event(roles))
    expect(res.status).toBe(403)
    expect(h.calls).toHaveLength(0)
  })

  it('no session gets 403', async () => {
    const { GET } = await import('./+server')
    expect((await GET(event(null))).status).toBe(403)
    expect(h.calls).toHaveLength(0)
  })

  it('without a resolved tenant the answer is 400 and nothing is read (never a default tenant)', async () => {
    const { GET } = await import('./+server')
    const e = event(['council-admin']) as unknown as { locals: { tenant: unknown } }
    e.locals.tenant = null
    expect((await GET(e as never)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })

  it('clamps the limit (1..200, default 100) and passes a valid cursor', async () => {
    const { GET } = await import('./+server')
    await GET(event(['council-admin'], 'tenant-a', '?limit=100000&before=2026-10-02T10:00:00Z'))
    await GET(event(['council-admin'], 'tenant-a', '?limit=abc'))
    expect(h.calls[0]).toMatchObject({ limit: 200 })
    expect(h.calls[0]!.before).toBeInstanceOf(Date)
    expect(h.calls[1]).toMatchObject({ limit: 100, before: null })
    expect((await GET(event(['council-admin'], 'tenant-a', '?before=not-a-date'))).status).toBe(400)
  })

  it('answers 503 with a German message when the read role is not configured (not an empty list that would read as "no access")', async () => {
    h.configured = false
    const { GET } = await import('./+server')
    const res = await GET(event(['council-admin']))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/nicht eingerichtet|nicht konfiguriert/)
  })
})
