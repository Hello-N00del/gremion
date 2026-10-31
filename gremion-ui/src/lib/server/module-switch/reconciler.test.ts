// @vitest-environment node
//
// Karenz phase 1, Task 13: the reconciler. It reads the platform's view of the tenant's council
// requests, copies a final state into the tenant-side record, applies a succeeded request to
// config.modules (plus the module-migration catch-up for an enable) and tells the listeners once.
// The council port, the store, the config and the migration runner are doubles. The store double
// reproduces the SQL semantics of the two atomic claims (one check-and-set step, a lease on
// `applying`), because "two reconcilers race by design" is what these tests pin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCouncilDb: vi.fn() }))
vi.mock('./council-db', () => ({ getCouncilDb: h.getCouncilDb }))

import type { TenantContext } from '$lib/server/tenant/context'
import type { SwitchRow, SwitchState } from './store'
import { _clearModuleSwitchListenersForTests, registerModuleSwitchListener, type ModuleSwitchEvent } from './listeners'
import {
  _clearPreApplyHooksForTests,
  registerPreApplyHook,
  runModuleSwitchPass,
  type CouncilPort,
  type CouncilRequestRow,
  type CouncilStateRow,
  type ReconcilerDeps,
  type ReconcilerState,
  type ReconcilerStore,
} from './reconciler'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const R1 = '33333333-3333-4333-8333-333333333331'
const R2 = '33333333-3333-4333-8333-333333333332'
const R3 = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-10-31T10:00:00Z')
const tenant = { id: TENANT_ID, slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext
const freshState = (): ReconcilerState => ({ aligned: new Set(), sweptAt: new Map(), alignRetryAt: new Map(), migrateOwed: new Set() })

/** In-memory module_switch_request with the claim semantics of store.ts (atomic steps, DB-clock lease). */
class FakeStore implements ReconcilerStore {
  rows = new Map<string, SwitchRow>()
  clock = T0
  async insertSwitch(_db: unknown, row: { requestId: string; moduleId: string; action: 'enable' | 'disable'; actorUserId: string; state?: SwitchState; submittedAt?: Date }) {
    this.rows.set(row.requestId, {
      requestId: row.requestId,
      moduleId: row.moduleId,
      action: row.action,
      actorUserId: row.actorUserId,
      submittedAt: row.submittedAt ?? new Date(this.clock),
      state: row.state ?? 'queued',
      outcome: null,
      configError: null,
      appliedAt: null,
      finishedAt: null,
      notifiedAt: null,
      claimedAt: null,
    })
  }
  async listSwitches() {
    return [...this.rows.values()].map((r) => ({ ...r }))
  }
  async pendingSwitches() {
    await Promise.resolve()
    // oldest submission first, like store.ts (ORDER BY submitted_at ASC)
    return [...this.rows.values()]
      .filter((r) => ['queued', 'succeeded', 'applying'].includes(r.state))
      .toSorted((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
      .map((r) => ({ ...r }))
  }
  async updateSwitch(_db: unknown, requestId: string, patch: Partial<SwitchRow>) {
    const r = this.rows.get(requestId)
    if (!r) return false
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v
    return true
  }
  async claimTransition(_db: unknown, requestId: string, from: readonly SwitchState[], to: SwitchState, opts: { leaseS?: number } = {}) {
    await Promise.resolve()
    // one synchronous check-and-set, like the single UPDATE ... WHERE ... RETURNING
    const r = this.rows.get(requestId)
    if (!r) return null
    const lease = (opts.leaseS ?? 120) * 1000
    const expired = to === 'applying' && r.state === 'applying' && (r.claimedAt === null || r.claimedAt.getTime() < this.clock - lease)
    if (!from.includes(r.state) && !expired) return null
    r.state = to
    r.claimedAt = new Date(this.clock)
    return { ...r }
  }
  async claimNotification(_db: unknown, requestId: string) {
    await Promise.resolve()
    const r = this.rows.get(requestId)
    if (!r || r.notifiedAt !== null) return false
    r.notifiedAt = new Date(this.clock)
    return true
  }
  seed(over: Partial<SwitchRow> & { requestId: string }): SwitchRow {
    const row: SwitchRow = {
      moduleId: 'votes',
      action: 'enable',
      actorUserId: ACTOR,
      submittedAt: new Date(this.clock),
      state: 'queued',
      outcome: null,
      configError: null,
      appliedAt: null,
      finishedAt: null,
      notifiedAt: null,
      claimedAt: null,
      ...over,
    }
    this.rows.set(row.requestId, row)
    return row
  }
}

const req = (request_id: string, over: Partial<CouncilRequestRow> = {}): CouncilRequestRow => ({
  request_id,
  kind: 'enable_module',
  module: 'votes',
  state: 'succeeded',
  outcome: null,
  actor: ACTOR,
  created_at: new Date(T0),
  finished_at: new Date(T0 + 1000),
  ...over,
})
const st = (module_key: string, state = 'disabled', has_row = false): CouncilStateRow => ({ module_key, state, has_row })
const CATALOGUE = ['board', 'calendar', 'elections', 'files', 'handover', 'messaging', 'publishing', 'votes', 'vault']

interface Rig {
  store: FakeStore
  platform: { requests: CouncilRequestRow[]; state: CouncilStateRow[] }
  calls: { requests: number; state: number }
  config: { modules: Record<string, boolean> }
  writes: Array<Record<string, boolean>>
  writeError: { err: Error | null; times: number }
  migrated: string[]
  migrateResult: { ok: boolean; error?: string }
  events: ModuleSwitchEvent[]
  deps: () => Partial<ReconcilerDeps>
}

function rig(): Rig {
  const store = new FakeStore()
  const r: Rig = {
    store,
    platform: { requests: [], state: CATALOGUE.map((k) => st(k)) },
    calls: { requests: 0, state: 0 },
    config: { modules: {} },
    writes: [],
    writeError: { err: null, times: 0 },
    migrated: [],
    migrateResult: { ok: true },
    events: [],
    deps: () => ({}),
  }
  const council: CouncilPort = {
    requests: async () => {
      r.calls.requests++
      return r.platform.requests
    },
    state: async () => {
      r.calls.state++
      return r.platform.state
    },
  }
  const state: ReconcilerState = freshState()
  r.deps = () => ({
    council: () => council,
    store,
    state,
    now: () => store.clock,
    readConfig: () => ({ modules: { ...r.config.modules } }),
    writeConfig: (update) => {
      if (r.writeError.err && r.writeError.times > 0) {
        r.writeError.times--
        throw r.writeError.err
      }
      const m = (update as { modules?: Record<string, boolean> }).modules ?? {}
      r.writes.push({ ...m })
      r.config.modules = { ...r.config.modules, ...m }
      return {} as never
    },
    migrate: async (ref) => {
      r.migrated.push(ref.slug)
      return r.migrateResult
    },
  })
  registerModuleSwitchListener(async (e) => {
    r.events.push(e)
  })
  return r
}

let r: Rig
beforeEach(() => {
  _clearModuleSwitchListenersForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  r = rig()
})
afterEach(() => {
  vi.restoreAllMocks()
  _clearModuleSwitchListenersForTests()
  _clearPreApplyHooksForTests()
})

describe('applying a succeeded request', () => {
  it('a succeeded enable of votes writes config.modules[votes]=true and runs the migration catch-up, then marks applied', async () => {
    r.store.seed({ requestId: R1 })
    r.config.modules = { votes: false }
    r.platform.requests = [req(R1, { outcome: 'enabled votes' })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 1, failed: 0, adopted: 0 })
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.migrated).toEqual(['rat-a'])
    const row = r.store.rows.get(R1)!
    expect(row.state).toBe('applied')
    expect(row.appliedAt).toBeInstanceOf(Date)
    expect(row.configError).toBeNull()
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ requestId: R1, tenantId: TENANT_ID, slug: 'rat-a', moduleId: 'votes', manifestId: 'votes', action: 'enable', outcome: 'applied', actorUserId: ACTOR })
  })

  it('a succeeded disable of elections writes config.modules[elections]=false and does not run migrations', async () => {
    // seeded directly: a council disable is refused in phase 1, operator-origin or phase 2 rows reach this branch
    r.store.seed({ requestId: R1, moduleId: 'elections', action: 'disable' })
    r.platform.requests = [req(R1, { kind: 'disable_module', module: 'elections' })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.applied).toBe(1)
    expect(r.writes).toEqual([{ elections: false }])
    expect(r.migrated).toEqual([])
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.events[0]).toMatchObject({ action: 'disable', outcome: 'applied', moduleId: 'elections' })
  })

  it('a running request is left queued and nothing is written', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'running', finished_at: null })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 0, failed: 0, adopted: 0 })
    expect(r.writes).toEqual([])
    expect(r.store.rows.get(R1)!.state).toBe('queued')
    expect(r.events).toEqual([])
  })
})

