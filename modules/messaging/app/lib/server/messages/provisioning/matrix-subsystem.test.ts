import { describe, it, expect } from 'vitest'
import { createMatrixSubsystem, aliasLocalpart } from './matrix-subsystem'
import type { OrgUnit } from '../../governance/org-units-db'

const unit: OrgUnit = {
  id: 'u1', parent_id: null, kind: 'committee', name: 'Vorstand',
  description: null, child_term: null, kind_label: null, authority: 'deciding',
  visibility: 'all_members',
  wants_matrix_room: true, wants_nextcloud_folder: true, created_at: new Date()
}

function deps() {
  // `log` records events in order so we can assert createUser happens before forceJoinRoom.
  const log: string[] = []
  return {
    matrix: {
      // `directory` maps a full room alias → room id; tests seed it to simulate
      // a room that survived a Postgres wipe. `createdWith` records the
      // (name, alias) pairs createRoom was called with.
      directory: new Map<string, string>(),
      createdWith: [] as Array<{ name: string; alias?: string }>,
      async createRoom(name: string, _topic: string, alias?: string) {
        this.createdWith.push({ name, alias })
        return `!room-${name}:srv`
      },
      async getRoomIdByAlias(alias: string) {
        return this.directory.get(alias) ?? null
      }
    },
    synapse: {
      joined: [] as Array<[string, string]>,
      deleted: [] as string[],
      created: [] as string[],
      async createUser(localpart: string) { log.push(`create:${localpart}`); this.created.push(localpart) },
      async forceJoinRoom(roomId: string, userId: string) { log.push(`join:${userId}`); this.joined.push([roomId, userId]) },
      async kickFromRoom() {},
      async deleteRoom(roomId: string) { this.deleted.push(roomId) }
    },
    kc: {
      async getUser(id: string) {
        return { id, username: `name-${id}`, firstName: 'First', lastName: 'Last' }
      }
    },
    log
  }
}

describe('matrix subsystem', () => {
  it('creates a room with the deterministic alias and returns its id', async () => {
    const d = deps()
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    const r = await sub.ensureResource(unit, { parentKeycloakGroupId: null }, null)
    expect(r.externalId).toBe('!room-Vorstand:srv')
    // The new room must carry the deterministic alias so future reseeds adopt it.
    expect(d.matrix.createdWith).toEqual([{ name: 'Vorstand', alias: 'stura-vorstand' }])
  })

  it('reuses a stored room id (ledger hit short-circuits before any lookup)', async () => {
    const d = deps()
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    const r = await sub.ensureResource(unit, { parentKeycloakGroupId: null }, '!existing:srv')
    expect(r.externalId).toBe('!existing:srv')
    // No room was created and the directory was not even consulted.
    expect(d.matrix.createdWith).toEqual([])
  })

  it('adopts an existing room by alias when the ledger is empty (cross-reseed dedupe)', async () => {
    const d = deps()
    // A room minted by a prior seed survived the Postgres wipe — it is reachable
    // by its deterministic alias even though the ledger has no entry for it.
    d.matrix.directory.set('#stura-vorstand:srv', '!survivor:srv')
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    const r = await sub.ensureResource(unit, { parentKeycloakGroupId: null }, null)
    expect(r.externalId).toBe('!survivor:srv')
    // Crucially: it must NOT mint a new room (that is the duplicate bug).
    expect(d.matrix.createdWith).toEqual([])
  })

  it('addMember force-joins @username:server resolved from the KC uuid', async () => {
    const d = deps()
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    await sub.addMember('!room:srv', 'uuid-9')
    expect(d.synapse.joined).toEqual([['!room:srv', '@name-uuid-9:srv']])
  })

  it('addMember calls createUser before forceJoinRoom', async () => {
    const d = deps()
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    await sub.addMember('!room:srv', 'uuid-9')
    // createUser must have been called with the localpart
    expect(d.synapse.created).toContain('name-uuid-9')
    // createUser must precede forceJoinRoom in the event log
    const createIdx = d.log.indexOf('create:name-uuid-9')
    const joinIdx = d.log.indexOf('join:@name-uuid-9:srv')
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(joinIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeLessThan(joinIdx)
  })

  it('F2: removeMember swallows "not in the room" — resolves without throw (already-absent idempotency)', async () => {
    const d = deps()
    // Override kickFromRoom to throw the Synapse already-absent error
    d.synapse.kickFromRoom = async () => { throw new Error('User @name-uuid-x:srv is not in the room') }
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    // Must resolve without throwing
    await expect(sub.removeMember('!room:srv', 'uuid-x')).resolves.toBeUndefined()
  })

  it('reconcileMembers calls createUser for every desired user before joining', async () => {
    const d = deps()
    const sub = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    await sub.reconcileMembers('!room:srv', ['uuid-1', 'uuid-2'])
    // Both localparts were provisioned
    expect(d.synapse.created).toContain('name-uuid-1')
    expect(d.synapse.created).toContain('name-uuid-2')
    // For each user, creation precedes the join
    for (const id of ['uuid-1', 'uuid-2']) {
      const localpart = `name-${id}`
      const createIdx = d.log.indexOf(`create:${localpart}`)
      const joinIdx = d.log.indexOf(`join:@${localpart}:srv`)
      expect(createIdx).toBeGreaterThanOrEqual(0)
      expect(joinIdx).toBeGreaterThanOrEqual(0)
      expect(createIdx).toBeLessThan(joinIdx)
    }
  })
})

describe('aliasLocalpart', () => {
  it('slugifies a simple name', () => {
    expect(aliasLocalpart('Vorstand')).toBe('stura-vorstand')
  })

  it('transliterates German umlauts and ß', () => {
    expect(aliasLocalpart('Referat Öffentlichkeitsarbeit')).toBe('stura-referat-oeffentlichkeitsarbeit')
    expect(aliasLocalpart('Über Ärger und Größe')).toBe('stura-ueber-aerger-und-groesse')
  })

  it('collapses spaces and accented/non-ascii characters into single hyphens', () => {
    expect(aliasLocalpart('Initiative Kulturcafé')).toBe('stura-initiative-kulturcafe')
    expect(aliasLocalpart('AG   Soziales & Kultur')).toBe('stura-ag-soziales-kultur')
  })

  it('trims leading/trailing separators produced by punctuation', () => {
    expect(aliasLocalpart('!! Sonderausschuss !!')).toBe('stura-sonderausschuss')
  })

  it('is stable across calls for the same name (reseed determinism)', () => {
    expect(aliasLocalpart('Referat Öffentlichkeitsarbeit')).toBe(aliasLocalpart('Referat Öffentlichkeitsarbeit'))
  })
})
