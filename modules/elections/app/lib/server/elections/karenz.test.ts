// @vitest-environment node
//
// Module Karenz (phase 2, Task 14): the elections participant. Switching elections off pauses the open
// Helios elections through the pause port, switching it back on gives every election its remaining time
// again, the results of closed elections are sealed at switch-off, and the final day archives only
// elections whose sealed result exists. Helios and the election table are stateful fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { KarenzPartialError, type KarenzContext, type KarenzItems } from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'
import { sealLines } from '$lib/server/module-karenz/retained/crypto'
import { fakeTenantDb } from '$lib/server/module-karenz/retained/fake-db.test-util'
import type { HeliosPausePort } from './helios-pause'

interface FakeElection {
  uuid: string
  name: string
  frozen_at: string | null
  voting_ends_at: string | null
  result: unknown
  archived: boolean
}

const h = vi.hoisted(() => ({
  elections: new Map<string, unknown>(),
  getElectionCalls: [] as string[],
  resultFor: undefined as undefined | ((uuid: string) => unknown),
  failRead: new Set<string>(),
  archiveCalls: [] as string[][],
  unarchiveCalls: [] as string[][],
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: () => undefined }))
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'tenant-a',
  getTenant: () => ({ id: 'tenant-a' }),
  runWithTenant: (_t: unknown, fn: () => unknown) => fn(),
}))
vi.mock('./helios-client', async (orig) => {
  const real = await orig<typeof import('./helios-client')>()
  return {
    ...real,
    HeliosClient: {
      ...real.HeliosClient,
      getElection: async (uuid: string) => {
        h.getElectionCalls.push(uuid)
        if (h.failRead.has(uuid)) throw new real.HeliosUnavailableError(`Helios /helios/elections/${uuid} unreachable`, null)
        const e = h.elections.get(uuid) as FakeElection | undefined
        if (!e) throw new real.HeliosUnavailableError(`Helios /helios/elections/${uuid} → 404`, 404)
        return { ...e, short_name: uuid, description: '', voting_starts_at: null, archived_at: null, num_cast_votes: 0, result_proof: null }
      },
      getResult: async (uuid: string) => {
        if (h.resultFor) return h.resultFor(uuid)
        return { questions: [{ question: `Frage ${uuid}`, answers: ['ja', 'nein'], tally: [3, 1], num_tallied: 4 }] }
      },
    },
  }
})
vi.mock('./election-db', () => ({
  ElectionDb: {
    findAll: async () => [...h.elections.values()].filter((e) => !(e as FakeElection).archived).map((e) => ({ helios_uuid: (e as FakeElection).uuid, id: (e as FakeElection).uuid })),
    archiveForKarenz: async (uuids: string[]) => {
      h.archiveCalls.push(uuids)
      let n = 0
      for (const u of uuids) {
        const e = h.elections.get(u) as FakeElection | undefined
        if (e && !e.archived) {
          e.archived = true
          n++
        }
      }
      return n
    },
    unarchiveForKarenz: async (uuids: string[]) => {
      h.unarchiveCalls.push(uuids)
      let n = 0
      for (const u of uuids) {
        const e = h.elections.get(u) as FakeElection | undefined
        if (e?.archived) {
          e.archived = false
          n++
        }
      }
      return n
    },
  },
}))

const T0 = new Date('2026-10-01T10:00:00Z')
const HOUR = 3_600_000
const DAY = 86_400_000
const TENANT = 'tenant-a'
const KARENZ = '55555555-5555-4555-8555-555555555551'
const SECRET = 'unit-test-secret-elections'
const EXTRACTOR = 'elections.election-results'
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  h.elections.clear()
  h.getElectionCalls.length = 0
  h.resultFor = undefined
  h.failRead.clear()
  h.archiveCalls.length = 0
  h.unarchiveCalls.length = 0
  vi.stubEnv('AUTH_SECRET', SECRET)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function seed(uuid: string, over: Partial<FakeElection> = {}): FakeElection {
  const e: FakeElection = { uuid, name: `Wahl ${uuid.slice(0, 2)}`, frozen_at: '2026-09-20T08:00:00Z', voting_ends_at: new Date(T0.getTime() + 3 * DAY).toISOString(), result: null, archived: false, ...over }
  h.elections.set(uuid, e)
  return e
}

