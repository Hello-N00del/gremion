// recordResolutionAdoptions is the last statement-level stop before a decision
// is stamped and written to the audit chain. A counted resolution nobody voted
// on is not a decision, so the recorder refuses it and the publish transaction
// rolls back. The verdict is taken from the row AS STAMPED (the UPDATE's
// RETURNING), not from the list the caller read earlier.
//
// The transaction is a recording fake here; the same refusal is pinned against a
// real database in resolution-adoption.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeAuditEntry: vi.fn(async () => {}) }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))
vi.mock('../db', () => ({
  getDb: () => {
    throw new Error('the recorder must only use the transaction')
  },
}))

import { recordResolutionAdoptions, type ProtocolResolution } from './protocol-db'
import { UntalliedResolutionError } from './untallied-resolution'
import type { PgTransaction } from '$lib/server/db/tx'

const resolution = (over: Partial<ProtocolResolution> = {}): ProtocolResolution => ({
  id: 'r1', protocol_id: 'p1', sequence_nr: 1, global_nr: 'B-2026-001', text: 'Antrag',
  votes_yes: 3, votes_no: 1, votes_abstain: 0, result: 'passed', required_majority: 'simple',
  adoption_mode: 'tally', decision_rule_params: null, decided_at: null, created_at: '2026-06-21T10:00:00Z',
  ...over,
})
const untallied = (over: Partial<ProtocolResolution> = {}) =>
  resolution({ votes_yes: 0, votes_no: 0, votes_abstain: 0, result: 'rejected', ...over })

/** A transaction whose stamping UPDATE returns `stored` (the row as the database holds it). */
function txReturning(stored: Record<string, ProtocolResolution | null>) {
  const statements: string[] = []
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(strings.join('?'))
    const row = stored[values[0] as string]
    return row ? [{ ...row, decided_at: '2026-06-21T12:00:00Z' }] : []
  })
  return { tx: tx as unknown as PgTransaction, statements }
}

beforeEach(() => h.writeAuditEntry.mockClear())

describe('recordResolutionAdoptions: a resolution nobody voted on is never recorded as a decision', () => {
  it('refuses an untallied resolution and writes no audit entry', async () => {
    const row = untallied()
    const { tx } = txReturning({ r1: row })
    await expect(recordResolutionAdoptions('admin', [row], tx)).rejects.toBeInstanceOf(UntalliedResolutionError)
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('judges the row as stamped, not the list the caller read before the transaction', async () => {
    const { tx } = txReturning({ r1: untallied() })
    await expect(recordResolutionAdoptions('admin', [resolution()], tx)).rejects.toMatchObject({
      name: 'UntalliedResolutionError',
      resolutionId: 'r1',
    })
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('stops at the first untallied resolution: earlier entries roll back with the transaction', async () => {
    const first = resolution({ id: 'r1' })
    const second = untallied({ id: 'r2' })
    const third = resolution({ id: 'r3' })
    const { tx } = txReturning({ r1: first, r2: second, r3: third })
    await expect(recordResolutionAdoptions('admin', [first, second, third], tx)).rejects.toBeInstanceOf(UntalliedResolutionError)
    expect(h.writeAuditEntry).toHaveBeenCalledTimes(1)
  })

  it('records a counted vote, a rejected one included', async () => {
    const passed = resolution({ id: 'r1' })
    const rejected = resolution({ id: 'r2', votes_yes: 0, votes_no: 4, result: 'rejected' })
    const { tx } = txReturning({ r1: passed, r2: rejected })
    expect(await recordResolutionAdoptions('admin', [passed, rejected], tx)).toBe(2)
    expect(h.writeAuditEntry).toHaveBeenCalledTimes(2)
  })

  it('records a consent resolution with an empty tally as adopted: silence adopts', async () => {
    const consent = untallied({ required_majority: 'consent', result: 'passed' })
    const { tx } = txReturning({ r1: consent })
    expect(await recordResolutionAdoptions('admin', [consent], tx)).toBe(1)
    const [entry] = h.writeAuditEntry.mock.calls[0] as unknown as [{ newValue: string }]
    expect(JSON.parse(entry.newValue)).toMatchObject({ resolutionId: 'r1', result: 'passed', requiredMajority: 'consent' })
  })

  it('records an acclamation without a count and skips a withdrawn resolution', async () => {
    const acclaimed = resolution({ id: 'r1', adoption_mode: 'acclamation', votes_yes: null, votes_no: null, votes_abstain: null })
    const withdrawn = untallied({ id: 'r2', result: 'withdrawn' })
    const { tx, statements } = txReturning({ r1: acclaimed, r2: withdrawn })
    expect(await recordResolutionAdoptions('admin', [acclaimed, withdrawn], tx)).toBe(1)
    expect(statements).toHaveLength(1) // the withdrawn row is never stamped
  })

  it('a republish is a non-event for an already decided resolution', async () => {
    const { tx } = txReturning({ r1: null }) // the UPDATE matched no undecided row
    expect(await recordResolutionAdoptions('admin', [resolution()], tx)).toBe(0)
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })
})
