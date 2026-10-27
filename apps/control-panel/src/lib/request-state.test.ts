// What the customer page says about the NEWEST request: the executor's real
// states (plt.provisioning_request.state; "verifying" is running with no
// evidence_verified_at yet), the current step and the failure in German.
// Fixtures are the strings infra/host/bin/gremion-executor (run_request) and
// request-verify really write: step names claim, verify, dispatch, create,
// phase-a, mail, record-step, phase-b, router, activate; outcomes
// "verify: ...", "<kind> <slug>: failed in <step> (exit N); ...",
// "refused: <reason>", "no handler for <kind>".
import { describe, expect, it } from 'vitest'
import { describeRequest, EXECUTOR_STEP_LABEL } from './request-state'

const base = { kind: 'create', state: 'queued', evidenceVerifiedAt: null as string | null, outcome: null as string | null, lastStep: null as string | null }
const FAILED = (step: string, n = 4) => `create proof-z: failed in ${step} (exit ${n}); a new request resumes from the ledger`

describe('describeRequest: active states', () => {
  it('queued is active and not retryable', () => {
    const d = describeRequest(base)
    expect(d).toMatchObject({ phase: 'queued', active: true, retryable: false })
    expect(d.label).toMatch(/Warteschlange/)
  })
  it('running before the evidence is verified is "verifying"', () => {
    expect(describeRequest({ ...base, state: 'running' })).toMatchObject({ phase: 'verifying', active: true, retryable: false })
  })
  it('running after verification shows the executor step in words', () => {
    const d = describeRequest({ ...base, state: 'running', evidenceVerifiedAt: '2026-10-27T10:00:00Z', lastStep: 'phase-a' })
    expect(d).toMatchObject({ phase: 'running', active: true, retryable: false, step: 'phase-a' })
    expect(d.text).toContain(EXECUTOR_STEP_LABEL['phase-a'])
  })
  it.each(['claim', 'verify', 'create', 'phase-a', 'mail', 'record-step', 'phase-b', 'router', 'activate'])('step %s has a German label', (s) => {
    expect(EXECUTOR_STEP_LABEL[s]).toBeTruthy()
    expect(describeRequest({ ...base, state: 'running', evidenceVerifiedAt: 'x', lastStep: s }).text).toContain(EXECUTOR_STEP_LABEL[s]!)
  })
  it('an unknown step is shown raw (as text), none is tolerated', () => {
    expect(describeRequest({ ...base, state: 'running', evidenceVerifiedAt: 'x', lastStep: 'weird-step' }).text).toContain('weird-step')
    expect(describeRequest({ ...base, state: 'running', evidenceVerifiedAt: 'x' }).phase).toBe('running')
  })
})

describe('describeRequest: failed (real outcome formats)', () => {
  it('"<kind> <slug>: failed in <step> (exit N)": code, German step, technical detail; retryable', () => {
    const d = describeRequest({ ...base, state: 'failed', outcome: FAILED('phase-a', 4) })
    expect(d).toMatchObject({ phase: 'failed', code: 'step_failed:phase-a', active: false, retryable: true, retryNote: null })
    expect(d.text).toContain(EXECUTOR_STEP_LABEL['phase-a'])
    expect(d.text).toMatch(/fehlgeschlagen/)
    expect(d.text).toMatch(/Exit 4/)
  })
  it('a failure naming the kind itself as step (no marker seen)', () => {
    expect(describeRequest({ ...base, state: 'failed', outcome: FAILED('create', 1) })).toMatchObject({ code: 'step_failed:create' })
  })
  it('"verify: request-verify could not decide ..." is verify_failed', () => {
    const d = describeRequest({ ...base, state: 'failed', outcome: 'verify: request-verify could not decide (exit 2); nothing ran' })
    expect(d).toMatchObject({ code: 'verify_failed', retryable: true })
    expect(d.text).toMatch(/nichts ausgeführt/)
  })
  it('"verify: request-verify printed no verdict" and "could not mark the request verified" too', () => {
    for (const o of ['verify: request-verify printed no verdict; nothing ran', 'verify: could not mark the request verified; nothing ran']) {
      expect(describeRequest({ ...base, state: 'failed', outcome: o })).toMatchObject({ code: 'verify_failed', retryable: true })
    }
  })
  it('an unrecognised outcome still has a code and is retryable', () => {
    expect(describeRequest({ ...base, state: 'failed', outcome: 'huh' })).toMatchObject({ code: 'failed', retryable: true })
    expect(describeRequest({ ...base, state: 'failed' })).toMatchObject({ code: 'failed', retryable: true })
  })
  it('a step name that is not a plain token is not echoed', () => {
    const d = describeRequest({ ...base, state: 'failed', outcome: 'create x: failed in <script>alert(1)</script> (exit 1)' })
    expect(d.text).not.toContain('<script>')
  })
})

describe('describeRequest: refused', () => {
  it('evidence refusals (sign-in) are retryable; the English reason is the technical detail', () => {
    for (const reason of ['evidence: the sign-in (auth_time) is 4000 s before the request; at most 3600 s before (or 60 s after) is accepted', 'a panel request without its signed evidence']) {
      const d = describeRequest({ ...base, state: 'refused', outcome: `refused: ${reason}` })
      expect(d).toMatchObject({ phase: 'refused', code: 'refused_evidence', retryable: true, retryNote: null, detail: reason })
      expect(d.text).toMatch(/Anmeldung/)
    }
  })
  it('other verify refusals (args, modules, operator, no handler) are not retryable and say why', () => {
    for (const o of [
      'refused: module vault is disabled in this build (modules/disabled.json)',
      'refused: dpia.calendar.document_ref is required: the written decision (TOM-annex entry) must be named for every module, whatever requires_dpia says',
      'refused: operator 8d6b9c7e is disabled in the ops realm',
      'no handler for import_members',
    ]) {
      const d = describeRequest({ ...base, state: 'refused', outcome: o })
      expect(d).toMatchObject({ phase: 'refused', retryable: false })
      expect(d.retryNote).toMatch(/Formular|Angaben|korrig/)
      expect(d.detail).not.toContain('refused:')
    }
  })
  it('the refused reason is the detail, not in the German sentence verbatim', () => {
    const d = describeRequest({ ...base, state: 'refused', outcome: 'refused: board ist noch nicht mandantengetrennt' })
    expect(d.code).toBe('refused')
    expect(d.detail).toBe('board ist noch nicht mandantengetrennt')
  })
})

describe('describeRequest: retry only for kind create', () => {
  it.each(['suspend', 'resume', 'reconcile', 'enable_module', 'import_members'])('a failed %s request is not retryable here', (kind) => {
    const d = describeRequest({ ...base, kind, state: 'failed', outcome: FAILED('phase-a') })
    expect(d.retryable).toBe(false)
    expect(d.retryNote).toBeTruthy()
  })
})

describe('describeRequest: final states', () => {
  it('succeeded is final and not retryable', () => {
    expect(describeRequest({ ...base, state: 'succeeded' })).toMatchObject({ phase: 'succeeded', active: false, retryable: false })
  })
  it('expired and dead (lease lost) offer retry for create', () => {
    for (const state of ['expired', 'dead']) expect(describeRequest({ ...base, state })).toMatchObject({ phase: state, active: false, retryable: true })
  })
  it('expired and dead of another kind do not', () => {
    for (const state of ['expired', 'dead']) expect(describeRequest({ ...base, kind: 'suspend', state }).retryable).toBe(false)
  })
})