/** A stateful stand-in for the pause port: lock closes the election, unlock sets its end to now plus the remaining time. */
function fakePort(over: { lock?: HeliosPausePort['lock']; unlock?: HeliosPausePort['unlock'] } = {}) {
  const calls: Array<{ op: 'lock' | 'unlock'; uuid: string; remainingMs?: number }> = []
  const port: HeliosPausePort = {
    mode: 'extend',
    lock: async (uuid) => {
      calls.push({ op: 'lock', uuid })
      if (over.lock) return over.lock(uuid)
      const e = h.elections.get(uuid) as FakeElection
      e.voting_ends_at = new Date(Date.now() - 1000).toISOString()
      return { ok: true }
    },
    unlock: async (uuid, remainingMs) => {
      calls.push({ op: 'unlock', uuid, remainingMs })
      if (over.unlock) return over.unlock(uuid, remainingMs)
      const e = h.elections.get(uuid) as FakeElection
      e.voting_ends_at = new Date(Date.now() + remainingMs).toISOString()
      return { ok: true }
    },
  }
  return { port, calls }
}

/** An in-memory item list with the semantics of the tenant table (a `recorded` upsert never undoes a later state). */
function memItems() {
  const rows = new Map<string, KarenzItemRow>()
  let seq = 0
  const hooks: { setState?: (itemId: string, s: ItemState) => void } = {}
  const items: KarenzItems = {
    list: async (kind) => [...rows.values()].filter((r) => kind === undefined || r.kind === kind).toSorted((a, b) => a.externalId.localeCompare(b.externalId)),
    upsert: async (i) => {
      const k = `${i.kind}|${i.externalId}`
      const ex = rows.get(k)
      if (ex && i.state === 'recorded' && ex.state !== 'recorded') return ex
      const row: KarenzItemRow = {
        itemId: ex?.itemId ?? `item-${++seq}`,
        karenzId: KARENZ,
        kind: i.kind,
        externalId: i.externalId,
        state: i.state,
        payload: i.payload ?? ex?.payload ?? null,
        detail: i.detail ?? null,
        updatedAt: new Date(),
      }
      rows.set(k, row)
      return row
    },
    setState: async (itemId, state, detail) => {
      hooks.setState?.(itemId, state)
      const row = [...rows.values()].find((r) => r.itemId === itemId)
      if (!row) throw new Error(`Karenz item ${itemId} no longer exists`)
      rows.set(`${row.kind}|${row.externalId}`, { ...row, state, detail: detail ?? null })
    },
  }
  return { items, rows, hooks, byUuid: (u: string) => rows.get(`election|${u}`) }
}

function ctxFor(m: ReturnType<typeof memItems>, over: { now?: Date; db?: unknown } = {}): KarenzContext {
  const clock = over.now ?? T0
  return {
    tenant: { id: TENANT, slug: 'rat-a', db: over.db } as unknown as TenantContext,
    karenzId: KARENZ,
    catalogueId: 'elections',
    manifestId: 'elections',
    switchedOffAt: T0,
    finalAt: new Date(T0.getTime() + 30 * DAY),
    now: () => clock,
    items: m.items,
    log: () => {},
  }
}

const failuresOf = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(KarenzPartialError)
  return (err as KarenzPartialError).failures
}

