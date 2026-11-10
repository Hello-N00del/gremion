// @vitest-environment node
// listGroupTree: the recipient picker needs every group, not only the top level
// (a body such as a board is a subgroup). listGroups stays top-level only, for
// the callers that rely on that.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeycloakAdminClient } from '$lib/server/keycloak-admin'

const BASE = 'http://kc-test:8080'
const PREFIX = `${BASE}/admin/realms/r1`

type Group = { id: string; name: string; path?: string; subGroupCount?: number }

/** Fetch stub: token endpoint plus a map from admin path (under the realm) to a
 *  JSON answer, or to a status code for a failure. Records every admin path. */
function stubKc(routes: Record<string, Group[] | number>): string[] {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
      }
      const path = url.slice(PREFIX.length).replace(/\?.*$/, '')
      seen.push(path)
      const hit = routes[path]
      if (typeof hit === 'number') return new Response('{}', { status: hit })
      return new Response(JSON.stringify(hit ?? []), { status: 200 })
    }),
  )
  return seen
}

/** Like stubKc, but honours first/max on /children and applies Keycloak's
 *  default page size of 10 when max is absent. */
function stubPaged(routes: Record<string, Group[]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
      }
      const [rawPath, query = ''] = url.slice(PREFIX.length).split('?')
      const q = new URLSearchParams(query)
      const all = routes[rawPath] ?? []
      if (!rawPath.endsWith('/children')) return new Response(JSON.stringify(all), { status: 200 })
      const first = Number(q.get('first') ?? 0)
      const max = Number(q.get('max') ?? 10)
      return new Response(JSON.stringify(all.slice(first, first + max)), { status: 200 })
    }),
  )
}

const client = () => new KeycloakAdminClient(BASE, 'r1', 'cid', 'secret')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listGroupTree', () => {
  it('returns every level as one flat list, ordered by path', async () => {
    stubKc({
      '/groups': [
        { id: 'b', name: 'Referate', path: '/Referate' },
        { id: 'a', name: 'Studierendenrat', path: '/Studierendenrat' },
      ],
      '/groups/a/children': [{ id: 'a1', name: 'Vorstand', path: '/Studierendenrat/Vorstand' }],
      '/groups/a1/children': [{ id: 'a11', name: 'Kasse', path: '/Studierendenrat/Vorstand/Kasse' }],
    })
    const tree = await client().listGroupTree()
    expect(tree.map((g) => g.path)).toEqual([
      '/Referate',
      '/Studierendenrat',
      '/Studierendenrat/Vorstand',
      '/Studierendenrat/Vorstand/Kasse',
    ])
  })

  it('builds the path from the parent when Keycloak omits it on a child', async () => {
    stubKc({
      '/groups': [{ id: 'a', name: 'Rat', path: '/Rat' }],
      '/groups/a/children': [{ id: 'a1', name: 'Vorstand' }],
    })
    const tree = await client().listGroupTree()
    expect(tree.find((g) => g.id === 'a1')?.path).toBe('/Rat/Vorstand')
  })

  it('does not ask for the children of a group that reports none', async () => {
    const seen = stubKc({ '/groups': [{ id: 'a', name: 'Rat', path: '/Rat', subGroupCount: 0 }] })
    await client().listGroupTree()
    expect(seen).toEqual(['/groups'])
  })

  it('keeps what it has when the children of one group cannot be read', async () => {
    stubKc({
      '/groups': [
        { id: 'a', name: 'Rat', path: '/Rat' },
        { id: 'b', name: 'Referate', path: '/Referate' },
      ],
      '/groups/a/children': 500,
      '/groups/b/children': [{ id: 'b1', name: 'IT', path: '/Referate/IT' }],
    })
    const tree = await client().listGroupTree()
    expect(tree.map((g) => g.path)).toEqual(['/Rat', '/Referate', '/Referate/IT'])
  })

  it('fails when the top level cannot be read, so the caller can fall back', async () => {
    stubKc({ '/groups': 500 })
    await expect(client().listGroupTree()).rejects.toThrow(/Keycloak Admin API error: 500/)
  })

  it('stops on a cycle instead of looping', async () => {
    stubKc({
      '/groups': [{ id: 'a', name: 'Rat', path: '/Rat' }],
      '/groups/a/children': [{ id: 'a', name: 'Rat', path: '/Rat' }],
    })
    const tree = await client().listGroupTree()
    expect(tree).toHaveLength(1)
  })

  it('listGroups still returns the top level only', async () => {
    const seen = stubKc({ '/groups': [{ id: 'a', name: 'Rat', path: '/Rat' }] })
    const top = await client().listGroups()
    expect(top).toHaveLength(1)
    expect(seen).toEqual(['/groups'])
  })

  it('reads every child of a group, because Keycloak pages /children at 10 by default', async () => {
    const kids = Array.from({ length: 12 }, (_, i) => ({
      id: `k${String(i).padStart(2, '0')}`,
      name: `K${String(i).padStart(2, '0')}`,
      path: `/Rat/K${String(i).padStart(2, '0')}`,
      subGroupCount: 0,
    }))
    stubPaged({ '/groups': [{ id: 'a', name: 'Rat', path: '/Rat', subGroupCount: 12 }], '/groups/a/children': kids })
    const tree = await client().listGroupTree()
    expect(tree).toHaveLength(13)
  })

  it('logs the group id and the error class when a branch cannot be read, and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stubKc({
      '/groups': [{ id: 'grp-7', name: 'Rat', path: '/Rat' }],
      '/groups/grp-7/children': 403,
    })
    const tree = await client().listGroupTree()
    expect(tree.map((g) => g.path)).toEqual(['/Rat'])
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(line).toContain('grp-7')
    expect(line).toContain('KcAdminError')
    expect(line).toContain('403')
    warn.mockRestore()
  })

  it('logs once when the walk is cut short by the size bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `g${i}`,
      name: `G${i}`,
      path: `/G${i}`,
      subGroupCount: 0,
    }))
    stubPaged({ '/groups': many })
    const tree = await client().listGroupTree()
    expect(tree).toHaveLength(500)
    expect(warn.mock.calls.filter((c) => c.join(' ').includes('truncated'))).toHaveLength(1)
    warn.mockRestore()
  })
})
