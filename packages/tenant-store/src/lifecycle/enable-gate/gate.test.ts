// TASK-044 TDD 3 (the part with no database) and TDD 5 (the evidence file):
// the gate's tip precedence, the refusal's shape, the DPIA input rule and the
// evidence stamp. The database half (every code over real rows) is
// test/integration/lifecycle-enable-gate.test.ts.
import type { Sql } from '@gremion/db'
import { describe, expect, it } from 'vitest'
import {
  assertDpiaDecisionInput,
  assertIsolationProven,
  createEnableGate,
  ENABLE_REFUSED_CODES,
  EnableRefused,
  IsolationEvidenceError,
  parseIsolationEvidence,
  type DpiaDecisionInput,
} from './index.js'

const C = '01900000-0000-7000-8000-000000000001'
const OP = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const TIP = 'b'.repeat(40)

/** A platform connection that must never be queried. */
function untouchable(): { sql: Sql; calls: string[] } {
  const calls: string[] = []
  const sql = ((strings: TemplateStringsArray) => {
    calls.push(strings.join('?'))
    throw new Error('the gate queried the database')
  }) as unknown as Sql
  return { sql, calls }
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

describe('createEnableGate: NO_RELEASE_TIP first, before any query (lane note A2 precedence)', () => {
  for (const tip of [undefined, null, '', 'HEAD', 'v1.2.3', 'B'.repeat(40), 'b'.repeat(39), 'b'.repeat(41), 'b'.repeat(63), `${'b'.repeat(40)}\n`]) {
    it(`tip ${JSON.stringify(tip)} -> NO_RELEASE_TIP naming module, customer and the variable; no query ran`, async () => {
      const { sql, calls } = untouchable()
      const err = await refusal(Promise.resolve(createEnableGate({ platform: sql, releaseTipSha: tip })(C, 'calendar')))
      expect(err.code).toBe('NO_RELEASE_TIP')
      expect(err.moduleKey).toBe('calendar')
      expect(err.customerId).toBe(C)
      expect(err.tipSha).toBeNull()
      expect(err.reason).toMatch(/calendar/)
      expect(err.reason).toContain(C)
      expect(err.reason).toMatch(/GREMION_RELEASE_TIP/)
      expect(err.message).toBe(`NO_RELEASE_TIP: ${err.reason}`)
      expect(calls).toEqual([])
    })
  }

  it('a 40- or 64-hex tip passes the tip check and reaches the database', async () => {
    for (const tip of [TIP, 'c'.repeat(64)]) {
      const { sql, calls } = untouchable()
      await expect(createEnableGate({ platform: sql, releaseTipSha: tip })(C, 'calendar')).rejects.toThrow(/queried the database/)
      expect(calls.length).toBe(1)
    }
  })

  it('the pre-flight refuses an unset tip for the first module before any query, the customer not created yet', async () => {
    const { sql, calls } = untouchable()
    const err = await refusal(assertIsolationProven({ platform: sql, releaseTipSha: '' }, ['votes', 'calendar']))
    expect(err).toMatchObject({ code: 'NO_RELEASE_TIP', moduleKey: 'votes', customerId: null })
    expect(err.reason).toMatch(/not created yet/)
    expect(calls).toEqual([])
  })

  it('needs a platform connection', () => {
    expect(() => createEnableGate({} as never)).toThrow(TypeError)
  })

  it('the six codes the brief names, no more', () => {
    expect([...ENABLE_REFUSED_CODES].sort()).toEqual(['FIXTURE_EVIDENCE', 'ISOLATION_FAILED', 'ISOLATION_STALE_TIP', 'NO_DPIA_DECISION', 'NO_ISOLATION_RESULT', 'NO_RELEASE_TIP'])
  })
})

describe('assertDpiaDecisionInput (brief Q3: a written decision, whatever requires_dpia says)', () => {
  const ok: DpiaDecisionInput = { customerId: C, moduleKey: 'votes', requiresDpia: 'no', reasonCodes: ['no_special_category'], documentRef: 'TOM-Anhang 3.2', decidedBy: { kind: 'operator', id: OP } }

  it('accepts a dated, written decision for each requires_dpia value', () => {
    for (const requiresDpia of ['yes', 'no', 'not_applicable'] as const) expect(() => assertDpiaDecisionInput({ ...ok, requiresDpia })).not.toThrow()
  })

  it('refuses a decision without document_ref for every value, not only yes', () => {
    for (const requiresDpia of ['yes', 'no', 'not_applicable'] as const) {
      for (const documentRef of ['', '   ', undefined, 'a\nb', 'x'.repeat(501)]) {
        expect(() => assertDpiaDecisionInput({ ...ok, requiresDpia, documentRef: documentRef as string }), `${requiresDpia} ${JSON.stringify(documentRef)}`).toThrow(/document_ref/)
      }
    }
  })

  it('refuses an unknown requires_dpia, bad or too many reason codes, a bad module key, a non-uuid actor', () => {
    expect(() => assertDpiaDecisionInput({ ...ok, requiresDpia: 'maybe' as never })).toThrow(/requires_dpia/)
    expect(() => assertDpiaDecisionInput({ ...ok, reasonCodes: [] })).toThrow(/1-20/)
    expect(() => assertDpiaDecisionInput({ ...ok, reasonCodes: Array.from({ length: 21 }, (_, i) => `c${i}`) })).toThrow(/1-20/)
    expect(() => assertDpiaDecisionInput({ ...ok, reasonCodes: ['Not-Snake'] })).toThrow(/snake_case/)
    expect(() => assertDpiaDecisionInput({ ...ok, moduleKey: 'Votes' })).toThrow(/module key/)
    expect(() => assertDpiaDecisionInput({ ...ok, decidedBy: { kind: 'operator', id: 'nobody' } })).toThrow(/uuid/)
    expect(() => assertDpiaDecisionInput({ ...ok, customerId: 'x' })).toThrow(/uuid/)
  })
})

describe('parseIsolationEvidence (TDD 5: only a verify-stamped PASS is imported)', () => {
  const ref = `sha256:${'d'.repeat(64)} scripts/verify/out/isolation/${TIP}.json#calendar`
  const good = () => ({
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: TIP,
    verify_record: { suite: 'isolation:tenant', sha: TIP, startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:02:00.000Z', collected: 8, passed: 8, failed: 0 },
    results: [{ module: 'calendar', test_kind: 'cross_customer', passed: true, run_at: '2026-10-05T10:01:00.000Z', release_tip_sha: TIP, evidence_ref: ref }],
  })
  const code = (json: unknown) => {
    try {
      parseIsolationEvidence(json)
    } catch (err) {
      if (err instanceof IsolationEvidenceError) return err.code
      throw err
    }
    return 'OK'
  }

  it('a stamped PASS parses, every result on the evidence tip', () => {
    const ev = parseIsolationEvidence(good())
    expect(ev.results).toEqual([{ module: 'calendar', test_kind: 'cross_customer', passed: true, run_at: '2026-10-05T10:01:00.000Z', release_tip_sha: TIP, evidence_ref: ref }])
  })

  it('an unstamped or standalone (run.mjs) file is refused', () => {
    expect(code({ ...good(), produced_by: 'run.mjs' })).toBe('EVIDENCE_UNSTAMPED')
    expect(code({ ...good(), produced_by: undefined })).toBe('EVIDENCE_UNSTAMPED')
    expect(code({ ...good(), tree_clean: false })).toBe('EVIDENCE_UNSTAMPED')
    expect(code({ ...good(), verify_record: undefined })).toBe('EVIDENCE_UNSTAMPED')
    expect(code({ results: good().results })).toBe('EVIDENCE_UNSTAMPED')
    expect(code(null)).toBe('EVIDENCE_MALFORMED')
    expect(code([good()])).toBe('EVIDENCE_MALFORMED')
  })

  it('a verify record that is not a PASS of isolation:tenant on that sha is refused', () => {
    const vr = good().verify_record
    expect(code({ ...good(), verify_record: { ...vr, failed: 1, passed: 7 } })).toBe('EVIDENCE_NOT_PASS')
    expect(code({ ...good(), verify_record: { ...vr, collected: 0, passed: 0 } })).toBe('EVIDENCE_NOT_PASS')
    expect(code({ ...good(), verify_record: { ...vr, passed: 7 } })).toBe('EVIDENCE_NOT_PASS')
    expect(code({ ...good(), verify_record: { ...vr, suite: 'isolation:storage' } })).toBe('EVIDENCE_NOT_PASS')
    expect(code({ ...good(), verify_record: { ...vr, sha: 'e'.repeat(40) } })).toBe('EVIDENCE_NOT_PASS')
    expect(code({ ...good(), results: [{ ...good().results[0], passed: false }] })).toBe('EVIDENCE_NOT_PASS')
  })

  it('an empty file is refused, and so is a malformed result', () => {
    expect(code({ ...good(), results: [] })).toBe('EVIDENCE_EMPTY')
    expect(code({ ...good(), results: undefined })).toBe('EVIDENCE_EMPTY')
    const r = good().results[0]!
    expect(code({ ...good(), results: [{ ...r, evidence_ref: 'scratch-fixture:calendar' }] })).toBe('EVIDENCE_MALFORMED')
    expect(code({ ...good(), results: [{ ...r, release_tip_sha: 'e'.repeat(40) }] })).toBe('EVIDENCE_MALFORMED')
    expect(code({ ...good(), results: [{ ...r, module: 'Calendar' }] })).toBe('EVIDENCE_MALFORMED')
    expect(code({ ...good(), results: [{ ...r, test_kind: 'cross_tenant' }] })).toBe('EVIDENCE_MALFORMED')
    expect(code({ ...good(), results: [{ ...r, run_at: 'yesterday' }] })).toBe('EVIDENCE_MALFORMED')
    expect(code({ ...good(), release_tip_sha: 'HEAD' })).toBe('EVIDENCE_MALFORMED')
  })
})