describe('electionsKarenz.switchOff', () => {
  it('locks only open elections and records the remaining time', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const open = seed(U1)
    seed(U2, { voting_ends_at: new Date(T0.getTime() - DAY).toISOString() }) // closed
    seed(U3, { frozen_at: null, voting_ends_at: null }) // draft
    const { port, calls } = fakePort()
    const m = memItems()
    await createElectionsKarenz(port).switchOff(ctxFor(m))
    expect(calls).toEqual([{ op: 'lock', uuid: U1 }])
    expect(m.byUuid(U1)).toMatchObject({ state: 'locked', payload: { endsAt: new Date(T0.getTime() + 3 * DAY).toISOString(), remainingMs: 3 * DAY } })
    expect(new Date(open.voting_ends_at as string).getTime()).toBeLessThan(T0.getTime())
    expect(m.byUuid(U2)).toBeUndefined()
    expect(m.byUuid(U3)).toBeUndefined()
  })

  it('records the item BEFORE the lock call (the item row is already there when the port is called)', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    const m = memItems()
    const seen: Array<{ state?: string; remainingMs?: unknown }> = []
    const { port } = fakePort({
      lock: async (uuid) => {
        const row = (await m.items.list('election'))[0]
        seen.push({ state: row?.state, remainingMs: (row?.payload as { remainingMs?: unknown } | null)?.remainingMs })
        ;(h.elections.get(uuid) as FakeElection).voting_ends_at = new Date(Date.now() - 1000).toISOString()
        return { ok: true }
      },
    })
    await createElectionsKarenz(port).switchOff(ctxFor(m))
    expect(seen).toEqual([{ state: 'recorded', remainingMs: 3 * DAY }])
  })

  it('a refused lock leaves the item lock_failed, fails the step with the election id (no name), and still locks the others', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1, { name: 'Wahl Erika Muster' })
    seed(U2)
    const { port } = fakePort({
      lock: async (uuid) => {
        if (uuid === U1) return { ok: false, reason: 'HTTP 500' }
        ;(h.elections.get(uuid) as FakeElection).voting_ends_at = new Date(Date.now() - 1000).toISOString()
        return { ok: true }
      },
    })
    const m = memItems()
    const failures = await failuresOf(createElectionsKarenz(port).switchOff(ctxFor(m)))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(U1)
    expect(failures.join(' ')).not.toMatch(/Erika/)
    expect(m.byUuid(U1)?.state).toBe('lock_failed')
    expect(m.byUuid(U2)?.state).toBe('locked')
    // nothing was closed for the refused election
    expect(new Date((h.elections.get(U1) as FakeElection).voting_ends_at as string).getTime()).toBeGreaterThan(T0.getTime())
  })

  it('a lock the port reports as done but that did not take effect is lock_failed, not locked', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    const { port } = fakePort({ lock: async () => ({ ok: true }) }) // claims success, changes nothing
    const m = memItems()
    const failures = await failuresOf(createElectionsKarenz(port).switchOff(ctxFor(m)))
    expect(failures[0]).toContain(U1)
    expect(m.byUuid(U1)?.state).toBe('lock_failed')
  })

  it('a crash after the lock call and before the item is marked locked leaves a recorded item that switchOff resolves and restore reopens', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const e = seed(U1)
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    let crash = true
    m.hooks.setState = () => {
      if (crash) throw new Error('process died')
    }
    const failures = await failuresOf(k.switchOff(ctxFor(m)))
    expect(failures.join(' ')).toContain(U1)
    expect(new Date(e.voting_ends_at as string).getTime()).toBeLessThan(T0.getTime()) // Helios side locked
    expect(m.byUuid(U1)?.state).toBe('recorded') // ledger still says recorded

    crash = false
    await k.switchOff(ctxFor(m))
    expect(m.byUuid(U1)?.state).toBe('locked')
    expect(calls.filter((c) => c.op === 'lock')).toHaveLength(1) // read back, no second lock

    // and the other crash: the restore after the crash reopens the election, never leaving it closed
    const m2 = memItems()
    h.elections.clear()
    const e2 = seed(U1)
    crash = true
    m2.hooks.setState = () => {
      if (crash) throw new Error('process died')
    }
    await failuresOf(k.switchOff(ctxFor(m2)))
    crash = false
    const later = new Date(T0.getTime() + 10 * DAY)
    vi.setSystemTime(later)
    await k.restore(ctxFor(m2, { now: later }))
    expect(new Date(e2.voting_ends_at as string).getTime()).toBe(later.getTime() + 3 * DAY)
    expect(m2.byUuid(U1)?.state).toBe('restored')
  })

  it('a closed election is never touched and an election that ran out by itself before the lock is not locked or reopened', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const closed = seed(U1, { voting_ends_at: new Date(T0.getTime() - HOUR).toISOString() })
    const endsAt = closed.voting_ends_at
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    await k.restore(ctxFor(m))
    expect(calls).toEqual([])
    expect(closed.voting_ends_at).toBe(endsAt)
    expect(m.rows.size).toBe(0)
  })

  it('an election that ran out by itself between recording and the lock is marked restored and never reopened', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const e = seed(U1, { voting_ends_at: new Date(T0.getTime() + HOUR).toISOString() })
    const endsAt = e.voting_ends_at
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    // the ledger knows the election as recorded, the port never ran, and the end has passed since
    await m.items.upsert({ kind: 'election', externalId: U1, state: 'recorded', payload: { endsAt, remainingMs: HOUR } })
    vi.setSystemTime(new Date(T0.getTime() + 2 * HOUR))
    await k.switchOff(ctxFor(m, { now: new Date(T0.getTime() + 2 * HOUR) }))
    expect(calls).toEqual([])
    expect(m.byUuid(U1)?.state).toBe('restored')
    await k.restore(ctxFor(m, { now: new Date(T0.getTime() + 3 * HOUR) }))
    expect(calls).toEqual([])
    expect(e.voting_ends_at).toBe(endsAt)
  })

  it('switchOff run twice locks nothing twice (idempotent)', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    await k.switchOff(ctxFor(m))
    expect(calls.filter((c) => c.op === 'lock')).toHaveLength(1)
  })

  it('an election that cannot be read is reported with its id and does not stop the others', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    seed(U2)
    h.failRead.add(U1)
    const { port } = fakePort()
    const m = memItems()
    const failures = await failuresOf(createElectionsKarenz(port).switchOff(ctxFor(m)))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(U1)
    expect(m.byUuid(U1)).toBeUndefined() // not recorded, not locked: the next pass tries again
    expect(m.byUuid(U2)?.state).toBe('locked')
  })

  it('with the unsupported port nothing is closed and the step fails for the open election', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const { heliosPause } = await import('./helios-pause')
    const e = seed(U1)
    const endsAt = e.voting_ends_at
    const m = memItems()
    const port = heliosPause('unsupported')
    expect(port.mode).toBe('unsupported')
    const failures = await failuresOf(createElectionsKarenz(port).switchOff(ctxFor(m)))
    expect(failures[0]).toContain(U1)
    expect(m.byUuid(U1)?.state).toBe('lock_failed')
    expect(e.voting_ends_at).toBe(endsAt)
  })
})

