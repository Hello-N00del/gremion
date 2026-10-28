// packages/retention/src/loki.ts -- docker/loki/loki.yaml is RENDERED from the
// registry (TASK-033-a). `retention render` rewrites it, `render --check`
// (and loki.test.ts) fail when the committed file differs from the render.
// The header table is generated too, so the numbers in the comment cannot
// drift from the numbers below it.
import { CEILING_DAYS, enforcedDays, formatDuration, lokiClasses, lokiWorstCaseMinutes } from './registry.ts'

/** Global default for an unlabelled stream: the SHORTEST class window. */
export function lokiGlobalDays(): number {
  return Math.min(...lokiClasses().map((c) => enforcedDays(c)))
}

export function renderLokiLimits(): string {
  const lines = lokiClasses().map(
    (c) => `    - selector: '{class="${c.id}"}'\n      priority: 1\n      period: ${enforcedDays(c)}d`,
  )
  return lines.join('\n')
}

function headerTable(): string {
  const rows = lokiClasses().map((c) => {
    const e = enforcedDays(c)
    const note = e < c.regularDays ? `  [A: ${e} d so the worst case stays under the cap]` : ''
    return { c, e, note }
  })
  const out: string[] = []
  for (const { c, e } of rows) {
    const bound = c.id === 'audit' ? ', bound to SEC' : ''
    out.push(
      `#   ${c.id.padEnd(12)} ${`${e} d`.padEnd(7)} ${formatDuration(lokiWorstCaseMinutes(e)).padEnd(16)} ${c.row} (${c.regularDays} d / ${c.capDays} d${bound})`
        + (e < c.regularDays ? ' [A: ' + e + ' d so' : ''),
    )
    if (e < c.regularDays) out.push('#                                         the worst case stays under the cap]')
  }
  const g = lokiGlobalDays()
  out.push(
    `#   (unlabelled) ${`${g} d`.padEnd(7)} ${formatDuration(lokiWorstCaseMinutes(g)).padEnd(16)} the global default: a stream without a`,
    '#                                         class gets the SHORTEST window',
  )
  return out.join('\n')
}

export function renderLoki(): string {
  const g = lokiGlobalDays()
  return `# docker/loki/loki.yaml -- the ops log store (TASK-039; first writer, G4).
# RENDERED by packages/retention from its registry (TASK-033-a): edit
# packages/retention/src/registry.ts and run \`node packages/retention/bin/retention.mjs render\`,
# never this file by hand; \`render --check\` and the retention suite fail on a diff.
#
# Single binary, filesystem storage under the ops bind mount, TSDB schema v13
# with a 24 h index period. RETENTION IS ON: Loki's default keeps every line
# for ever, and the operator ceiling is ${CEILING_DAYS} days for every log class
# [D R29-I6]. Five class streams (retention catalogue section 4.1, [D R17-25]),
# each one's WORST CASE under ${CEILING_DAYS} days:
#
#   worst case = window + 24 h (index period) + retention_delete_delay (2 h)
#                + compaction_interval (10 min)
#
#   class        window  worst case       row
${headerTable()}
#
# compose/observability/retention.test.mjs reads this file and fails on any
# window whose worst case exceeds ${CEILING_DAYS} days (watched RED on 31 d).
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: ${g}d
  retention_stream:
${renderLokiLimits()}
  # A line older than a day is refused on ingest, so a replayed or
  # back-dated line cannot land in a chunk that outlives its class window.
  reject_old_samples: true
  reject_old_samples_max_age: 24h
  allow_structured_metadata: true

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 50
  delete_request_store: filesystem

ruler:
  enable_api: false

analytics:
  reporting_enabled: false
`
}
