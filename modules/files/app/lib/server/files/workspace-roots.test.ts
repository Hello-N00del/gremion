// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Where the Files page opens a unit's folder: found by the folder id the provisioning ledger stores, never by
// the unit's name. On the one shared Nextcloud a name can belong to another customer's folder.
const h = vi.hoisted(() => ({
  ledger: new Map<string, string | null>(),
  folders: [] as Array<{ id: number; mountPoint: string }>,
  listFails: false,
  ledgerFails: false,
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResource: vi.fn(async (unitId: string) => {
    if (h.ledgerFails) throw new Error('database down')
    return h.ledger.has(unitId) ? { external_id: h.ledger.get(unitId) } : null
  }),
}))
vi.mock('./nextcloud-client', () => ({
  createNextcloudClient: () => ({
    listGroupFolders: async () => {
      if (h.listFails) throw new Error('nextcloud down')
      return h.folders.map((f) => ({ ...f, groups: [] }))
    },
  }),
}))

import { resolveWorkspaceRoots } from './workspace-roots'

const KEY = 'ka00000001'
const unit = (id: string, name: string) => ({ id, name })

describe('resolveWorkspaceRoots', () => {
  beforeEach(() => {
    h.ledger.clear()
    h.folders = []
    h.listFails = false
    h.ledgerFails = false
  })

  it('takes the mount point of the folder the ledger names, whatever it is called (namespaced or from before the namespace)', async () => {
    h.folders = [{ id: 12, mountPoint: 'Vorstand' }, { id: 13, mountPoint: `Fachschaft (${KEY})` }]
    h.ledger.set('u1', '12:ou-u1')
    h.ledger.set('u2', `13:ou-${KEY}-u2`)
    const roots = await resolveWorkspaceRoots([unit('u1', 'Vorstand'), unit('u2', 'Fachschaft')], KEY)
    expect(roots.get('u1')).toBe('Vorstand')
    expect(roots.get('u2')).toBe(`Fachschaft (${KEY})`)
  })

  it("never resolves another customer's folder by name: a unit whose folder is namespaced is not sent to a plain-named folder of the same name", async () => {
    h.folders = [{ id: 12, mountPoint: 'Vorstand' }, { id: 13, mountPoint: 'Vorstand (kb00000002)' }]
    // this customer's unit "Vorstand" owns folder 13; folder 12 (also "Vorstand") belongs to somebody else
    h.ledger.set('u1', `13:ou-kb00000002-u1`)
    const roots = await resolveWorkspaceRoots([unit('u1', 'Vorstand')], 'kb00000002')
    expect(roots.get('u1')).toBe('Vorstand (kb00000002)')
  })

  it('a unit with no folder yet is sent to its own namespaced name, never to a folder that merely has its plain name', async () => {
    h.folders = [{ id: 12, mountPoint: 'Vorstand' }]
    const roots = await resolveWorkspaceRoots([unit('u1', 'Vorstand')], KEY)
    expect(roots.get('u1')).toBe(`Vorstand (${KEY})`)
  })

  it('a recorded folder that no longer exists falls back to the namespaced name', async () => {
    h.ledger.set('u1', '99:ou-u1')
    const roots = await resolveWorkspaceRoots([unit('u1', 'Vorstand')], KEY)
    expect(roots.get('u1')).toBe(`Vorstand (${KEY})`)
  })

  it('Nextcloud or the ledger being unreadable degrades to the namespaced names instead of failing the page', async () => {
    h.ledger.set('u1', '12:ou-u1')
    h.listFails = true
    expect((await resolveWorkspaceRoots([unit('u1', 'Vorstand')], KEY)).get('u1')).toBe(`Vorstand (${KEY})`)
    h.listFails = false
    h.ledgerFails = true
    expect((await resolveWorkspaceRoots([unit('u1', 'Vorstand')], KEY)).get('u1')).toBe(`Vorstand (${KEY})`)
  })

  it('without any unit it does not ask Nextcloud at all', async () => {
    h.listFails = true
    expect((await resolveWorkspaceRoots([], KEY)).size).toBe(0)
  })
})
