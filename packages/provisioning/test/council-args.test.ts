// Phase 1 Task 4: the actor kind through the provisioning library and the
// council-origin args verification (Review Focus 7 and 8). Pure: the verdicts
// of verifyRequestArgs and the actor kind the library hands to its ports.
import { describe, expect, it } from 'vitest'
import {
  COUNCIL_DISABLE_ALLOWED,
  createPhaseA,
  createPhaseB,
  disableCustomerModule,
  enableCustomerModule,
  recordHostStep,
  verifyRequestArgs,
  type CreateSpec,
  type RequestEnvelope,
  type VerifyContext,
} from '../src/index.ts'
import { ADMINS, deps, DPIA, hostStamp, OPERATOR, world } from './fakes.ts'

const PERSON = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const CATALOGUE = ['board', 'calendar', 'content', 'finance', 'publishing', 'vault', 'votes', 'elections']
const DISABLED = ['content', 'finance', 'vault', 'board']
const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({ catalogueIds: CATALOGUE, disabledIds: DISABLED, ...over })

const dpia = { requires_dpia: false, reason_codes: ['council_decision'], document_ref: 'TOM-Anhang 4.1' }
const council = (kind: string, args: unknown, over: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ kind, customerSlug: 'musterstadt', args, operatorId: PERSON, origin: 'council', ...over })
const panel = (kind: string, args: unknown, over: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ kind, customerSlug: 'musterstadt', args, operatorId: PERSON, ...over })

describe('council origin: enable_module', () => {
  it('returns actorKind person and a dpia with reasonCodes [council_decision]', () => {
    expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'votes', dpia }), ctx())).toEqual({
      verdict: 'ok',
      args: {
        slug: 'musterstadt',
        module: 'votes',
        dpia: { requiresDpia: 'no', reasonCodes: ['council_decision'], documentRef: 'TOM-Anhang 4.1' },
        actorKind: 'person',
      },
    })
  })

  it('without a dpia in the request the recorded decision is used (dpia null), still actorKind person', () => {
    expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'calendar' }), ctx())).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'calendar', dpia: null, actorKind: 'person' },
    })
  })

  it('refuses a dpia whose reason_codes contain operator_decision, or anything but exactly [council_decision]', () => {
    for (const reason_codes of [['operator_decision'], ['council_decision', 'operator_decision'], ['no_special_category'], ['council_decision', 'council_decision']]) {
      const v = verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'votes', dpia: { ...dpia, reason_codes } }), ctx())
      expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/council_decision/) })
    }
  })

  it('a panel (or host) dpia may still carry any snake_case code', () => {
    const v = verifyRequestArgs(panel('enable_module', { slug: 'musterstadt', module: 'votes', dpia: { ...dpia, reason_codes: ['operator_decision'] } }), ctx())
    expect(v).toMatchObject({ verdict: 'ok' })
  })

  it('board and vault are refused by name and a module in disabledIds is refused (Review Focus 7)', () => {
    for (const m of ['board', 'vault']) {
      expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: m, dpia }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(new RegExp(`${m} cannot be enabled`)) })
    }
    expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'finance', dpia }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/disabled in this build/) })
    expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'nosuch', dpia }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not in the catalogue/) })
  })

  it('the args slug must be the request slug and unknown fields are refused, as for the panel', () => {
    expect(verifyRequestArgs(council('enable_module', { slug: 'other', module: 'votes' }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not the request's slug/) })
    expect(verifyRequestArgs(council('enable_module', { slug: 'musterstadt', module: 'votes', actorKind: 'operator' }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field actorKind/) })
  })
})

describe('council origin: kinds', () => {
  it.each(['create', 'suspend', 'resume', 'reconcile', 'record_dpia', 'import_members', 'seed_vertical', 'import_isolation'])('%s is refused "not allowed for a council request"', (kind) => {
    expect(verifyRequestArgs(council(kind, { slug: 'musterstadt' }), ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not allowed for a council request/) })
  })

  it('an unknown kind is still refused as unknown', () => {
    expect(verifyRequestArgs(council('drop_everything', {}), ctx())).toEqual({ verdict: 'refused', reason: 'unknown request kind drop_everything' })
  })
})

