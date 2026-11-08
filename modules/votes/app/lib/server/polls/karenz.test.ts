// @vitest-environment node
//
// Module Karenz (phase 2, Task 13): the votes participant. Switching votes off freezes the deadlines of
// the tenant's Nextcloud Polls, switching it back on gives every poll its remaining time again, and the
// final day deletes only what a sealed copy and no protocol still needs. One stateful fake Nextcloud
// (fake-nc.ts) serves several tenants, exactly like the shared instance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { KarenzPartialError, type KarenzContext, type KarenzItems } from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'
import { sealLines } from '$lib/server/module-karenz/retained/crypto'
import { fakeTenantDb } from '$lib/server/module-karenz/retained/fake-db.test-util'
import { makeFakeNc, type FakePoll } from './fake-nc'

vi.mock('$lib/server/env/service-env', () => ({
  serviceEnv: (n: string) => ({ NEXTCLOUD_URL: 'http://nc', NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: 'pw' } as Record<string, string>)[n],
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/tenant/context', () => ({
  // the participant pins the tenant from the Karenz context; the ambient one must never be needed
  getTenant: () => {
    throw new Error('no ambient tenant in the Karenz pass')
  },
}))

const T0 = new Date('2026-10-01T10:00:00Z')
const T0_EPOCH = T0.getTime() / 1000
const DAY = 86_400
const TENANT = 'tenant-a'
const OTHER = 'tenant-b'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const SECRET = 'unit-test-secret-votes'
const EXTRACTOR = 'votes.poll-results'