describe('requests that did not succeed', () => {
  it('a refused request (NO_DPIA_DECISION) leaves config untouched, stores the outcome, listeners get outcome refused', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'refused', outcome: 'NO_DPIA_DECISION: no DPIA decision recorded' })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 0, failed: 1, adopted: 0 })
    expect(r.writes).toEqual([])
    expect(r.migrated).toEqual([])
    const row = r.store.rows.get(R1)!
    expect(row.state).toBe('refused')
    expect(row.outcome).toContain('NO_DPIA_DECISION')
    expect(row.finishedAt).toBeInstanceOf(Date)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ outcome: 'refused', detail: 'NO_DPIA_DECISION: no DPIA decision recorded' })
  })

  it('an expired request (30 min unclaimed) is shown as expired and config is untouched', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'expired', outcome: null })]
    await runModuleSwitchPass(tenant, r.deps())
    const row = r.store.rows.get(R1)!
    expect(row.state).toBe('expired')
    expect(row.outcome).toBeTruthy()
    expect(r.writes).toEqual([])
    expect(r.events.map((e) => e.outcome)).toEqual(['expired'])
    expect(r.events[0]!.detail).toBeNull()
  })

  it.each(['failed', 'dead'] as const)('a %s request is stored with the outcome text and reported once', async (state) => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state, outcome: 'the handler stopped' })]
    await runModuleSwitchPass(tenant, r.deps())
    expect(r.store.rows.get(R1)!.state).toBe(state)
    expect(r.store.rows.get(R1)!.outcome).toBe('the handler stopped')
    expect(r.writes).toEqual([])
    expect(r.events.map((e) => e.outcome)).toEqual([state])
  })
})