describe('electionsKarenz.restore', () => {
  it('unlocks with the stored remaining time and verifies by reading the election back', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const e = seed(U1)
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    const later = new Date(T0.getTime() + 12 * DAY)
    vi.setSystemTime(later)
    h.getElectionCalls.length = 0
    await k.restore(ctxFor(m, { now: later }))
    expect(calls.filter((c) => c.op === 'unlock')).toEqual([{ op: 'unlock', uuid: U1, remainingMs: 3 * DAY }])
    // now plus remaining, not the original date
    expect(new Date(e.voting_ends_at as string).getTime()).toBe(later.getTime() + 3 * DAY)
    expect(h.getElectionCalls.length).toBeGreaterThanOrEqual(2) // before the unlock and the read-back
    expect(m.byUuid(U1)?.state).toBe('restored')
  })

  it('a refused unlock keeps the election locked, marks unlock_failed and fails the step', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const e = seed(U1)
    const { port } = fakePort({ unlock: async () => ({ ok: false, reason: 'HTTP 403' }) })
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    const failures = await failuresOf(k.restore(ctxFor(m, { now: new Date(T0.getTime() + DAY) })))
    expect(failures[0]).toContain(U1)
    expect(m.byUuid(U1)?.state).toBe('unlock_failed')
    expect(new Date(e.voting_ends_at as string).getTime()).toBeLessThan(T0.getTime()) // still locked
    // the next restore retries (unlock_failed is pending)
    const ok = fakePort()
    await createElectionsKarenz(ok.port).restore(ctxFor(m, { now: new Date(T0.getTime() + DAY) }))
    expect(m.byUuid(U1)?.state).toBe('restored')
  })

  it('an unlock the port reports as done but that left the election closed is unlock_failed', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    const k0 = createElectionsKarenz(fakePort().port)
    const m = memItems()
    await k0.switchOff(ctxFor(m))
    const { port } = fakePort({ unlock: async () => ({ ok: true }) }) // claims success, changes nothing
    const failures = await failuresOf(createElectionsKarenz(port).restore(ctxFor(m)))
    expect(failures[0]).toContain(U1)
    expect(m.byUuid(U1)?.state).toBe('unlock_failed')
  })

  it('a locked item whose election was reopened by hand is marked restored and nothing is written', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    const e = seed(U1)
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    e.voting_ends_at = new Date(T0.getTime() + 5 * DAY).toISOString() // reopened by the operator
    await k.restore(ctxFor(m))
    expect(calls.filter((c) => c.op === 'unlock')).toEqual([])
    expect(m.byUuid(U1)?.state).toBe('restored')
  })

  it('restore is idempotent and un-archives what the final step archived', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1)
    const { port, calls } = fakePort()
    const k = createElectionsKarenz(port)
    const m = memItems()
    await k.switchOff(ctxFor(m))
    await m.items.upsert({ kind: 'election-archive', externalId: U2, state: 'kept', detail: 'archived' })
    seed(U2, { archived: true })
    await k.restore(ctxFor(m, { now: new Date(T0.getTime() + DAY) }))
    await k.restore(ctxFor(m, { now: new Date(T0.getTime() + DAY) }))
    expect(calls.filter((c) => c.op === 'unlock')).toHaveLength(1)
    expect(h.unarchiveCalls).toEqual([[U2]])
    expect((h.elections.get(U2) as FakeElection).archived).toBe(false)
    expect(m.rows.get(`election-archive|${U2}`)?.state).toBe('restored')
  })
})

