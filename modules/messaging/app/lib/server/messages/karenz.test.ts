import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Module Karenz (phase 2, Task 15): the messaging participant. The REAL room-admin, matrix-client and
// synapse-admin code runs against an in-memory homeserver (state events, directory aliases, the admin
// room API) behind a fetch stub, so "archived, restored exactly, deleted on day 30" is proven end to
// end; only the governance layer (org units, provisioning ledger) is faked, as in room-admin.test.ts.

vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({
  env: {
    MATRIX_URL: 'http://matrix.test:8008',
    SYNAPSE_ADMIN_TOKEN: 'admin-token',
    SYNAPSE_ADMIN_BOT_USER_ID: '@bot:matrix.test',
    SYNAPSE_SERVER_NAME: 'matrix.test',
  },
}))
const runWithTenant = vi.fn(<T>(_tenant: unknown, fn: () => T): T => fn())
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
  runWithTenant,
}))

interface Unit { id: string; name: string }
const units: Unit[] = []
const ledger = new Map<string, { status: string; external_id: string | null }>()
let detachFailures = 0
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: async (id: string) => units.find((u) => u.id === id) ?? null,
  listOrgUnits: async () => units,
  setSubsystemWanted: async () => undefined,
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResource: async (unitId: string) => ledger.get(unitId) ?? null,
  enqueueResources: async () => undefined,
  markResourceOk: async (unitId: string, _s: string, externalId: string) => {
    ledger.set(unitId, { status: 'ok', external_id: externalId })
  },
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  attachSubsystem: vi.fn(),
  releaseSubsystem: async (unitId: string, _s: string, teardown: (id: string | null) => Promise<void>) => {
    const before = ledger.get(unitId)
    await teardown(before?.external_id ?? null)
    if (detachFailures > 0) { detachFailures--; throw new Error('db down') } // the Matrix side is done, the detach is not
    ledger.delete(unitId)
    return before?.external_id ?? null
  },
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) }),
}))
const writeAuditEntry = vi.fn()
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry }))

import type { KarenzContext } from '$lib/server/module-karenz/participants'
import { KarenzPartialError } from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'

const BOT = '@bot:matrix.test'
const CALL_TYPES = [
  'org.matrix.msc4143.rtc.member', 'org.matrix.msc3401.call.member', 'm.call.member', 'io.element.call.encryption_keys',
]
const originalLevels = () => ({
  events_default: 0, invite: 0, state_default: 50,
  events: { ...Object.fromEntries(CALL_TYPES.map((t) => [t, 0])), 'm.room.name': 50 },
  users: { [BOT]: 100 },
})

// ── the in-memory homeserver ─────────────────────────────────────────────────

interface FakeRoom {
  id: string
  creator: string
  state: Map<string, unknown>
  /** Overrides the sender of the archive marker (a forged marker). */
  markerSender?: string
}
const rooms = new Map<string, FakeRoom>()
const aliases = new Map<string, string>()
let faults: Array<{ match: (url: string, method: string) => boolean; once: boolean; status?: number; error?: string }> = []
let writes: Array<{ method: string; url: string }> = []