describe('a config write that fails', () => {
  it('config write throws EACCES: state stays applying, config_error set, next pass retries and succeeds, listeners fire exactly once', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1)]
    r.writeError = { err: Object.assign(new Error('EACCES: permission denied, open config.json'), { code: 'EACCES' }), times: 1 }

    const first = await runModuleSwitchPass(tenant, r.deps())
    expect(first).toEqual({ applied: 0, failed: 1, adopted: 0 })
    let row = r.store.rows.get(R1)!
    expect(row.state).toBe('applying')
    expect(row.configError).toContain('EACCES')
    expect(r.events).toEqual([])
    expect(r.migrated).toEqual([])
    expect(console.error).toHaveBeenCalled()

    // inside the lease: another pass leaves the half-applied row alone
    r.store.clock += 10_000
    const during = await runModuleSwitchPass(tenant, r.deps())
    expect(during).toEqual({ applied: 0, failed: 0, adopted: 0 })
    expect(r.writes).toEqual([])

    // after the 120 s lease the row is re-claimed and completed
    r.store.clock += 120_000
    const retry = await runModuleSwitchPass(tenant, r.deps())
    expect(retry.applied).toBe(1)
    row = r.store.rows.get(R1)!
    expect(row.state).toBe('applied')
    expect(row.configError).toBeNull()
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.events).toHaveLength(1)
  })

  it('a failed migration catch-up on an enable is handled like a failed config write', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1)]
    r.migrateResult = { ok: false, error: 'migration: relation already exists' }
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.failed).toBe(1)
    const row = r.store.rows.get(R1)!
    expect(row.state).toBe('applying')
    expect(row.configError).toContain('relation already exists')
    expect(r.events).toEqual([])
  })
})

