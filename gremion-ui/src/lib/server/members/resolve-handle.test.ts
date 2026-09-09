// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

const kc = {
  listUsers: vi.fn(async ({ search }: { search?: string }) =>
    search === 'anna.berger' ? [{ id: 'uuid-anna', username: 'anna.berger' }] : [],
  ),
}
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => kc,
  getKeycloakAdminClientForCurrentTenant: () => kc,
}))

import { resolveHandle } from './resolve-handle'

it('resolves an exact username handle to a UUID', async () => {
  expect(await resolveHandle('anna.berger')).toBe('uuid-anna')
})

it('returns null on no exact match', async () => {
  expect(await resolveHandle('nobody')).toBeNull()
})
