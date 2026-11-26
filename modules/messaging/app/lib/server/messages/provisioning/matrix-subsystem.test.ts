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

// MATRIX_IDENTITY=namespaced: an account is created when missing and otherwise left as it is. The login
// path never reactivates or renames an account (matrix-identity.mint.test.ts); provisioning must not
// either, or an erased subject would come back with the next membership sync.
describe('matrix subsystem with a namespaced identity', () => {
  const identity = { slug: 'acme', tenantId: 'tid-acme' }
  function nsDeps(deactivated: string[] = []) {
    const d = deps()
    const ensured: Array<[string, string | undefined]> = []
    const synapse = {
      ...d.synapse,
      async ensureUser(localpart: string, displayName?: string) {
        ensured.push([localpart, displayName])
        d.log.push(`ensure:${localpart}`)
        return deactivated.includes(localpart) ? ('deactivated' as const) : ('ok' as const)
      },
    }
    return { ...d, synapse, ensured }
  }
  const build = (d: ReturnType<typeof nsDeps>) =>
    createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv', identity)

  it('addMember ensures the account instead of writing it, and joins it', async () => {
    const d = nsDeps()
    await build(d).addMember('!room:srv', 'uuid-9')
    expect(d.ensured).toEqual([['acme.name-uuid-9', 'First Last']])
    expect(d.synapse.created).toEqual([])
    expect(d.log).toEqual(['ensure:acme.name-uuid-9', 'join:@acme.name-uuid-9:srv'])
  })

  it('addMember does not join a deactivated account, and does not fail', async () => {
    const d = nsDeps(['acme.name-uuid-9'])
    await expect(build(d).addMember('!room:srv', 'uuid-9')).resolves.toBeUndefined()
    expect(d.synapse.joined).toEqual([])
    expect(d.synapse.created).toEqual([])
  })

  it('reconcileMembers skips a deactivated account and still joins the others', async () => {
    const d = nsDeps(['acme.name-uuid-1'])
    await build(d).reconcileMembers('!room:srv', ['uuid-1', 'uuid-2', 'uuid-3'])
    expect(d.synapse.joined).toEqual([['!room:srv', '@acme.name-uuid-2:srv'], ['!room:srv', '@acme.name-uuid-3:srv']])
    expect(d.synapse.created).toEqual([])
  })

  it('a name that is only the username (an address) is not offered as display name', async () => {
    const d = nsDeps()
    d.kc.getUser = async (id: string) => ({ id, username: 'max@example.org', firstName: '', lastName: '' }) as never
    await build(d).addMember('!room:srv', 'uuid-9')
    expect(d.ensured).toEqual([['acme.max_40example.org', undefined]])
  })

  it('the legacy form (no identity) still writes the account with createUser and never asks ensureUser', async () => {
    const d = nsDeps()
    const legacy = createMatrixSubsystem({ matrix: d.matrix as never, synapse: d.synapse as never, kc: d.kc as never }, 'srv')
    await legacy.addMember('!room:srv', 'uuid-9')
    expect(d.synapse.created).toEqual(['name-uuid-9'])
    expect(d.ensured).toEqual([])
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