describe('adoption', () => {
  it('a platform request unknown to the tenant table is adopted', async () => {
    r.platform.requests = [req(R1, { state: 'running', finished_at: null })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 0, failed: 0, adopted: 1 })
    const row = r.store.rows.get(R1)!
    expect(row).toMatchObject({ moduleId: 'votes', action: 'enable', actorUserId: ACTOR, state: 'queued' })
    expect(console.warn).toHaveBeenCalled()
  })

  it('an adopted request that already succeeded is applied in the same pass', async () => {
    r.platform.requests = [req(R1)]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 1, failed: 0, adopted: 1 })
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.events).toHaveLength(1)
  })

  it('a platform row for a non-switchable id (files, messaging, board) is adopted as refused with outcome "not switchable" and config.modules is never written for it', async () => {
    r.platform.requests = [
      req(R1, { module: 'files' }),
      req(R2, { module: 'messaging' }),
      req(R3, { module: 'board', state: 'failed' }),
    ]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.adopted).toBe(3)
    for (const id of [R1, R2, R3]) {
      const row = r.store.rows.get(id)!
      expect(row.state).toBe('refused')
      expect(row.outcome).toContain('not switchable')
    }
    expect(r.writes).toEqual([])
    expect(r.migrated).toEqual([])
    expect(r.events).toEqual([])
  })

  it('a request that appears on the platform after the first sweep (a failed tenant-side insert while the process runs) is adopted and applied by a later pass, with no other row pending', async () => {
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps) // the first sweep: nothing there yet
    expect(r.store.rows.size).toBe(0)
    r.platform.requests = [req(R1)] // the platform accepted it; the tenant-side insert failed
    r.store.clock += 10_000
    const soon = await runModuleSwitchPass(tenant, deps)
    expect(soon.adopted).toBe(0) // inside the sweep interval: still no platform call
    r.store.clock += 5 * 60_000
    const later = await runModuleSwitchPass(tenant, deps)
    expect(later).toEqual({ applied: 1, failed: 0, adopted: 1 })
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.events.map((e) => e.requestId)).toEqual([R1])
  })

  it('adopted requests keep the platform creation time, so they are applied oldest first and the newest request wins', async () => {
    // The platform lists newest first. An enable, then a later disable of the same module.
    r.platform.requests = [
      req(R2, { kind: 'disable_module', created_at: new Date(T0 + 60_000), finished_at: new Date(T0 + 61_000) }),
      req(R1, { created_at: new Date(T0), finished_at: new Date(T0 + 1000) }),
    ]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out).toEqual({ applied: 2, failed: 0, adopted: 2 })
    expect(r.store.rows.get(R1)!.submittedAt).toEqual(new Date(T0))
    expect(r.store.rows.get(R2)!.submittedAt).toEqual(new Date(T0 + 60_000))
    expect(r.writes).toEqual([{ votes: true }, { votes: false }])
    expect(r.config.modules.votes).toBe(false)
  })

  it('a request without a module is adopted as refused too', async () => {
    r.platform.requests = [req(R1, { module: null })]
    await runModuleSwitchPass(tenant, r.deps())
    expect(r.store.rows.get(R1)!.state).toBe('refused')
    expect(r.writes).toEqual([])
  })

  it('a known row whose module is not switchable is refused, never applied', async () => {
    r.store.seed({ requestId: R1, moduleId: 'files' })
    r.platform.requests = [req(R1, { module: 'files' })]
    await runModuleSwitchPass(tenant, r.deps())
    expect(r.store.rows.get(R1)!.state).toBe('refused')
    expect(r.writes).toEqual([])
  })
})

