// TASK-043 TDD 3, 6, 7, 8, 9, 10, 14 (unit halves) over recording fakes:
// the phases in order, the post-conditions read back, the idempotent rerun
// (zero mutating calls), suspend/resume ordering. TASK-044: every enable goes
// through the level-1 gate (fakeGate mirrors lifecycle/enable-gate), the
// operator's DPIA decision rides the create request (lane note D2), and the
// gate's pre-flight refuses before any write.
import { describe, expect, it } from 'vitest'
import {
  createPhaseA,
  createPhaseB,
  enableCustomerModule,
  EnableRefused,
  EXECUTION_ORDER,
  provisioningStatus,
  ProvisioningError,
  recordHostStep,
  resumeCustomer,
  suspendCustomer,
  type CreateSpec,
  type ProvisioningDeps,
} from '../src/index.ts'
import { ADMINS, deps, DPIA, hostStamp, OPERATOR, PLATFORM_DOMAIN, TIP, UNDECIDED_MODULE, world } from './fakes.ts'

const spec = (over: Partial<CreateSpec> = {}): CreateSpec => {
  const enable = over.enable ?? ['calendar', 'votes']
  return {
    slug: 'musterstadt',
    host: 'rat.musterstadt.example',
    enable,
    operatorId: OPERATOR,
    admins: ADMINS,
    dpia: Object.fromEntries(enable.map((m) => [m, DPIA])),
    ...over,
  }
}

async function createAll(w: ReturnType<typeof world>, d: ReturnType<typeof deps>, s = spec()) {
  const a = await createPhaseA(s, d)
  if (!w.realms.get(a.customer.realm)?.smtp.user) hostStamp(w, a.customer)
  await recordHostStep(s.slug, 'mail_principal_issued', s.operatorId, d)
  const b = await createPhaseB(s, d)
  return { a, b }
}

async function refusal(p: Promise<unknown>): Promise<EnableRefused> {
  try {
    await p
  } catch (err) {
    if (err instanceof EnableRefused) return err
    throw err
  }
  throw new Error('expected an EnableRefused')
}