let nc: ReturnType<typeof makeFakeNc>
let netHook: ((method: string, path: string, body: Record<string, any>) => Response | void | Promise<Response | void>) | undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  nc = makeFakeNc()
  netHook = undefined
  vi.stubEnv('AUTH_SECRET', SECRET)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string, i?: RequestInit) => {
      const method = (i?.method ?? 'GET').toUpperCase()
      const path = String(u).replace(/^.*\/api\/v1\.0/, '')
      const body = i?.body ? (JSON.parse(String(i.body)) as Record<string, any>) : {}
      const over = await netHook?.(method, path, body)
      return over ?? nc.handler(String(u), i)
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** Seed a poll straight into the fake Nextcloud, bound to a tenant the way the module binds its own polls. */
function seed(over: Partial<FakePoll> & { tenant?: string; title?: string }): FakePoll {
  const id = nc.polls.size + 1
  const { tenant = TENANT, title = `Poll ${id}`, ...rest } = over
  const p: FakePoll = {
    id,
    type: 'textPoll',
    title: `[gt:${tenant}] ${title}`,
    description: '',
    anonymous: false,
    expire: 0,
    options: [
      { id: 1000 + id * 10, text: 'ja' },
      { id: 1001 + id * 10, text: 'nein' },
    ],
    voters: new Map(),
    owner: 'admin',
    ...rest,
  }
  nc.polls.set(id, p)
  return p
}

/** An in-memory item list with the semantics of the tenant table (a `recorded` upsert never undoes a later state). */
function memItems() {
  const rows = new Map<string, KarenzItemRow>()
  let seq = 0
  const hooks: { setState?: (itemId: string, s: ItemState) => void } = {}
  const items: KarenzItems = {
    list: async (kind) => [...rows.values()].filter((r) => kind === undefined || r.kind === kind).toSorted((a, b) => a.externalId.localeCompare(b.externalId, 'en', { numeric: true })),
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
  return { items, rows, hooks, byPoll: (id: number) => rows.get(`poll|${id}`) }
}

function ctxFor(m: ReturnType<typeof memItems>, over: { now?: Date; db?: unknown; tenantId?: string } = {}): KarenzContext {
  let clock = over.now ?? T0
  return {
    tenant: { id: over.tenantId ?? TENANT, slug: 'rat-a', db: over.db } as unknown as TenantContext,
    karenzId: KARENZ,
    catalogueId: 'votes',
    manifestId: 'votes',
    switchedOffAt: T0,
    finalAt: new Date(T0.getTime() + 30 * DAY * 1000),
    now: () => clock,
    items: m.items,
    log: () => {},
  }
}

const puts = () => nc.calls.filter((c) => c.method === 'PUT' && /^\/poll\/\d+$/.test(c.path))
const failuresOf = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(KarenzPartialError)
  return (err as KarenzPartialError).failures
}

describe('votesKarenz.switchOff', () => {
  it('locks every open poll, stores the remaining seconds and reads the lock back', async () => {
    const { votesKarenz } = await import('./karenz')
    const p1 = seed({ expire: T0_EPOCH + 3600, showResults: 'always' })
    const p2 = seed({ expire: T0_EPOCH + 3 * DAY })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    for (const p of [p1, p2]) expect(p.expire * 1000).toBeLessThan(T0.getTime())
    expect(m.byPoll(1)).toMatchObject({ state: 'locked', payload: { expire: T0_EPOCH + 3600, remainingS: 3600, showResults: 'always' } })
    expect(m.byPoll(2)).toMatchObject({ state: 'locked', payload: { expire: T0_EPOCH + 3 * DAY, remainingS: 3 * DAY } })
    // results are hidden while the poll is frozen, but only for a poll that carries the setting
    expect(p1.showResults).toBe('never')
    expect(p2.showResults).toBeUndefined()
  })

  it('records the item BEFORE the lock call (the item row is already there when the PUT arrives)', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    const seen: Array<{ state?: string; remainingS?: unknown }> = []
    netHook = async (method, path) => {
      if (method === 'PUT' && path === '/poll/1') {
        const row = (await m.items.list('poll'))[0]
        seen.push({ state: row?.state, remainingS: (row?.payload as { remainingS?: unknown } | null)?.remainingS })
      }
    }
    await votesKarenz.switchOff(ctxFor(m))
    expect(seen).toEqual([{ state: 'recorded', remainingS: 3600 }])
  })

  it('a crash between the lock and recording it: a re-run resolves the item to locked, and a restore reopens the poll with now plus the stored remaining time', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    let crash = true
    m.hooks.setState = () => {
      if (crash) throw new Error('process died')
    }
    const failures = await failuresOf(votesKarenz.switchOff(ctxFor(m)))
    expect(failures.join(' ')).toContain('poll 1')
    // the Nextcloud side is locked, the ledger still says recorded
    expect(p.expire * 1000).toBeLessThan(T0.getTime())
    expect(m.byPoll(1)?.state).toBe('recorded')

    crash = false
    const before = puts().length
    await votesKarenz.switchOff(ctxFor(m))
    expect(m.byPoll(1)?.state).toBe('locked')
    expect(puts().length).toBe(before) // read back, no second lock

    const later = new Date(T0.getTime() + 10 * DAY * 1000)
    vi.setSystemTime(later)
    await votesKarenz.restore(ctxFor(m, { now: later }))
    expect(p.expire).toBe(later.getTime() / 1000 + 3600)
    expect(p.expire * 1000).toBeGreaterThan(later.getTime())
    expect(m.byPoll(1)?.state).toBe('restored')
  })

  it('a leftover recorded item whose PUT never happened is locked now', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await m.items.upsert({ kind: 'poll', externalId: '1', state: 'recorded', payload: { expire: p.expire, remainingS: 3600 } })
    await votesKarenz.switchOff(ctxFor(m))
    expect(p.expire * 1000).toBeLessThan(T0.getTime())
    expect(m.byPoll(1)?.state).toBe('locked')
  })

  it('a poll without a deadline is locked and restored to expire 0', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: 0 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    expect(p.expire).toBeGreaterThan(0)
    expect(p.expire * 1000).toBeLessThan(T0.getTime())
    expect(m.byPoll(1)?.payload).toMatchObject({ expire: 0, remainingS: null })
    await votesKarenz.restore(ctxFor(m))
    expect(p.expire).toBe(0)
    expect(m.byPoll(1)?.state).toBe('restored')
  })

  it('a poll that had already expired is never recorded and never reopened', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH - 100 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    await votesKarenz.restore(ctxFor(m))
    expect(m.rows.size).toBe(0)
    expect(p.expire).toBe(T0_EPOCH - 100)
    expect(puts()).toHaveLength(0)
  })

  it('a refused lock marks the item lock_failed, the other polls are still locked, and the step fails with the poll id and no title', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 600, title: 'Geheime Abstimmung Erika' })
    const p2 = seed({ expire: T0_EPOCH + 600, title: 'Geheime Abstimmung Erika' })
    const p3 = seed({ expire: T0_EPOCH + 600 })
    const m = memItems()
    netHook = (method, path) => {
      if (method === 'PUT' && path === '/poll/2') return new Response('{}', { status: 403 })
    }
    const failures = await failuresOf(votesKarenz.switchOff(ctxFor(m)))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('poll 2')
    expect(failures.join(' ')).not.toMatch(/Geheime|Erika/)
    expect(m.byPoll(2)?.state).toBe('lock_failed')
    expect(p2.expire).toBe(T0_EPOCH + 600) // still open: reported, never closed silently
    expect(m.byPoll(1)?.state).toBe('locked')
    expect(m.byPoll(3)?.state).toBe('locked')
    expect(p3.expire * 1000).toBeLessThan(T0.getTime())

    // the next pass retries the failed lock and converges
    netHook = undefined
    await votesKarenz.switchOff(ctxFor(m))
    expect(m.byPoll(2)?.state).toBe('locked')
    expect(p2.expire * 1000).toBeLessThan(T0.getTime())
  })

  it('a poll deleted in Nextcloud before the lock check does not fail the step', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 600 })
    const m = memItems()
    await m.items.upsert({ kind: 'poll', externalId: '77', state: 'recorded', payload: { expire: T0_EPOCH + 600, remainingS: 600 } })
    await votesKarenz.switchOff(ctxFor(m))
    expect(m.byPoll(77)?.state).toBe('gone')
    expect(m.byPoll(1)?.state).toBe('locked')
  })

  it('run twice it locks nothing twice (idempotent)', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: 0 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    const first = puts().length
    expect(first).toBe(2)
    await votesKarenz.switchOff(ctxFor(m))
    expect(puts().length).toBe(first)
    expect([...m.rows.values()].every((r) => r.state === 'locked')).toBe(true)
  })

  it("only the calling tenant's polls are ever listed or touched", async () => {
    const { votesKarenz } = await import('./karenz')
    const mine = seed({ expire: T0_EPOCH + 600 })
    const foreign = seed({ expire: T0_EPOCH + 600, tenant: OTHER })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    expect(mine.expire * 1000).toBeLessThan(T0.getTime())
    expect(foreign.expire).toBe(T0_EPOCH + 600)
    expect(puts().map((c) => c.path)).toEqual(['/poll/1'])
  })
})