describe('listeners', () => {
  it('listeners run once per request even if the pass runs twice (also in a second process); a throwing listener does not stop the next', async () => {
    _clearModuleSwitchListenersForTests()
    const seen: string[] = []
    registerModuleSwitchListener(async () => {
      throw new Error('first listener fails')
    })
    registerModuleSwitchListener(async (e) => {
      seen.push(e.requestId)
    })
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1)]
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    await runModuleSwitchPass(tenant, deps)
    // a restarted process: fresh per-process state, same tenant table
    const restarted: Partial<ReconcilerDeps> = { ...r.deps(), state: freshState() }
    await runModuleSwitchPass(tenant, restarted)
    expect(seen).toEqual([R1])
    expect(r.writes).toEqual([{ votes: true }])
  })

  it('two reconciler instances running a pass concurrently on one db apply a succeeded request once and call each listener once', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1)]
    const second: Partial<ReconcilerDeps> = { ...r.deps(), state: freshState() }
    const results = await Promise.all([runModuleSwitchPass(tenant, r.deps()), runModuleSwitchPass(tenant, second)])
    expect(results.map((x) => x.applied).toSorted((a, b) => a - b)).toEqual([0, 1])
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.migrated).toHaveLength(1)
    expect(r.events).toHaveLength(1)
  })

  it('two reconcilers racing on a refused request notify once', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'refused', outcome: 'GATE' })]
    const second: Partial<ReconcilerDeps> = { ...r.deps(), state: freshState() }
    await Promise.all([runModuleSwitchPass(tenant, r.deps()), runModuleSwitchPass(tenant, second)])
    expect(r.events).toHaveLength(1)
    expect(r.store.rows.get(R1)!.state).toBe('refused')
  })

  it('an applying row whose lease expired (a crashed pass) is re-claimed and completed; a fresh applying row is left alone', async () => {
    r.store.seed({ requestId: R1, state: 'applying', claimedAt: new Date(T0 - 300_000) })
    r.store.seed({ requestId: R2, moduleId: 'calendar', state: 'applying', claimedAt: new Date(T0 - 5_000) })
    r.platform.requests = [req(R1), req(R2, { module: 'calendar' })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.applied).toBe(1)
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.store.rows.get(R2)!.state).toBe('applying')
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.events.map((e) => e.requestId)).toEqual([R1])
  })
})

describe('the notification claim', () => {
  it('an applied request whose notice was already claimed (a stale holder re-applies it) does not notify again', async () => {
    r.store.seed({ requestId: R1, state: 'applying', claimedAt: new Date(T0 - 300_000), notifiedAt: new Date(T0 - 200_000) })
    r.platform.requests = [req(R1)]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.applied).toBe(1)
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.events).toEqual([])
  })

  it('a refused request whose notice was already claimed does not notify again', async () => {
    r.store.seed({ requestId: R1, notifiedAt: new Date(T0 - 200_000) })
    r.platform.requests = [req(R1, { state: 'refused', outcome: 'GATE' })]
    await runModuleSwitchPass(tenant, r.deps())
    expect(r.store.rows.get(R1)!.state).toBe('refused')
    expect(r.events).toEqual([])
  })
})

