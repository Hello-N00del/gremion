import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNextcloudSubsystem } from './nextcloud-subsystem'
import { NextcloudClient } from '../nextcloud-client'
import type { OrgUnit } from '../../governance/org-units-db'

const unit: OrgUnit = {
  id: 'abc', parent_id: null, kind: 'committee', name: 'Vorstand',
  description: null, child_term: null, kind_label: null, authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: true, wants_nextcloud_folder: true, created_at: new Date()
}

type FakeFolder = { id: number; mountPoint: string; groups: string[]; groupPermissions?: Record<string, number> }

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
    /** number of upcoming grants that add the group and then fail to set its permissions */
    failPermissionStep: 0,
    /** what a group is given when it is added, before its permissions are set */
    addedGroupPermissions: 0,
    permissionSets: [] as Array<[number, string, number]>,
    /** runs at the start of every grant, to observe what the caller had recorded by then */
    onGrant: undefined as undefined | (() => void),
    async createGroup(g: string) { this.groups.add(g) },
    async deleteGroup(g: string) { this.groups.delete(g) },
    async listGroupFolders() {
      return this._existingFolders.map((f) => ({
        ...f, groups: [...f.groups], ...(f.groupPermissions ? { groupPermissions: { ...f.groupPermissions } } : {})
      }))
    },
    async createGroupFolder(mp: string) {
      // the folder list spans the whole Nextcloud: a mount point is unique on it, whoever owns the folder
      if (this._existingFolders.some((f) => f.mountPoint === mp)) {
        throw new Error('Nextcloud POST /index.php/apps/groupfolders/folders → 400: Mount point already exists')
      }
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
      folder.groupPermissions = { ...folder.groupPermissions, [groupId]: this.addedGroupPermissions }
      if (this.failPermissionStep > 0) { this.failPermissionStep--; throw new Error('groupfolders: set permissions refused') }
      folder.groupPermissions[groupId] = 31
    },
    async setGroupFolderPermissions(folderId: number, groupId: string, permissions: number) {
      this.permissionSets.push([folderId, groupId, permissions])
      const folder = this._existingFolders.find((f) => f.id === folderId)
      if (!folder) throw new Error('no such folder')
      folder.groupPermissions = { ...folder.groupPermissions, [groupId]: permissions }
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

function subsystem(nc: ReturnType<typeof fakeNc>, kc = fakeKc(), providerId = 1, key = 'k1') {
  return createNextcloudSubsystem({ nc: nc as never, kc: kc as never }, providerId, { key })
}

describe('nextcloud subsystem', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('creates the group + folder and returns the composite external id', async () => {
    const nc = fakeNc()
    const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
    expect(r.externalId).toBe('77:ou-k1-abc')
    expect(nc.groups.has('ou-k1-abc')).toBe(true)
  })

  describe('adopt-by-name (idempotent folder creation)', () => {
    it('adopts an existing folder by mountpoint instead of minting a duplicate', async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand (k1)', groups: ['ou-k1-abc'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(0) // createGroupFolder NOT called
      expect(r.externalId).toContain('42')
    })

    it('calls createGroupFolder once when no existing folder matches (normal path)', async () => {
      const nc = fakeNc([{ id: 5, mountPoint: 'OtherCommittee', groups: ['ou-k1-abc'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toHaveLength(1) // createGroupFolder called exactly once
      expect(r.externalId).toContain('77')
    })

    it("does not adopt another unit's folder of the same name (its group is not ours): creates its own", async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand', groups: ['ou-other'] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
    })

    it('adopts the LOWEST id when two folders share the mountpoint and warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const nc = fakeNc([
        { id: 10, mountPoint: 'Vorstand (k1)', groups: ['ou-k1-abc'] },
        { id: 3, mountPoint: 'Vorstand (k1)', groups: ['ou-k1-abc'] }
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
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(recordedWhenGrantStarted).toBe('77:ou-k1-abc') // recorded BEFORE the grant was attempted
      expect(row.externalId).toBe('77:ou-k1-abc') // and it survived the failure

      const r = await sub.ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand (k1)']) // still exactly one folder
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']])
      expect(r.externalId).toBe('77:ou-k1-abc')
    })

    it('does not create another folder on each of several refused grants', async () => {
      const nc = fakeNc()
      const { row, ctx } = ledgerRow()
      nc.failGrants = 3
      const sub = subsystem(nc)
      await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow('add group refused')
      await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow('add group refused')
      await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow('add group refused')
      const r = await sub.ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toHaveLength(1)
      expect(r.externalId).toBe('77:ou-k1-abc')
    })

    it('creates a new folder when the recorded one no longer exists (and records the new id)', async () => {
      const nc = fakeNc([{ id: 5, mountPoint: 'Anderes', groups: ['ou-other'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc' // no folder 41 in Nextcloud
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(row.externalId).toBe('77:ou-k1-abc')
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']])
    })

    it('creates a new folder when the recorded one is gone and Nextcloud reads an empty folder list', async () => {
      const nc = fakeNc([])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(row.externalId).toBe('77:ou-k1-abc')
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']])
    })

    it('makes nothing and keeps the recorded id when the folder list cannot be read (real client, failure envelope)', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-abc'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const failure = { ocs: { meta: { status: 'failure', statuscode: 997, message: 'Not authorised' }, data: null } }
      vi.stubGlobal('fetch', (async () => new Response(JSON.stringify(failure), { status: 200 })) as unknown as typeof fetch)
      const real = new NextcloudClient('http://nc', 'admin', 'pw')
      nc.listGroupFolders = () => real.listGroupFolders() as never
      await expect(subsystem(nc).ensureResource(unit, ctx, row.externalId)).rejects.toThrow('997')
      expect(nc.folders).toEqual([])
      expect(nc.grants).toEqual([])
      expect(nc.deleted).toEqual([])
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

    it('a grant that added the group but could not set its permissions is finished on the retry, on the same folder', async () => {
      const nc = fakeNc()
      nc.failPermissionStep = 1
      const { row, ctx } = ledgerRow()
      const sub = subsystem(nc)

      await expect(sub.ensureResource(unit, ctx, row.externalId)).rejects.toThrow('set permissions refused')
      expect(row.externalId).toBe('77:ou-k1-abc')

      const r = await sub.ensureResource(unit, ctx, row.externalId)
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(nc.folders).toEqual(['Vorstand (k1)']) // still exactly one folder
      expect(nc.grants).toHaveLength(1) // the group is not added a second time
      expect(nc.permissionSets).toEqual([[77, 'ou-k1-abc', 31]])
    })

    it('leaves the permissions alone when Nextcloud already reports them as set', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-abc'], groupPermissions: { 'ou-abc': 31 } }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.permissionSets).toHaveLength(0)
      expect(nc.grants).toHaveLength(0)
    })

    it('leaves permissions an operator lowered alone: a recorded folder with the unit group and other bits is not reset', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-abc'], groupPermissions: { 'ou-abc': 1 } }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(r.externalId).toBe('41:ou-abc')
      expect(nc.permissionSets).toHaveLength(0)
      expect(nc.grants).toHaveLength(0)
    })

    it('does not grant a recorded group-less folder whose mount point is another name: it makes its own', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Fremd', groups: [] }, { id: 5, mountPoint: 'X', groups: ['ou-x'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']]) // folder 41 was not granted
    })

    it('does not adopt a recorded folder that carries only another group: it makes its own', async () => {
      const nc = fakeNc([{ id: 41, mountPoint: 'Vorstand', groups: ['ou-other'] }])
      const { row, ctx } = ledgerRow()
      row.externalId = '41:ou-abc'
      const r = await subsystem(nc).ensureResource(unit, ctx, row.externalId)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']]) // the other group's folder was not granted
    })

    it('never adopts a folder by name alone: a same-name folder without any group is not reused when nothing is recorded', async () => {
      const nc = fakeNc([{ id: 42, mountPoint: 'Vorstand', groups: [] }])
      const r = await subsystem(nc).ensureResource(unit, { parentKeycloakGroupId: null }, null)
      expect(nc.folders).toEqual(['Vorstand (k1)'])
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']])
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
      expect(r.externalId).toBe('77:ou-k1-abc')
      expect(nc.folders).toHaveLength(1)
      expect(nc.grants).toEqual([[77, 'ou-k1-abc']])
    })
  })

  it('addMember pre-provisions the OIDC account before adding it to the group', async () => {
    const nc = fakeNc()
    await subsystem(nc).addMember('77:ou-k1-abc', 'uuid-1')
    expect(nc.provisioned).toEqual([
      { providerId: 1, userId: 'uuid-1', displayName: 'Max Muster', email: 'uuid-1@stura.de' }
    ])
    expect(nc.membership).toEqual([['uuid-1', 'ou-k1-abc']])
    // the account must exist before the group-add, or the OCS call 404s
    expect(nc.callOrder).toEqual(['provision', 'addToGroup'])
  })

  it('reconcileMembers provisions and group-adds every desired user', async () => {
    const nc = fakeNc()
    await subsystem(nc).reconcileMembers('77:ou-k1-abc', ['uuid-1', 'uuid-2'])
    expect(nc.provisioned.map((p) => p.userId)).toEqual(['uuid-1', 'uuid-2'])
    expect(nc.membership).toEqual([['uuid-1', 'ou-k1-abc'], ['uuid-2', 'ou-k1-abc']])
  })

  describe('one Nextcloud shared by several customers (per-customer namespace)', () => {
    const ctx = { parentKeycloakGroupId: null }

    it('two customers with a unit of the same name BOTH get a folder; the shown name stays the plain one', async () => {
      const nc = fakeNc()
      const a = await subsystem(nc, fakeKc(), 1, 'ka').ensureResource(unit, ctx, null)
      const b = await subsystem(nc, fakeKc(), 1, 'kb').ensureResource({ ...unit, id: 'def' }, ctx, null)
      expect(a.externalId).toBe('77:ou-ka-abc')
      expect(b.externalId).toBe('78:ou-kb-def')
      expect(nc.folders).toEqual(['Vorstand (ka)', 'Vorstand (kb)'])
      expect(unit.name).toBe('Vorstand') // the unit keeps its plain name; only the Nextcloud mount point carries the key
    })

    it('two customers whose units carry the same id still get separate groups and folders', async () => {
      const nc = fakeNc()
      const a = await subsystem(nc, fakeKc(), 1, 'ka').ensureResource(unit, ctx, null)
      const b = await subsystem(nc, fakeKc(), 1, 'kb').ensureResource(unit, ctx, null)
      expect(a.externalId).not.toBe(b.externalId)
      expect([...nc.groups].sort()).toEqual(['ou-ka-abc', 'ou-kb-abc'])
      expect(nc.grants).toEqual([[77, 'ou-ka-abc'], [78, 'ou-kb-abc']])
    })

    it("customer B never adopts customer A's folder of the same unit name, however it is named", async () => {
      const nc = fakeNc([
        { id: 12, mountPoint: 'Vorstand (ka)', groups: ['ou-ka-abc'] },
        { id: 13, mountPoint: 'Vorstand', groups: ['ou-abc'] }, // an earlier, plain-named folder of another customer
      ])
      const r = await subsystem(nc, fakeKc(), 1, 'kb').ensureResource(unit, ctx, null)
      expect(r.externalId).toBe('77:ou-kb-abc')
      expect(nc.folders).toEqual(['Vorstand (kb)'])
      expect(nc.grants).toEqual([[77, 'ou-kb-abc']]) // neither folder of A was granted to B's group
    })

    it('a customer finds its own folder again by the namespaced mount point and its own group', async () => {
      const nc = fakeNc([{ id: 12, mountPoint: 'Vorstand (ka)', groups: ['ou-ka-abc'] }])
      const r = await subsystem(nc, fakeKc(), 1, 'ka').ensureResource(unit, ctx, null)
      expect(r.externalId).toBe('12:ou-ka-abc')
      expect(nc.folders).toHaveLength(0)
    })
  })

  describe('a folder made before the namespace existed (plain mount point, plain group)', () => {
    const ctx = { parentKeycloakGroupId: null }

    it('is kept as recorded: no second folder, no new group, nothing moved by a provisioning pass', async () => {
      const nc = fakeNc([{ id: 12, mountPoint: 'Vorstand', groups: ['ou-abc'], groupPermissions: { 'ou-abc': 31 } }])
      const r = await subsystem(nc).ensureResource(unit, ctx, '12:ou-abc')
      expect(r.externalId).toBe('12:ou-abc')
      expect(nc.folders).toHaveLength(0)
      expect(nc.groups.size).toBe(0)
      expect(nc.grants).toHaveLength(0)
      expect(nc.deleted).toHaveLength(0)
    })

    it('a half-made one (plain name, no group yet) is granted its RECORDED group', async () => {
      const nc = fakeNc([{ id: 12, mountPoint: 'Vorstand', groups: [] }])
      const r = await subsystem(nc).ensureResource(unit, ctx, '12:ou-abc')
      expect(r.externalId).toBe('12:ou-abc')
      expect(nc.grants).toEqual([[12, 'ou-abc']])
      expect(nc.folders).toHaveLength(0)
    })

    it('members are added to and removed from the recorded group, not a recomputed one', async () => {
      const nc = fakeNc()
      const removed: Array<[string, string]> = []
      nc.removeUserFromGroup = (async (u: string, g: string) => { removed.push([u, g]) }) as never
      await subsystem(nc).addMember('12:ou-abc', 'uuid-1')
      await subsystem(nc).removeMember('12:ou-abc', 'uuid-1')
      expect(nc.membership).toEqual([['uuid-1', 'ou-abc']])
      expect(removed).toEqual([['uuid-1', 'ou-abc']])
    })
  })
})
