import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNextcloudSubsystem } from './nextcloud-subsystem'
import type { OrgUnit } from '../../governance/org-units-db'

const unit: OrgUnit = {
  id: 'abc', parent_id: null, kind: 'committee', name: 'Vorstand',
  description: null, child_term: null, kind_label: null, authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: true, wants_nextcloud_folder: true, created_at: new Date()
}

function fakeNc(existingFolders: Array<{ id: number; mountPoint: string }> = []) {
  return {
    groups: new Set<string>(),
    folders: [] as string[],
    membership: [] as Array<[string, string]>,
    provisioned: [] as Array<{ providerId: number; userId: string; displayName?: string | null; email?: string | null }>,
    callOrder: [] as string[],
    _existingFolders: existingFolders,
    async createGroup(g: string) { this.groups.add(g) },
    async deleteGroup(g: string) { this.groups.delete(g) },
    async listGroupFolders() { return this._existingFolders },
    async createGroupFolder(mp: string) { this.folders.push(mp); return { id: 77, mountPoint: mp } },
    async assignGroupFolderPermissions() {},
    async deleteGroupFolder() {},
    async provisionOidcUser(data: { providerId: number; userId: string; displayName?: string | null; email?: string | null }) {
      this.provisioned.push(data); this.callOrder.push('provision')
    },
    async addUserToGroup(u: string, g: string) { this.membership.push([u, g]); this.callOrder.push('addToGroup') },
    async removeUserFromGroup() {}
  }
}

function fakeKc() {
  return {
    async getUser(id: string) {
      return {
        id, username: `user-${id}`, email: `${id}@stura.de`,
        firstName: 'Max', lastName: 'Muster', enabled: true, emailVerified: true
      }
    }
  }
}

function subsystem(nc: ReturnType<typeof fakeNc>, kc = fakeKc(), providerId = 1) {
  return createNextcloudSubsystem({ nc: nc as never, kc: kc as never }, providerId)
}

describe('nextcloud subsystem', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('creates the group + folder and returns the composite external id', async () => {
    const nc = fakeNc()
    const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
    expect(r.externalId).toBe('77:ou-abc')
    expect(nc.groups.has('ou-abc')).toBe(true)
  })

  describe('adopt-by-name (idempotent folder creation)', () => {
    it('adopts an existing folder by mountpoint instead of minting a duplicate', async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand' }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(0) // createGroupFolder NOT called
      expect(r.externalId).toContain('42')
    })

    it('calls createGroupFolder once when no existing folder matches (normal path)', async () => {
      const nc = fakeNc([{ id: 5, mountPoint: 'OtherCommittee' }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(1) // createGroupFolder called exactly once
      expect(r.externalId).toContain('77')
    })

    it('adopts the LOWEST id when two folders share the mountpoint and warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const nc = fakeNc([
        { id: 10, mountPoint: 'Vorstand' },
        { id: 3, mountPoint: 'Vorstand' }
      ])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(0) // createGroupFolder NOT called
      expect(r.externalId).toContain('3') // lowest id adopted
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  it('addMember pre-provisions the OIDC account before adding it to the group', async () => {
    const nc = fakeNc()
    await subsystem(nc).addMember('77:ou-abc', 'uuid-1')
    expect(nc.provisioned).toEqual([
      { providerId: 1, userId: 'uuid-1', displayName: 'Max Muster', email: 'uuid-1@stura.de' }
    ])
    expect(nc.membership).toEqual([['uuid-1', 'ou-abc']])
    // the account must exist before the group-add, or the OCS call 404s
    expect(nc.callOrder).toEqual(['provision', 'addToGroup'])
  })

  it('reconcileMembers provisions and group-adds every desired user', async () => {
    const nc = fakeNc()
    await subsystem(nc).reconcileMembers('77:ou-abc', ['uuid-1', 'uuid-2'])
    expect(nc.provisioned.map((p) => p.userId)).toEqual(['uuid-1', 'uuid-2'])
    expect(nc.membership).toEqual([['uuid-1', 'ou-abc'], ['uuid-2', 'ou-abc']])
  })
})