describe('platform calls and the first pass', () => {
  it('with no pending rows the pass makes no platform call between the periodic adopting reads (after the one-time alignment read)', async () => {
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    expect(r.calls.state).toBe(1)
    r.calls = { requests: 0, state: 0 }
    r.store.clock += 10_000
    const out = await runModuleSwitchPass(tenant, deps)
    expect(out).toEqual({ applied: 0, failed: 0, adopted: 0 })
    expect(r.calls).toEqual({ requests: 0, state: 0 })
    // the next adopting read is due after the sweep interval
    r.store.clock += 5 * 60_000
    await runModuleSwitchPass(tenant, deps)
    expect(r.calls).toEqual({ requests: 1, state: 0 })
  })

  it('a lost terminal outcome write (updateSwitch returns false) is logged, not dropped silently', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'refused', outcome: 'GATE' })]
    vi.spyOn(r.store, 'updateSwitch').mockResolvedValue(false)
    await runModuleSwitchPass(tenant, r.deps())
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(R1)
  })

  it('the first pass per tenant aligns config.modules to the platform state only for modules that have a platform row, leaves unmanaged modules untouched, and runs once per process, not on every pass', async () => {
    r.platform.state = CATALOGUE.map((k) => {
      if (k === 'calendar') return st(k, 'enabled', true) // platform on, config off -> on
      if (k === 'elections') return st(k, 'disabled', true) // platform row off, config on (default) -> off
      if (k === 'votes') return st(k, 'disabled', false) // no row: unmanaged, default-on config stays
      if (k === 'files') return st(k, 'enabled', true) // a row, but not council-switchable: not touched
      return st(k)
    })
    r.config.modules = { calendar: false }
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    expect(r.writes).toEqual([{ calendar: true, elections: false }])
    expect(r.config.modules).toEqual({ calendar: true, elections: false })
    // the module that came on gets its migration catch-up
    expect(r.migrated).toEqual(['rat-a'])
    // once per process
    r.writes.length = 0
    r.config.modules = { calendar: false }
    await runModuleSwitchPass(tenant, deps)
    expect(r.writes).toEqual([])
    expect(r.calls.state).toBe(1)
  })

  it('an alignment that finds nothing to change writes nothing', async () => {
    r.platform.state = CATALOGUE.map((k) => (k === 'votes' ? st(k, 'enabled', true) : st(k)))
    r.config.modules = { votes: true }
    await runModuleSwitchPass(tenant, r.deps())
    expect(r.writes).toEqual([])
    expect(r.migrated).toEqual([])
  })

  it('a failed alignment write is logged, does not stop the pass, and is retried after a backoff, not on every pass', async () => {
    r.platform.state = CATALOGUE.map((k) => (k === 'calendar' ? st(k, 'enabled', true) : st(k)))
    r.config.modules = { calendar: false }
    r.writeError = { err: new Error('EACCES'), times: 1 }
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    expect(console.error).toHaveBeenCalled()
    expect(r.writes).toEqual([])
    r.store.clock += 1_000
    await runModuleSwitchPass(tenant, deps)
    expect(r.writes).toEqual([]) // still inside the backoff
    r.store.clock += 120_000
    await runModuleSwitchPass(tenant, deps)
    expect(r.writes).toEqual([{ calendar: true }])
  })

  it('a failed migration catch-up after alignment is retried after the backoff (the config diff is gone by then), then not again', async () => {
    r.platform.state = CATALOGUE.map((k) => (k === 'calendar' ? st(k, 'enabled', true) : st(k)))
    r.config.modules = { calendar: false }
    r.migrateResult = { ok: false, error: 'db down' }
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    expect(r.writes).toEqual([{ calendar: true }])
    expect(r.migrated).toEqual(['rat-a'])
    r.store.clock += 1_000
    await runModuleSwitchPass(tenant, deps)
    expect(r.migrated).toEqual(['rat-a']) // inside the backoff
    r.store.clock += 120_000
    r.migrateResult = { ok: true }
    await runModuleSwitchPass(tenant, deps)
    expect(r.migrated).toEqual(['rat-a', 'rat-a']) // retried although the config already matches
    expect(r.writes).toEqual([{ calendar: true }]) // no second config write
    r.store.clock += 120_000
    await runModuleSwitchPass(tenant, deps)
    expect(r.migrated).toHaveLength(2) // done: aligned
  })

  it('a pending row triggers the platform read on every pass until it is final', async () => {
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'running', finished_at: null })]
    const deps = r.deps()
    await runModuleSwitchPass(tenant, deps)
    await runModuleSwitchPass(tenant, deps)
    expect(r.calls.requests).toBe(2)
    r.platform.requests = [req(R1)]
    await runModuleSwitchPass(tenant, deps)
    expect(r.store.rows.get(R1)!.state).toBe('applied')
  })
})

