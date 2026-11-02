// @vitest-environment node
//
// Module Karenz (phase 2, Task 8): the per-tenant pass. The platform bridge, the step store, the audit
// writer, the clock and the participants are doubles; the engine itself is the real one. What the tests
// pin is the ORDER and the ONCE: a step that is done is never run again, a failing step never stops the
// next one, and nothing destructive runs unless the platform row says live AND the retained copies exist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import type { TenantContext } from '$lib/server/tenant/context'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import type { SwitchRow } from '$lib/server/module-switch/store'
import type { ItemState, KarenzItem, KarenzItemRow, StepPatch, StepRow } from './store'
import { KarenzPartialError, type KarenzContext, type KarenzParticipant } from './participants'
import type { KarenzRowView, KarenzState } from './platform'
import type { RoleHolders } from '$lib/server/governance/role-holders'
import { createNoticeStages, type NoticeDeps } from './notices'
import {
  _clearKarenzStagesForTests,
  _registeredStagesForTests,
  _resetKarenzPassForTests,
  _resetKarenzStagesToDefaultsForTests,
  defaultHasLocalEvidence,
  pickStartedActor,
  registerKarenzStages,
  runKarenzPass,
  STEP,
  type KarenzPassDeps,
  type KarenzStepStore,
} from './engine'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const K1 = '44444444-4444-4444-8444-444444444441'
const K2 = '44444444-4444-4444-8444-444444444442'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const T0 = new Date('2026-10-01T10:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const tenant = { id: TENANT_ID, slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext

/** In-memory module_karenz_step / module_karenz_item with the semantics of store.ts. */
class FakeStore implements KarenzStepStore {
  steps = new Map<string, StepRow>()
  items = new Map<string, KarenzItemRow>()
  constructor(private readonly clock: () => Date) {}
  async getStep(_db: unknown, karenzId: string, step: string) {
    const r = this.steps.get(`${karenzId}|${step}`)
    return r ? { ...r } : null
  }
  async listSteps(_db: unknown, karenzId: string) {
    return [...this.steps.values()].filter((r) => r.karenzId === karenzId).map((r) => ({ ...r }))
  }
  async markStep(_db: unknown, karenzId: string, step: string, patch: StepPatch) {
    const key = `${karenzId}|${step}`
    const prev = this.steps.get(key)
    const now = this.clock()
    const row: StepRow = {
      karenzId,
      step,
      state: patch.state,
      attempts: (prev?.attempts ?? 0) + 1,
      lastError: patch.error ?? null,
      lastReportedAt: patch.reported === true ? now : (prev?.lastReportedAt ?? null),
      doneAt: prev?.doneAt ?? (patch.state === 'done' ? now : null),
      updatedAt: now,
    }
    this.steps.set(key, row)
    return { ...row }
  }
  async upsertItem(_db: unknown, item: KarenzItem) {
    const key = `${item.karenzId}|${item.kind}|${item.externalId}`
    const prev = [...this.items.values()].find((r) => `${r.karenzId}|${r.kind}|${r.externalId}` === key)
    const row: KarenzItemRow = {
      itemId: prev?.itemId ?? `item-${this.items.size + 1}`,
      karenzId: item.karenzId,
      kind: item.kind,
      externalId: item.externalId,
      state: item.state,
      payload: item.payload ?? null,
      detail: item.detail ?? null,
      updatedAt: this.clock(),
    }
    this.items.set(row.itemId, row)
    return { ...row }
  }
  async listItems(_db: unknown, karenzId: string, kind?: string) {
    return [...this.items.values()].filter((r) => r.karenzId === karenzId && (kind === undefined || r.kind === kind)).map((r) => ({ ...r }))
  }
  async setItemState(_db: unknown, itemId: string, state: ItemState, detail?: string) {
    const r = this.items.get(itemId)
    if (!r) return false
    r.state = state
    r.detail = detail ?? null
    return true
  }
}

interface Report {
  karenzId: string
  step: string
  level: 'info' | 'error'
  message: string
  mark?: 'tenant_done' | 'restored'
}

interface Rig {
  now: Date
  store: FakeStore
  rows: KarenzRowView[]
  reports: Report[]
  audits: Array<{ userId: string; field: string; oldValue: string | null; newValue: string }>
  order: string[]
  listCalls: number
  reportFails: { times: number }
  actor: string | null
  evidence: boolean
  parts: Map<string, KarenzParticipant[]>
  deps: () => Partial<KarenzPassDeps>
  advance(ms: number): void
}

function rig(): Rig {
  const r = {
    now: new Date(T0),
    rows: [] as KarenzRowView[],
    reports: [] as Report[],
    audits: [] as Rig['audits'],
    order: [] as string[],
    listCalls: 0,
    reportFails: { times: 0 },
    actor: ACTOR as string | null,
    evidence: false,
    parts: new Map<string, KarenzParticipant[]>(),
  } as unknown as Rig
  r.store = new FakeStore(() => r.now)
  r.advance = (ms) => {
    r.now = new Date(r.now.getTime() + ms)
  }
  r.deps = () => ({
    listKarenz: async () => {
      r.listCalls++
      return r.rows.map((x) => ({ ...x }))
    },
    // the platform: a mark moves the row exactly as plt.council_karenz_report does
    reportKarenz: async (_customerId, karenzId, e) => {
      if (r.reportFails.times > 0) {
        r.reportFails.times--
        throw new Error('platform unreachable')
      }
      const row = r.rows.find((x) => x.karenzId === karenzId)!
      if (e.mark === 'tenant_done') {
        if (row.finalMode !== 'live') throw new Error('tenant_done needs final_mode live')
        row.tenantDoneAt = r.now
        if (row.platformDoneAt) row.state = 'finalized'
      }
      if (e.mark === 'restored') row.state = 'restored'
      r.reports.push({ karenzId, ...e })
    },
    participantsFor: (id) => r.parts.get(id) ?? [],
    store: r.store,
    writeAudit: async (e) => {
      r.audits.push(e)
    },
    startedActor: async () => r.actor,
    hasLocalEvidence: async () => r.evidence,
    now: () => r.now,
  })
  return r
}

const row = (over: Partial<KarenzRowView> = {}): KarenzRowView => ({
  karenzId: K1,
  catalogueId: 'votes',
  manifestId: 'votes',
  state: 'open',
  switchedOffAt: T0,
  finalAt: new Date(T0.getTime() + 30 * DAY),
  restoreRequestedAt: null,
  finalMode: null,
  platformDoneAt: null,
  tenantDoneAt: null,
  ...over,
})

interface PartOpts {
  failSwitchOff?: () => unknown
  failRestore?: () => unknown
  failFinalize?: () => unknown
  deleted?: Record<string, number>
  slow?: Promise<void>
}
function part(rg: Rig, id: string, opts: PartOpts = {}): KarenzParticipant & { calls: string[] } {
  const calls: string[] = []
  const p: KarenzParticipant & { calls: string[] } = {
    catalogueId: id,
    calls,
    async switchOff() {
      calls.push('switchOff')
      rg.order.push(`${id}:switchOff`)
      await opts.slow
      const f = opts.failSwitchOff?.()
      if (f) throw f
    },
    async restore() {
      calls.push('restore')
      rg.order.push(`${id}:restore`)
      const f = opts.failRestore?.()
      if (f) throw f
    },
    async finalize(_ctx, o) {
      calls.push(o.dryRun ? 'finalize:dry' : 'finalize:live')
      rg.order.push(`${id}:finalize:${o.dryRun ? 'dry' : 'live'}`)
      const f = opts.failFinalize?.()
      if (f) throw f
      return { deleted: opts.deleted ?? {} }
    },
  }
  rg.parts.set(id, [...(rg.parts.get(id) ?? []), p])
  return p
}

/** The mail seam of Task 9 as a double: `sent` collects `<kind>:<user>` for every notice recorded as sent. */
function noticeDeps(sent: string[], now: () => Date, who: RoleHolders = { holders: [], skipped: [] }): Partial<NoticeDeps> {
  const holders = who.holders.length > 0 || who.skipped.length > 0 ? who : { holders: [1, 2].map((n) => ({ userId: `user-${n}`, email: `p${n}@rat.example.test`, displayName: `P ${n}`, roles: ['council-admin'] })), skipped: [] }
  const ledger = new Set<string>()
  return {
    listRoleHolders: async () => holders,
    send: async () => ({}),
    noticesSent: async (_db, karenzId, kind) => new Set([...ledger].filter((k) => k.startsWith(`${karenzId}|${kind}|`)).map((k) => k.split('|')[2]!)),
    recordNotice: async (_db, n) => {
      if (n.state !== 'sent') return
      ledger.add(`${n.karenzId}|${n.kind}|${n.userId}`)
      sent.push(`${n.kind}:${n.userId}`)
    },
    now,
    settingsUrl: () => 'https://rat.example.test/settings/module',
  }
}

let rg: Rig
beforeEach(() => {
  rg = rig()
  _resetKarenzPassForTests()
  _clearKarenzStagesForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const pass = () => runKarenzPass(tenant, rg.deps())
const stepOf = (karenzId: string, step: string) => rg.store.steps.get(`${karenzId}|${step}`)
const errorsOf = (step: string) => rg.reports.filter((x) => x.level === 'error' && x.step === step)

describe('an open row: the switch-off steps', () => {
  it('runs the notice, the retained copies, then the participants, each exactly once, and writes one audit entry naming the actor from module_switch_request (karenz-service when there is none)', async () => {
    rg.rows = [row()]
    const p = part(rg, 'votes')
    registerKarenzStages({
      noticeSwitchoff: async () => void rg.order.push('notice'),
      retained: async () => void rg.order.push('retained'),
    })
    const first = await pass()
    expect(rg.order).toEqual(['notice', 'retained', 'votes:switchOff'])
    expect(first).toEqual({ steps: 4, failed: 0 }) // started, notice, retained, participant
    expect(rg.audits).toEqual([{ userId: ACTOR, field: 'module.karenz.started', oldValue: null, newValue: expect.stringContaining(K1) }])
    expect(rg.audits[0]!.newValue).toContain('module=votes')
    expect(rg.audits[0]!.newValue).not.toMatch(/actor/i)
    for (const s of [STEP.started, STEP.noticeSwitchoff, STEP.retained, STEP.participant('votes', 'switchoff')]) {
      expect(stepOf(K1, s)?.state, s).toBe('done')
    }

    // a second pass finds every step done: nothing runs again, nothing is written again
    rg.advance(5 * MIN)
    expect(await pass()).toEqual({ steps: 0, failed: 0 })
    expect(p.calls).toEqual(['switchOff'])
    expect(rg.order).toHaveLength(3)
    expect(rg.audits).toHaveLength(1)

    // an operator-origin disable has no module_switch_request row: the audit user is karenz-service
    const rg2 = rig()
    rg2.actor = null
    rg2.rows = [row()]
    await runKarenzPass(tenant, rg2.deps())
    expect(rg2.audits[0]!.userId).toBe('karenz-service')
  })

  it('a notice stage\'s one-line summary is the info event of its own step (the host stale gauge reads that event); without a summary the line says done; a report the platform cannot take leaves the step open for the next pass', async () => {
    rg.rows = [row()]
    let mails = 0
    registerKarenzStages({
      noticeSwitchoff: async () => {
        mails++
        return 'sent 3, skipped 1'
      },
      reminder: async () => {},
    })
    rg.reportFails.times = 1
    const first = await pass()
    expect(first.failed).toBe(1)
    expect(stepOf(K1, STEP.noticeSwitchoff)?.state).toBe('failed')
    rg.advance(5 * MIN)
    await pass()
    expect(mails).toBe(2) // the stage's own ledger (Task 9) is what keeps a retry from mailing twice
    expect(rg.reports.filter((x) => x.step === STEP.noticeSwitchoff && x.level === 'info')).toEqual([
      { karenzId: K1, step: STEP.noticeSwitchoff, level: 'info', message: 'sent 3, skipped 1' },
    ])
    rg.advance(23 * DAY + HOUR)
    await pass()
    expect(rg.reports.find((x) => x.step === STEP.noticeT23)).toMatchObject({ level: 'info', message: 'done' })
  })

  it('without a registered stage the notice and the retained steps are not marked: nothing pretends a copy exists', async () => {
    rg.rows = [row()]
    part(rg, 'votes')
    await pass()
    expect(stepOf(K1, STEP.noticeSwitchoff)).toBeUndefined()
    expect(stepOf(K1, STEP.retained)).toBeUndefined()
    expect(stepOf(K1, STEP.participant('votes', 'switchoff'))?.state).toBe('done')
  })

  it('a participant of another module is not driven by this row', async () => {
    rg.rows = [row()]
    const mine = part(rg, 'votes')
    const other = part(rg, 'elections')
    await pass()
    expect(mine.calls).toEqual(['switchOff'])
    expect(other.calls).toEqual([])
  })

  it('rows are processed oldest switch-off first', async () => {
    rg.rows = [row({ karenzId: K2, catalogueId: 'elections', manifestId: 'elections', switchedOffAt: new Date(T0.getTime() + HOUR) }), row()]
    part(rg, 'votes')
    part(rg, 'elections')
    await pass()
    expect(rg.order).toEqual(['votes:switchOff', 'elections:switchOff'])
  })

  it('the reminders run when due only: day 23 and day 29 before the final day, never before, never after it', async () => {
    rg.rows = [row()]
    const kinds: string[] = []
    registerKarenzStages({ reminder: async (_ctx, kind) => void kinds.push(kind) })
    await pass()
    expect(kinds).toEqual([])
    rg.advance(22 * DAY + 23 * HOUR)
    await pass()
    expect(kinds).toEqual([])
    rg.advance(2 * HOUR) // day 23 + 1 h
    await pass()
    expect(kinds).toEqual(['t23'])
    rg.advance(6 * DAY) // day 29 + 1 h
    await pass()
    expect(kinds).toEqual(['t23', 't29'])
    await pass()
    expect(kinds).toEqual(['t23', 't29'])
    expect(stepOf(K1, STEP.noticeT23)?.state).toBe('done')
    expect(stepOf(K1, STEP.noticeT29)?.state).toBe('done')
    // past the final day a reminder is moot: it is not sent, and the miss is an ERROR event of its own step
    // (Review Focus 8: a late reminder must not pass in silence), reported once per 6 h like any unchanged failure, not on every pass
    const rg2 = rig()
    rg2.rows = [row()]
    rg2.now = new Date(T0.getTime() + 31 * DAY)
    const late: string[] = []
    registerKarenzStages({ reminder: async (_c, k) => void late.push(k) })
    await runKarenzPass(tenant, rg2.deps())
    expect(late).toEqual([])
    for (const step of [STEP.noticeT23, STEP.noticeT29]) {
      expect(rg2.reports.filter((x) => x.level === 'error' && x.step === step), step).toHaveLength(1)
      expect(rg2.store.steps.get(`${K1}|${step}`)?.state, step).toBe('failed')
    }
    await runKarenzPass(tenant, rg2.deps())
    expect(rg2.reports.filter((x) => x.level === 'error' && x.step === STEP.noticeT23)).toHaveLength(1)
    // and in dry mode, where the pass keeps working past the final day, the misses are still reported
    const rg3 = rig()
    rg3.rows = [row({ finalMode: 'dry' })]
    rg3.now = new Date(T0.getTime() + 31 * DAY)
    await runKarenzPass(tenant, rg3.deps())
    expect(rg3.reports.filter((x) => x.level === 'error').map((x) => x.step).toSorted()).toEqual([STEP.noticeT23, STEP.noticeT29])
    // a reminder that WAS sent in time is not reported as missed
    const rg4 = rig()
    rg4.rows = [row()]
    await runKarenzPass(tenant, rg4.deps())
    rg4.advance(29 * DAY + HOUR)
    await runKarenzPass(tenant, rg4.deps())
    rg4.advance(2 * DAY)
    await runKarenzPass(tenant, rg4.deps())
    expect(rg4.reports.filter((x) => x.level === 'error')).toEqual([])
  })

  it('the default stages are the notices of Task 9: the switch-off mail runs first of all steps after started, the reminders when due, each through the ledger', async () => {
    _resetKarenzStagesToDefaultsForTests()
    const stages = _registeredStagesForTests()
    expect(typeof stages.noticeSwitchoff).toBe('function')
    expect(typeof stages.reminder).toBe('function')
    // wired through the real engine, with a doubled mail seam
    const sent: string[] = []
    registerKarenzStages(createNoticeStages(noticeDeps(sent, () => rg.now)))
    rg.rows = [row()]
    part(rg, 'votes')
    registerKarenzStages({ retained: async () => void rg.order.push('retained') })
    await pass()
    expect(sent).toEqual(['switchoff:user-1', 'switchoff:user-2'])
    expect(rg.order).toEqual(['retained', 'votes:switchOff'])
    expect(rg.reports.find((x) => x.step === STEP.noticeSwitchoff)).toMatchObject({ level: 'info', message: 'sent 2, skipped 0' })
    rg.advance(23 * DAY + HOUR)
    await pass()
    expect(sent.slice(2)).toEqual(['t23:user-1', 't23:user-2'])
    await pass()
    expect(sent).toHaveLength(4) // done steps are not run again
    rg.advance(6 * DAY)
    await pass()
    expect(sent.slice(4)).toEqual(['t29:user-1', 't29:user-2'])
    // no message anywhere on the platform side names a person or an address
    expect(JSON.stringify(rg.reports)).not.toMatch(/@|person/i)
  })

  it('a notice that cannot be delivered fails its step loudly (error event named after the code), the next steps still run, and the next pass retries it', async () => {
    registerKarenzStages(createNoticeStages(noticeDeps([], () => rg.now, { holders: [], skipped: [{ userId: 'u9', reason: 'no-email' }] })))
    rg.rows = [row()]
    part(rg, 'votes')
    await pass()
    expect(stepOf(K1, STEP.noticeSwitchoff)?.state).toBe('failed')
    expect(errorsOf(STEP.noticeSwitchoff)).toEqual([expect.objectContaining({ message: 'KarenzNoticeError_NO_RECIPIENTS' })])
    expect(rg.order).toEqual(['votes:switchOff'])
    // fixed (an admin got an e-mail address): the next pass sends it
    const sent: string[] = []
    registerKarenzStages(createNoticeStages(noticeDeps(sent, () => rg.now)))
    await pass()
    expect(sent).toEqual(['switchoff:user-1', 'switchoff:user-2'])
    expect(stepOf(K1, STEP.noticeSwitchoff)?.state).toBe('done')
  })

  it('the publish steps are the stage\'s own list, each run through the ledger: a failed one is retried on the next pass and does not stop the other steps', async () => {
    rg.rows = [row()]
    const p = part(rg, 'votes')
    let failFirst = true
    const ran: string[] = []
    registerKarenzStages({
      publish: async () => [
        {
          step: STEP.publish('files', 'rec1'),
          run: async () => {
            ran.push('rec1')
            if (failFirst) throw new Error('nextcloud 503')
          },
        },
        { step: STEP.publish('files', 'rec2'), run: async () => void ran.push('rec2') },
      ],
    })
    const first = await pass()
    expect(first.failed).toBe(1)
    expect(ran).toEqual(['rec1', 'rec2'])
    expect(p.calls).toEqual(['switchOff']) // the participant after the failing publish still ran
    expect(stepOf(K1, STEP.publish('files', 'rec1'))?.state).toBe('failed')
    expect(stepOf(K1, STEP.publish('files', 'rec2'))?.state).toBe('done')

    failFirst = false
    rg.advance(5 * MIN)
    const second = await pass()
    expect(second.failed).toBe(0)
    expect(ran).toEqual(['rec1', 'rec2', 'rec1']) // only the failed one is retried
    expect(stepOf(K1, STEP.publish('files', 'rec1'))?.state).toBe('done')
  })
})

describe('failures are reported, once', () => {
  it('a failing step does not stop the next one, is reported as an error event once per 6 hours, and a later success reports info', async () => {
    rg.rows = [row()]
    let broken = true
    part(rg, 'votes', { failSwitchOff: () => (broken ? Object.assign(new Error('lock refused: poll 17 of anna@example.org'), { status: 503 }) : null) })
    registerKarenzStages({ retained: async () => void rg.order.push('retained') })
    const first = await pass()
    expect(first.failed).toBe(1)
    expect(rg.order).toContain('retained') // the step before it ran, and the audit step (after the failing one in a row) is unaffected
    const step = STEP.participant('votes', 'switchoff')
    expect(errorsOf(step)).toHaveLength(1)
    // the platform text is the error CLASS and status, never the message (it may carry a name or an address)
    expect(errorsOf(step)[0]!.message).toContain('Error (HTTP 503)')
    expect(errorsOf(step)[0]!.message).not.toMatch(/anna|poll 17|example/)
    expect(stepOf(K1, step)).toMatchObject({ state: 'failed', attempts: 1 })

    rg.advance(5 * MIN)
    await pass()
    rg.advance(5 * MIN)
    await pass()
    expect(errorsOf(step), 'unchanged message inside 6 h: not reported again').toHaveLength(1)
    expect(stepOf(K1, step)!.attempts).toBe(3) // but it is retried every pass

    rg.advance(6 * HOUR)
    await pass()
    expect(errorsOf(step), '6 h later the still-failing step is reported again').toHaveLength(2)

    broken = false
    rg.advance(5 * MIN)
    await pass()
    expect(stepOf(K1, step)?.state).toBe('done')
    const last = rg.reports.at(-1)!
    expect(last).toMatchObject({ level: 'info', step })
    expect(errorsOf(step)).toHaveLength(2)
  })

  it('a changed failure text is reported at once, inside the 6 hours', async () => {
    rg.rows = [row()]
    let err: unknown = Object.assign(new Error('x'), { status: 503 })
    part(rg, 'votes', { failSwitchOff: () => err })
    await pass()
    err = Object.assign(new Error('x'), { status: 401 })
    rg.advance(5 * MIN)
    await pass()
    expect(errorsOf(STEP.participant('votes', 'switchoff'))).toHaveLength(2)
  })

  it('a KarenzPartialError is reported by class and count, never by its failure texts', async () => {
    rg.rows = [row()]
    part(rg, 'votes', { failSwitchOff: () => new KarenzPartialError(['poll 3 of berta@example.org refused', 'poll 7 gone']) })
    await pass()
    const [e] = errorsOf(STEP.participant('votes', 'switchoff'))
    expect(e!.message).toContain('KarenzPartialError')
    expect(e!.message).toContain('2')
    expect(e!.message).not.toMatch(/berta|poll 3/)
    // the operator log has the full text
    expect((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')).toContain('poll 3 of berta@example.org refused')
  })

  it('a report the platform refuses or cannot take is not recorded as reported: the next pass reports it again', async () => {
    rg.rows = [row()]
    part(rg, 'votes', { failSwitchOff: () => new Error('boom') })
    rg.reportFails.times = 1
    await pass()
    const step = STEP.participant('votes', 'switchoff')
    expect(errorsOf(step)).toHaveLength(0)
    expect(stepOf(K1, step)).toMatchObject({ state: 'failed', lastReportedAt: null })
    rg.advance(5 * MIN)
    await pass()
    expect(errorsOf(step)).toHaveLength(1)
    expect(stepOf(K1, step)!.lastReportedAt).not.toBeNull()
  })

  it('a store failure on one row is logged and counted and does not stop the next row', async () => {
    rg.rows = [row(), row({ karenzId: K2, catalogueId: 'elections', manifestId: 'elections', switchedOffAt: new Date(T0.getTime() + HOUR) })]
    part(rg, 'votes')
    const other = part(rg, 'elections')
    const real = rg.store.getStep.bind(rg.store)
    rg.store.getStep = async (db, karenzId, step) => {
      if (karenzId === K1) throw new Error('tenant database down')
      return real(db, karenzId, step)
    }
    const out = await pass()
    expect(out.failed).toBe(1)
    expect(other.calls).toEqual(['switchOff'])
  })
})

describe('a pass without work', () => {
  it('a pass with no live rows makes one platform read and writes nothing', async () => {
    rg.rows = []
    part(rg, 'votes')
    expect(await pass()).toEqual({ steps: 0, failed: 0 })
    expect(rg.listCalls).toBe(1)
    expect(rg.store.steps.size).toBe(0)
    expect(rg.audits).toEqual([])
    expect(rg.reports).toEqual([])

    // closed rows inside the window are not work either
    rg.rows = [row({ state: 'restored' }), row({ karenzId: K2, state: 'finalized' })]
    expect(await pass()).toEqual({ steps: 0, failed: 0 })
    expect(rg.store.steps.size).toBe(0)
  })

  it('two concurrent passes for one tenant do not run a step twice (single-flight)', async () => {
    rg.rows = [row()]
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const p = part(rg, 'votes', { slow: gate })
    const a = pass()
    const b = pass()
    await new Promise((res) => setTimeout(res, 10))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(p.calls).toEqual(['switchOff'])
    expect(ra).toEqual(rb)
    expect(rg.listCalls).toBe(1)
    // once settled, the next pass is a normal one
    await pass()
    expect(rg.listCalls).toBe(2)
  })

  it('a pass for another tenant is not blocked by this tenant\'s pass', async () => {
    rg.rows = [row()]
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const p = part(rg, 'votes', { slow: gate })
    const a = pass()
    const other = { ...tenant, id: '99999999-9999-4999-8999-999999999999' } as TenantContext
    const rg2 = rig()
    const b = runKarenzPass(other, rg2.deps())
    await expect(b).resolves.toEqual({ steps: 0, failed: 0 })
    release()
    await a
    expect(p.calls).toEqual(['switchOff'])
  })
})

describe('the council pool is not configured', () => {
  const notConfigured = () => {
    const d = rg.deps()
    d.listKarenz = async () => {
      throw new CouncilNotConfigured()
    }
    return d
  }

  it('is logged and the pass returns without throwing; with no live Karenz on record it is not an error', async () => {
    await expect(runKarenzPass(tenant, notConfigured())).resolves.toEqual({ steps: 0, failed: 0 })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('with a live Karenz on record it is logged with console.error, at most once per 10 minutes', async () => {
    rg.evidence = true
    const d = notConfigured()
    await runKarenzPass(tenant, d)
    expect(console.error).toHaveBeenCalledTimes(1)
    expect((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')).toMatch(/PLATFORM_MODULES_DATABASE_URL|council/i)
    rg.advance(5 * MIN)
    await runKarenzPass(tenant, d)
    expect(console.error).toHaveBeenCalledTimes(1)
    rg.advance(6 * MIN)
    await runKarenzPass(tenant, d)
    expect(console.error).toHaveBeenCalledTimes(2)
  })
})

describe('a restoring row', () => {
  const restoring = (over: Partial<KarenzRowView> = {}) => row({ state: 'restoring', restoreRequestedAt: new Date(T0.getTime() + HOUR), ...over })

  it('runs the participants\' restore and reports restored only when all steps are done; a throwing participant keeps it restoring', async () => {
    rg.rows = [restoring()]
    let broken = true
    const a = part(rg, 'votes', { failRestore: () => (broken ? new Error('unlock refused') : null) })
    const out = await pass()
    expect(out.failed).toBe(1)
    expect(a.calls).toEqual(['restore'])
    expect(rg.reports.filter((r) => r.mark)).toEqual([])
    expect(rg.rows[0]!.state).toBe('restoring')

    broken = false
    rg.advance(5 * MIN)
    await pass()
    const marks = rg.reports.filter((r) => r.mark)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ karenzId: K1, mark: 'restored', level: 'info', step: STEP.restore })
    expect(rg.rows[0]!.state).toBe('restored')

    // the platform has closed the row: the next pass is a no-op
    rg.advance(5 * MIN)
    expect(await pass()).toEqual({ steps: 0, failed: 0 })
    expect(a.calls).toEqual(['restore', 'restore'])
  })

  it('a module with no participant at all is restored by the mark alone', async () => {
    rg.rows = [restoring()]
    await pass()
    expect(rg.reports.filter((r) => r.mark)).toHaveLength(1)
    expect(rg.rows[0]!.state).toBe('restored')
  })

  it('does not run the switch-off steps of the same row: a module switched back on gets no info mail and no new audit entry', async () => {
    rg.rows = [restoring()]
    const p = part(rg, 'votes')
    const notice = vi.fn(async () => {})
    registerKarenzStages({ noticeSwitchoff: notice, retained: notice })
    await pass()
    expect(notice).not.toHaveBeenCalled()
    expect(p.calls).toEqual(['restore'])
    expect(rg.audits).toEqual([])
  })

  it('a refused restored mark keeps the row restoring and is retried: the step is not done until the platform took the mark', async () => {
    rg.rows = [restoring()]
    part(rg, 'votes')
    rg.reportFails.times = 1
    await pass()
    expect(stepOf(K1, STEP.restore)?.state).toBe('failed')
    expect(rg.rows[0]!.state).toBe('restoring')
    rg.advance(5 * MIN)
    await pass()
    expect(rg.rows[0]!.state).toBe('restored')
  })

  it('restoring stuck for more than an hour is an ERROR event of its own, rate-limited; a restore that finishes reports info', async () => {
    rg.rows = [restoring({ restoreRequestedAt: T0 })]
    let broken = true
    part(rg, 'votes', { failRestore: () => (broken ? new Error('unlock refused') : null) })
    await pass() // 0 min after the request
    expect(errorsOf(STEP.restoreStuck)).toHaveLength(0)
    rg.advance(61 * MIN)
    await pass()
    expect(errorsOf(STEP.restoreStuck)).toHaveLength(1)
    expect(errorsOf(STEP.restoreStuck)[0]!.message).toMatch(/since 2026-10-01T10:00:00/)
    rg.advance(5 * MIN)
    await pass()
    expect(errorsOf(STEP.restoreStuck), 'not again inside 6 h').toHaveLength(1)
    rg.advance(6 * HOUR)
    await pass()
    expect(errorsOf(STEP.restoreStuck)).toHaveLength(2)
    broken = false
    await pass()
    expect(rg.rows[0]!.state).toBe('restored')
  })

  it('disable, enable, disable with no manual step: after the pass closed the restore, the next switch-off is a new row with fresh steps and fresh reminders', async () => {
    const p = part(rg, 'votes')
    const kinds: string[] = []
    registerKarenzStages({ reminder: async (_c, k) => void kinds.push(k) })
    rg.rows = [row()]
    await pass() // off
    expect(p.calls).toEqual(['switchOff'])
    rg.advance(2 * DAY)
    rg.rows[0]!.state = 'restoring' // the enable (the platform moves the row)
    rg.rows[0]!.restoreRequestedAt = rg.now
    await pass()
    expect(p.calls).toEqual(['switchOff', 'restore'])
    expect(rg.rows[0]!.state).toBe('restored') // reported by the pass itself, no UPDATE by hand
    // off again: the platform inserts a NEW row (its live-row key is free now)
    rg.advance(HOUR)
    rg.rows.push(row({ karenzId: K2, switchedOffAt: rg.now, finalAt: new Date(rg.now.getTime() + 30 * DAY) }))
    await pass()
    expect(p.calls).toEqual(['switchOff', 'restore', 'switchOff'])
    expect(stepOf(K2, STEP.participant('votes', 'switchoff'))?.state).toBe('done')
    expect(rg.audits).toHaveLength(2) // one "started" per row
    rg.advance(23 * DAY + HOUR)
    await pass()
    expect(kinds, 'the second row owns its own reminders').toEqual(['t23'])
  })
})

describe('the final day: the dry run and the real thing', () => {
  const due = (over: Partial<KarenzRowView> = {}) => row({ switchedOffAt: new Date(T0.getTime() - 31 * DAY), finalAt: new Date(T0.getTime() - DAY), ...over })

  it('an open row past final_at with finalMode dry runs finalize(dryRun true) for every participant, deletes nothing and reports one info event "would delete" per 24 h', async () => {
    rg.rows = [due({ finalMode: 'dry' })]
    const a = part(rg, 'votes', { deleted: { polls: 3 } })
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual(['finalize:dry'])
    const lines = rg.reports.filter((r) => r.step === STEP.finalDry)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'info' })
    expect(lines[0]!.message).toMatch(/^deletion off: would delete: /)
    expect(lines[0]!.message).toContain('polls')
    expect(lines[0]!.message).toContain('3')
    expect(lines[0]!.mark).toBeUndefined()

    rg.advance(5 * MIN)
    await pass()
    rg.advance(HOUR)
    await pass()
    expect(rg.reports.filter((r) => r.step === STEP.finalDry), 'one per 24 h').toHaveLength(1)
    expect(a.calls.filter((c) => c === 'finalize:dry'), 'and the dry run itself is not repeated before it is due').toHaveLength(1)

    rg.advance(24 * HOUR)
    await pass()
    expect(rg.reports.filter((r) => r.step === STEP.finalDry)).toHaveLength(2)
    expect(a.calls.filter((c) => c === 'finalize:live')).toEqual([])
    expect(rg.rows[0]!.tenantDoneAt).toBeNull()
  })

  it('a dry run that finds nothing says so; a participant that fails in the dry run is an error event, not a silent line', async () => {
    rg.rows = [due({ finalMode: 'dry' })]
    part(rg, 'votes', { failFinalize: () => new Error('nextcloud down') })
    await pass()
    const dry = rg.reports.filter((r) => r.step === STEP.finalDry)
    expect(dry).toHaveLength(1)
    expect(dry[0]).toMatchObject({ level: 'error' })

    const rg2 = rig()
    rg2.rows = [due({ finalMode: 'dry' })]
    await runKarenzPass(tenant, rg2.deps())
    expect(rg2.reports.find((r) => r.step === STEP.finalDry)?.message).toContain('nothing')
  })

  it('with finalMode null the pass waits and calls no finalize; so does a live mode on a row the platform job has not yet moved to finalizing', async () => {
    const a = part(rg, 'votes')
    rg.rows = [due({ finalMode: null })]
    await pass()
    rg.rows = [due({ finalMode: 'live' })]
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    expect(rg.reports.filter((r) => r.step === STEP.finalDry)).toEqual([])
  })

  it('a finalizing row refuses every participant finalize while the retained step is not done, reports that as an ERROR event and runs no finalize; once retained is done it runs finalize(dryRun false) and reports tenant_done', async () => {
    rg.rows = [due({ state: 'finalizing', finalMode: 'live' })]
    const a = part(rg, 'votes', { deleted: { polls: 2 } })
    const out = await pass()
    expect(out.failed).toBeGreaterThan(0)
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    const refusal = errorsOf(STEP.final)
    expect(refusal).toHaveLength(1)
    expect(refusal[0]!.message).toMatch(/retained/i)
    expect(rg.rows[0]!.tenantDoneAt).toBeNull()

    // inside the 6 hours the same refusal is not reported again, but it is still a refusal
    rg.advance(5 * MIN)
    await pass()
    expect(errorsOf(STEP.final)).toHaveLength(1)
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])

    // the retained copies exist now
    await rg.store.markStep(null, K1, STEP.retained, { state: 'done' })
    rg.advance(5 * MIN)
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual(['finalize:live'])
    const marks = rg.reports.filter((r) => r.mark)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ mark: 'tenant_done', level: 'info', step: STEP.final })
    expect(marks[0]!.message).toContain('polls')
    expect(rg.rows[0]!.tenantDoneAt).not.toBeNull()
  })

  it('a failed publish step refuses the finalize as well, even with the retained step done', async () => {
    rg.rows = [due({ state: 'finalizing', finalMode: 'live' })]
    const a = part(rg, 'votes')
    await rg.store.markStep(null, K1, STEP.retained, { state: 'done' })
    await rg.store.markStep(null, K1, STEP.publish('files', 'rec1'), { state: 'failed', error: 'Error (HTTP 503)' })
    await rg.store.markStep(null, K1, STEP.publish('files', 'rec2'), { state: 'done' })
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    expect(errorsOf(STEP.final)).toHaveLength(1)
    expect(errorsOf(STEP.final)[0]!.message).toMatch(/publish/i)
  })

  it('a finalizing row whose mode is not live is refused too (the platform job only ever sets finalizing in live mode)', async () => {
    rg.rows = [due({ state: 'finalizing', finalMode: 'dry' })]
    const a = part(rg, 'votes')
    await rg.store.markStep(null, K1, STEP.retained, { state: 'done' })
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    expect(errorsOf(STEP.final)).toHaveLength(1)
  })

  it('a participant whose finalize fails keeps the row finalizing: no tenant_done mark; the next pass retries only that participant', async () => {
    rg.rows = [due({ state: 'finalizing', finalMode: 'live' })]
    await rg.store.markStep(null, K1, STEP.retained, { state: 'done' })
    let broken = true
    const a = part(rg, 'votes', { failFinalize: () => (broken ? new Error('boom') : null), deleted: { polls: 1 } })
    await pass()
    expect(rg.reports.filter((r) => r.mark)).toEqual([])
    broken = false
    rg.advance(5 * MIN)
    await pass()
    expect(a.calls.filter((c) => c === 'finalize:live')).toHaveLength(2)
    expect(rg.reports.filter((r) => r.mark)).toHaveLength(1)
    rg.advance(5 * MIN)
    // the platform closed (or will close) the row; a pass that still sees it finalizing runs nothing twice
    await pass()
    expect(a.calls.filter((c) => c === 'finalize:live')).toHaveLength(2)
    expect(rg.reports.filter((r) => r.mark)).toHaveLength(1)
  })
})

describe('the retained and publish stages after the platform job moved the row on (review round 1)', () => {
  /** What karenz-run does at final_at in live mode: the open row becomes finalizing, whatever the tenant ledger says. */
  const platformFlips = () => {
    rg.advance(30 * DAY)
    rg.rows[0]!.state = 'finalizing'
    rg.rows[0]!.finalMode = 'live'
  }

  it('a reminder that was never sent is reported as an ERROR event on a row the platform job has already moved to finalizing (live mode closes the open window at final_at)', async () => {
    registerKarenzStages({ reminder: async () => 'never called' })
    rg.rows = [row({ state: 'finalizing', finalMode: 'live', switchedOffAt: new Date(T0.getTime() - 31 * DAY), finalAt: new Date(T0.getTime() - DAY) })]
    await pass()
    for (const step of [STEP.noticeT23, STEP.noticeT29]) {
      expect(rg.reports.filter((x) => x.level === 'error' && x.step === step), step).toHaveLength(1)
      expect(stepOf(K1, step)?.state, step).toBe('failed')
    }
    // reported once for an unchanged text, not on every pass
    await pass()
    expect(rg.reports.filter((x) => x.level === 'error' && x.step === STEP.noticeT23)).toHaveLength(1)
    // a reminder that WAS sent in time is not reported as missed
    const rg2 = rig()
    rg2.rows = [row()]
    await runKarenzPass(tenant, rg2.deps())
    rg2.advance(29 * DAY + HOUR)
    await runKarenzPass(tenant, rg2.deps())
    rg2.advance(2 * DAY)
    rg2.rows[0]!.state = 'finalizing'
    rg2.rows[0]!.finalMode = 'live'
    await runKarenzPass(tenant, rg2.deps())
    expect(rg2.reports.filter((x) => x.level === 'error' && (x.step === STEP.noticeT23 || x.step === STEP.noticeT29))).toEqual([])
  })

  it('a retained stage that failed while the row was open is retried on the finalizing row, and the finalize then runs with no hand-written ledger entry', async () => {
    rg.rows = [row()]
    const a = part(rg, 'votes', { deleted: { polls: 1 } })
    let nextcloudUp = false
    const retained = vi.fn(async () => {
      if (!nextcloudUp) throw new Error('nextcloud 503')
    })
    registerKarenzStages({ retained })
    await pass()
    expect(stepOf(K1, STEP.retained)?.state).toBe('failed')

    platformFlips()
    const refused = await pass() // still down: retried, still refused
    expect(retained).toHaveBeenCalledTimes(2)
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    expect(refused.failed).toBeGreaterThan(0)

    nextcloudUp = true
    rg.advance(5 * MIN)
    await pass()
    expect(retained).toHaveBeenCalledTimes(3)
    expect(stepOf(K1, STEP.retained)?.state).toBe('done')
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual(['finalize:live'])
    expect(rg.reports.filter((r) => r.mark)).toEqual([expect.objectContaining({ mark: 'tenant_done', step: STEP.final })])
    expect(rg.rows[0]!.tenantDoneAt).not.toBeNull()
  })

  it('a publish step that failed while the row was open is retried on the finalizing row too', async () => {
    rg.rows = [row()]
    const a = part(rg, 'votes')
    let up = false
    const ran: string[] = []
    registerKarenzStages({
      retained: async () => {},
      publish: async () => [
        {
          step: STEP.publish('files', 'rec1'),
          run: async () => {
            ran.push('rec1')
            if (!up) throw new Error('nextcloud 503')
          },
        },
      ],
    })
    await pass()
    expect(stepOf(K1, STEP.publish('files', 'rec1'))?.state).toBe('failed')
    platformFlips()
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    up = true
    rg.advance(5 * MIN)
    await pass()
    expect(ran).toEqual(['rec1', 'rec1', 'rec1'])
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual(['finalize:live'])
  })

  it('a publish LIST that could not be built once does not block the final deletion for good: the next list that builds clears it, with an info event', async () => {
    rg.rows = [row()]
    const a = part(rg, 'votes')
    let listUp = false
    registerKarenzStages({
      retained: async () => {},
      publish: async () => {
        if (!listUp) throw new Error('sink lookup 503')
        return [{ step: STEP.publish('files', 'rec1'), run: async () => {} }]
      },
    })
    await pass()
    expect(stepOf(K1, 'publish:list')?.state).toBe('failed')
    expect(errorsOf('publish:list')).toHaveLength(1)

    listUp = true
    rg.advance(5 * MIN)
    await pass()
    expect(stepOf(K1, 'publish:list')?.state).toBe('done')
    expect(rg.reports.filter((r) => r.step === 'publish:list' && r.level === 'info')).toHaveLength(1)

    platformFlips()
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual(['finalize:live'])
    expect(rg.rows[0]!.tenantDoneAt).not.toBeNull()
  })

  it('a list that cannot be built on the finalizing row refuses the finalize and says so in the refusal text', async () => {
    rg.rows = [row({ state: 'finalizing', finalMode: 'live', switchedOffAt: new Date(T0.getTime() - 31 * DAY), finalAt: new Date(T0.getTime() - DAY) })]
    const a = part(rg, 'votes')
    registerKarenzStages({
      retained: async () => {},
      publish: async () => {
        throw new Error('sink lookup 503')
      },
    })
    await pass()
    expect(a.calls.filter((c) => c.startsWith('finalize'))).toEqual([])
    expect(errorsOf(STEP.final)[0]!.message).toMatch(/list/i)
  })

  it('a finalize for a module with no registered participant says so in the tenant_done line (nothing was deleted by this pass)', async () => {
    rg.rows = [row({ state: 'finalizing', finalMode: 'live', switchedOffAt: new Date(T0.getTime() - 31 * DAY), finalAt: new Date(T0.getTime() - DAY) })]
    await rg.store.markStep(null, K1, STEP.retained, { state: 'done' })
    await pass()
    const marks = rg.reports.filter((r) => r.mark)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.message).toMatch(/no participant registered for votes/)
  })
})

