// @vitest-environment node
import { it, expect, vi } from 'vitest'

interface ListOpts {
  search?: string
  username?: string
  exact?: boolean
  max?: number
}

// Models Keycloak: a `search` is a substring match over MANY users (capped by
// `max`); `username`+`exact` is an exact lookup. 'anna' has 6 substring matches,
// and the real 'anna' account sorts last, i.e. beyond a max=5 cap (K1#6).
const many = ['anna.a', 'anna.b', 'anna.c', 'anna.d', 'anna.e', 'anna']
const kc = {
  listUsers: vi.fn(async (o: ListOpts) => {
    if (o.username !== undefined) {
      return o.exact ? many.filter((n) => n === o.username).map((n) => ({ id: `uuid-${n}`, username: n })) : []
    }
    const hits = many.filter((n) => n.includes(o.search ?? '')).map((n) => ({ id: `uuid-${n}`, username: n }))
    return hits.slice(0, o.max ?? 25)
  }),
}
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => kc,
  getKeycloakAdminClientForCurrentTenant: () => kc,
}))

import { resolveHandle } from './resolve-handle'

it('resolves an exact username handle to a UUID', async () => {
  expect(await resolveHandle('anna.b')).toBe('uuid-anna.b')
})

it('returns null on no exact match', async () => {
  expect(await resolveHandle('nobody')).toBeNull()
})

it('K1#6: resolves the exact username even when more than 5 substring matches exist', async () => {
  expect(await resolveHandle('anna')).toBe('uuid-anna')
})

it('K1#6: asks Keycloak for an exact match instead of a capped substring search', async () => {
  kc.listUsers.mockClear()
  await resolveHandle('anna')
  const opts = kc.listUsers.mock.calls[0]![0]
  expect(opts.username).toBe('anna')
  expect(opts.exact).toBe(true)
  expect(opts.search).toBeUndefined()
})
