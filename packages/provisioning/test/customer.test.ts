// TASK-043 TDD 3, 6, 7, 8, 9, 10, 14 (unit halves) over recording fakes:
// the phases in order, the post-conditions read back, the interim gate, the
// idempotent rerun (zero mutating calls), suspend/resume ordering.
import { describe, expect, it } from 'vitest'
import {
  createPhaseA,
  createPhaseB,
  EXECUTION_ORDER,
  provisioningStatus,
  ProvisioningError,
  recordHostStep,
  resumeCustomer,
  suspendCustomer,
  type CreateSpec,
} from '../src/index.ts'
import { ADMINS, deps, hostStamp, OPERATOR, PLATFORM_DOMAIN, UNDECIDED_MODULE, world } from './fakes.ts'

const spec = (over: Partial<CreateSpec> = {}): CreateSpec => ({
  slug: 'musterstadt',
  host: 'rat.musterstadt.example',
  enable: ['calendar', 'votes'],
  operatorId: OPERATOR,
  admins: ADMINS,
  ...over,
})

async function createAll(w: ReturnType<typeof world>, d: ReturnType<typeof deps>, s = spec()) {
  const a = await createPhaseA(s, d)
  if (!w.realms.get(a.customer.realm)?.smtp.user) hostStamp(w, a.customer)
  await recordHostStep(s.slug, 'mail_principal_issued', s.operatorId, d)
  const b = await createPhaseB(s, d)
  return { a, b }
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
    // Q19: one attestation per module, persisted before its enable, both refs = that id
    const mine = w.enabled.get(c.id)!
    for (const mod of ['calendar', 'votes']) {
      const att = w.attestations.get(`${c.id}/${mod}`)!
      expect(mine.get(mod)).toEqual({ gateRefs: [att.id, att.id], by: OPERATOR })
      expect(w.mutations.indexOf(`plt:attest ${mod}`)).toBeLessThan(w.mutations.indexOf(`pg:enable musterstadt/${mod}`))
      expect(att.enableList).toEqual(['calendar', 'votes'])
    }
    expect(w.mutations.indexOf('control:status musterstadt=active')).toBeGreaterThan(w.mutations.indexOf('ledger:first_accounts_created=done'))
  })

  it('a second run makes zero mutating calls, reloads nothing, sends no invite', async () => {
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

  it('an id outside --enable gets GATE_REFUSED from the gate and nothing is created for it', async () => {
    const w = world()
    const d = deps(w)
    await createAll(w, d)
    const c = await d.control.getBySlug('musterstadt')
    const ref = { id: c!.id, slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }
    const { operatorAllowGate } = await import('../src/index.ts')
    const gate = operatorAllowGate(new Set(['calendar']), (cid, mid) => d.attestations.lookup(cid, mid))
    await expect(d.modules.enable(ref, 'publishing', gate, OPERATOR)).rejects.toMatchObject({ code: 'GATE_REFUSED' })
    expect(w.enabled.get(c!.id)?.has('publishing')).toBe(false)
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
  it('reports each step, completeness, and the interim attestations TASK-044 must re-gate', async () => {
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
    expect(end.interimAttestations.map((a) => a.moduleKey).sort()).toEqual(['calendar', 'votes'])
    expect(end.interimAttestations[0]!.basis).toBe('interim gate, no isolation test (TASK-044)')
  })
})