describe('the production council port', () => {
  it('reads the requests of the slug and the state of the tenant through the two requester functions, with the 100-row maximum', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    h.getCouncilDb.mockReturnValue((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ')
      queries.push({ text, values })
      return Promise.resolve(text.includes('council_module_state') ? CATALOGUE.map((k) => st(k)) : [])
    })
    const { council: _unused, ...rest } = r.deps()
    await runModuleSwitchPass(tenant, rest)
    const state = queries.find((q) => q.text.includes('plt.council_module_state('))
    const requests = queries.find((q) => q.text.includes('plt.council_module_requests('))
    expect(state?.values).toEqual([TENANT_ID])
    expect(requests?.values).toEqual(['rat-a', 100])
    // nothing but those two functions is ever called on the platform
    expect(queries).toHaveLength(2)
  })
})

describe('pre-apply hooks (Karenz phase 2, Task 8)', () => {
  it('run for an enable after the platform request succeeded and BEFORE config.modules is written, with the event minus outcome and time', async () => {
    const seen: Array<{ event: unknown; writesAtCall: number }> = []
    registerPreApplyHook(async (e) => {
      seen.push({ event: e, writesAtCall: r.writes.length })
    })
    r.store.seed({ requestId: R1 })
    r.config.modules = { votes: false }
    r.platform.requests = [req(R1)]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.applied).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.writesAtCall).toBe(0)
    expect(seen[0]!.event).toEqual({
      requestId: R1,
      tenantId: TENANT_ID,
      slug: 'rat-a',
      moduleId: 'votes',
      manifestId: 'votes',
      action: 'enable',
      actorUserId: ACTOR,
      detail: null,
    })
    expect(r.writes).toEqual([{ votes: true }])
  })

  it('a throwing pre-apply hook leaves an enable applying with config_error and config untouched, the next pass retries', async () => {
    let broken = true
    const calls: string[] = []
    registerPreApplyHook(async () => {
      calls.push('hook')
      if (broken) throw new Error('erasure replay failed')
    })
    r.store.seed({ requestId: R1 })
    r.config.modules = { votes: false }
    r.platform.requests = [req(R1)]

    const first = await runModuleSwitchPass(tenant, r.deps())
    expect(first).toEqual({ applied: 0, failed: 1, adopted: 0 })
    const row = r.store.rows.get(R1)!
    expect(row.state).toBe('applying')
    expect(row.configError).toContain('erasure replay failed')
    expect(r.writes).toEqual([])
    expect(r.config.modules.votes).toBe(false)
    expect(r.migrated).toEqual([])
    expect(r.events).toEqual([])

    // the lease (120 s) expires, the hook works now: the same request is applied
    broken = false
    r.store.clock += 121_000
    const second = await runModuleSwitchPass(tenant, r.deps())
    expect(second.applied).toBe(1)
    expect(calls).toEqual(['hook', 'hook'])
    expect(r.writes).toEqual([{ votes: true }])
    expect(r.store.rows.get(R1)!.state).toBe('applied')
    expect(r.store.rows.get(R1)!.configError).toBeNull()
    expect(r.events.map((e) => e.outcome)).toEqual(['applied'])
  })

  it('the first failing hook stops the apply and the hooks after it are not run', async () => {
    const later = vi.fn(async () => {})
    registerPreApplyHook(async () => {
      throw new Error('first')
    })
    registerPreApplyHook(later)
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1)]
    await runModuleSwitchPass(tenant, r.deps())
    expect(later).not.toHaveBeenCalled()
    expect(r.writes).toEqual([])
  })

  it('do not run for disable', async () => {
    const hook = vi.fn(async () => {})
    registerPreApplyHook(hook)
    r.store.seed({ requestId: R1, moduleId: 'elections', action: 'disable' })
    r.platform.requests = [req(R1, { kind: 'disable_module', module: 'elections' })]
    const out = await runModuleSwitchPass(tenant, r.deps())
    expect(out.applied).toBe(1)
    expect(hook).not.toHaveBeenCalled()
  })

  it('do not run for a request that did not succeed', async () => {
    const hook = vi.fn(async () => {})
    registerPreApplyHook(hook)
    r.store.seed({ requestId: R1 })
    r.platform.requests = [req(R1, { state: 'refused', outcome: 'NO_DPIA_DECISION: none' })]
    await runModuleSwitchPass(tenant, r.deps())
    expect(hook).not.toHaveBeenCalled()
  })
})