describe('create (phases A, host, B)', () => {
  it('provisions every resource, in EXECUTION_ORDER, and ends active with setup complete', async () => {
    const w = world()
    const d = deps(w)
    const { a, b } = await createAll(w, d)
    const c = a.customer
    expect(c.token).toBe('musterstadt')
    expect(a.run.ran).toEqual(EXECUTION_ORDER.slice(0, 6))
    expect(b.run.ran).toEqual(['first_accounts_created'])
    const done = w.mutations.filter((x) => x.startsWith('ledger:') && x.endsWith('=done')).map((x) => x.slice(7, -5))
    expect(done).toEqual(EXECUTION_ORDER)
    expect(w.control.get('musterstadt')?.status).toBe('active')
    expect(w.config.get('musterstadt')).toEqual({ modules: [], setupComplete: true })
    expect(w.mutations.indexOf('config:write musterstadt')).toBeLessThan(w.mutations.indexOf(`pg:migrate-kernel ${c.id}`))
    expect(w.kernel.get(c.id)).toMatchObject({ orgUnits: 1, committees: 0, seedRows: [], ledgerColumns: ['filename', 'applied_at'] })
    expect(w.groups.get('musterstadt')).toEqual(['council'])
    // TDD 7/8: calendar gets a NATS user, votes (NO_BROKER) does not
    expect(w.broker.get('musterstadt')).toEqual(['calendar', 'kernel'])
    expect(b.enabled).toEqual(['calendar', 'votes'])
    // TDD 10: two users, each invited once from the realm's own principal
    const r = w.realms.get('musterstadt')!
    expect([...r.users.values()].map((u) => u.role).sort()).toEqual(['council-admin', 'it-admin'])
    expect(r.mails).toEqual([`kc-musterstadt@${PLATFORM_DOMAIN} -> it@customer.example`, `kc-musterstadt@${PLATFORM_DOMAIN} -> council@customer.example`])
    // TASK-044: each module enabled through the gate with the current-tip pass
    // and the operator's DPIA decision, recorded BEFORE its enable
    const mine = w.enabled.get(c.id)!
    for (const mod of ['calendar', 'votes']) {
      const decisions = w.dpia.get(`${c.id}/${mod}`)!
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({ decision: DPIA, operatorId: OPERATOR })
      expect(mine.get(mod)).toEqual({ gateRefs: [w.isolation.get(mod)!.id, decisions[0]!.id], by: OPERATOR })
      expect(w.mutations.indexOf(`ops:dpia ${mod}`)).toBeLessThan(w.mutations.indexOf(`pg:enable musterstadt/${mod}`))
      expect(w.mutations.indexOf(`ops:dpia ${mod}`)).toBeGreaterThan(w.mutations.indexOf('ledger:broker_account_created=done'))
    }
    expect(w.mutations.indexOf('control:status musterstadt=active')).toBeGreaterThan(w.mutations.indexOf('ledger:first_accounts_created=done'))
  })

  it('a second run makes zero mutating calls (the DPIA decision is reused), reloads nothing, sends no invite', async () => {
    const w = world()
    const d = deps(w)
    await createAll(w, d)
    const mails = w.realms.get('musterstadt')!.mails.length
    w.mutations.length = 0
    const { b } = await createAll(w, d)
    expect(w.mutations).toEqual([])
    expect(b.reloaded).toBe(false)
    expect(b.activated).toBe(false)
    expect(w.realms.get('musterstadt')!.mails.length).toBe(mails)
  })

  it('a kill after first_body_created resumes at broker_account_created', async () => {
    const w = world()
    const d = deps(w)
    d.hooks = {
      afterStep: (k) => {
        if (k === 'first_body_created') throw new Error('killed')
      },
    }
    await expect(createPhaseA(spec(), d)).rejects.toThrow('killed')
    delete d.hooks
    w.mutations.length = 0
    const a = await createPhaseA(spec(), d)
    expect(a.run.ran).toEqual(['broker_account_created'])
    expect(w.mutations).toEqual(['nats:ensure musterstadt=[kernel]', 'ledger:broker_account_created=done'])
  })

  it('board and vault are refused by name before any write (R29-I1; R30 A1, PRD-PLAT-012 / PRD-REC-003); an unknown module too', async () => {
    const w = world()
    const d = deps(w)
    await expect(createPhaseA(spec({ enable: ['calendar', 'board'] }), d)).rejects.toMatchObject({ code: 'MODULE_DENIED' })
    await expect(createPhaseA(spec({ enable: ['calendar', 'vault'] }), d)).rejects.toMatchObject({ code: 'MODULE_DENIED' })
    await expect(createPhaseA(spec({ enable: ['nope'] }), d)).rejects.toMatchObject({ code: 'MODULE_UNKNOWN' })
    expect(w.mutations).toEqual([])
    expect(w.control.size).toBe(0)
  })

  it('a module whose plt.module_version init did not load (a synthetic undecided module, Q20) is refused BEFORE any write -- no realm, no invite (review B1, r2)', async () => {
    const w = world()
    const d = deps(w)
    await expect(createPhaseA(spec({ enable: ['calendar', UNDECIDED_MODULE] }), d)).rejects.toMatchObject({ code: 'MODULE_NOT_LOADED' })
    expect(w.mutations).toEqual([])
    expect(w.control.size).toBe(0)
    // phase B checks it too (a resume after an operator edited --enable)
    const w2 = world()
    const d2 = deps(w2)
    await createPhaseA(spec({ enable: ['calendar'] }), d2)
    hostStamp(w2, { realm: 'musterstadt', token: 'musterstadt' })
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d2)
    const mails = w2.realms.get('musterstadt')!.mails.length
    await expect(createPhaseB(spec({ enable: ['calendar', UNDECIDED_MODULE] }), d2)).rejects.toMatchObject({ code: 'MODULE_NOT_LOADED' })
    expect(w2.realms.get('musterstadt')!.mails.length).toBe(mails)
  })

  it('a database-less module init now loads under a provisional profile (votes, R29-I24) is accepted by phase A, not refused as not loaded', async () => {
    const w = world()
    const d = deps(w)
    const a = await createPhaseA(spec({ enable: ['calendar', 'votes'] }), d)
    expect(a.customer.slug).toBe('musterstadt')
    expect(w.control.size).toBe(1)
  })

  // G6 (operator decision 2026-10-21: feature modules are deselectable, the kernel works without them)
  it('G6 module OFF: a create with enable [] reaches active with the ledger complete (8/8) and touches no module at all', async () => {
    const w = world()
    const d = deps(w)
    const { b } = await createAll(w, d, spec({ enable: [], dpia: {} }))
    const done = w.mutations.filter((x) => x.startsWith('ledger:') && x.endsWith('=done')).map((x) => x.slice(7, -5))
    expect(done).toEqual(EXECUTION_ORDER)
    expect(done).toHaveLength(8)
    expect(w.control.get('musterstadt')?.status).toBe('active')
    expect(b.activated).toBe(true)
    expect(b.enabled).toEqual([])
    expect(w.mutations.filter((x) => /enable|dpia/.test(x))).toEqual([])
    expect(w.broker.get('musterstadt')).toEqual(['kernel'])
  })

  it('G6 module subset: votes and calendar only are enabled, nothing else, and the ledger is still 8/8; board is refused BY NAME with no write', async () => {
    const w = world()
    const { b } = await createAll(w, deps(w), spec({ enable: ['votes', 'calendar'] }))
    expect(b.enabled).toEqual(['calendar', 'votes'])
    expect(w.mutations.filter((x) => x.startsWith('ledger:') && x.endsWith('=done'))).toHaveLength(8)
    const w2 = world()
    const before = w2.mutations.length
    await expect(createPhaseA(spec({ enable: ['board'] }), deps(w2))).rejects.toMatchObject({ code: 'MODULE_DENIED', message: expect.stringContaining('board') })
    expect(w2.mutations.length).toBe(before)
  })

  it('no module is enabled by default; votes gets an enablement and no broker user', async () => {
    const w = world()
    const d = deps(w)
    const { b } = await createAll(w, d, spec({ enable: ['votes'] }))
    expect(b.enabled).toEqual(['votes'])
    expect(w.broker.get('musterstadt')).toEqual(['kernel'])
    const w2 = world()
    const { b: b2 } = await createAll(w2, deps(w2), spec({ enable: [] }))
    expect(b2.enabled).toEqual([])
  })

  it('phase B refuses the accounts step until the host stamped the principal', async () => {
    const w = world()
    const d = deps(w)
    await createPhaseA(spec(), d)
    await expect(createPhaseB(spec(), d)).rejects.toMatchObject({ code: 'STEP_OUT_OF_ORDER' })
    expect(w.realms.get('musterstadt')!.users.size).toBe(0)
  })

  it('record-step fails on an unstamped realm, a platform@ sender or a foreign kc-* principal', async () => {
    for (const user of [null, `platform@${PLATFORM_DOMAIN}`, `kc-other@${PLATFORM_DOMAIN}`]) {
      const w = world()
      const d = deps(w)
      const a = await createPhaseA(spec(), d)
      if (user !== null) hostStamp(w, a.customer, user)
      const err = await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProvisioningError)
      expect((err as ProvisioningError).code).toBe('POSTCONDITION')
      expect((await d.ledger.rows(a.customer.id)).filter((r) => r.kind === 'mail_principal_issued').map((r) => r.status)).toEqual(['pending', 'failed'])
    }
  })

  it('TDD 6: seeds applied (GREMION_DISABLE_SEEDS missing) fail the database step', async () => {
    const w = world()
    w.knobs.seedsOn = true
    await expect(createPhaseA(spec(), deps(w))).rejects.toThrow(/seed file\(s\) 0005_dev_seed\.sql/)
  })

  it('TDD 6b: a kernel ledger with the tenant-store sha256 shape fails the database step', async () => {
    const w = world()
    w.knobs.runnerShape = 'tenant-store'
    await expect(createPhaseA(spec(), deps(w))).rejects.toThrow(/not gremion-ui's \(filename, applied_at\)/)
  })

  it('a tombstoned slug and a host mismatch are refused', async () => {
    const w = world()
    const d = deps(w)
    await createAll(w, d)
    w.control.get('musterstadt')!.status = 'deleted'
    await expect(createPhaseA(spec(), d)).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    w.control.get('musterstadt')!.status = 'active'
    await expect(createPhaseA(spec({ host: 'other.example' }), d)).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
  })

  it('refuses a bad host, a missing admin role, a non-uuid operator', async () => {
    const d = deps(world())
    await expect(createPhaseA(spec({ host: 'Not A Host' }), d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(createPhaseA(spec({ admins: [ADMINS[0]!] }), d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(createPhaseA(spec({ operatorId: 'root' }), d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('TASK-044: the gate in create (lane note D2: pre-flight before any write)', () => {
  it('a module the request carries no DPIA decision for refuses NO_DPIA_DECISION before phase A writes anything', async () => {
    const w = world()
    const d = deps(w)
    const err = await refusal(createPhaseA(spec({ dpia: { calendar: DPIA } }), d))
    expect(err).toMatchObject({ code: 'NO_DPIA_DECISION', moduleKey: 'votes', customerId: null, tipSha: TIP })
    expect(err.message).toMatch(/^NO_DPIA_DECISION: /)
    expect(w.mutations).toEqual([])
    expect(w.control.size).toBe(0)
  })

  it('no tip, a stale pass, a failed or missing result: refused by name before phase A writes anything', async () => {
    const cases: [string, (w: ReturnType<typeof world>) => void][] = [
      ['NO_RELEASE_TIP', (w) => (w.tip = null)],
      ['ISOLATION_STALE_TIP', (w) => (w.isolation.get('calendar')!.tip = 'b2'.repeat(20))],
      ['ISOLATION_FAILED', (w) => (w.isolation.get('votes')!.passed = false)],
      ['NO_ISOLATION_RESULT', (w) => w.isolation.delete('votes')],
    ]
    for (const [code, mutate] of cases) {
      const w = world()
      mutate(w)
      const err = await refusal(createPhaseA(spec(), deps(w)))
      expect(err.code, code).toBe(code)
      expect(w.mutations, code).toEqual([])
      expect(w.control.size, code).toBe(0)
    }
  })

  it('phase B re-runs the pre-flight before the accounts step: a tip that moved since phase A invites nobody', async () => {
    const w = world()
    const d = deps(w)
    const a = await createPhaseA(spec(), d)
    hostStamp(w, a.customer)
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)
    w.tip = 'c3'.repeat(20)
    expect((await refusal(createPhaseB(spec(), d))).code).toBe('ISOLATION_STALE_TIP')
    expect(w.realms.get('musterstadt')!.users.size).toBe(0)
    expect(w.enabled.get(a.customer.id)).toBeUndefined()
  })

  it('a DPIA decision for a module outside the enable list, or one without document_ref, is INVALID_INPUT before any write', async () => {
    const w = world()
    const d = deps(w)
    await expect(createPhaseA(spec({ enable: ['calendar'], dpia: { calendar: DPIA, votes: DPIA } }), d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(createPhaseA(spec({ dpia: { calendar: { ...DPIA, documentRef: '' }, votes: DPIA } }), d)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/document_ref/),
    })
    await expect(createPhaseA(spec({ dpia: { calendar: { ...DPIA, requiresDpia: 'maybe' as never }, votes: DPIA } }), d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(w.mutations).toEqual([])
  })

  it('a resumed phase B whose request carries no decision uses the one already recorded for the customer', async () => {
    const w = world()
    const d = deps(w)
    await createAll(w, d)
    w.mutations.length = 0
    const b = await createPhaseB(spec({ dpia: undefined }), d)
    expect(b.enabled).toEqual(['calendar', 'votes'])
    expect(w.mutations).toEqual([])
  })
})

describe('TASK-044: enableCustomerModule (lane note D3, the one path after create)', () => {
  async function active() {
    const w = world()
    const d = deps(w)
    await createAll(w, d, spec({ enable: ['calendar'] }))
    w.mutations.length = 0
    return { w, d }
  }

  it('records the operator\'s decision, enables through the gate, then extends the broker users', async () => {
    const { w, d } = await active()
    const r = await enableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR, dpia: DPIA }, d)
    expect(r).toMatchObject({ moduleKey: 'publishing', noop: false, enabled: ['calendar', 'publishing'], reloaded: true })
    expect(w.mutations).toEqual(['ops:dpia publishing', 'pg:enable musterstadt/publishing', 'nats:ensure musterstadt=[calendar,kernel,publishing]'])
    const c = r.customer
    expect(w.enabled.get(c.id)!.get('publishing')).toEqual({ gateRefs: [w.isolation.get('publishing')!.id, w.dpia.get(`${c.id}/publishing`)![0]!.id], by: OPERATOR })
  })

  it('board and vault are refused by name with zero mutations and the gate never asked (lane note A2)', async () => {
    const { w, d } = await active()
    let asked = 0
    const gate = d.gate
    const counted: ProvisioningDeps = {
      ...d,
      gate: {
        ...gate,
        releaseTipSha: gate.releaseTipSha,
        enableGate: async (c, m) => ((asked++), gate.enableGate(c, m)),
        assertIsolationProven: async (k, c) => ((asked++), gate.assertIsolationProven(k, c)),
        hasDpiaDecision: async (c, m) => ((asked++), gate.hasDpiaDecision(c, m)),
      },
    }
    for (const m of ['vault', 'board']) {
      await expect(enableCustomerModule('musterstadt', m, { operatorId: OPERATOR, dpia: DPIA }, counted)).rejects.toMatchObject({ code: 'MODULE_DENIED' })
    }
    expect(asked).toBe(0)
    expect(w.mutations).toEqual([])
  })

  it('a module with no pass is refused by the gate\'s own EnableRefused (not wrapped), nothing enabled or recorded', async () => {
    const { w, d } = await active()
    w.isolation.delete('publishing')
    const err = await refusal(enableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR, dpia: DPIA }, d))
    expect(err.code).toBe('NO_ISOLATION_RESULT')
    expect(w.mutations).toEqual([])
  })

  it('without a decision in the request and none recorded: NO_DPIA_DECISION before any write', async () => {
    const { w, d } = await active()
    expect((await refusal(enableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR }, d))).code).toBe('NO_DPIA_DECISION')
    expect(w.mutations).toEqual([])
  })

  it('refuses a suspended or unknown customer, an undecided module and a non-uuid operator', async () => {
    const { w, d } = await active()
    await expect(enableCustomerModule('nobody', 'publishing', { operatorId: OPERATOR, dpia: DPIA }, d)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(enableCustomerModule('musterstadt', UNDECIDED_MODULE, { operatorId: OPERATOR, dpia: DPIA }, d)).rejects.toMatchObject({ code: 'MODULE_NOT_LOADED' })
    await expect(enableCustomerModule('musterstadt', 'publishing', { operatorId: 'root', dpia: DPIA }, d)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    w.control.get('musterstadt')!.status = 'suspended'
    await expect(enableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR, dpia: DPIA }, d)).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    expect(w.mutations).toEqual([])
  })
})

describe('suspend and resume (TDD 14, unit half)', () => {
  it('suspend: status first, then realm disabled, then module users evicted (kernel stays); a second suspend changes nothing', async () => {
    const w = world()
    const d = deps(w)
    await createAll(w, d)
    await createAll(w, d, spec({ slug: 'zweitstadt', host: 'rat.zweitstadt.example' }))
    w.mutations.length = 0
    const r = await suspendCustomer('musterstadt', d)
    expect(r.changed).toBe(true)
    expect(w.mutations).toEqual(['control:status musterstadt=suspended', 'kc:enabled musterstadt=false', 'nats:ensure musterstadt=[kernel]'])
    expect(w.realms.get('musterstadt')!.notBefore).toBeGreaterThan(0)
    w.mutations.length = 0
    expect((await suspendCustomer('musterstadt', d)).changed).toBe(false)
    expect(w.mutations).toEqual([])
    // the second customer is untouched
    expect(w.control.get('zweitstadt')!.status).toBe('active')
    expect(w.realms.get('zweitstadt')!.enabled).toBe(true)
    expect(w.broker.get('zweitstadt')).toEqual(['calendar', 'kernel'])
  })

  it('resume refuses without a fresh stamp, then restores realm, users and status (status last)', async () => {
    const w = world()
    const d = deps(w)
    const { a } = await createAll(w, d)
    await suspendCustomer('musterstadt', d)
    // the host's --revoke blanks the realm's sender
    w.realms.get('musterstadt')!.smtp = { host: null, port: null, user: null, from: null, starttls: null }
    await expect(resumeCustomer('musterstadt', d)).rejects.toMatchObject({ code: 'POSTCONDITION' })
    expect(w.control.get('musterstadt')!.status).toBe('suspended')
    hostStamp(w, a.customer)
    w.mutations.length = 0
    await resumeCustomer('musterstadt', d)
    expect(w.mutations).toEqual(['kc:enabled musterstadt=true', 'nats:ensure musterstadt=[calendar,kernel]', 'control:status musterstadt=active'])
  })

  it('refuses to suspend a customer that is still provisioning, and an unknown slug', async () => {
    const w = world()
    const d = deps(w)
    await createPhaseA(spec(), d)
    await expect(suspendCustomer('musterstadt', d)).rejects.toMatchObject({ code: 'CUSTOMER_STATE' })
    await expect(suspendCustomer('nobody', d)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('provisioningStatus', () => {
  it('reports each step, completeness, and (TASK-044, Q8) the enabled modules not proven on this release', async () => {
    const w = world()
    const d = deps(w)
    await createPhaseA(spec(), d)
    const mid = await provisioningStatus('musterstadt', d)
    expect(mid.complete).toBe(false)
    expect(mid.steps.find((s) => s.kind === 'mail_principal_issued')?.status).toBe('pending')
    expect(mid.steps.find((s) => s.kind === 'broker_account_created')?.status).toBe('done')
    hostStamp(w, { realm: 'musterstadt', token: 'musterstadt' })
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)
    await createPhaseB(spec(), d)
    const end = await provisioningStatus('musterstadt', d)
    expect(end.complete).toBe(true)
    expect(end.status).toBe('active')
    expect(end.unprovenEnablements).toEqual([])
    // the next release: both enabled modules lack a pass on its tip
    w.tip = 'd4'.repeat(20)
    const next = await provisioningStatus('musterstadt', d)
    expect(next.unprovenEnablements.map((u) => [u.moduleKey, u.codes])).toEqual([
      ['calendar', ['ISOLATION_STALE_TIP']],
      ['votes', ['ISOLATION_STALE_TIP']],
    ])
  })
})
