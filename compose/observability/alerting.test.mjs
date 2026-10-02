// TASK-039 TDD 4 (static half) and TDD 6: the alert conditions, the Grafana
// rules that fire on them, the notification policy and the contact point's
// resolve notice (TRD-181, TRD-182, FLOW-OPS-009). The promtool half (healthy
// world silent, blind world fires every rule, the backup / TRD-224 / broker
// scenarios) is prometheus/rules.test.yml, run by
// test/host/integration/ops-check-configs.sh.
//
//   node --test compose/observability/alerting.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contactPointViolations, grafanaRuleViolations, policyViolations, readText, readYaml, recordingRuleViolations, seconds } from './checks.mjs'

const RULES = readYaml('compose/observability/prometheus/rules.yml')
const GRAFANA = readYaml('compose/observability/grafana/provisioning/alerting/rules.yaml')
const POLICY = readYaml('compose/observability/grafana/provisioning/alerting/policies.yaml')
const copy = (o) => JSON.parse(JSON.stringify(o))
const recs = (doc) => doc.groups.flatMap((g) => g.rules)

test('rules.yml: twelve gremion:cond:* conditions, each fail-closed (absent()) but the documented third_party one', () => {
  assert.equal(recs(RULES).length, 12)
  assert.deepEqual(recordingRuleViolations(RULES), [])
})

test('TDD 4 RED: a condition whose absent() arm is dropped, an alerting rule in Prometheus, zero rules each fail', () => {
  const r = copy(RULES)
  const backup = recs(r).find((x) => x.record === 'gremion:cond:backup_failed')
  backup.expr = backup.expr.split('\n').filter((l) => !/absent\(/.test(l)).join('\n')
  assert.match(recordingRuleViolations(r).join('\n'), /gremion:cond:backup_failed has no absent\(\) arm/)
  const a = copy(RULES)
  a.groups[0].rules.push({ alert: 'DiskAbove70', expr: 'vector(1)' })
  assert.match(recordingRuleViolations(a).join('\n'), /DiskAbove70: not a gremion:cond:\* recording rule/)
  assert.match(recordingRuleViolations({ groups: [] }).join('\n'), /zero recording rules/)
})

test('Grafana: one rule per condition, threshold > 0 on the prometheus datasource, no data and errors alert', () => {
  assert.deepEqual(grafanaRuleViolations(GRAFANA, RULES), [])
  const titles = recs(GRAFANA).map((r) => r.title).sort()
  assert.deepEqual(titles, [
    'BackupFailedOrOverdue', 'BrokerConsumerStalled', 'CertExpiresUnder20d', 'ContainerUnhealthy2m', 'DiskAbove70', 'EdgePort80Down',
    'MailQueueOldest1h', 'MemoryPressure', 'PostgresConnections80pct', 'SignalAbsent', 'StorageComponentAbove70pct', 'ThirdPartyUnreachable',
  ])
})

test('Grafana RED: a rule on no condition, a condition with no rule, NoData=OK, a threshold other than > 0 each fail', () => {
  const g1 = copy(GRAFANA)
  recs(g1)[0].data[0].model.expr = 'up'
  const v1 = grafanaRuleViolations(g1, RULES).join('\n')
  assert.match(v1, /DiskAbove70: query A \(up\) is not one recording rule/)
  assert.match(v1, /gremion:cond:disk_above_70 has no Grafana rule/)
  const g2 = copy(GRAFANA)
  recs(g2)[1].noDataState = 'OK'
  assert.match(grafanaRuleViolations(g2, RULES).join('\n'), /MemoryPressure: noDataState is OK, want Alerting/)
  const g3 = copy(GRAFANA)
  recs(g3)[2].data[1].model.conditions[0].evaluator.params = [1]
  assert.match(grafanaRuleViolations(g3, RULES).join('\n'), /ContainerUnhealthy2m: the condition is not threshold\(A\) > 0/)
  const g4 = copy(GRAFANA)
  recs(g4)[3].execErrState = 'OK'
  assert.match(grafanaRuleViolations(g4, RULES).join('\n'), /execErrState is OK/)
})

test('a Grafana annotation template is $$-escaped (Grafana expands $VAR in provisioning files)', () => {
  const text = readText('compose/observability/grafana/provisioning/alerting/rules.yaml')
  assert.ok(!/\{\{[^}]*[^$]\$labels/.test(text), 'an unescaped $labels would be expanded to an empty string')
  assert.match(text, /\{\{ \$\$labels\.component \}\}/)
})

test('TDD 6: the policy groups by [alertname, component], waits 30s, re-groups at 5m, never repeats an open condition (8760h)', () => {
  assert.deepEqual(policyViolations(POLICY), [])
  const p = POLICY.policies[0]
  assert.equal(seconds(p.group_wait), 30)
  assert.equal(seconds(p.group_interval), 300)
  assert.equal(seconds(p.repeat_interval), 8760 * 3600)
})

test('TDD 6 RED: the old repeat_interval 4h, a group_by without alertname, another receiver each fail', () => {
  const p1 = copy(POLICY)
  p1.policies[0].repeat_interval = '4h'
  assert.match(policyViolations(p1).join('\n'), /repeat_interval 4h is under 8760h/)
  const p2 = copy(POLICY)
  p2.policies[0].group_by = ['component']
  assert.match(policyViolations(p2).join('\n'), /lacks alertname/)
  const p3 = copy(POLICY)
  p3.policies[0].receiver = 'grafana-default-email'
  assert.match(policyViolations(p3).join('\n'), /receiver grafana-default-email, want platform/)
})

test('TDD 6: the rendered contact point sends resolve notices; RED with resolve off or no integration', () => {
  const good = { contactPoints: [{ name: 'platform', receivers: [{ uid: 'platform-email', type: 'email', disableResolveMessage: false }] }] }
  assert.deepEqual(contactPointViolations(good), [])
  const off = copy(good)
  off.contactPoints[0].receivers[0].disableResolveMessage = true
  assert.match(contactPointViolations(off).join('\n'), /resolve notices are off/)
  assert.match(contactPointViolations({ contactPoints: [{ name: 'platform', receivers: [] }] }).join('\n'), /no integration/)
  assert.match(contactPointViolations({ contactPoints: [] }).join('\n'), /no platform contact point/)
  // render-ops.sh writes disableResolveMessage: false for every integration
  // and never true (the behaviour itself is test/host/ops.bats').
  const render = readText('infra/host/ops/render-ops.sh')
  assert.equal((render.match(/disableResolveMessage: false/g) ?? []).length, 2)
  assert.ok(!/disableResolveMessage: true/.test(render))
})