describe('who is credited with the switch-off (review round 1)', () => {
  const sw = (over: Partial<SwitchRow>): SwitchRow => ({
    requestId: 'r',
    moduleId: 'votes',
    action: 'disable',
    actorUserId: ACTOR,
    submittedAt: new Date(T0.getTime() - MIN),
    state: 'applied',
    outcome: null,
    configError: null,
    appliedAt: null,
    finishedAt: null,
    notifiedAt: null,
    claimedAt: null,
    ...over,
  })

  it('a tenant request that is still succeeded or applying when the pass looks is the actor already (the platform row exists before the reconciler marks it applied)', () => {
    for (const state of ['queued', 'succeeded', 'applying', 'applied'] as const) {
      expect(pickStartedActor([sw({ state })], 'votes', T0), state).toBe(ACTOR)
    }
  })

  it('a failed, refused, expired or dead request is nobody\'s switch-off', () => {
    for (const state of ['failed', 'refused', 'expired', 'dead'] as const) {
      expect(pickStartedActor([sw({ state })], 'votes', T0), state).toBeNull()
    }
  })

  it('an operator-origin disable after a council disable and a council enable is not credited to the older actor', () => {
    const rows = [
      sw({ requestId: 'enable', action: 'enable', actorUserId: 'someone-else', submittedAt: new Date(T0.getTime() - 2 * HOUR) }),
      sw({ requestId: 'old-disable', submittedAt: new Date(T0.getTime() - 3 * DAY) }),
    ]
    expect(pickStartedActor(rows, 'votes', T0)).toBeNull()
  })

  it('an operator-origin disable long after an old council disable (no request of its own) is not credited to it', () => {
    expect(pickStartedActor([sw({ submittedAt: new Date(T0.getTime() - 3 * DAY) })], 'votes', T0)).toBeNull()
  })

  it('a request submitted after the platform row (a later switch-on or switch-off) is not this row\'s', () => {
    expect(pickStartedActor([sw({ action: 'enable', actorUserId: 'later', submittedAt: new Date(T0.getTime() + HOUR) }), sw({})], 'votes', T0)).toBe(ACTOR)
    expect(pickStartedActor([sw({ actorUserId: 'later', submittedAt: new Date(T0.getTime() + HOUR) })], 'votes', T0)).toBeNull()
  })

  it('only this module\'s requests count', () => {
    expect(pickStartedActor([sw({ moduleId: 'elections' })], 'votes', T0)).toBeNull()
  })
})

