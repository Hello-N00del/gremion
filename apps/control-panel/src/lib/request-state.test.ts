// What the customer page says about the NEWEST request: the executor's real
// states (plt.provisioning_request.state; "verifying" is running with no
// evidence_verified_at yet), the current step and the failure in German.
import { describe, expect, it } from 'vitest'
import { describeRequest } from './request-state'

const base = { state: 'queued', evidenceVerifiedAt: null as string | null, outcome: null as string | null, lastStep: null as string | null }

describe('describeRequest', () => {
  it('queued is active and not retryable', () => {
    const d = describeRequest(base)
    expect(d).toMatchObject({ phase: 'queued', active: true, retryable: false })
    expect(d.label).toMatch(/Warteschlange/)
  })
  it('running before the evidence is verified is "verifying"', () => {
    expect(describeRequest({ ...base, state: 'running' })).toMatchObject({ phase: 'verifying', active: true, retryable: false })
  })
  it('running after verification shows the current step in words', () => {
    const d = describeRequest({ ...base, state: 'running', evidenceVerifiedAt: '2026-10-27T10:00:00Z', lastStep: 'database_created' })
    expect(d).toMatchObject({ phase: 'running', active: true, retryable: false, step: 'database_created' })
    expect(d.text).toMatch(/Kerndatenbank/)
  })
  it('an unknown step is shown raw, none is tolerated', () => {
    expect(describeRequest({ ...base, state: 'running', evidenceVerifiedAt: 'x', lastStep: 'weird' }).text).toMatch(/weird/)
    expect(describeRequest({ ...base, state: 'running', evidenceVerifiedAt: 'x' }).phase).toBe('running')
  })
  it('failed in a step: reason code, the step and a German text; retryable', () => {
    const d = describeRequest({ ...base, state: 'failed', outcome: 'create proof-z: failed in domain_bound (exit 4); a new request resumes from the ledger' })
    expect(d).toMatchObject({ phase: 'failed', code: 'step_failed:domain_bound', active: false, retryable: true })
    expect(d.text).toMatch(/Host gebunden/)
    expect(d.text).toMatch(/fehlgeschlagen/)
  })
  it('failed in verification: its own code', () => {
    const d = describeRequest({ ...base, state: 'failed', outcome: 'verify: request-verify could not decide (exit 2); nothing ran' })
    expect(d).toMatchObject({ code: 'verify_failed', retryable: true })
    expect(d.text).toMatch(/nichts ausgeführt/)
  })
  it('failed with an unrecognised outcome still has a code and is retryable', () => {
    expect(describeRequest({ ...base, state: 'failed', outcome: 'huh' })).toMatchObject({ code: 'failed', retryable: true })
    expect(describeRequest({ ...base, state: 'failed' })).toMatchObject({ code: 'failed', retryable: true })
  })
  it('refused carries the verify reason; retryable', () => {
    const d = describeRequest({ ...base, state: 'refused', outcome: 'refused: board ist noch nicht mandantengetrennt' })
    expect(d).toMatchObject({ phase: 'refused', code: 'refused', retryable: true })
    expect(d.text).toContain('board ist noch nicht mandantengetrennt')
    expect(d.text).not.toContain('refused:')
  })
  it('succeeded, expired and dead are final and not retryable here', () => {
    for (const state of ['succeeded', 'expired', 'dead']) expect(describeRequest({ ...base, state })).toMatchObject({ phase: state, active: false, retryable: false })
  })
})
