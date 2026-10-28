// @vitest-environment node
import { it, expect, vi } from 'vitest'

const kc = {
  updateUser: vi.fn(async () => {}),
  getUser: vi.fn(async (_id: string) => ({ username: 'anna.berger' })),
  listUserRoles: vi.fn(async (_id: string) => [{ id: 'r', name: 'member' }] as { id: string; name: string }[]),
}
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => kc }))
vi.mock('$lib/server/members/resolve-handle', () => ({
  resolveHandle: vi.fn(async (h: string) =>
    h === 'anna.berger' ? 'uuid-anna' : h === 'it.boss' ? 'uuid-it' : h === 'service-account-gremion' ? 'uuid-sa' : h === 'me' ? 'u1' : null,
  ),
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

it('403 when a council-admin targets an it-admin (rank), no update', async () => {
  kc.updateUser.mockClear()
  kc.getUser.mockResolvedValueOnce({ username: 'it.boss' })
  kc.listUserRoles.mockResolvedValueOnce([{ id: 'r', name: 'it-admin' }])
  await expect(
    PATCH(eventFor(['council-admin'], { enabled: false }, 'it.boss') as never),
  ).rejects.toMatchObject({ status: 403 })
  expect(kc.updateUser).not.toHaveBeenCalled()
})

it('it-admin may target another it-admin', async () => {
  kc.getUser.mockResolvedValueOnce({ username: 'it.boss' })
  kc.listUserRoles.mockResolvedValueOnce([{ id: 'r', name: 'it-admin' }])
  const res = await PATCH(eventFor(['it-admin'], { enabled: false }, 'it.boss') as never)
  expect(res.status).toBe(200)
})

it('403 for service accounts', async () => {
  kc.updateUser.mockClear()
  kc.getUser.mockResolvedValueOnce({ username: 'service-account-gremion' })
  await expect(
    PATCH(eventFor(['it-admin'], { enabled: false }, 'service-account-gremion') as never),
  ).rejects.toMatchObject({ status: 403 })
  expect(kc.updateUser).not.toHaveBeenCalled()
})

it('403 on self-disable', async () => {
  kc.updateUser.mockClear()
  await expect(PATCH(eventFor(['it-admin'], { enabled: false }, 'me') as never)).rejects.toMatchObject({ status: 403 })
  expect(kc.updateUser).not.toHaveBeenCalled()
})
