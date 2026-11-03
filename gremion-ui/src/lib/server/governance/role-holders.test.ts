import { describe, it, expect, vi } from 'vitest'
import { listRoleHolders, NOTIFY_ROLES } from './role-holders'
import type { KcUser } from '$lib/server/keycloak-admin'

function kcUser(over: Partial<KcUser> & { id: string }): KcUser {
  return {
    username: `name-${over.id}`,
    email: `${over.id}@example.test`,
    firstName: 'Erika',
    lastName: 'Muster',
    enabled: true,
    emailVerified: true,
    ...over
  }
}

function fakeKc(byRole: Record<string, KcUser[] | Error>) {
  return {
    listRealmRoleMembers: vi.fn(async (role: string) => {
      const v = byRole[role]
      if (v instanceof Error) throw v
      return v ?? []
    })
  }
}

const tenant = { id: 't1' } as never

describe('NOTIFY_ROLES', () => {
  it('is the council admin and the vorstand role', () => {
    expect([...NOTIFY_ROLES]).toEqual(['council-admin', 'vorstand'])
  })
})

describe('listRoleHolders', () => {
  it('a user holding both roles is returned once with both roles', async () => {
    const both = kcUser({ id: 'u1' })
    const kc = fakeKc({ 'council-admin': [both, kcUser({ id: 'u2' })], vorstand: [both, kcUser({ id: 'u3' })] })
    const r = await listRoleHolders(tenant, undefined, kc)
    expect(r.holders.map((h) => h.userId).sort()).toEqual(['u1', 'u2', 'u3'])
    expect(r.holders.find((h) => h.userId === 'u1')!.roles).toEqual(['council-admin', 'vorstand'])
    expect(r.holders.find((h) => h.userId === 'u2')!.roles).toEqual(['council-admin'])
    expect(r.holders.find((h) => h.userId === 'u3')!.roles).toEqual(['vorstand'])
    expect(r.skipped).toEqual([])
  })

  it('disabled users and users without email are skipped with a reason', async () => {
    const kc = fakeKc({
      'council-admin': [
        kcUser({ id: 'ok' }),
        kcUser({ id: 'off', enabled: false }),
        kcUser({ id: 'blank', email: '   ' }),
        kcUser({ id: 'none', email: undefined as unknown as string }),
        kcUser({ id: 'off-and-blank', enabled: false, email: '' })
      ],
      vorstand: [kcUser({ id: 'off', enabled: false })]
    })
    const r = await listRoleHolders(tenant, undefined, kc)
    expect(r.holders.map((h) => h.userId)).toEqual(['ok'])
    expect(r.skipped).toEqual([
      { userId: 'off', reason: 'disabled' },
      { userId: 'blank', reason: 'no-email' },
      { userId: 'none', reason: 'no-email' },
      { userId: 'off-and-blank', reason: 'disabled' }
    ])
  })

  it('an empty realm role yields empty holders and no throw', async () => {
    const r = await listRoleHolders(tenant, undefined, fakeKc({}))
    expect(r).toEqual({ holders: [], skipped: [] })
  })

  it('a Keycloak 500 on one role rejects the whole call', async () => {
    const kc = fakeKc({ 'council-admin': [kcUser({ id: 'u1' })], vorstand: new Error('Keycloak Admin API error: 500 boom') })
    await expect(listRoleHolders(tenant, undefined, kc)).rejects.toThrow('500')
  })

  it('looks up every requested role by name', async () => {
    const kc = fakeKc({})
    await listRoleHolders(tenant, ['vorstand'], kc)
    expect(kc.listRealmRoleMembers.mock.calls.map((c) => c[0])).toEqual(['vorstand'])
  })

  it('email is lower-cased and trimmed', async () => {
    const kc = fakeKc({ vorstand: [kcUser({ id: 'u1', email: '  Erika.Muster@Example.TEST ' })] })
    const r = await listRoleHolders(tenant, ['vorstand'], kc)
    expect(r.holders[0]!.email).toBe('erika.muster@example.test')
  })

  it('display name is first and last name, falling back to the username', async () => {
    const kc = fakeKc({
      vorstand: [
        kcUser({ id: 'a', firstName: ' Erika ', lastName: 'Muster' }),
        kcUser({ id: 'b', firstName: '', lastName: '', username: 'login-b' })
      ]
    })
    const r = await listRoleHolders(tenant, ['vorstand'], kc)
    expect(r.holders.map((h) => h.displayName)).toEqual(['Erika Muster', 'login-b'])
  })

  it('a person listed twice in one role is returned once', async () => {
    const u = kcUser({ id: 'u1' })
    const r = await listRoleHolders(tenant, ['vorstand'], fakeKc({ vorstand: [u, u] }))
    expect(r.holders).toHaveLength(1)
    expect(r.holders[0]!.roles).toEqual(['vorstand'])
  })
})