function addRoom(id: string, opts: { alias?: string; creator?: string } = {}): FakeRoom {
  const room: FakeRoom = { id, creator: opts.creator ?? BOT, state: new Map() }
  room.state.set('m.room.create', { room_version: '10' })
  room.state.set('m.room.power_levels', originalLevels())
  if (opts.alias) {
    room.state.set('m.room.canonical_alias', { alias: opts.alias })
    aliases.set(opts.alias, id)
  }
  rooms.set(id, room)
  return room
}
function addUnitRoom(unit: Unit, roomId: string, alias: string): FakeRoom {
  units.push(unit)
  ledger.set(unit.id, { status: 'ok', external_id: roomId })
  return addRoom(roomId, { alias })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const notFound = () => json({ errcode: 'M_NOT_FOUND', error: 'not found' }, 404)

async function homeserver(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  if (method !== 'GET') writes.push({ method, url })
  const fault = faults.find((f) => f.match(url, method))
  if (fault) {
    if (fault.once) faults = faults.filter((f) => f !== fault)
    return json({ errcode: 'M_UNKNOWN', error: fault.error ?? 'injected failure' }, fault.status ?? 500)
  }
  const path = url.replace('http://matrix.test:8008', '')

  const st = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\//.exec(path)
  if (st) {
    const room = rooms.get(decodeURIComponent(st[1]!))
    // Synapse answers a client-API state call about a room the user is not in - and a room that was
    // purged is one - with 403 M_FORBIDDEN, never 404 (that is the admin API's answer, below).
    if (!room) return json({ errcode: 'M_FORBIDDEN', error: 'User is not in the room' }, 403)
    const type = decodeURIComponent(st[2]!)
    if (method === 'PUT') {
      const content = JSON.parse(init!.body as string)
      room.state.set(type, content)
      if (type === 'm.room.canonical_alias') { /* the directory is separate in Matrix */ }
      return json({ event_id: '$e' })
    }
    if (!room.state.has(type)) return notFound()
    if (path.includes('format=event')) {
      const sender = type === 'org.gremion.room.archived' ? (room.markerSender ?? BOT) : room.creator
      return json({ sender, content: room.state.get(type) })
    }
    return json(room.state.get(type))
  }

  const dir = /^\/_matrix\/client\/v3\/directory\/room\/([^?]+)/.exec(path)
  if (dir) {
    const alias = decodeURIComponent(dir[1]!)
    if (method === 'PUT') { aliases.set(alias, JSON.parse(init!.body as string).room_id); return json({}) }
    if (method === 'DELETE') { aliases.delete(alias); return json({}) }
    return aliases.has(alias) ? json({ room_id: aliases.get(alias) }) : notFound()
  }

  if (path.endsWith('/make_room_admin')) return json({})

  const detail = /^\/_synapse\/admin\/v1\/rooms\/([^/?]+)$/.exec(path)
  if (detail) {
    const id = decodeURIComponent(detail[1]!)
    const room = rooms.get(id)
    if (method === 'DELETE') {
      if (!room) return notFound()
      rooms.delete(id)
      for (const [a, r] of aliases) if (r === id) aliases.delete(a)
      return json({ kicked_users: [] })
    }
    if (!room) return notFound()
    const canonical = (room.state.get('m.room.canonical_alias') as { alias?: string } | undefined)?.alias ?? null
    return json({ room_id: id, creator: room.creator, canonical_alias: canonical })
  }
  if (path.startsWith('/_synapse/admin/v1/rooms')) {
    return json({
      rooms: [...rooms.values()].map((r) => ({
        room_id: r.id, creator: r.creator,
        canonical_alias: (r.state.get('m.room.canonical_alias') as { alias?: string } | undefined)?.alias ?? null,
      })),
    })
  }
  return json({})
}

// ── the participant's item list (same upsert rule as the real store) ─────────

function makeItems() {
  const rows = new Map<string, KarenzItemRow>()
  let n = 0
  const items: KarenzContext['items'] = {
    list: async (kind) => [...rows.values()].filter((r) => kind === undefined || r.kind === kind),
    upsert: async (i) => {
      const k = `${i.kind}\u0000${i.externalId}`
      const prev = rows.get(k)
      if (prev && i.state === 'recorded' && prev.state !== 'recorded') return prev
      const row: KarenzItemRow = {
        itemId: prev?.itemId ?? `item-${++n}`, karenzId: 'k1', kind: i.kind, externalId: i.externalId, state: i.state,
        payload: i.payload ?? prev?.payload ?? null, detail: i.detail ?? null, updatedAt: new Date(),
      }
      rows.set(k, row)
      return row
    },
    setState: async (itemId, state: ItemState, detail) => {
      const row = [...rows.values()].find((r) => r.itemId === itemId)
      if (!row) throw new Error(`Karenz item ${itemId} no longer exists`)
      row.state = state
      row.detail = detail ?? null
    },
  }
  return { rows, items }
}

function makeCtx(items: KarenzContext['items']): KarenzContext {
  return {
    tenant: { id: 'default', slug: 'default' } as never,
    karenzId: 'k1', catalogueId: 'messaging', manifestId: 'messages',
    switchedOffAt: new Date('2026-11-01T00:00:00Z'), finalAt: new Date('2026-12-01T00:00:00Z'),
    now: () => new Date('2026-11-01T12:00:00Z'), items, log: vi.fn(),
  }
}

describe('messagingKarenz', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let karenz: Awaited<typeof import('./karenz')>
  let store: ReturnType<typeof makeItems>
  let ctx: KarenzContext

  const stateOf = (item: { externalId: string }) => store.rows.get(`room\u0000${item.externalId}`)?.state
  const levelsOf = (roomId: string) => rooms.get(roomId)!.state.get('m.room.power_levels') as ReturnType<typeof originalLevels>
  const markerOf = (roomId: string) => rooms.get(roomId)!.state.get('org.gremion.room.archived') as Record<string, unknown> | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    units.length = 0
    ledger.clear()
    detachFailures = 0
    rooms.clear()
    aliases.clear()
    faults = []
    writes = []
    fetchMock = vi.fn(homeserver)
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store = makeItems()
    ctx = makeCtx(store.items)
    karenz = await import('./karenz')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function seed() {
    addUnitRoom({ id: 'u1', name: 'Vorstand' }, '!r1:matrix.test', '#stura-vorstand:matrix.test')
    addUnitRoom({ id: 'u2', name: 'Finanzen' }, '!r2:matrix.test', '#stura-finanzen:matrix.test')
    addRoom('!meet:matrix.test', { alias: '#meeting-evt1:matrix.test' })
  }

  it('is registered for the messaging catalogue id', () => {
    expect(karenz.messagingKarenz.catalogueId).toBe('messaging')
  })

  describe('switchOff', () => {
    it('archives every ledger room, records one item per room and records meeting-linked rooms as kept without touching them', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)

      for (const roomId of ['!r1:matrix.test', '!r2:matrix.test']) {
        expect(markerOf(roomId)?.org_unit_id).toBeTruthy()
        expect(levelsOf(roomId).events_default).toBe(100) // read-only
      }
      expect(ledger.size).toBe(0) // both ledger rows released
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('locked')
      expect(store.rows.get('room\u0000!r1:matrix.test')!.payload).toEqual({ unitId: 'u1' })

      expect(stateOf({ externalId: '!meet:matrix.test' })).toBe('kept')
      expect(writes.filter((w) => w.url.includes(encodeURIComponent('!meet:matrix.test')))).toEqual([])
      expect(markerOf('!meet:matrix.test')).toBeUndefined()
      expect(levelsOf('!meet:matrix.test')).toEqual(originalLevels())
    })

    it('a meeting-linked room that sits in the ledger is kept, never archived', async () => {
      addUnitRoom({ id: 'u9', name: 'Sitzung' }, '!m2:matrix.test', '#meeting-evt9:matrix.test')
      await karenz.messagingKarenz.switchOff(ctx)
      expect(stateOf({ externalId: '!m2:matrix.test' })).toBe('kept')
      expect(markerOf('!m2:matrix.test')).toBeUndefined()
      expect(ledger.get('u9')?.status).toBe('ok')
    })

    it('writes the audit entries under the karenz-service actor', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'karenz-service', field: 'messages.room.archive', newValue: 'u1:!r1:matrix.test:ok' })
      )
    })

    it('a failing archive of one room does not stop the others and fails the step with unit ids only (no room names)', async () => {
      seed()
      faults.push({ match: (url, m) => m === 'PUT' && url.includes(encodeURIComponent('!r1:matrix.test')) && url.includes('m.room.power_levels'), once: false })

      const err = await karenz.messagingKarenz.switchOff(ctx).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(KarenzPartialError)
      const failures = (err as KarenzPartialError).failures
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('u1')
      expect(failures.join(' ')).not.toMatch(/Vorstand|Finanzen|!r1|matrix\.test/)

      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('locked') // the other room was archived anyway
      expect(levelsOf('!r2:matrix.test').events_default).toBe(100)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('lock_failed')
    })

    it('a recorded room that was purged at the homeserver (its state read answers 403, not 404) is gone, not lock_failed', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!old:matrix.test', state: 'recorded', payload: { unitId: 'u3' } })

      await karenz.messagingKarenz.switchOff(ctx)

      expect(stateOf({ externalId: '!old:matrix.test' })).toBe('gone')
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
    })

    it('a room whose ledger row is failed but still names it is archived like any other (a transient member-sync error must not exempt a room)', async () => {
      seed()
      ledger.set('u1', { status: 'failed', external_id: '!r1:matrix.test' })

      await karenz.messagingKarenz.switchOff(ctx)

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
      expect(markerOf('!r1:matrix.test')?.org_unit_id).toBe('u1')
      expect(levelsOf('!r1:matrix.test').events_default).toBe(100)
      expect(ledger.has('u1')).toBe(false) // released

      await karenz.messagingKarenz.restore(ctx)
      expect(levelsOf('!r1:matrix.test')).toEqual(originalLevels())
    })

    it('a recorded room whose ledger row flipped to failed before the archive is still archived, never dropped as gone', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!r1:matrix.test', state: 'recorded', payload: { unitId: 'u1' } })
      ledger.set('u1', { status: 'failed', external_id: '!r1:matrix.test' })

      await karenz.messagingKarenz.switchOff(ctx)

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
      expect(levelsOf('!r1:matrix.test').events_default).toBe(100)
    })

    it('a retry of an archive that an older build interrupted (marker without a prior, levels already read-only) stores no prior, so the restore falls back to the createRoom defaults', async () => {
      seed()
      const room = rooms.get('!r1:matrix.test')!
      room.state.set('org.gremion.room.archived', { org_unit_id: 'u1', archived_at: '2026-10-01T00:00:00Z' })
      const closed = {
        ...originalLevels(), events_default: 100, invite: 100, state_default: 100,
        events: { ...Object.fromEntries(CALL_TYPES.map((t) => [t, 100])), 'm.room.name': 50 },
      }
      room.state.set('m.room.power_levels', closed)

      await karenz.messagingKarenz.switchOff(ctx)
      expect(markerOf('!r1:matrix.test')?.prior).toBeNull()

      await karenz.messagingKarenz.restore(ctx)
      const pl = levelsOf('!r1:matrix.test')
      expect([pl.events_default, pl.invite, pl.state_default]).toEqual([0, 0, 50])
      expect(console.warn).toHaveBeenCalled()
    })

    it('a failing lookup of the archive alias on a retry is reported as such, the alias PUT is not attempted', async () => {
      seed()
      rooms.get('!r1:matrix.test')!.state.set('org.gremion.room.archived', {
        org_unit_id: 'u1', archived_at: '2026-10-01T00:00:00Z', archive_alias: '#stura-archiv-vorstand-202610010000:matrix.test',
        prior: { events_default: 0, invite: 0, state_default: 50, events: {} },
      })
      aliases.set('#stura-archiv-vorstand-202610010000:matrix.test', '!r1:matrix.test')
      faults = [{ match: (url, method) => method === 'GET' && decodeURIComponent(url).includes('#stura-archiv-'), once: false, status: 502 }]
      writes = []

      await expect(karenz.messagingKarenz.switchOff(ctx)).rejects.toThrow(KarenzPartialError)

      expect(writes.filter((w) => w.method === 'PUT' && decodeURIComponent(w.url).includes('directory/room/#stura-archiv-vorstand'))).toEqual([])
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('lock_failed')
    })

    it('a recorded room whose unit now points at ANOTHER room is gone (positive evidence), not a failure', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!moved:matrix.test', state: 'recorded', payload: { unitId: 'u2' } })
      addRoom('!moved:matrix.test')

      await karenz.messagingKarenz.switchOff(ctx) // u2's ledger names !r2, not !moved

      expect(stateOf({ externalId: '!moved:matrix.test' })).toBe('gone')
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('locked')
    })

    it('a live room that is neither attached to its unit nor archived by us fails the step and is logged, not closed silently', async () => {
      addRoom('!detached:matrix.test')
      units.push({ id: 'u5', name: 'Kasse' }) // no ledger row at all
      await store.items.upsert({ kind: 'room', externalId: '!detached:matrix.test', state: 'recorded', payload: { unitId: 'u5' } })

      const err = await karenz.messagingKarenz.switchOff(ctx).then(() => null, (e: unknown) => e)

      expect(err).toBeInstanceOf(KarenzPartialError)
      expect((err as KarenzPartialError).failures.join(' ')).toContain('u5')
      expect((err as KarenzPartialError).failures.join(' ')).not.toMatch(/detached|matrix\.test/)
      expect(stateOf({ externalId: '!detached:matrix.test' })).toBe('lock_failed')
      expect(ctx.log).toHaveBeenCalled()
    })

    it('a retry in a later minute reuses the archive alias of the earlier attempt, so the restore leaves no archive alias behind', async () => {
      seed()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-11-01T10:00:30Z'))
        detachFailures = 1 // the Matrix side completes, the ledger detach does not
        await expect(karenz.messagingKarenz.switchOff(ctx)).rejects.toBeInstanceOf(KarenzPartialError)
        vi.setSystemTime(new Date('2026-11-01T10:07:30Z'))
        await karenz.messagingKarenz.switchOff(ctx)
      } finally {
        vi.useRealTimers()
      }
      expect([...aliases.keys()].filter((a) => a.startsWith('#stura-archiv-') && aliases.get(a) === '!r1:matrix.test')).toHaveLength(1)

      await karenz.messagingKarenz.restore(ctx)
      expect([...aliases.keys()].filter((a) => a.startsWith('#stura-archiv-'))).toEqual([])
      expect(aliases.get('#stura-vorstand:matrix.test')).toBe('!r1:matrix.test')
    })

    it('a retry after the failure converges, and the restore then puts the room back EXACTLY as it was', async () => {
      seed()
      faults.push({ match: (url, m) => m === 'PUT' && url.includes(encodeURIComponent('!r1:matrix.test')) && url.includes('m.room.power_levels'), once: true })

      await expect(karenz.messagingKarenz.switchOff(ctx)).rejects.toBeInstanceOf(KarenzPartialError)
      expect(markerOf('!r1:matrix.test')?.prior).toBeTruthy() // the marker went first, with the prior
      await karenz.messagingKarenz.switchOff(ctx) // the engine runs the step again

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
      expect(ledger.size).toBe(0)

      await karenz.messagingKarenz.restore(ctx)
      for (const roomId of ['!r1:matrix.test', '!r2:matrix.test']) expect(levelsOf(roomId)).toEqual(originalLevels())
    })

    it('a stale marker of ANOTHER unit on the room never sets the prior this archive stores', async () => {
      seed()
      const stale = { events_default: 77, invite: 77, state_default: 77, events: {} }
      rooms.get('!r1:matrix.test')!.state.set('org.gremion.room.archived', { org_unit_id: 'someone-else', archived_at: '2020-01-01T00:00:00Z', prior: stale })

      await karenz.messagingKarenz.switchOff(ctx)

      const marker = markerOf('!r1:matrix.test')!
      expect(marker.org_unit_id).toBe('u1')
      expect(marker.prior).toMatchObject({ events_default: 0, invite: 0, state_default: 50 })
      expect(marker.archived_at).not.toBe('2020-01-01T00:00:00Z')
    })

    it('a room archived by a council admin BEFORE the switch-off is not recorded, not restored and not deleted', async () => {
      seed()
      const older = addRoom('!old:matrix.test', { alias: '#stura-archiv-alt-202601010000:matrix.test' })
      older.state.set('org.gremion.room.archived', { org_unit_id: 'u7', archived_at: '2026-01-01T00:00:00Z' })
      older.state.set('m.room.power_levels', { ...originalLevels(), events_default: 100 })

      await karenz.messagingKarenz.switchOff(ctx)
      expect(store.rows.has('room\u0000!old:matrix.test')).toBe(false)

      await karenz.messagingKarenz.restore(ctx)
      expect(levelsOf('!old:matrix.test').events_default).toBe(100) // still read-only
      expect(markerOf('!old:matrix.test')?.org_unit_id).toBe('u7')

      await karenz.messagingKarenz.switchOff(ctx)
      await karenz.messagingKarenz.finalize(ctx, { dryRun: false })
      expect(rooms.has('!old:matrix.test')).toBe(true) // deleted on day 30 only if the Karenz archived it
    })
  })

  describe('restore', () => {
    it('unarchives every archived room, marks the items restored and leaves kept ones alone', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      await karenz.messagingKarenz.restore(ctx)

      for (const roomId of ['!r1:matrix.test', '!r2:matrix.test']) {
        expect(levelsOf(roomId)).toEqual(originalLevels())
        expect(markerOf(roomId)?.org_unit_id).toBeUndefined()
      }
      expect(aliases.get('#stura-vorstand:matrix.test')).toBe('!r1:matrix.test')
      expect(ledger.get('u1')).toEqual({ status: 'ok', external_id: '!r1:matrix.test' })
      expect(ledger.get('u2')).toEqual({ status: 'ok', external_id: '!r2:matrix.test' })
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
      expect(stateOf({ externalId: '!meet:matrix.test' })).toBe('kept')
    })

    it('a room that is already unarchived is a no-op (no write reaches the homeserver)', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      await karenz.messagingKarenz.restore(ctx)
      for (const row of store.rows.values()) if (row.state === 'restored') row.state = 'locked' // the pass did not record it
      writes = []

      await karenz.messagingKarenz.restore(ctx)

      expect(writes).toEqual([])
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
    })

    it('a never-archived room whose ledger row is failed (the archive died before the marker write) restores as already active, whatever the row status', async () => {
      seed()
      ledger.set('u1', { status: 'failed', external_id: '!r1:matrix.test' })
      faults = [{ match: (url, method) => method === 'PUT' && decodeURIComponent(url).includes('!r1:') && url.includes('org.gremion.room.archived'), once: false }]
      await expect(karenz.messagingKarenz.switchOff(ctx)).rejects.toThrow(KarenzPartialError)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('lock_failed')
      expect(markerOf('!r1:matrix.test')).toBeUndefined() // nothing was archived
      faults = []
      writes = []

      await karenz.messagingKarenz.restore(ctx)

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('restored')
      expect(levelsOf('!r1:matrix.test')).toEqual(originalLevels())
      expect(ledger.get('u1')).toEqual({ status: 'failed', external_id: '!r1:matrix.test' }) // untouched
      expect(writes.filter((w) => decodeURIComponent(w.url).includes('!r1:'))).toEqual([])
    })

    it('a recorded room with a failed ledger row that was never archived restores as already active', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!r1:matrix.test', state: 'recorded', payload: { unitId: 'u1' } })
      ledger.set('u1', { status: 'failed', external_id: '!r1:matrix.test' })

      await karenz.messagingKarenz.restore(ctx)

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
    })

    it('a restore whose unit alias belongs to another room is audited as such, not as a plain success', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      aliases.set('#stura-vorstand:matrix.test', '!other:matrix.test')
      writeAuditEntry.mockClear()

      await karenz.messagingKarenz.restore(ctx)

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
      const values = writeAuditEntry.mock.calls.map((c) => (c[0] as { newValue: string }).newValue)
      expect(values).toContain('u1:!r1:matrix.test:ok-alias-taken')
      expect(values).toContain('u2:!r2:matrix.test:ok')
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('unit u1'))
    })

    it('a bookkeeping write that fails while reporting a failed room does not stop the remaining rooms', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      faults = [{ match: (url, method) => method === 'PUT' && decodeURIComponent(url).includes('!r1:'), once: false }]
      const realSetState = store.items.setState
      store.items.setState = async (itemId, state, detail) => {
        const row = [...store.rows.values()].find((r) => r.itemId === itemId)
        if (row?.externalId === '!r1:matrix.test') throw new Error('Karenz item no longer exists')
        return realSetState(itemId, state, detail)
      }

      const err = await karenz.messagingKarenz.restore(ctx).catch((e) => e)

      expect(err).toBeInstanceOf(KarenzPartialError)
      expect((err as KarenzPartialError).failures).toEqual(['unit u1'])
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('restored')
    })

    it('one failing room does not stop the others; the failure names the unit only', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      faults.push({ match: (url, m) => m === 'PUT' && url.includes(encodeURIComponent('!r1:matrix.test')) && url.includes('m.room.power_levels'), once: true })

      const err = await karenz.messagingKarenz.restore(ctx).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(KarenzPartialError)
      expect((err as KarenzPartialError).failures.join(' ')).not.toMatch(/Vorstand|!r1/)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('unlock_failed')
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('restored')

      await karenz.messagingKarenz.restore(ctx) // the retry finishes it
      expect(levelsOf('!r1:matrix.test')).toEqual(originalLevels())
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
    })

    it('a room that no longer exists at the homeserver is gone, not a failure', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      rooms.delete('!r2:matrix.test')
      await karenz.messagingKarenz.restore(ctx)
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('gone')
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('restored')
    })

    it('an org unit deleted during the Karenz ends its item as kept (the room stays archived) and the restore converges', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      units.splice(units.findIndex((u) => u.id === 'u1'), 1) // the empty committee was deleted while messaging was off

      await karenz.messagingKarenz.restore(ctx) // must not throw

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('kept')
      expect(store.rows.get('room\u0000!r1:matrix.test')!.detail).toContain('no longer exists')
      expect(stateOf({ externalId: '!r2:matrix.test' })).toBe('restored')
      expect(markerOf('!r1:matrix.test')?.org_unit_id).toBe('u1') // nothing to restore it to: still archived and read-only
      expect(levelsOf('!r1:matrix.test').events_default).toBe(100)

      writes = []
      await karenz.messagingKarenz.restore(ctx) // the next pass has nothing left to do
      expect(writes).toEqual([])
    })

    it('a room the switch-off could not archive (neither attached nor archived) has nothing to restore: the item ends as kept', async () => {
      addRoom('!detached:matrix.test')
      units.push({ id: 'u5', name: 'Kasse' }) // no ledger row at all
      await store.items.upsert({ kind: 'room', externalId: '!detached:matrix.test', state: 'lock_failed', payload: { unitId: 'u5' } })

      await karenz.messagingKarenz.restore(ctx) // must not throw

      expect(stateOf({ externalId: '!detached:matrix.test' })).toBe('kept')
      expect(store.rows.get('room\u0000!detached:matrix.test')!.detail).toContain('never archived')
    })

    it('a locked room whose unit exists but whose marker is missing still fails the restore, visibly', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      rooms.get('!r1:matrix.test')!.state.set('org.gremion.room.archived', { unarchived_at: '2026-11-01T00:00:00Z' }) // marker lost

      const err = await karenz.messagingKarenz.restore(ctx).then(() => null, (e: unknown) => e)

      expect(err).toBeInstanceOf(KarenzPartialError)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('unlock_failed')
    })

    it('a restore of a room that fell back to the createRoom defaults is audited and logged as such', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      const marker = markerOf('!r1:matrix.test')!
      rooms.get('!r1:matrix.test')!.state.set('org.gremion.room.archived', { ...marker, prior: null }) // an older build stored none
      writeAuditEntry.mockClear()

      await karenz.messagingKarenz.restore(ctx)

      const values = writeAuditEntry.mock.calls.map((c) => (c[0] as { newValue: string }).newValue)
      expect(values).toContain('u1:!r1:matrix.test:ok-defaults')
      expect(values).toContain('u2:!r2:matrix.test:ok')
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('unit u1'))
    })

    it('an archive that died after the archive alias was put but before the canonical alias was written leaves no archive alias behind after the restore', async () => {
      seed()
      faults = [{ match: (url, method) => method === 'PUT' && decodeURIComponent(url).includes('!r1:') && url.includes('m.room.canonical_alias'), once: false }]
      await expect(karenz.messagingKarenz.switchOff(ctx)).rejects.toBeInstanceOf(KarenzPartialError)
      expect([...aliases.keys()].filter((a) => a.startsWith('#stura-archiv-') && aliases.get(a) === '!r1:matrix.test')).toHaveLength(1)
      faults = []
      // the unit alias was deleted and the canonical_alias state still names it; the row is still attached
      ledger.set('u1', { status: 'ok', external_id: '!r1:matrix.test' })

      await karenz.messagingKarenz.restore(ctx)

      expect([...aliases.keys()].filter((a) => a.startsWith('#stura-archiv-'))).toEqual([])
      expect(aliases.get('#stura-vorstand:matrix.test')).toBe('!r1:matrix.test')
    })
  })

  describe('finalize', () => {
    it('a dry run deletes nothing and counts the archived rooms', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      writes = []

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: true })

      expect(r).toEqual({ deleted: { rooms: 2 } })
      expect(writes).toEqual([])
      expect(rooms.has('!r1:matrix.test')).toBe(true)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
    })

    it('deletes the archived rooms, never a meeting-linked one', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: false })

      expect(r).toEqual({ deleted: { rooms: 2 } })
      expect(rooms.has('!r1:matrix.test')).toBe(false)
      expect(rooms.has('!r2:matrix.test')).toBe(false)
      expect(rooms.has('!meet:matrix.test')).toBe(true)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('deleted')
      expect(stateOf({ externalId: '!meet:matrix.test' })).toBe('kept')
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'karenz-service', field: 'messages.room.delete', newValue: 'u1:!r1:matrix.test:ok' })
      )
    })

    it('never deletes a meeting-linked room even when an item points at it', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!meet:matrix.test', state: 'locked', payload: { unitId: 'u1' } })
      rooms.get('!meet:matrix.test')!.state.set('org.gremion.room.archived', { org_unit_id: 'u1', archived_at: '2026-11-01T00:00:00Z' })

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: false })

      expect(r).toEqual({ deleted: { rooms: 0 } })
      expect(rooms.has('!meet:matrix.test')).toBe(true)
      expect(stateOf({ externalId: '!meet:matrix.test' })).toBe('kept')
    })

    it('never deletes a room whose archive marker was not sent by the admin bot (forged marker), and says so: a failure naming the unit, the item stays locked', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      rooms.get('!r1:matrix.test')!.markerSender = '@mallory:matrix.test'

      const err = await karenz.messagingKarenz.finalize(ctx, { dryRun: false }).then(() => null, (e: unknown) => e)

      expect(err).toBeInstanceOf(KarenzPartialError)
      expect((err as KarenzPartialError).failures).toEqual(['unit u1'])
      expect(rooms.has('!r1:matrix.test')).toBe(true)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked') // not parked as kept: every pass reports it
      expect(rooms.has('!r2:matrix.test')).toBe(false) // the other room is still deleted
      const logged = (ctx.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('unit u1')
      expect(logged).not.toMatch(/!r1|Vorstand/)
    })

    it('a final-deletion failure logs the full error server-side (the settings label keeps the class only)', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      faults.push({ match: (url, m) => m === 'DELETE' && url.includes(encodeURIComponent('!r1:matrix.test')), once: true })

      const err = await karenz.messagingKarenz.finalize(ctx, { dryRun: false }).then(() => null, (e: unknown) => e)

      expect((err as KarenzPartialError).failures.join(' ')).not.toMatch(/injected/)
      const logged = vi.mocked(console.error).mock.calls
        .map((c) => c[1] as { unitId?: string; err?: Error } | undefined)
        .filter((d) => d?.unitId === 'u1')
      expect(logged).toHaveLength(1)
      expect(logged[0]!.err?.message).toContain('injected failure') // the homeserver's own answer reaches the server log
    })

    it('a dry run does not fail for a room whose archive never finished (a preview only counts)', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!r1:matrix.test', state: 'lock_failed', payload: { unitId: 'u1' } })

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: true })

      expect(r).toEqual({ deleted: { rooms: 0 } })
      expect(ctx.log).toHaveBeenCalled()
    })

    it('an unavailable homeserver at the deletion is reported as MatrixUnavailableError, and a failing audit write does not hide it', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      faults.push({ match: (url, m) => m === 'DELETE' && url.includes('/_synapse/admin/v1/rooms/'), once: false, status: 503, error: 'upstream answered 503' })
      writeAuditEntry.mockRejectedValueOnce(new Error('audit down'))

      await expect(karenz.messagingKarenz.finalize(ctx, { dryRun: false })).rejects.toBeInstanceOf(KarenzPartialError)

      const logged = vi.mocked(ctx.log).mock.calls.map((c) => String(c[0]))
      expect(logged.some((l) => l.includes('MatrixUnavailableError'))).toBe(true)
      expect(rooms.has('!r1:matrix.test')).toBe(true)
    })

    it('a room that is already gone at the homeserver is deleted, not a failure', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      rooms.delete('!r1:matrix.test')

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: false })

      expect(r).toEqual({ deleted: { rooms: 1 } })
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('deleted')
    })

    it('a deletion whose success audit write failed leaves an audit entry on the retry that finds the room gone', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      writeAuditEntry.mockClear()
      writeAuditEntry.mockRejectedValueOnce(new Error('audit down')) // the first room's ':ok' entry (the room IS deleted by then)

      await expect(karenz.messagingKarenz.finalize(ctx, { dryRun: false })).rejects.toBeInstanceOf(KarenzPartialError)
      expect(rooms.has('!r1:matrix.test')).toBe(false)
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')

      await karenz.messagingKarenz.finalize(ctx, { dryRun: false })

      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('deleted')
      const values = writeAuditEntry.mock.calls.map((c) => (c[0] as { newValue: string }).newValue)
      expect(values).toContain('u1:!r1:matrix.test:ok-already-gone')
    })

    it('a dry run that finds a room gone writes no audit entry', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      rooms.delete('!r1:matrix.test')
      writeAuditEntry.mockClear()

      await karenz.messagingKarenz.finalize(ctx, { dryRun: true })

      expect(writeAuditEntry).not.toHaveBeenCalled()
      expect(stateOf({ externalId: '!r1:matrix.test' })).toBe('locked')
    })

    it('a room whose archive never finished is a failure, never deleted', async () => {
      seed()
      await store.items.upsert({ kind: 'room', externalId: '!r1:matrix.test', state: 'lock_failed', payload: { unitId: 'u1' } })

      const err = await karenz.messagingKarenz.finalize(ctx, { dryRun: false }).then(() => null, (e: unknown) => e)

      expect(err).toBeInstanceOf(KarenzPartialError)
      expect(rooms.has('!r1:matrix.test')).toBe(true)
    })

    it('a failing delete of one room does not stop the others and a re-run converges', async () => {
      seed()
      await karenz.messagingKarenz.switchOff(ctx)
      faults.push({ match: (url, m) => m === 'DELETE' && url.includes(encodeURIComponent('!r1:matrix.test')), once: true })

      await expect(karenz.messagingKarenz.finalize(ctx, { dryRun: false })).rejects.toBeInstanceOf(KarenzPartialError)
      expect(rooms.has('!r2:matrix.test')).toBe(false)
      expect(rooms.has('!r1:matrix.test')).toBe(true)

      const r = await karenz.messagingKarenz.finalize(ctx, { dryRun: false })
      expect(r.deleted.rooms).toBe(1)
      expect(rooms.has('!r1:matrix.test')).toBe(false)
    })
  })

  describe('the deletion preview', () => {
    it('counts a room whose ledger row is failed but still names it', async () => {
      seed()
      ledger.set('u1', { status: 'failed', external_id: '!r1:matrix.test' })
      const d = await karenz.messagingKarenz.describe!({ id: 'default', slug: 'default' } as never)
      expect(d.deletes).toEqual([{ label: 'Chat-Räume', count: 2 }])
    })

    it('runs under the tenant it is handed, not the ambient one', async () => {
      seed()
      const tenant = { id: 't-x', slug: 't-x' } as never
      await karenz.messagingKarenz.describe!(tenant)
      expect(runWithTenant).toHaveBeenCalledWith(tenant, expect.any(Function))
    })

    it('counts the rooms a switch-off would archive and delete, and the meeting-linked rooms that stay', async () => {
      seed()
      const d = await karenz.messagingKarenz.describe!({ id: 'default', slug: 'default' } as never)
      expect(d.deletes).toEqual([{ label: 'Chat-Räume', count: 2 }])
      expect(d.retained).toHaveLength(1)
      expect(d.retained[0]).toMatchObject({ count: 1, retentionClass: 'RC-MSG-LINK' })
      expect(d.retained[0]!.label).toContain('Terminbezug')
    })
  })
})