describe('votesKarenz.restore', () => {
  it('sets expire to now plus the stored remaining time, not the original date', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 2 * DAY, showResults: 'closed' })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    expect(p.showResults).toBe('never')
    const later = new Date(T0.getTime() + 20 * DAY * 1000)
    vi.setSystemTime(later)
    await votesKarenz.restore(ctxFor(m, { now: later }))
    expect(p.expire).toBe(later.getTime() / 1000 + 2 * DAY)
    expect(p.showResults).toBe('closed')
  })

  it('a recorded item whose poll is still open writes nothing and is marked restored', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await m.items.upsert({ kind: 'poll', externalId: '1', state: 'recorded', payload: { expire: T0_EPOCH + 3600, remainingS: 3600 } })
    await votesKarenz.restore(ctxFor(m))
    expect(puts()).toHaveLength(0)
    expect(p.expire).toBe(T0_EPOCH + 3600)
    expect(m.byPoll(1)?.state).toBe('restored')
  })

  it('a recorded item whose untouched poll ran out by itself during the Karenz is not extended', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await m.items.upsert({ kind: 'poll', externalId: '1', state: 'recorded', payload: { expire: T0_EPOCH + 3600, remainingS: 3600 } })
    const later = new Date(T0.getTime() + 10 * DAY * 1000)
    vi.setSystemTime(later)
    await votesKarenz.restore(ctxFor(m, { now: later }))
    expect(puts()).toHaveLength(0)
    expect(p.expire).toBe(T0_EPOCH + 3600)
    expect(m.byPoll(1)?.state).toBe('restored')
  })

  it('a refused unlock keeps the poll locked, marks unlock_failed and fails the step; a retry converges', async () => {
    const { votesKarenz } = await import('./karenz')
    const p = seed({ expire: T0_EPOCH + 3600 })
    const ok = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    netHook = (method, path) => {
      if (method === 'PUT' && path === '/poll/1') return new Response('{}', { status: 403 })
    }
    const failures = await failuresOf(votesKarenz.restore(ctxFor(m)))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('poll 1')
    expect(m.byPoll(1)?.state).toBe('unlock_failed')
    expect(p.expire * 1000).toBeLessThan(T0.getTime()) // stays locked, reported
    expect(m.byPoll(2)?.state).toBe('restored')
    expect(ok.expire).toBeGreaterThan(T0_EPOCH)

    netHook = undefined
    await votesKarenz.restore(ctxFor(m))
    expect(m.byPoll(1)?.state).toBe('restored')
    expect(p.expire).toBe(T0_EPOCH + 3600)
  })

  it('a poll deleted meanwhile becomes gone and does not fail the step', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 3600 })
    const keep = seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    nc.polls.delete(1)
    await votesKarenz.restore(ctxFor(m))
    expect(m.byPoll(1)?.state).toBe('gone')
    expect(m.byPoll(2)?.state).toBe('restored')
    expect(keep.expire).toBe(T0_EPOCH + 3600)
  })

  it('a poll that stayed locked is reopened only when the unlock reads back as open', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 3600 })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    // Nextcloud acknowledges the PUT but keeps the poll closed
    netHook = (method, path) => {
      if (method === 'PUT' && path === '/poll/1') return new Response(JSON.stringify({ ocs: { meta: { status: 'ok' }, data: {} } }), { status: 200 })
    }
    const failures = await failuresOf(votesKarenz.restore(ctxFor(m)))
    expect(failures[0]).toContain('poll 1')
    expect(m.byPoll(1)?.state).toBe('unlock_failed')
  })
})

