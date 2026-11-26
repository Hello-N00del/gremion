import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNextcloudSubsystem } from './nextcloud-subsystem'
import type { OrgUnit } from '../../governance/org-units-db'

const unit: OrgUnit = {
  id: 'abc', parent_id: null, kind: 'committee', name: 'Vorstand',
  description: null, child_term: null, kind_label: null, authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: true, wants_nextcloud_folder: true, created_at: new Date()
}

type FakeFolder = { id: number; mountPoint: string; groups: string[] }

function fakeNc(existingFolders: FakeFolder[] = []) {
  return {
    groups: new Set<string>(),
    folders: [] as string[],
    membership: [] as Array<[string, string]>,
    provisioned: [] as Array<{ providerId: number; userId: string; displayName?: string | null; email?: string | null }>,
    callOrder: [] as string[],
    deleted: [] as number[],
    grants: [] as Array<[number, string]>,
    /** every folder Nextcloud holds: the pre-existing ones plus what createGroupFolder made */
    _existingFolders: existingFolders.map((f) => ({ ...f, groups: [...f.groups] })),
    _nextId: 77,
    /** number of upcoming grants that fail before anything is granted */
    failGrants: 0,
    /** runs at the start of every grant, to observe what the caller had recorded by then */
    onGrant: undefined as undefined | (() => void),
    async createGroup(g: string) { this.groups.add(g) },
    async deleteGroup(g: string) { this.groups.delete(g) },
    async listGroupFolders() { return this._existingFolders.map((f) => ({ ...f, groups: [...f.groups] })) },
    async createGroupFolder(mp: string) {
      this.folders.push(mp)
      const id = this._nextId++
      this._existingFolders.push({ id, mountPoint: mp, groups: [] })
      return { id, mountPoint: mp }
    },
    async assignGroupFolderPermissions(folderId: number, groupId: string) {
      this.onGrant?.()
      if (this.failGrants > 0) { this.failGrants--; throw new Error('groupfolders: add group refused') }
      this.grants.push([folderId, groupId])
      const folder = this._existingFolders.find((f) => f.id === folderId)
      if (!folder) throw new Error('no such folder')
      if (!folder.groups.includes(groupId)) folder.groups.push(groupId)
    },
    async deleteGroupFolder(id: number) {
      this.deleted.push(id)
      this._existingFolders = this._existingFolders.filter((f) => f.id !== id)
    },
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
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand', groups: ['ou-abc'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(0) // createGroupFolder NOT called
      expect(r.externalId).toContain('42')
    })

    it('calls createGroupFolder once when no existing folder matches (normal path)', async () => {
      const nc = fakeNc([{ id: 5, mountPoint: 'OtherCommittee', groups: ['ou-abc'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(1) // createGroupFolder called exactly once
      expect(r.externalId).toContain('77')
    })

    it("does not adopt another unit's folder of the same name (its group is not ours): creates its own", async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand', groups: ['ou-other'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toEqual(['Vorstand'])
      expect(r.externalId).toBe('77:ou-abc')
    })

    it('adopts the LOWEST id when two folders share the mountpoint and warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const nc = fakeNc([
        { id: 10, mountPoint: 'Vorstand', groups: ['ou-abc'] },
        { id: 3, mountPoint: 'Vorstand', groups: ['ou-abc'] }
      ])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(0) // createGroupFolder NOT called
      expect(r.externalId).toContain('3') // lowest id adopted
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('a folder whose group grant failed is reused on retry', () => {
    /** Stands in for the orchestrator: one ledger row, its external id passed back as `existing`,
     *  and the recorder the orchestrator hands to the adapter. */
    function ledgerRow() {
      const row = { externalId: null as string | null }
      const ctx = {
        parentKeycloakGroupId: null,
        recordExternalId: async (id: string) => { row.externalId = id }
      }
      return { row, ctx }
    }

    it('two runs after a refused grant create exactly ONE folder, and the second run grants it', async () => {
      const nc = fakeNc()
      const { row, ctx } = ledgerRow()
      let recordedWhenGrantStarted: string | null = null
      nc.onGrant = () => { recordedWhenGrantStarted = row.externalId }
      nc.failGrants = 1
      const sub = subsystem(nc)

      await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow('add group refused')
      expect(nc.folders).toEqual(['Vorstand'])
      expect(recordedWhenGrantStarted).toBe('77:ou-abc') // recorded BEFORE the grant was attempted
      expect(row.externalId).toBe('77:ou-abc') // and it survived the failure

      const r = await sub.ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand']) // still exactly one folder
      expect(nc.grants).toEqual([[77, 'ou-abc']])
      expect(r.externalId).toBe('77:ou-abc')
    })

    it('does not create another folder on each of several refused grants', async () => {
      const nc = fakeNc()
      const { row, ctx } = ledgerRow()
      nc.failGrants = 3
      const sub = subsystem(nc)
      for (let i = 0; i < 3; i++) await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow()
      const r = await sub.ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toHaveLength(1)
      expect(r.externalId).toBe('77:ou-abc')
    })

    it('creates a new folder when the recorded one no longer exists (and records the new id)', async () => {
      const nc = fakeNc([{ id: 5, mountPoint: 'Anderes', groups: ['ou-other'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc' // no folder 41 in Nextcloud
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand'])
      expect(r.externalId).toBe('77:ou-abc')
      expect(row.externalId).toBe('77:ou-abc')
      expect(nc.grants).toEqual([[77, 'ou-abc']])
    })

    it('does not mint a folder when the folder list is empty: a recorded folder cannot be verified then', async () => {
      const nc = fakeNc([])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      await expect(subsystem(nc).ensureResource(unit, ctx, row.externalId)).rejects.toThrow()
      expect(nc.folders).toHaveLength(0)
      expect(row.externalId).toBe('41:ou-abc')
    })

    it('keeps a recorded folder that already carries the unit group, without granting again', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-abc'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(r.externalId).toBe('41:ou-abc')
      expect(nc.folders).toHaveLength(0)
      expect(nc.grants).toHaveLength(0)
    })

    it('does not adopt a recorded folder that carries only another group: it makes its own', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-other'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand'])
      expect(r.externalId).toBe('77:ou-abc')
      expect(nc.grants).toEqual([[77, 'ou-abc']]) // the other group's folder was not granted
    })

    it('never adopts a folder by name alone: a same-name folder without any group is not reused when nothing is recorded', async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand', groups: [] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toEqual(['Vorstand'])
      expect(r.externalId).toBe('77:ou-abc')
      expect(nc.grants).toEqual([[77, 'ou-abc']])
    })

    it('removes the folder it just made when the id cannot be recorded, so none is left behind', async () => {
      const nc = fakeNc()
      const ctx = { parentKeycloakGroupId: null, recordExternalId: async () => { throw new Error('ledger unavailable') } }
      await expect(subsystem(nc).ensureResource(unit, ctx, null)).rejects.toThrow('ledger unavailable')
      expect(nc.deleted).toEqual([77])
      expect(nc.grants).toHaveLength(0)
    })

    it('a first attempt that succeeds records the folder once and grants it (unchanged result)', async () => {
      const nc = fakeNc()
      const { row, ctx } = ledgerRow()
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(r.externalId).toBe('77:ou-abc')
      expect(nc.folders).toHaveLength(1)
      expect(nc.grants).toEqual([[77, 'ou-abc']])
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
