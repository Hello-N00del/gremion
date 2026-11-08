// @vitest-environment node
//
// Module Karenz (phase 2, Task 12): Art. 17 while a module is switched off.
//
// What the tests pin:
//   - the ledger holds subject ids ONLY and is pruned with the oldest live switch-off;
//   - which modules an erasure must walk while a Karenz is live (and that an unreadable list is an
//     ERROR in the report, never a silent omission);
//   - the replay before a restore: every subject erased since the switch-off, the id-only subject,
//     a skipped hook is never reported as erased, a failing hook stops the restore;
//   - the pre-apply hook runs BEFORE config.modules flips, through the REAL reconciler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import type { ErasureContext } from '@gremion/ports/erasure'
import { _resetRuntimeRegistryForTests, registerErasureHook, type KernelErasureHook } from '$lib/server/modules/runtime-registry'
import type { TenantContext } from '$lib/server/tenant/context'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import { _clearPreApplyHooksForTests, registerPreApplyHook, runModuleSwitchPass, type ReconcilerDeps, type ReconcilerState } from '$lib/server/module-switch/reconciler'
import type { SwitchRow, SwitchState } from '$lib/server/module-switch/store'
import type { KarenzRowView, KarenzState } from './platform'
import {
  ErasureReplayError,
  KARENZ_LIST_UNAVAILABLE_MODULE_ID,
  createErasureReplayPreApply,
  karenzErasureModules,
  karenzListUnavailableHook,
  oldestKeptSwitchOff,
  pruneKarenzErasure,
  recordKarenzErasure,
  replayErasureForRestore,
} from './erasure'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SWITCH_OFF = new Date('2026-10-10T08:00:00Z')

/** In-memory module_karenz_erasure with the statements erasure.ts issues. */
function ledgerDb() {
  const rows = new Map<string, Date>()
  const statements: string[] = []
  let clock = new Date('2026-10-01T00:00:00Z')
  const tag = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join('?')
    statements.push(text)
    if (/INSERT INTO module_karenz_erasure/.test(text)) {
      rows.set(v[0] as string, new Date(clock))
      return []
    }
    if (/SELECT subject_id FROM module_karenz_erasure/.test(text)) {
      const since = v[0] as Date
      return [...rows.entries()]
        .filter(([, at]) => at.getTime() >= since.getTime())
        .toSorted((a, b) => a[1].getTime() - b[1].getTime() || a[0].localeCompare(b[0]))
        .map(([subject_id]) => ({ subject_id }))
    }
    if (/DELETE FROM module_karenz_erasure/.test(text)) {
      const before = v.length > 0 ? (v[0] as Date) : null
      let count = 0
      for (const [id, at] of rows) {
        if (before === null || at.getTime() < before.getTime()) {
          rows.delete(id)
          count++
        }
      }
      return Object.assign([], { count })
    }
    throw new Error(`ledger fake: unexpected statement: ${text}`)
  }
  return {
    db: tag as unknown as Sql,
    rows,
    statements,
    at: (d: Date) => {
      clock = d
    },
  }
}

const row = (over: Partial<KarenzRowView> & { state: KarenzState }): KarenzRowView => ({
  karenzId: '44444444-4444-4444-8444-444444444441',
  catalogueId: 'votes',
  manifestId: 'votes',
  switchedOffAt: SWITCH_OFF,
  finalAt: new Date(SWITCH_OFF.getTime() + 30 * 86_400_000),
  restoreRequestedAt: null,
  finalMode: null,
  platformDoneAt: null,
  tenantDoneAt: null,
  ...over,
})

const hookOf = (
  moduleId: string,
  erase: (ctx: ErasureContext<Sql>) => ReturnType<KernelErasureHook['erase']>,
  requiresConnection?: boolean,
): KernelErasureHook => ({ moduleId, ...(requiresConnection === undefined ? {} : { requiresConnection }), erase })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  _resetRuntimeRegistryForTests()
  _clearPreApplyHooksForTests()
})

