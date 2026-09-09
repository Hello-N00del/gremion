import { describe, it, expect } from 'vitest'
import { createKeycloakSubsystem } from './keycloak'
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
    async createGroup(name: string) { this.created.push(name); return 'kc-top' },
    async createSubgroup(parentId: string, name: string) { this.subgroups.push([parentId, name]); return 'kc-sub' },
    // ensureResource now adopts an existing same-name sibling before creating
    // (idempotent re-provision against leftover Keycloak state). Returning no
    // siblings makes the adopt-by-name miss, so every test falls through to the
    // create / stale-recreate path each one asserts.
    async listGroups() { return [] as Array<{ id: string; name: string; path: string }> },
    async listSubGroups(_parentId: string) { return [] as Array<{ id: string; name: string; path: string }> },
    async getGroup(id: string) { if (id === 'stale') throw new Error('404'); return { id, name: 'x', path: '/x' } },
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
  })

  it('reconcileMembers adds only the missing members', async () => {
    const kc = fakeKc()
    kc.members.add('a')
    const sub = createKeycloakSubsystem(kc as never)
    await sub.reconcileMembers('kc-top', ['a', 'b'])
    expect([...kc.members].sort()).toEqual(['a', 'b'])
  })
})