describe('electionResultsExtractor', () => {
  async function collect(ctx: KarenzContext) {
    const { electionResultsExtractor } = await import('./karenz')
    const out = []
    for await (const l of electionResultsExtractor.extract(ctx)) out.push(l)
    return out
  }

  it('is the RC-ELE extractor of the elections catalogue id', async () => {
    const { electionResultsExtractor } = await import('./karenz')
    expect(electionResultsExtractor).toMatchObject({ id: EXTRACTOR, catalogueId: 'elections', retentionClass: 'RC-ELE' })
  })

  it('emits one line per closed election and no voter data; open and draft elections are not copied', async () => {
    seed(U1, { name: 'Abgeschlossen', voting_ends_at: '2026-09-25T12:00:00.000Z', result: { questions: [] } })
    seed(U2) // open
    seed(U3, { frozen_at: null, voting_ends_at: null }) // draft
    const lines = await collect(ctxFor(memItems()))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      id: U1,
      data: { name: 'Abgeschlossen', votingEndsAt: '2026-09-25T12:00:00.000Z', result: { questions: [{ question: `Frage ${U1}`, tally: [3, 1] }] } },
      persons: [],
    })
    expect(JSON.stringify(lines)).not.toMatch(/voter|email|listVoters/i)
  })

  it('a closed election without a tallied result is sealed with result null instead of failing', async () => {
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' })
    const { HeliosUnavailableError } = await import('./helios-client')
    h.resultFor = () => {
      throw new HeliosUnavailableError('Helios /result → 404', 404)
    }
    const lines = await collect(ctxFor(memItems()))
    expect(lines).toHaveLength(1)
    expect((lines[0]!.data as { result: unknown }).result).toBeNull()
  })

  it('an election the participant paused is not sealed as a closed election, even when the extractor runs after the lock', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1) // open at switch-off
    seed(U2, { voting_ends_at: '2026-09-25T12:00:00.000Z' }) // closed before
    const m = memItems()
    await createElectionsKarenz(fakePort().port).switchOff(ctxFor(m))
    const lines = await collect(ctxFor(m))
    expect(lines.map((l) => l.id)).toEqual([U2])
  })

  it('an unreadable election fails the extraction instead of sealing a partial copy', async () => {
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' })
    h.failRead.add(U1)
    await expect(collect(ctxFor(memItems()))).rejects.toThrow()
  })
})

