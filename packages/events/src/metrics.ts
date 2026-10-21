// packages/events/src/metrics.ts (@gremion/events)
//
// The three gauges the operator's alerting reads (TASK-079 Q13), as OpenMetrics
// 1.0 text of CURRENT row counts (not counters: a requeued or replayed row
// returns the gauge to 0):
//
//   gremion_outbox_dead_lettered{ctx}            relay_state = 'dead_lettered'
//   gremion_inbox_dead_lettered{ctx,consumer}    processing_state = 'dead_lettered'
//   gremion_inbox_stalled{ctx,consumer}          received|failed for longer than the delivery
//                                                horizon: a crash on the last delivery, which
//                                                leaves no dead_lettered row and no DLQ publish
//
// The host collector `docker exec`s `events metrics` in each labelled service
// container (infra/host/ops/metrics-textfile.sh, emit_events).
import type { Sql } from '@gremion/db'
import { STALLED_AFTER_MS } from './backoff.ts'
import { inTenantTx } from './db.ts'
import { assertContext } from './plumbing.ts'

export interface EventMetrics {
  ctx: string
  consumer: string
  outboxDeadLettered: number
  inboxDeadLettered: number
  inboxStalled: number
}

export interface MetricsOptions {
  ctx: string
  /** The `consumer` label (default: the context code: one inbox per service database). */
  consumer?: string
  stalledAfterMs?: number
}

export async function collectMetrics(sql: Sql, opts: MetricsOptions): Promise<EventMetrics> {
  assertContext(opts.ctx)
  const { ctx } = opts
  const horizon = (opts.stalledAfterMs ?? STALLED_AFTER_MS) / 1000
  const [row] = await inTenantTx(sql, ctx, (tx) =>
    tx.unsafe<{ o: string; d: string; s: string }[]>(
      `SELECT (SELECT count(*) FROM ${ctx}.outbox WHERE relay_state = 'dead_lettered') AS o,
              (SELECT count(*) FROM ${ctx}.inbox WHERE processing_state = 'dead_lettered') AS d,
              (SELECT count(*) FROM ${ctx}.inbox WHERE processing_state IN ('received', 'failed')
                  AND received_at < now() - make_interval(secs => $1::double precision)) AS s`,
      [horizon],
    ),
  )
  return {
    ctx,
    consumer: opts.consumer ?? ctx,
    outboxDeadLettered: Number(row!.o),
    inboxDeadLettered: Number(row!.d),
    inboxStalled: Number(row!.s),
  }
}

const label = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** OpenMetrics 1.0 exposition of one or more databases' gauges, ending in # EOF. */
export function renderMetrics(all: EventMetrics | readonly EventMetrics[]): string {
  const list = Array.isArray(all) ? all : [all as EventMetrics]
  const out: string[] = []
  const family = (name: string, help: string, line: (m: EventMetrics) => string) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
    for (const m of list) out.push(line(m))
  }
  family('gremion_outbox_dead_lettered', 'Outbox rows the relay gave up on (relay_state dead_lettered).', (m) => `gremion_outbox_dead_lettered{ctx="${label(m.ctx)}"} ${m.outboxDeadLettered}`)
  family(
    'gremion_inbox_dead_lettered',
    'Inbox rows whose message reached MaxDeliver and went to the dead-letter stream.',
    (m) => `gremion_inbox_dead_lettered{ctx="${label(m.ctx)}",consumer="${label(m.consumer)}"} ${m.inboxDeadLettered}`,
  )
  family(
    'gremion_inbox_stalled',
    'Inbox rows received or failed for longer than the delivery horizon (a crash on the last delivery).',
    (m) => `gremion_inbox_stalled{ctx="${label(m.ctx)}",consumer="${label(m.consumer)}"} ${m.inboxStalled}`,
  )
  out.push('# EOF')
  return `${out.join('\n')}\n`
}