describe('council origin: disable_module (Review Focus 8)', () => {
  const args = { slug: 'musterstadt', module: 'votes' }

  it('the constant is true: the 30-day Karenz (phase 2) lifts the phase 1 refusal', () => {
    expect(COUNCIL_DISABLE_ALLOWED).toBe(true)
  })

  it('with the shipped constant a council disable verifies (actorKind person) and is no longer refused DISABLE_NOT_YET', () => {
    expect(verifyRequestArgs(council('disable_module', args), ctx())).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'votes', actorKind: 'person' },
    })
  })

  it('is still refused DISABLE_NOT_YET for an explicit councilDisableAllowed false, whatever the module', () => {
    expect(verifyRequestArgs(council('disable_module', { slug: 'musterstadt', module: 'nosuch' }), ctx({ councilDisableAllowed: false }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^DISABLE_NOT_YET/) })
  })

  it('returns actorKind person when ctx.councilDisableAllowed is true, and still validates the module', () => {
    expect(verifyRequestArgs(council('disable_module', args), ctx({ councilDisableAllowed: true }))).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'votes', actorKind: 'person' },
    })
    expect(verifyRequestArgs(council('disable_module', { slug: 'musterstadt', module: 'nosuch' }), ctx({ councilDisableAllowed: true }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not in the catalogue/) })
    expect(verifyRequestArgs(council('disable_module', { ...args, dpia }), ctx({ councilDisableAllowed: true }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field dpia/) })
  })

  it('the panel path is not affected by the council refusal', () => {
    expect(verifyRequestArgs(panel('disable_module', args), ctx())).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'votes', actorKind: 'operator' } })
  })
})

describe('panel and host origins carry actorKind operator', () => {
  const enableArgs = { slug: 'musterstadt', module: 'votes' }
  it.each([undefined, 'panel', 'host'] as const)('origin %s: enable_module and disable_module (golden over the existing fixtures plus the new field)', (origin) => {
    const over = origin ? { origin } : {}
    expect(verifyRequestArgs(panel('enable_module', enableArgs, over), ctx())).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'votes', dpia: null, actorKind: 'operator' } })
    expect(verifyRequestArgs(panel('enable_module', { ...enableArgs, dpia }, over), ctx())).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'votes', dpia: { requiresDpia: 'no', reasonCodes: ['council_decision'], documentRef: 'TOM-Anhang 4.1' }, actorKind: 'operator' },
    })
    expect(verifyRequestArgs(panel('disable_module', enableArgs, over), ctx())).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'votes', actorKind: 'operator' } })
  })

  it('the other kinds are unchanged (no actorKind)', () => {
    expect(verifyRequestArgs(panel('suspend', { slug: 'musterstadt' }), ctx())).toEqual({ verdict: 'ok', args: { slug: 'musterstadt' } })
    expect(verifyRequestArgs(panel('reconcile', { slug: 'musterstadt', apply: false }), ctx())).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', apply: false } })
  })
})

describe('the actor kind reaches the ports', () => {
  const spec: CreateSpec = { slug: 'musterstadt', host: 'rat.musterstadt.example', enable: ['calendar'], operatorId: OPERATOR, admins: ADMINS, dpia: { calendar: DPIA } }
  async function active() {
    const w = world()
    const d = deps(w)
    const a = await createPhaseA(spec, d)
    hostStamp(w, a.customer)
    await recordHostStep(spec.slug, 'mail_principal_issued', spec.operatorId, d)
    await createPhaseB(spec, d)
    w.actors.length = 0
    return { w, d }
  }

  it('enableCustomerModule passes actorKind person to modules.enable and gate.recordDpia', async () => {
    const { w, d } = await active()
    await enableCustomerModule('musterstadt', 'publishing', { operatorId: PERSON, actorKind: 'person', dpia: DPIA }, d)
    expect(w.actors).toEqual(['dpia publishing person', 'enable publishing person'])
  })

  it('enableCustomerModule defaults to operator (the break-glass and panel paths)', async () => {
    const { w, d } = await active()
    await enableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR, dpia: DPIA }, d)
    expect(w.actors).toEqual(['dpia publishing operator', 'enable publishing operator'])
  })

  it('disableCustomerModule passes actorKind person, and defaults to operator', async () => {
    const { w, d } = await active()
    await disableCustomerModule('musterstadt', 'calendar', { operatorId: PERSON, actorKind: 'person' }, d)
    expect(w.actors).toEqual(['disable calendar person'])
    w.actors.length = 0
    await disableCustomerModule('musterstadt', 'calendar', { operatorId: OPERATOR }, d)
    expect(w.actors).toEqual(['disable calendar operator'])
  })

  it('create (phase B) enables as an operator', async () => {
    const w = world()
    const d = deps(w)
    const a = await createPhaseA(spec, d)
    hostStamp(w, a.customer)
    await recordHostStep(spec.slug, 'mail_principal_issued', spec.operatorId, d)
    await createPhaseB(spec, d)
    expect(w.actors).toEqual(['dpia calendar operator', 'enable calendar operator'])
  })
})
