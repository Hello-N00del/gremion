// @vitest-environment node
//
// TASK-033-a (Q6): the log deletion windows are fixed by the retention registry.
// PATCH /api/settings refuses the whole `retention` key with 400, whatever the
// value, so an admin can neither lengthen nor shorten a window (the earlier
// R29-RETENTION-30-K caps are subsumed: no value is accepted at all). The other
// keys stay patchable.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockReadConfig, mockWriteConfig, mockHasRole } = vi.hoisted(() => ({
  mockReadConfig: vi.fn(),
  mockWriteConfig: vi.fn(),
  mockHasRole: vi.fn(),
}))

vi.mock('$lib/server/config', () => ({ readConfig: mockReadConfig, writeConfig: mockWriteConfig }))
vi.mock('$lib/auth', () => ({ hasRole: mockHasRole, Role: { ITAdmin: 'it-admin' } }))

import { PATCH } from './+server'

const CURRENT = {
  retention: { access_logs_days: 14, app_logs_days: 28, security_logs_days: 27, security_nopii_logs_days: 27 },
}

function patch(body: unknown) {
  const request = new Request('http://localhost/api/settings', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals: { auth: async () => ({ user: { id: 'u', roles: ['it-admin'] } }) } })
}

beforeEach(() => {
  mockHasRole.mockReturnValue(true)
  mockReadConfig.mockReturnValue(CURRENT)
  mockWriteConfig.mockReset()
  mockWriteConfig.mockReturnValue(CURRENT)
})

describe('PATCH /api/settings has no retention key (Q6)', () => {
  it.each([
    ['security_logs_days', 45],
    ['security_logs_days', 29],
    ['security_logs_days', 1],
    ['app_logs_days', 30],
    ['access_logs_days', 14],
    ['security_nopii_logs_days', 30],
  ])('refuses %s = %i with 400 and writes nothing', async (field, value) => {
    const res = await patch({ retention: { [field]: value } })
    expect(res.status).toBe(400)
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('refuses the key even when it is empty or sent next to a valid key', async () => {
    expect((await patch({ retention: {} })).status).toBe(400)
    expect((await patch({ org: { name: 'X' }, retention: { security_logs_days: 27 } })).status).toBe(400)
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('says why in plain German, with no plan id', async () => {
    const body = (await (await patch({ retention: { security_logs_days: 45 } })).json()) as { error: string }
    expect(body.error).toContain('fest vorgegeben')
    expect(body.error).not.toMatch(/R\d\d-|TASK-/)
  })

  it('other settings keys still patch', async () => {
    const res = await patch({ org: { name: 'Example Council' } })
    expect(res.status).toBe(200)
    expect(mockWriteConfig).toHaveBeenCalledWith({ org: { name: 'Example Council' } })
  })
})