describe('pollResultsExtractor', () => {
  const collect = async (ctx: KarenzContext) => {
    const { pollResultsExtractor } = await import('./retained')
    const out = []
    for await (const l of pollResultsExtractor.extract(ctx)) out.push(l)
    return out
  }

  it('is a RC-GOV-RES extractor of the votes catalogue id', async () => {
    const { pollResultsExtractor } = await import('./retained')
    expect(pollResultsExtractor).toMatchObject({ id: EXTRACTOR, catalogueId: 'votes', retentionClass: 'RC-GOV-RES' })
  })

  it('emits one line per closed poll and per poll locked at switch-off, with the tally and no voter data', async () => {
    const closed = seed({ expire: T0_EPOCH - 5 * DAY, title: 'Alt' })
    closed.voters.set('Bearer secret-voter-token-1', new Set([closed.options[0]!.id]))
    closed.voters.set('Bearer secret-voter-token-2', new Set([closed.options[0]!.id]))
    const open = seed({ expire: T0_EPOCH + 3600, title: 'Offen' })
    open.voters.set('Bearer secret-voter-token-1', new Set([open.options[1]!.id]))
    seed({ expire: T0_EPOCH + 3600, title: 'Fremd', tenant: OTHER })
    const lines = await collect(ctxFor(memItems()))
    expect(lines.map((l) => l.id)).toEqual(['1', '2'])
    expect(lines[0]).toMatchObject({
      id: '1',
      persons: [],
      data: { title: 'Alt', closedOrLockedAt: new Date((T0_EPOCH - 5 * DAY) * 1000).toISOString(), options: ['ja', 'nein'] },
    })
    expect((lines[0]!.data.tally as Array<{ option: string; count: number }>).map((t) => [t.option, t.count])).toEqual([
      ['ja', 2],
      ['nein', 0],
    ])
    expect(lines[1]).toMatchObject({ id: '2', data: { title: 'Offen', closedOrLockedAt: T0.toISOString() } })
    const text = JSON.stringify(lines)
    expect(text).not.toContain('secret-voter-token')
    expect(text).not.toContain('Fremd')
  })

  it('a poll already locked by the participant keeps its switch-off time, not the lock value', async () => {
    const { votesKarenz } = await import('./karenz')
    seed({ expire: T0_EPOCH + 3600, title: 'Offen' })
    const m = memItems()
    await votesKarenz.switchOff(ctxFor(m))
    const lines = await collect(ctxFor(m, { now: new Date(T0.getTime() + 3600_000) }))
    expect(lines).toHaveLength(1)
    expect((lines[0]!.data as { closedOrLockedAt: string }).closedOrLockedAt).toBe(T0.toISOString())
  })
})

