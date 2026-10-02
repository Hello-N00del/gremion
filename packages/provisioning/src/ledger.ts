// packages/provisioning/src/ledger.ts — the provisioning ledger port.
//
// plt.provisioning_step is APPEND-ONLY (its trigger refuses UPDATE): one row
// per step outcome, `pending` when the customer's run opens, then `done` or
// `failed`. A kind is done at most once per customer: the partial unique index
// provisioning_step_customer_id_step_kind_key answers a second `done` with
// 23505, which the machine treats as "a concurrent run already finished it".
//
// Two implementations: pgLedger (gremion_platform, the real one) and
// memoryLedger (the unit suite's, which raises the same 23505 shape).
import type { Sql } from '@gremion/db'
import { assertUuid } from './errors.ts'
import { isStepKind, type StepKind, type StepStatus } from './steps.ts'

export interface StepRow {
  kind: StepKind
  status: StepStatus
  operatorId: string | null
  occurredAt: Date
}

export interface LedgerPort {
  /** Every row of the customer, oldest first. */
  rows(customerId: string): Promise<StepRow[]>
  /** Appends one row. A second `done` of a kind rejects with SQLSTATE 23505. */
  append(customerId: string, kind: StepKind, status: StepStatus, operatorId: string | null): Promise<void>
}

export const DONE_KEY = 'provisioning_step_customer_id_step_kind_key'

/** True for the unique violation a second `done` of one kind raises. */
export function isDuplicateDone(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown } | null
  return e?.code === '23505' && (e.constraint_name === DONE_KEY || e.constraint === DONE_KEY)
}

export function doneKinds(rows: readonly StepRow[]): Set<StepKind> {
  return new Set(rows.filter((r) => r.status === 'done').map((r) => r.kind))
}

/** The latest status of each kind (a `failed` after a `pending` reads failed). */
export function latestStatus(rows: readonly StepRow[]): Map<StepKind, StepStatus> {
  const out = new Map<StepKind, StepStatus>()
  for (const r of rows) {
    if (out.get(r.kind) === 'done') continue
    out.set(r.kind, r.status)
  }
  return out
}

export function memoryLedger(): LedgerPort & { all(): Map<string, StepRow[]> } {
  const byCustomer = new Map<string, StepRow[]>()
  let tick = 0
  return {
    all: () => byCustomer,
    async rows(customerId) {
      return [...(byCustomer.get(customerId) ?? [])]
    },
    async append(customerId, kind, status, operatorId) {
      if (!isStepKind(kind)) throw Object.assign(new Error(`unknown kind ${String(kind)}`), { code: '23514' })
      const list = byCustomer.get(customerId) ?? []
      if (status === 'done' && list.some((r) => r.kind === kind && r.status === 'done')) {
        throw Object.assign(new Error(`duplicate key value violates unique constraint "${DONE_KEY}"`), { code: '23505', constraint_name: DONE_KEY })
      }
      list.push({ kind, status, operatorId, occurredAt: new Date(Date.UTC(2026, 0, 1) + tick++) })
      byCustomer.set(customerId, list)
    },
  }
}

/** The real ledger on gremion_platform (asserted by the caller: assertPlatform). */
export function pgLedger(platform: Sql): LedgerPort {
  return {
    async rows(customerId) {
      assertUuid(customerId, 'customer id')
      const rows = await platform<{ step_kind: string; status: StepStatus; actor_operator_id: string | null; occurred_at: Date }[]>`
        SELECT step_kind, status, actor_operator_id::text, occurred_at
          FROM plt.provisioning_step
         WHERE customer_id = ${customerId}
         ORDER BY occurred_at, provisioning_step_id`
      return rows.map((r) => {
        if (!isStepKind(r.step_kind)) throw new Error(`plt.provisioning_step holds an unknown kind ${r.step_kind}`)
        return { kind: r.step_kind, status: r.status, operatorId: r.actor_operator_id, occurredAt: r.occurred_at }
      })
    },
    async append(customerId, kind, status, operatorId) {
      assertUuid(customerId, 'customer id')
      if (operatorId !== null) assertUuid(operatorId, 'operator id')
      await platform`
        INSERT INTO plt.provisioning_step (customer_id, step_kind, status, actor_operator_id)
        VALUES (${customerId}, ${kind}, ${status}, ${operatorId})`
    },
  }
}
