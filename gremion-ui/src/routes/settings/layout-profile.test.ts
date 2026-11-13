// @vitest-environment node
// The settings layout reads the signed-in user's own Keycloak record for Settings > Profil, and only for that section.
import { describe, expect, test, vi, beforeEach } from 'vitest'

const kc = vi.hoisted(() => ({
  getUser: vi.fn(),
  isRequiredActionEnabled: vi.fn(),
  hasOtpCredential: vi.fn(),
}))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => kc }))
vi.mock('$lib/server/modules/runtime-registry', () => ({ getDataProvider: () => undefined }))

import { load } from './+layout.server'
import { Role } from '$lib/auth/types'

const user = { id: 'kc-uuid-1', email: 'anna@example.org', name: 'Anna Alt', roles: [Role.Member], groups: [], loa: 1, authTime: 0 }

let tenantSeq = 0
function run(pathname: string, cookie?: string, tenantId = `tenant-${++tenantSeq}`) {
  const store = new Map<string, string>(cookie ? [['gremion.kc_action', cookie]] : [])
  return (load as unknown as (e: unknown) => Promise<Record<string, unknown>>)({
    locals: { auth: async () => ({ user }), tenant: { id: tenantId } },
    fetch: vi.fn(),
    url: new URL('https://pilot.test' + pathname),
    cookies: { get: (n: string) => store.get(n), set: vi.fn(), delete: (n: string) => void store.delete(n) },
  })
}

beforeEach(() => {
  kc.getUser.mockReset().mockResolvedValue({ id: 'kc-uuid-1', firstName: 'Anna', lastName: 'Alt', email: 'anna@example.org' })
  kc.isRequiredActionEnabled.mockReset().mockResolvedValue(false)
  kc.hasOtpCredential.mockReset()
})

describe('settings layout load, Profil data', () => {
  test.each(['/settings', '/settings/', '/settings/profil'])('%s reads the session user from Keycloak', async (path) => {
    const data = await run(path)
    expect(kc.getUser).toHaveBeenCalledWith('kc-uuid-1')
    expect(data.profile).toEqual({ firstName: 'Anna', lastName: 'Alt', email: 'anna@example.org' })
    expect(data).not.toHaveProperty('accountUrl')
  })

  test.each(['/settings/darstellung', '/settings/organisation', '/settings/module'])('%s does not call Keycloak for it', async (path) => {
    const data = await run(path)
    expect(kc.getUser).not.toHaveBeenCalled()
    expect(kc.isRequiredActionEnabled).not.toHaveBeenCalled()
    expect(data.profile).toBeNull()
    expect(data.emailActionAvailable).toBe(false)
  })

  test('the e-mail capability follows the realm: off before UPDATE_EMAIL is enabled, on after', async () => {
    // a fresh tenant id per case: the answer is cached per tenant for a minute
    expect((await run('/settings')).emailActionAvailable).toBe(false)
    expect(kc.isRequiredActionEnabled).toHaveBeenCalledWith('UPDATE_EMAIL')
    kc.isRequiredActionEnabled.mockResolvedValue(true)
    expect((await run('/settings')).emailActionAvailable).toBe(true)
    // an unreadable realm answer stays hidden
    kc.isRequiredActionEnabled.mockRejectedValue(new Error('403'))
    expect((await run('/settings')).emailActionAvailable).toBe(false)
  })

  test('a returned account action is reported once', async () => {
    const data = await run('/settings/profil', 'CONFIGURE_TOTP.cancelled')
    expect(data.accountActionResult).toEqual({ action: 'CONFIGURE_TOTP', status: 'cancelled' })
  })
})
