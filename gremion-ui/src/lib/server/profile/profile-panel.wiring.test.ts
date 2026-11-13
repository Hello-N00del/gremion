// The production seam must be total: when the admin client cannot even be built (its
// secret is missing, which throws synchronously), every dependency still hands back a
// rejected promise, so callers that await it see an ordinary failure.
import { describe, expect, test, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'

vi.mock('$lib/server/keycloak-admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/keycloak-admin')>()),
  getKeycloakAdminClient: () => {
    throw new Error('admin secret missing')
  },
}))

import { accountActionDeps, loadProfilePanel, ownNameDeps, profilePanelDeps } from './profile-panel'

const tenant = { id: 'wiring-test' } as unknown as TenantContext
const user = { id: 'kc-uuid-1' }
const cookies = { get: () => undefined, set: vi.fn(), delete: vi.fn() }

describe('production wiring without an admin client', () => {
  test('every dependency rejects instead of throwing', async () => {
    const p = profilePanelDeps(tenant)
    const names = ownNameDeps(tenant)
    const actions = accountActionDeps(tenant, async () => undefined)
    for (const call of [
      () => p.getUser('x'),
      () => names.updateUserNames('x', { firstName: 'A', lastName: 'B' }),
      () => actions.hasOtpCredential('x'),
    ]) {
      let returned: unknown
      expect(() => {
        returned = call()
      }).not.toThrow()
      await expect(returned).rejects.toThrow('admin secret missing')
    }
  })

  test('the e-mail probe answers false (the capability cache absorbs the failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(profilePanelDeps(tenant).emailActionAvailable()).resolves.toBe(false)
    warn.mockRestore()
  })

  test('the Profil load still answers: no names, no e-mail action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await loadProfilePanel({ user, cookies, wantsProfile: true }, profilePanelDeps(tenant))
    expect(out).toEqual({ profile: null, emailActionAvailable: false, accountActionResult: null })
    warn.mockRestore()
  })
})
