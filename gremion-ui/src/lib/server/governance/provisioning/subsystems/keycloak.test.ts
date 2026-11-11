import { describe, it, expect } from 'vitest'
import { createKeycloakSubsystem } from './keycloak'
import { KcAdminError } from '../../../keycloak-admin'
import type { OrgUnit } from '../../org-units-db'

const unit = (over: Partial<OrgUnit> = {}): OrgUnit => ({
  id: 'u1', parent_id: null, kind: 'committee', name: 'Vorstand',
  description: null, child_term: null, kind_label: null, authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: true, wants_nextcloud_folder: true,
  created_at: new Date(), ...over
})

function fakeKc() {
  return {
    created: [] as string[],
    subgroups: [] as Array<[string, string]>,
    members: new Set<string>(),
    async createGroup(name: string) { this.calls.push('createGroup'); this.created.push(name); return 'kc-top' },
    async createSubgroup(parentId: string, name: string) { this.calls.push('createSubgroup'); this.subgroups.push([parentId, name]); return 'kc-sub' },
    // ensureResource now adopts an existing same-name sibling before creating
    // (idempotent re-provision against leftover Keycloak state). Returning no
    // siblings makes the adopt-by-name miss, so every test falls through to the
    // create / stale-recreate path each one asserts.
    async listGroups() { this.calls.push('listGroups'); return [] as Array<{ id: string; name: string; path: string }> },
    async listSubGroups(_parentId: string) { this.calls.push('listSubGroups'); return [] as Array<{ id: string; name: string; path: string }> },
    // 'stale' is a real Keycloak 404; 'kc-503' is an outage; 'kc-net' a transport
    // failure (timeout / connection refused) that never reached a status code.
    // Every create/list call is recorded so a test can prove nothing else was touched.
    calls: [] as string[],
    async getGroup(id: string) {
      if (id === 'stale') throw new KcAdminError(404, 'Could not find group by id')
      if (id === 'kc-503') throw new KcAdminError(503, 'service unavailable')
      if (id === 'kc-net') throw new Error('fetch failed')
      return { id, name: 'x', path: '/x' }
    },
    async deleteGroup() {},
    async addUserToGroup(userId: string) { this.members.add(userId) },
    async removeUserFromGroup(userId: string) { this.members.delete(userId) },
    async listGroupMembers() { return [...this.members].map((id) => ({ id })) }
  }
}

describe('keycloak subsystem', () => {
  it('creates a top-level group when the node has no parent', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    const r = await sub.ensureResource(unit(), { parentKeycloakGroupId: null }, null)
    expect(r.externalId).toBe('kc-top')
    expect(kc.created).toEqual(['Vorstand'])
  })

  it('creates a subgroup when the node has a parent', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    const r = await sub.ensureResource(unit({ parent_id: 'p' }), { parentKeycloakGroupId: 'kc-parent' }, null)
    expect(r.externalId).toBe('kc-sub')
    expect(kc.subgroups).toEqual([['kc-parent', 'Vorstand']])
  })

  it('reuses an existing group id that still exists', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    const r = await sub.ensureResource(unit(), { parentKeycloakGroupId: null }, 'kc-existing')
    expect(r.externalId).toBe('kc-existing')
    expect(kc.created).toEqual([])
  })

  it('recreates when the stored group id is stale', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    const r = await sub.ensureResource(unit(), { parentKeycloakGroupId: null }, 'stale')
    expect(r.externalId).toBe('kc-top')
    expect(kc.created).toEqual(['Vorstand'])
  })

  it('rethrows a Keycloak 5xx from getGroup and creates nothing', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    const err = await sub
      .ensureResource(unit(), { parentKeycloakGroupId: null }, 'kc-503')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(503)
    expect(kc.calls).toEqual([])
    expect(kc.created).toEqual([])
    expect(kc.subgroups).toEqual([])
  })

  it('rethrows a 5xx for a child unit too, without listing or creating subgroups', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    await expect(
      sub.ensureResource(unit({ parent_id: 'p' }), { parentKeycloakGroupId: 'kc-parent' }, 'kc-503')
    ).rejects.toBeInstanceOf(KcAdminError)
    expect(kc.calls).toEqual([])
  })

  it('rethrows a plain network or timeout error from getGroup and creates nothing', async () => {
    const kc = fakeKc()
    const sub = createKeycloakSubsystem(kc as never)
    await expect(
      sub.ensureResource(unit(), { parentKeycloakGroupId: null }, 'kc-net')
    ).rejects.toThrow('fetch failed')
    expect(kc.calls).toEqual([])
    expect(kc.created).toEqual([])
  })

  it('reconcileMembers adds only the missing members', async () => {
    const kc = fakeKc()
    kc.members.add('a')
    const sub = createKeycloakSubsystem(kc as never)
    await sub.reconcileMembers('kc-top', ['a', 'b'])
    expect([...kc.members].sort()).toEqual(['a', 'b'])
  })
})
