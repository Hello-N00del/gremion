// org-unit-event-relay.test.ts — the wire contract of one relay pass.
//
// PORT NOTE (B5): the frozen StuRa tree ships runOrgUnitRelayPass with no test of
// its own; its only other reference there is register.server.ts. Porting it on
// that basis would put the one place the wire subject is built into the kernel
// unguarded, and the plan's stated RED for this task (the not-draining test) is
// not one: that test imports only ./org-unit-event-outbox and is already green
// from the previous task. This file is the missing guard, and it holds exactly
// the three rules the relay's own header states.

import { describe, it, expect, vi } from 'vitest'
import type { BrokerPort, EventEnvelope } from '@gremion/ports/broker'
import { orgUnitSubject } from '@gremion/ports/broker'
import type { SqlRunner } from '$lib/server/db/tx'
import { runOrgUnitRelayPass } from './org-unit-event-relay'
import type { OrgUnitOutboxRow } from './org-unit-event-outbox'

const TENANT = 'acme'

function row(over: Partial<OrgUnitOutboxRow> = {}): OrgUnitOutboxRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    event_id: '22222222-2222-2222-2222-222222222222',
    event_type: 'upserted',
    aggregate_id: '33333333-3333-3333-3333-333333333333',
    payload: { id: '33333333-3333-3333-3333-333333333333', name: 'Referat', kind: 'referat', parent_id: null },
    correlation_id: 'corr-1',
    occurred_at: new Date('2026-01-02T03:04:05.000Z'),
    status: 'pending',
    attempts: 0,
    next_attempt_at: null,
    first_failed_at: null,
    last_error: null,
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    ...over,
  }
}

/**
 * A SqlRunner double whose `begin` hands back itself and whose tagged-template
 * calls answer the two statements drainOutbox issues inside that transaction:
 * the due-row SELECT, and the mark-ok / mark-failed UPDATEs.
 */
function makeSql(dueRows: OrgUnitOutboxRow[]) {
  const statements: string[] = []
  const tag = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join('?')
    statements.push(text)
    if (/SELECT/i.test(text) && /org_unit_event_outbox/i.test(text)) return Promise.resolve(dueRows)
    return Promise.resolve([])
  }
  const sql = Object.assign(tag, {
    begin: (cb: (tx: SqlRunner) => Promise<void>) => cb(sql as unknown as SqlRunner),
  })
  return { sql: sql as unknown as SqlRunner, statements }
}

function makeBroker() {
  const published: Array<{ subject: string; envelope: EventEnvelope }> = []
  const broker = {
    publish: vi.fn(async (subject: string, envelope: EventEnvelope) => {
      published.push({ subject, envelope })
    }),
  } as unknown as BrokerPort
  return { broker, published }
}

describe('runOrgUnitRelayPass', () => {
  it('publishes each due row on the subject orgUnitSubject() builds, and marks it ok', async () => {
    const { sql, statements } = makeSql([row()])
    const { broker, published } = makeBroker()

    const res = await runOrgUnitRelayPass(sql, TENANT, broker)

    expect(res).toEqual({ ok: 1, failed: 0 })
    expect(published).toHaveLength(1)
    // The ONLY place the wire subject is built — asserted against the port's own
    // builder, never a literal, so a wire-root change can never diverge here.
    expect(published[0]!.subject).toBe(orgUnitSubject(TENANT, 'upserted'))
    expect(statements.some((s) => /status\s*=\s*'ok'/i.test(s))).toBe(true)
  })

  it('carries the STABLE event_id and the DML instant, not the publish time', async () => {
    const { sql } = makeSql([row()])
    const { broker, published } = makeBroker()

    await runOrgUnitRelayPass(sql, TENANT, broker)

    const env = published[0]!.envelope
    // A retry re-publishes the SAME id, which is what lets the leaf dedup it.
    expect(env.eventId).toBe('22222222-2222-2222-2222-222222222222')
    expect(env.eventType).toBe('upserted')
    expect(env.tenantId).toBe(TENANT)
    // occurredAt is the DML instant: the leaf's per-aggregate ordering guard is
    // driven by DML order, so relay-publish time would reorder a backlog.
    expect(env.occurredAt).toBe('2026-01-02T03:04:05.000Z')
    expect(env.correlationId).toBe('corr-1')
    expect(env.payload).toEqual({
      id: '33333333-3333-3333-3333-333333333333',
      name: 'Referat',
      kind: 'referat',
      parent_id: null,
    })
  })

  it('records a publish that threw as failed instead of losing the row', async () => {
    const { sql, statements } = makeSql([row()])
    const broker = { publish: vi.fn(async () => { throw new Error('NoStreamError') }) } as unknown as BrokerPort

    const res = await runOrgUnitRelayPass(sql, TENANT, broker)

    expect(res).toEqual({ ok: 0, failed: 1 })
    expect(statements.some((s) => /status\s*=\s*'failed'/i.test(s))).toBe(true)
    expect(statements.some((s) => /status\s*=\s*'ok'/i.test(s))).toBe(false)
  })
})