describe('votesKarenz.finalize', () => {
  /** A tenant db that knows the sealed copy and the protocols table (the rest is the retained fake). */
  function tenantDb(protocolPollIds: string[]) {
    const t = fakeTenantDb()
    const statements: string[] = []
    const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      if (/approval_poll_id/.test(text)) {
        statements.push(text)
        return protocolPollIds.map((id) => ({ approval_poll_id: id }))
      }
      return (t.db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values)
    }
    const db = Object.assign(tag, { unsafe: (s: string) => s, begin: (t.db as unknown as { begin: unknown }).begin })
    return { db, statements }
  }
  const seal = async (db: unknown, ids: string[]) => {
    const lines = ids.map((id) => ({ id, data: { title: `p${id}` }, persons: [] as { id: string; field: string }[] }))
    await sealLines(db as never, TENANT, KARENZ, EXTRACTOR, lines, { catalogueId: 'votes', retentionClass: 'RC-GOV-RES' }, { secret: SECRET, guard: async () => {} })
  }
  const lockedAll = async (m: ReturnType<typeof memItems>) => {
    const { votesKarenz } = await import('./karenz')
    await votesKarenz.switchOff(ctxFor(m))
    return votesKarenz
  }

  it('a dry run deletes nothing and counts what a real run would delete', async () => {
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: T0_EPOCH - 10 })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb(['2'])
    await seal(t.db, ['1', '2', '3'])
    const r = await votes.finalize(ctxFor(m, { db: t.db }), { dryRun: true })
    expect(r).toEqual({ deleted: { polls: 2 } })
    expect(nc.polls.size).toBe(3)
    expect(nc.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('a real finalize deletes a poll with a sealed line and no protocol, keeps a poll a protocol references, and is idempotent', async () => {
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: T0_EPOCH + 600, tenant: OTHER })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb(['2'])
    await seal(t.db, ['1', '2'])
    const r = await votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false })
    expect(r).toEqual({ deleted: { polls: 1 } })
    expect([...nc.polls.keys()]).toEqual([2, 3]) // the referenced poll and the other tenant's poll stay
    expect(m.byPoll(1)?.state).toBe('deleted')
    expect(m.byPoll(2)?.state).toBe('kept')
    // a second run converges and deletes nothing more
    expect(await votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false })).toEqual({ deleted: { polls: 0 } })
    expect([...nc.polls.keys()]).toEqual([2, 3])
  })

  it('keeps a poll WITHOUT a sealed line and reports it as an error, while the sealed ones are still deleted', async () => {
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: T0_EPOCH + 600, title: 'Ohne Siegel Erika' })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb([])
    await seal(t.db, ['1'])
    const failures = await failuresOf(votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false }))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('poll 2')
    expect(failures.join(' ')).not.toMatch(/Erika/)
    expect([...nc.polls.keys()]).toEqual([2])
    expect(m.byPoll(2)?.state).toBe('kept')
  })

  it('with no sealed copy at all nothing is deleted and the step fails', async () => {
    seed({ expire: T0_EPOCH + 600 })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb([])
    const failures = await failuresOf(votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false }))
    expect(failures[0]).toContain('poll 1')
    expect(nc.polls.size).toBe(1)
    expect(nc.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('reads the protocol references from the tenant database as text ids', async () => {
    seed({ expire: T0_EPOCH + 600 })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb(['1'])
    await seal(t.db, ['1'])
    await votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false })
    expect(t.statements.join('\n')).toMatch(/FROM protocols/i)
    expect(nc.polls.has(1)).toBe(true)
  })

  it('a poll that is already gone when it is deleted counts as deleted', async () => {
    seed({ expire: T0_EPOCH + 600 })
    const m = memItems()
    const votes = await lockedAll(m)
    const t = tenantDb([])
    await seal(t.db, ['1'])
    netHook = (method, path) => {
      if (method === 'DELETE' && path === '/poll/1') {
        nc.polls.delete(1) // deleted by someone else between the check and the call
        return new Response('{}', { status: 404 })
      }
    }
    expect(await votes.finalize(ctxFor(m, { db: t.db }), { dryRun: false })).toEqual({ deleted: { polls: 1 } })
  })
})