describe('electionsKarenz.finalize', () => {
  const seal = async (db: unknown, ids: string[]) => {
    const lines = ids.map((id) => ({ id, data: { name: `w${id}` }, persons: [] as { id: string; field: string }[] }))
    await sealLines(db as never, TENANT, KARENZ, EXTRACTOR, lines, { catalogueId: 'elections', retentionClass: 'RC-ELE' }, { secret: SECRET, guard: async () => {} })
  }

  it('a dry run archives nothing and counts what a real run would archive', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' })
    seed(U2, { voting_ends_at: '2026-09-26T12:00:00.000Z' })
    const t = fakeTenantDb()
    await seal(t.db, [U1])
    const r = await createElectionsKarenz(fakePort().port).finalize(ctxFor(memItems(), { db: t.db }), { dryRun: true })
    expect(r).toEqual({ deleted: { elections: 1 } })
    expect(h.archiveCalls).toEqual([])
    expect((h.elections.get(U1) as FakeElection).archived).toBe(false)
  })

  it('archives only elections whose sealed result exists, and is idempotent', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' })
    seed(U2, { voting_ends_at: '2026-09-26T12:00:00.000Z' }) // no sealed line
    seed(U3) // open at switch-off, no result
    const t = fakeTenantDb()
    await seal(t.db, [U1])
    const m = memItems()
    const k = createElectionsKarenz(fakePort().port)
    expect(await k.finalize(ctxFor(m, { db: t.db }), { dryRun: false })).toEqual({ deleted: { elections: 1 } })
    expect(h.archiveCalls).toEqual([[U1]])
    expect((h.elections.get(U1) as FakeElection).archived).toBe(true)
    expect((h.elections.get(U2) as FakeElection).archived).toBe(false)
    expect((h.elections.get(U3) as FakeElection).archived).toBe(false)
    expect(m.rows.get(`election-archive|${U1}`)).toMatchObject({ state: 'kept' })
    // a second run finds nothing left to archive
    expect(await k.finalize(ctxFor(m, { db: t.db }), { dryRun: false })).toEqual({ deleted: { elections: 0 } })
  })

  it('with no sealed copy at all nothing is archived', async () => {
    const { createElectionsKarenz } = await import('./karenz')
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' })
    const t = fakeTenantDb()
    expect(await createElectionsKarenz(fakePort().port).finalize(ctxFor(memItems(), { db: t.db }), { dryRun: false })).toEqual({ deleted: { elections: 0 } })
    expect(h.archiveCalls).toEqual([])
  })
})

describe('the switch-off guard', () => {
  const tenant = { id: TENANT, slug: 'rat-a' } as unknown as TenantContext

  it('with mode unsupported the guard blocks the switch-off while an election is open and allows it when none is', async () => {
    const { electionsSwitchOffGuard } = await import('./karenz')
    seed(U1, { voting_ends_at: '2026-09-25T12:00:00.000Z' }) // closed
    seed(U3, { frozen_at: null, voting_ends_at: null }) // draft
    expect(await electionsSwitchOffGuard(tenant)).toBeNull()
    seed(U2) // open
    expect(await electionsSwitchOffGuard(tenant)).toMatch(/Laufende Wahlen/)
  })

  it('a Helios that cannot be read makes the guard throw, so the switch service fails closed', async () => {
    const { electionsSwitchOffGuard } = await import('./karenz')
    seed(U1)
    h.failRead.add(U1)
    await expect(electionsSwitchOffGuard(tenant)).rejects.toThrow()
  })
})

describe('heliosPause', () => {
  it('ships unsupported until the running Helios is probed, and an unsupported port refuses to lock or unlock', async () => {
    const { heliosPause, HELIOS_PAUSE_MODE } = await import('./helios-pause')
    expect(HELIOS_PAUSE_MODE).toBe('unsupported')
    const p = heliosPause()
    expect(p.mode).toBe('unsupported')
    expect(await p.lock(U1)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await p.unlock(U1, 1000)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('an extend port without an implementation refuses instead of pretending', async () => {
    const { heliosPause } = await import('./helios-pause')
    const p = heliosPause('extend')
    expect(p.mode).toBe('extend')
    const r = await p.lock(U1)
    expect(r.ok).toBe(false)
  })

  it('an extend port delegates to its implementation and a throwing implementation becomes a refusal', async () => {
    const { heliosPause } = await import('./helios-pause')
    const lock = vi.fn(async () => {})
    const unlock = vi.fn(async () => {
      throw new Error('boom Erika')
    })
    const p = heliosPause('extend', { lock, unlock })
    expect(await p.lock(U1)).toEqual({ ok: true })
    expect(lock).toHaveBeenCalledWith(U1)
    const r = await p.unlock(U1, 5000)
    expect(r.ok).toBe(false)
    expect(unlock).toHaveBeenCalledWith(U1, 5000)
    expect(JSON.stringify(r)).not.toMatch(/Erika/)
  })
})
