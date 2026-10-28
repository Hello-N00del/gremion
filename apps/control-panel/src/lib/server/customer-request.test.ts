// queueRequest (suspend, resume, enable_module, disable_module, record_dpia,
// reconcile): TRD-092 -- the vendor-access record is written by
// oac.record_access in the SAME statement as the request, like submitCreate and
// retryRequest. A request whose record cannot be written is refused.
import { describe, expect, it } from 'vitest'
import { queueRequest } from './customer-request'
import { retryRequest } from './retry'
import { SubmitRefused, type Evidence } from './requests'

const OP = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const EVIDENCE: Evidence = { token: 'x'.repeat(120), acr: 'loa2', authTime: new Date('2026-10-21T10:00:00Z'), sessionAt: new Date('2026-10-21T10:00:01Z') }
const KINDS = ['suspend', 'resume', 'enable_module', 'disable_module', 'record_dpia', 'reconcile'] as const

/** Answers the in-flight read with no rows and the submit with an id; records every statement. */
function fakeSql(fail?: unknown) {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      calls.push({ text, values })
      if (text.includes('provisioning_request_status')) return Promise.resolve([])
      return fail ? Promise.reject(fail) : Promise.resolve([{ id: 'req-1' }])
    },
    { json: (v: unknown) => ({ json: v }) },
  )
  return { sql: sql as never, calls }
}

describe('queueRequest writes the vendor-access record in the same statement', () => {
  for (const kind of KINDS) {
    it(`${kind}: the submit statement carries oac.record_access with the operator as actor`, async () => {
      const f = fakeSql()
      await queueRequest(f.sql, kind, 'alpha-rat', {}, OP, EVIDENCE)
      const submits = f.calls.filter((c) => c.text.includes('plt.submit_provisioning_request('))
      expect(submits).toHaveLength(1)
      const c = submits[0]!
      expect(c.text).toContain('oac.record_access(')
      expect(c.values).toContain('panel_request')
      expect(c.values.filter((v) => v === OP)).toHaveLength(2) // the request's operator and the record's actor
      expect(c.values.some((v) => typeof v === 'string' && v.includes(`Anfrage ${kind} für alpha-rat`))).toBe(true)
      // the signed evidence token is in the request only, never in the record's words
      expect(c.values.filter((v) => typeof v === 'string' && v.includes(EVIDENCE.token))).toHaveLength(1)
    })
  }
  it('a database refusal (the record cannot be written) refuses the request', async () => {
    const f = fakeSql(Object.assign(new Error('db'), { code: '42501' }))
    const err = await queueRequest(f.sql, 'suspend', 'alpha-rat', {}, OP, EVIDENCE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubmitRefused)
  })
})

describe('retryRequest re-queues a failed disable_module (the resumable disable, with its access record)', () => {
  it('replays the same args as a new request, in one statement with oac.record_access', async () => {
    const calls: { text: string; values: unknown[] }[] = []
    const row = { kind: 'disable_module', state: 'failed', outcome: 'disable_module alpha-rat: failed in disable_module (exit 1); a new request resumes from the ledger', evidence_verified_at: new Date(), args: { slug: 'alpha-rat', module: 'votes' } }
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?')
        calls.push({ text, values })
        if (text.includes('args FROM plt.provisioning_request_status')) return Promise.resolve([row])
        if (text.includes('provisioning_request_status')) return Promise.resolve([])
        return Promise.resolve([{ id: 'req-2' }])
      },
      { json: (v: unknown) => ({ json: v }) },
    )
    await expect(retryRequest(sql as never, 'alpha-rat', OP, EVIDENCE)).resolves.toBe('req-2')
    const submit = calls.find((c) => c.text.includes('plt.submit_provisioning_request('))!
    expect(submit.text).toContain('oac.record_access(')
    expect(submit.values).toContain('disable_module')
    expect((submit.values.find((v) => (v as { json?: unknown })?.json) as { json: unknown }).json).toEqual({ slug: 'alpha-rat', module: 'votes' })
  })
})