describe('the polls client additions', () => {
  it('setConfiguration checks the tenant first and sends the patch as pollConfiguration', async () => {
    const { createPollsClient } = await import('./polls-client')
    seed({ expire: 0 })
    const foreign = seed({ expire: 0, tenant: OTHER })
    const c = createPollsClient({ tenantId: TENANT })
    const out = await c.setConfiguration(1, { expire: 123 })
    expect(out.id).toBe(1)
    expect(nc.polls.get(1)!.expire).toBe(123)
    expect(nc.calls.filter((x) => x.method === 'PUT').length).toBe(1)
    await expect(c.setConfiguration(foreign.id, { expire: 5 })).rejects.toMatchObject({ pollsStatus: 404 })
    expect(foreign.expire).toBe(0)
  })

  it('deletePoll refuses another tenant’s poll and deletes its own', async () => {
    const { createPollsClient } = await import('./polls-client')
    seed({})
    const foreign = seed({ tenant: OTHER })
    const c = createPollsClient({ tenantId: TENANT })
    await expect(c.deletePoll(foreign.id)).rejects.toMatchObject({ pollsStatus: 404 })
    expect(nc.polls.has(foreign.id)).toBe(true)
    await c.deletePoll(1)
    expect(nc.polls.has(1)).toBe(false)
  })
})

describe('votesDeletionPreview', () => {
  it('counts open and closed polls of the calling tenant', async () => {
    const { votesDeletionPreview } = await import('./karenz')
    seed({ expire: T0_EPOCH + 600 })
    seed({ expire: 0 })
    seed({ expire: T0_EPOCH - 600 })
    seed({ expire: T0_EPOCH + 600, tenant: OTHER })
    const items = await votesDeletionPreview({ id: TENANT } as unknown as TenantContext)
    expect(items).toEqual([
      { key: 'open_polls', label: 'Offene Umfragen', count: 2, unit: 'Umfragen' },
      { key: 'closed_polls', label: 'Abgeschlossene Umfragen', count: 1, unit: 'Umfragen' },
    ])
  })
})
