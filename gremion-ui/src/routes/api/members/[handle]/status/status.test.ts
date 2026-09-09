// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

const kc = { updateUser: vi.fn(async () => {}) }
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => kc }))
vi.mock('$lib/server/members/resolve-handle', () => ({
  resolveHandle: vi.fn(async (h: string) => (h === 'anna.berger' ? 'uuid-anna' : null)),
}))

import { PATCH } from './+server'

// Auth is read via locals.auth() (same as /api/users/[id]) and gated on
// Role.CouncilAdmin (admits IT-Team by hierarchy). The mocked locals expose an
// async auth() returning the session.
const eventFor = (roles: string[], body: unknown, handle = 'anna.berger') => ({
  params: { handle },
  request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
  locals: { auth: async () => ({ user: { id: 'u1', roles } }) },
})

it('disables a member for a council-admin', async () => {
  const res = await PATCH(eventFor(['council-admin'], { enabled: false }) as never)
  expect(res.status).toBe(200)
  expect(kc.updateUser).toHaveBeenCalledWith('uuid-anna', { enabled: false })
})

it('allows it-admin (admits via role hierarchy)', async () => {
  kc.updateUser.mockClear()
  const res = await PATCH(eventFor(['it-admin'], { enabled: true }) as never)
  expect(res.status).toBe(200)
  expect(kc.updateUser).toHaveBeenCalledWith('uuid-anna', { enabled: true })
})

it('403 for a plain member', async () => {
  await expect(PATCH(eventFor(['member'], { enabled: false }) as never)).rejects.toMatchObject({ status: 403 })
})

it('403 when not signed in', async () => {
  const ev = {
    params: { handle: 'anna.berger' },
    request: new Request('http://x', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    locals: { auth: async () => null },
  }
  await expect(PATCH(ev as never)).rejects.toMatchObject({ status: 403 })
})

it('404 when the handle does not resolve', async () => {
  await expect(
    PATCH(eventFor(['council-admin'], { enabled: false }, 'nobody') as never),
  ).rejects.toMatchObject({ status: 404 })
})

it('400 when enabled is not a boolean', async () => {
  await expect(
    PATCH(eventFor(['council-admin'], { enabled: 'yes' }) as never),
  ).rejects.toMatchObject({ status: 400 })
})