describe('the ledger (module_karenz_erasure)', () => {
  it('records the subject id and nothing else, once per subject (a second erasure refreshes the time)', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-02T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-1')
    l.at(new Date('2026-10-05T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-1')
    expect([...l.rows.entries()]).toEqual([['kc-1', new Date('2026-10-05T00:00:00Z')]])
    // the statement names the subject id column only
    expect(l.statements.every((s) => !/username|email|name/i.test(s.replace('module_karenz_erasure', '')))).toBe(true)
  })

  it('refuses an empty subject id', async () => {
    await expect(recordKarenzErasure(ledgerDb().db, '  ')).rejects.toThrow(/subject id/)
  })

  it('prune keeps entries newer than the oldest live switch-off and drops the rest', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-01T00:00:00Z'))
    await recordKarenzErasure(l.db, 'before')
    l.at(new Date('2026-10-12T00:00:00Z'))
    await recordKarenzErasure(l.db, 'after')
    expect(await pruneKarenzErasure(l.db, SWITCH_OFF)).toBe(1)
    expect([...l.rows.keys()]).toEqual(['after'])
  })

  it('prune with no live switch-off empties the ledger', async () => {
    const l = ledgerDb()
    await recordKarenzErasure(l.db, 'a')
    await recordKarenzErasure(l.db, 'b')
    expect(await pruneKarenzErasure(l.db, null)).toBe(2)
    expect(l.rows.size).toBe(0)
  })

  it('oldestKeptSwitchOff: the oldest switch-off of every row that still has a database (a restored row counts until it leaves the window), null with none', () => {
    const early = new Date('2026-09-20T00:00:00Z')
    expect(oldestKeptSwitchOff([])).toBeNull()
    expect(oldestKeptSwitchOff([row({ state: 'finalized', switchedOffAt: early })])).toBeNull()
    expect(
      oldestKeptSwitchOff([row({ state: 'open' }), row({ state: 'restored', switchedOffAt: early }), row({ state: 'finalized', switchedOffAt: new Date('2026-08-01T00:00:00Z') })]),
    ).toEqual(early)
  })
})

describe('karenzErasureModules: which modules an erasure walks while a Karenz is live', () => {
  const tenant = { id: TENANT_ID, slug: 'rat-a', db: {} } as unknown as TenantContext

  it('lists the manifest id of every open or restoring row and no other', async () => {
    const rows = [
      row({ state: 'open', manifestId: 'votes', catalogueId: 'votes' }),
      row({ state: 'restoring', manifestId: 'elections', catalogueId: 'elections', karenzId: 'k2' }),
      row({ state: 'finalizing', manifestId: 'calendar', catalogueId: 'calendar', karenzId: 'k3' }),
      row({ state: 'restored', manifestId: 'calendar', catalogueId: 'calendar', karenzId: 'k4' }),
    ]
    const listKarenz = vi.fn(async () => rows)
    expect(await karenzErasureModules(tenant, { listKarenz })).toEqual({ ids: ['votes', 'elections'], unreadable: false })
    expect(listKarenz).toHaveBeenCalledWith(TENANT_ID, 0)
  })

  it('a module with no council manifest id is named by its catalogue id, so it shows up as "no erasure hook" instead of vanishing', async () => {
    const listKarenz = async () => [row({ state: 'open', manifestId: null, catalogueId: 'messaging' })]
    expect((await karenzErasureModules(tenant, { listKarenz })).ids).toEqual(['messaging'])
  })

  it('no live row: nothing to add', async () => {
    expect(await karenzErasureModules(tenant, { listKarenz: async () => [] })).toEqual({ ids: [], unreadable: false })
  })

  it('a failing platform read is unreadable, never an empty list', async () => {
    const out = await karenzErasureModules(tenant, {
      listKarenz: async () => {
        throw new Error('platform down')
      },
    })
    expect(out).toEqual({ ids: [], unreadable: true })
  })

  it('an unconfigured council pool is fine for a tenant with no Karenz on record and an error for one with local evidence', async () => {
    const listKarenz = async () => {
      throw new CouncilNotConfigured()
    }
    expect(await karenzErasureModules(tenant, { listKarenz, hasLocalEvidence: async () => false })).toEqual({ ids: [], unreadable: false })
    expect(await karenzErasureModules(tenant, { listKarenz, hasLocalEvidence: async () => true })).toEqual({ ids: [], unreadable: true })
  })

  it('the unavailable-list step is a hook that fails, with a reason that is only a class name', async () => {
    expect(karenzListUnavailableHook.moduleId).toBe(KARENZ_LIST_UNAVAILABLE_MODULE_ID)
    expect(karenzListUnavailableHook.requiresConnection).toBe(false)
    const err = await karenzListUnavailableHook
      .erase({ tenantId: TENANT_ID, subjectId: 's', db: null })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('KarenzListUnavailable')
  })
})

