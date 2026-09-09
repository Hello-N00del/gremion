// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

const kc = {
  listUserRoles: vi.fn(async () => [{ name: 'council-admin' }, { name: 'member' }]),
  listUserGroups: vi.fn(async () => [{ name: 'mitglied' }, { name: 'admin' }, { name: 'ref-finanzen-hv' }]),
  listUsers: vi.fn(async () => [] as unknown[]),
}
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => kc,
  getKeycloakAdminClientForCurrentTenant: () => kc,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: vi.fn(async () => ['ou-1']),
  getOrgUnit: vi.fn(async () => ({ id: 'ou-1', name: 'Vorstand', kind: 'committee' })),
  listOrgUnitMembers: vi.fn(async () => [
    { user_keycloak_id: 'uuid-anna', membership_type: 'elected', term_start: '2025-10-01', term_end: '2026-09-30' },
  ]),
}))

import { memberView, listMembers } from './member-view'

const annaKc = {
  id: 'uuid-anna',
  username: 'anna.berger',
  firstName: 'Anna',
  lastName: 'Berger',
  email: 'anna.berger@council.example',
  enabled: true,
}

it('projects a friendly, leak-free Member', async () => {
  const m = await memberView(annaKc as never)
  expect(m.id).toBe('anna.berger') // opaque handle, NOT the UUID
  expect(m.name).toBe('Anna Berger')
  expect(m.enabled).toBe(true)
  expect(m.roles).toContain('Vorstand') // council-admin → Vorstand (design string)
  expect(m.roles).toContain('Mitglied')
  expect(m.scopes).toContain('Belege freigeben') // ref-finanzen-hv → friendly scope
  expect(m.memberships[0]).toMatchObject({ gremium_or_referat_name: 'Vorstand', role: 'Gewählt' })
})

it('never leaks UUID / raw group id / realm key / SSO', async () => {
  const m = await memberView(annaKc as never)
  const blob = JSON.stringify(m)
  for (const leak of ['uuid-anna', 'ref-finanzen-hv', 'council-admin', 'mitglied', 'Keycloak', 'SSO']) {
    expect(blob).not.toContain(leak)
  }
})

it('admin sees everyone; basic sees only placed+active', async () => {
  kc.listUsers = vi.fn(async () => [
    annaKc,
    { id: 'uuid-tom', username: 'tom.maier', firstName: 'Tom', lastName: 'Maier', email: 't@x', enabled: true }, // guest, unplaced
    { id: 'uuid-old', username: 'old.user', firstName: 'Old', lastName: 'User', email: 'o@x', enabled: false }, // disabled
  ])
  const orgDb = await import('$lib/server/governance/org-units-db')
  ;(orgDb.getOrgUnitIdsForUser as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
    id === 'uuid-anna' ? ['ou-1'] : [],
  )

  const admin = await listMembers({ adminView: true })
  expect(admin.map((m) => m.id).sort()).toEqual(['anna.berger', 'old.user', 'tom.maier'])

  const basic = await listMembers({ adminView: false })
  expect(basic.map((m) => m.id)).toEqual(['anna.berger']) // only placed + enabled
})
