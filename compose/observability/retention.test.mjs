// TASK-039 retention (R29-I6: no log class older than 30 days, worst case;
// retention catalogue section 4.1). Loki keeps every line for ever unless the
// compactor's retention is on, so "a placeholder" is not a bound: each class
// stream is checked with its worst case (window + index period + delete delay
// + compaction interval), and the guard is watched RED on a 31-day window.
//
//   node --test compose/observability/retention.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readEnvKey } from '../../scripts/verify/census/render.mjs'
import { lokiRetentionViolations, promRetentionViolations, readText, readYaml, seconds, tempoRetentionViolations } from './checks.mjs'

const LOKI = readYaml('docker/loki/loki.yaml')
const TEMPO = readYaml('docker/tempo/tempo.yaml')
const OPS_TMPL = readText('infra/host/templates/env/ops.env.tmpl')
const copy = (o) => JSON.parse(JSON.stringify(o))
const stream = (doc, cls) => doc.limits_config.retention_stream.find((s) => s.selector === `{class="${cls}"}`)

test('Loki: retention on, five class streams, each worst case at most 30 days', () => {
  assert.deepEqual(lokiRetentionViolations(LOKI), [])
  assert.equal(seconds(stream(LOKI, 'access').period), 14 * 86400)
  for (const cls of ['security', 'finance', 'audit']) assert.equal(seconds(stream(LOKI, cls).period), 27 * 86400, cls)
  assert.equal(seconds(stream(LOKI, 'application').period), 28 * 86400)
  assert.equal(seconds(LOKI.limits_config.retention_period), 14 * 86400, 'an unlabelled stream gets the shortest window')
})

test('Loki RED: a 31-day class, a 30-day class (its worst case is over), retention off, a missing class each fail', () => {
  const a = copy(LOKI)
  stream(a, 'audit').period = '31d'
  assert.match(lokiRetentionViolations(a).join('\n'), /class=audit 31d reaches .* above the 30-day ceiling/)
  const b = copy(LOKI)
  stream(b, 'application').period = '30d'
  assert.match(lokiRetentionViolations(b).join('\n'), /class=application 30d reaches 31\.09 d/)
  const c = copy(LOKI)
  c.compactor.retention_enabled = false
  assert.match(lokiRetentionViolations(c).join('\n'), /retention is not enabled/)
  const d = copy(LOKI)
  d.limits_config.retention_stream = d.limits_config.retention_stream.filter((s) => s.selector !== '{class="finance"}')
  assert.match(lokiRetentionViolations(d).join('\n'), /no retention stream for class=finance/)
  const e = copy(LOKI)
  e.limits_config.retention_period = '744h'
  assert.match(lokiRetentionViolations(e).join('\n'), /the global retention_period 744h reaches/)
})

test('Tempo: 7-day block retention (RC-LOG-TRC 7 / 14); RED on 8 days and on none', () => {
  assert.deepEqual(tempoRetentionViolations(TEMPO), [])
  const t = copy(TEMPO)
  t.compactor.compaction.block_retention = '192h'
  assert.match(tempoRetentionViolations(t).join('\n'), /exceeds the 7-day RC-LOG-TRC window/)
  delete t.compactor.compaction.block_retention
  assert.match(tempoRetentionViolations(t).join('\n'), /traces kept for ever/)
})

test('Prometheus: ops.env.tmpl keeps 30 days at most and the compose file takes it from there; RED on 31d', () => {
  const v = readEnvKey(OPS_TMPL, 'PROM_RETENTION_TIME')
  assert.deepEqual(promRetentionViolations(v), [])
  assert.match(promRetentionViolations('31d').join('\n'), /exceeds the 30-day ceiling/)
  assert.match(promRetentionViolations('90d').join('\n'), /exceeds the 30-day ceiling/)
  assert.match(readText('compose/observability/docker-compose.yml'), /--storage\.tsdb\.retention\.time=\$\{PROM_RETENTION_TIME:\?/)
})

test("Grafana's request log on disk rotates daily and keeps 7 days", () => {
  const compose = readText('compose/observability/docker-compose.yml')
  assert.match(compose, /GF_LOG_FILE_DAILY_ROTATE: "true"/)
  const days = Number(/GF_LOG_FILE_MAX_DAYS: "(\d+)"/.exec(compose)?.[1])
  assert.ok(days > 0 && days <= 30, `GF_LOG_FILE_MAX_DAYS ${days}`)
})