describe('replayErasureForRestore', () => {
  const ctxFor = (l: ReturnType<typeof ledgerDb>) => ({ tenantId: TENANT_ID, manifestId: 'votes', switchedOffAt: SWITCH_OFF, db: l.db })

  it('calls the registered hook once per subject erased since the switch-off, with the id-only subject, and not for earlier ones', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-01T00:00:00Z'))
    await recordKarenzErasure(l.db, 'erased-before')
    l.at(new Date('2026-10-11T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-a')
    l.at(new Date('2026-10-12T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-b')
    const seen: ErasureContext<Sql>[] = []
    registerErasureHook(
      hookOf('votes', async (ctx) => {
        seen.push(ctx)
        return { status: 'erased', counts: { rows: 1 } }
      }),
    )
    const out = await replayErasureForRestore(ctxFor(l))
    expect(out).toMatchObject({ subjects: 2, erased: 2, skipped: 0, failed: 0 })
    expect(seen.map((c) => c.subjectId)).toEqual(['kc-a', 'kc-b'])
    expect(seen[0]).toMatchObject({ tenantId: TENANT_ID, subject: { id: 'kc-a', username: null, email: null } })
    expect(seen[0]!.db).toBe(l.db)
    // the bound is part of the statement itself (the fake cannot enforce it): "since the switch-off", inclusive
    expect(l.statements.some((q) => /WHERE requested_at >= \?/.test(q))).toBe(true)
  })

  it('a hook that skips (no username) is reported as skipped (id-only), never as erased', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-11T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-a')
    registerErasureHook(hookOf('votes', async () => ({ status: 'skipped', reason: 'the realm no longer holds the account' }), false))
    const out = await replayErasureForRestore(ctxFor(l))
    expect(out).toMatchObject({ subjects: 1, erased: 0, skipped: 1, failed: 0 })
    expect(out.details.join('\n')).toMatch(/skipped \(id-only\)/)
  })

  it('a module without a registered hook is reported as skipped in the detail, not as replayed, and does not fail', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-11T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-a')
    const out = await replayErasureForRestore(ctxFor(l))
    expect(out).toMatchObject({ subjects: 1, erased: 0, skipped: 1, failed: 0 })
    expect(out.details.join('\n')).toMatch(/no erasure hook registered/)
  })

  it('a failing hook is counted, the other subjects are still replayed, and the replay throws so the switch stays applying', async () => {
    const l = ledgerDb()
    l.at(new Date('2026-10-11T00:00:00Z'))
    await recordKarenzErasure(l.db, 'kc-a')
    await recordKarenzErasure(l.db, 'kc-b')
    const calls: string[] = []
    registerErasureHook(
      hookOf('votes', async (ctx) => {
        calls.push(ctx.subjectId)
        if (ctx.subjectId === 'kc-a') throw new Error('database is gone for kc-a')
        return { status: 'erased', counts: {} }
      }),
    )
    const err = await replayErasureForRestore(ctxFor(l)).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ErasureReplayError)
    expect(calls).toEqual(['kc-a', 'kc-b'])
    // the message carries counts, never a subject id or the hook's own text
    expect((err as Error).message).toMatch(/1 of 2/)
    expect((err as Error).message).not.toMatch(/kc-a|database is gone/)
  })

  it('with nothing in the ledger it calls no hook', async () => {
    const hook = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    registerErasureHook(hookOf('votes', hook))
    expect(await replayErasureForRestore(ctxFor(ledgerDb()))).toMatchObject({ subjects: 0, failed: 0 })
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('the pre-apply hook', () => {
  const tenant = { id: TENANT_ID, slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext
  const event = { requestId: 'r1', tenantId: TENANT_ID, slug: 'rat-a', moduleId: 'votes', manifestId: 'votes', action: 'enable' as const, actorUserId: 'u', detail: null }

  it('replays with the switch-off of the newest restoring or restored row of that module', async () => {
    const replay = vi.fn(async () => ({ subjects: 0, erased: 0, skipped: 0, failed: 0, details: [] }))
    const hook = createErasureReplayPreApply({
      listKarenz: async () => [
        row({ state: 'restored', karenzId: 'old', switchedOffAt: new Date('2026-08-01T00:00:00Z'), restoreRequestedAt: new Date('2026-08-05T00:00:00Z') }),
        row({ state: 'restoring', karenzId: 'new', switchedOffAt: SWITCH_OFF, restoreRequestedAt: new Date('2026-10-20T00:00:00Z') }),
        row({ state: 'open', karenzId: 'other-module', catalogueId: 'elections', switchedOffAt: new Date('2026-07-01T00:00:00Z') }),
      ],
      tenantFor: async () => tenant,
      withTenant: (_t, fn) => fn(),
      replay,
    })
    await hook(event)
    expect(replay).toHaveBeenCalledTimes(1)
    expect(replay).toHaveBeenCalledWith({ tenantId: TENANT_ID, manifestId: 'votes', switchedOffAt: SWITCH_OFF, db: tenant.db })
  })

  it('no restoring row for the module (a fresh start after day 30, or a first enable): nothing is replayed', async () => {
    const replay = vi.fn()
    const hook = createErasureReplayPreApply({
      listKarenz: async () => [row({ state: 'finalized' })],
      tenantFor: async () => tenant,
      withTenant: (_t, fn) => fn(),
      replay,
    })
    await hook(event)
    expect(replay).not.toHaveBeenCalled()
  })

  it('a replay failure rejects, so the reconciler keeps the enable applying', async () => {
    const hook = createErasureReplayPreApply({
      listKarenz: async () => [row({ state: 'restoring' })],
      tenantFor: async () => tenant,
      withTenant: (_t, fn) => fn(),
      replay: async () => {
        throw new ErasureReplayError('1 of 1')
      },
    })
    await expect(hook(event)).rejects.toBeInstanceOf(ErasureReplayError)
  })

  it('a tenant that cannot be resolved rejects (never a silent skip)', async () => {
    const hook = createErasureReplayPreApply({ listKarenz: async () => [row({ state: 'restoring' })], tenantFor: async () => null, withTenant: (_t, fn) => fn(), replay: vi.fn() })
    await expect(hook(event)).rejects.toThrow(/tenant/)
  })
})

describe('restore through the real reconciler: the replay runs before config.modules flips', () => {
  const T0 = Date.parse('2026-10-31T10:00:00Z')
  const R1 = '33333333-3333-4333-8333-333333333331'
  const tenant = { id: TENANT_ID, slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext

  function rig() {
    const switches = new Map<string, SwitchRow>()
    switches.set(R1, {
      requestId: R1,
      moduleId: 'votes',
      action: 'enable',
      actorUserId: 'u',
      submittedAt: new Date(T0),
      state: 'queued',
      outcome: null,
      configError: null,
      appliedAt: null,
      finishedAt: null,
      notifiedAt: null,
      claimedAt: null,
    })
    const order: string[] = []
    const config: { modules: Record<string, boolean> } = { modules: { votes: false } }
    let clock = T0
    const deps: Partial<ReconcilerDeps> = {
      council: () => ({
        requests: async () => [{ request_id: R1, kind: 'enable_module', module: 'votes', state: 'succeeded', outcome: null, actor: 'u', created_at: new Date(T0), finished_at: new Date(T0) }],
        state: async () => [],
      }),
      store: {
        insertSwitch: async () => {},
        listSwitches: async () => [...switches.values()].map((r) => ({ ...r })),
        pendingSwitches: async () => [...switches.values()].filter((r) => ['queued', 'succeeded', 'applying'].includes(r.state)).map((r) => ({ ...r })),
        updateSwitch: async (_db: unknown, id: string, patch: Partial<SwitchRow>) => {
          const r = switches.get(id)
          if (!r) return false
          for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v
          return true
        },
        claimTransition: async (_db: unknown, id: string, from: readonly SwitchState[], to: SwitchState) => {
          const r = switches.get(id)
          if (!r) return null
          const expired = to === 'applying' && r.state === 'applying' && (r.claimedAt === null || r.claimedAt.getTime() < clock - 120_000)
          if (!from.includes(r.state) && !expired) return null
          r.state = to
          r.claimedAt = new Date(clock)
          return { ...r }
        },
        claimNotification: async () => true,
      } as unknown as ReconcilerDeps['store'],
      state: { aligned: new Set([TENANT_ID]), sweptAt: new Map(), alignRetryAt: new Map(), migrateOwed: new Set() } as ReconcilerState,
      readConfig: () => ({ modules: config.modules }) as never,
      writeConfig: (update: { modules?: Record<string, boolean> }) => {
        order.push('config')
        Object.assign(config.modules, update.modules)
      },
      migrate: async () => ({ ok: true }) as never,
      now: () => clock,
    }
    return { deps, order, config, switches, tick: (ms: number) => (clock += ms) }
  }

  it('a failing replay leaves the enable applying and config.modules untouched; the next pass replays again and flips it', async () => {
    const r = rig()
    let broken = true
    registerPreApplyHook(
      createErasureReplayPreApply({
        listKarenz: async () => [row({ state: 'restoring' })],
        tenantFor: async () => tenant,
        withTenant: (_t, fn) => fn(),
        replay: async () => {
          r.order.push('replay')
          if (broken) throw new ErasureReplayError('1 of 1')
          return { subjects: 1, erased: 1, skipped: 0, failed: 0, details: [] }
        },
      }),
    )
    const first = await runModuleSwitchPass(tenant, r.deps)
    expect(first.applied).toBe(0)
    expect(r.switches.get(R1)!.state).toBe('applying')
    expect(r.switches.get(R1)!.configError).toMatch(/1 of 1/)
    expect(r.config.modules.votes).toBe(false)
    broken = false
    r.tick(121_000)
    const second = await runModuleSwitchPass(tenant, r.deps)
    expect(second.applied).toBe(1)
    expect(r.order).toEqual(['replay', 'replay', 'config'])
    expect(r.config.modules.votes).toBe(true)
  })

  it('startup alignment of a restored module (platform enabled, config still off, no request row yet) replays the erasures BEFORE config.modules flips, and a failing replay keeps it off', async () => {
    const r = rig()
    r.switches.clear() // no council request row: only the platform enablement says "on"
    r.deps.state = { aligned: new Set(), sweptAt: new Map([[TENANT_ID, T0]]), alignRetryAt: new Map(), migrateOwed: new Set() } as ReconcilerState
    r.deps.council = () => ({ requests: async () => [], state: async () => [{ module_key: 'votes', state: 'enabled', has_row: true }] })
    let broken = true
    registerPreApplyHook(
      createErasureReplayPreApply({
        listKarenz: async () => [row({ state: 'restored' })],
        tenantFor: async () => tenant,
        withTenant: (_t, fn) => fn(),
        replay: async () => {
          r.order.push('replay')
          if (broken) throw new ErasureReplayError('1 of 1')
          return { subjects: 1, erased: 1, skipped: 0, failed: 0, details: [] }
        },
      }),
    )
    await runModuleSwitchPass(tenant, r.deps)
    expect(r.order).toEqual(['replay'])
    expect(r.config.modules.votes).toBe(false)
    broken = false
    r.tick(120_000)
    await runModuleSwitchPass(tenant, r.deps)
    expect(r.order).toEqual(['replay', 'replay', 'config'])
    expect(r.config.modules.votes).toBe(true)
  })

  it('startup alignment of a module with no Karenz row (or none restoring) still turns it on without any replay', async () => {
    const r = rig()
    r.switches.clear()
    r.deps.state = { aligned: new Set(), sweptAt: new Map([[TENANT_ID, T0]]), alignRetryAt: new Map(), migrateOwed: new Set() } as ReconcilerState
    r.deps.council = () => ({ requests: async () => [], state: async () => [{ module_key: 'votes', state: 'enabled', has_row: true }] })
    const replay = vi.fn()
    registerPreApplyHook(createErasureReplayPreApply({ listKarenz: async () => [row({ state: 'open' })], tenantFor: async () => tenant, withTenant: (_t, fn) => fn(), replay }))
    await runModuleSwitchPass(tenant, r.deps)
    expect(replay).not.toHaveBeenCalled()
    expect(r.config.modules.votes).toBe(true)
  })
})