describe('is there local evidence of a live Karenz (review round 1)', () => {
  const dbWith = (stepUpdatedAt: Date | null) => {
    const q = ((strings: TemplateStringsArray) => {
      const text = strings.join('?')
      if (text.includes('module_karenz_step')) return Promise.resolve(stepUpdatedAt ? [{ updated_at: stepUpdatedAt }] : [])
      return Promise.resolve([])
    }) as unknown as Sql
    ;(q as unknown as { unsafe: (s: string) => string }).unsafe = (s) => s
    return { db: q } as unknown as TenantContext
  }

  it('a pending or failed step of a recent Karenz is evidence', async () => {
    expect(await defaultHasLocalEvidence(dbWith(new Date(T0.getTime() - 3 * DAY)), T0)).toBe(true)
  })

  it('a failed step left behind by a Karenz that ended long ago is not (it would keep the error line up for ever)', async () => {
    expect(await defaultHasLocalEvidence(dbWith(new Date(T0.getTime() - 40 * DAY)), T0)).toBe(false)
  })

  it('no step and no recent disable: no evidence', async () => {
    expect(await defaultHasLocalEvidence(dbWith(null), T0)).toBe(false)
  })
})

describe('the items handed to a participant', () => {
  it('are bound to the row: upsert records under this karenz id, list returns them, setState throws for an item that vanished', async () => {
    rg.rows = [row()]
    let ctx!: KarenzContext
    const seen: Record<string, unknown> = {}
    const p = part(rg, 'votes')
    p.switchOff = async (c) => {
      ctx = c
      const item = await c.items.upsert({ kind: 'poll', externalId: '42', state: 'locked', payload: { remainingMs: 1000 } })
      seen.karenzId = item.karenzId
      seen.polls = (await c.items.list('poll')).length
      seen.elections = (await c.items.list('election')).length
      await c.items.setState(item.itemId, 'restored', 'ok')
      seen.after = (await c.items.list('poll'))[0]
      seen.vanished = await c.items.setState('no-such-item', 'restored').then(
        () => 'resolved',
        (e: Error) => e.message,
      )
    }
    const out = await pass()
    expect(out.failed).toBe(0)
    expect(seen).toMatchObject({ karenzId: K1, polls: 1, elections: 0, after: { state: 'restored', detail: 'ok' } })
    expect(String(seen.vanished)).toMatch(/item/i)
    expect(ctx).toMatchObject({ karenzId: K1, catalogueId: 'votes', manifestId: 'votes' })
    expect(ctx.switchedOffAt).toEqual(T0)
    expect(ctx.finalAt).toEqual(new Date(T0.getTime() + 30 * DAY))
    expect(ctx.now()).toEqual(rg.now)
    expect(ctx.tenant).toBe(tenant)
  })
})
