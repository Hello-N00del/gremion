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

import { contactPointViolations, grafanaRuleViolations, NO_ABSENT, policyViolations, quietHoursViolations, readText, readYaml, recordingRuleViolations, seconds } from './checks.mjs'

const RULES = readYaml('compose/observability/prometheus/rules.yml')
const GRAFANA = readYaml('compose/observability/grafana/provisioning/alerting/rules.yaml')
const POLICY = readYaml('compose/observability/grafana/provisioning/alerting/policies.yaml')
const TIMES = readYaml('compose/observability/grafana/provisioning/alerting/time-intervals.yaml')
const copy = (o) => JSON.parse(JSON.stringify(o))
const recs = (doc) => doc.groups.flatMap((g) => g.rules)

test('rules.yml: sixteen gremion:cond:* conditions, each fail-closed (absent()) but the documented ones (third_party, the four TASK-079 dead-letter conditions)', () => {
  assert.equal(recs(RULES).length, 16)
  assert.deepEqual(recordingRuleViolations(RULES), [])
})

test('TASK-079: the dead-letter conditions read the gauges the library prints and the collector stamps, one component per path', () => {
  const byName = Object.fromEntries(recs(RULES).map((r) => [r.record, String(r.expr)]))
  assert.match(byName['gremion:cond:outbox_dead_lettered'], /max by \(ctx\) \(gremion_outbox_dead_lettered\) > bool 0/)
  assert.match(byName['gremion:cond:inbox_dead_lettered'], /max by \(ctx, consumer\) \(gremion_inbox_dead_lettered\) > bool 0/)
  assert.match(byName['gremion:cond:inbox_stalled'], /max by \(ctx, consumer\) \(gremion_inbox_stalled\) > bool 0/)
  assert.match(byName['gremion:cond:dead_letter_queue'], /gremion_nats_stream_messages\{stream="DLQ"\}\) > bool 0/)
  // Not fail-closed on purpose (a host without an events service has no gauge): the exemption is explicit.
  for (const n of ['outbox_dead_lettered', 'inbox_dead_lettered', 'inbox_stalled', 'dead_letter_queue']) {
    assert.ok(NO_ABSENT.has(`gremion:cond:${n}`), n)
    assert.ok(!/absent\(/.test(byName[`gremion:cond:${n}`]), `${n} must not carry an absent() arm`)
  }
  // RED: drop the exemption and the violation names the condition.
  const r = copy(RULES)
  const rec = recs(r).find((x) => x.record === 'gremion:cond:inbox_stalled')
  rec.record = 'gremion:cond:inbox_stalled_renamed'
  assert.match(recordingRuleViolations(r).join('\n'), /gremion:cond:inbox_stalled_renamed has no absent\(\) arm/)
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
    'BackupFailedOrOverdue', 'BrokerConsumerStalled', 'CertExpiresUnder20d', 'ContainerUnhealthy2m', 'DeadLetterQueueNotEmpty', 'DiskAbove70',
    'EdgePort80Down', 'InboxDeadLettered', 'InboxStalled', 'MailQueueOldest1h', 'MemoryPressure', 'OutboxDeadLettered', 'PostgresConnections80pct',
    'SignalAbsent', 'StorageComponentAbove70pct', 'ThirdPartyUnreachable',
  ])
})

test('TASK-079: each dead-letter path has its OWN Grafana rule on its OWN condition, critical, one e-mail per group (the README rule table lists them)', () => {
  const want = {
    OutboxDeadLettered: 'gremion:cond:outbox_dead_lettered',
    InboxDeadLettered: 'gremion:cond:inbox_dead_lettered',
    InboxStalled: 'gremion:cond:inbox_stalled',
    DeadLetterQueueNotEmpty: 'gremion:cond:dead_letter_queue',
  }
  const readme = readText('compose/observability/README.md')
  for (const [title, cond] of Object.entries(want)) {
    const rule = recs(GRAFANA).find((r) => r.title === title)
    assert.ok(rule, `${title}: no Grafana rule`)
    assert.equal(rule.data.find((d) => d.refId === 'A').model.expr, cond)
    assert.equal(rule.labels.severity, 'critical')
    assert.equal(rule.annotations.component, '{{ $labels.component }}')
    assert.ok(seconds(rule.for) > 0, `${title}: no pending period`)
    assert.ok(readme.includes(`| \`${title}\` |`), `${title}: not in the README rule table`)
  }
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

test('a Grafana annotation template is written plainly: alerting provisioning is not env-expanded, a $$ breaks it', () => {
  // Measured on the pinned 12.4.0 (observability-proof.sh): `{{ $$labels... }}`
  // reached the template engine literally ("Error in expanding template").
  const body = readText('compose/observability/grafana/provisioning/alerting/rules.yaml')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
  assert.ok(!/\$\$/.test(body), 'a $$ outside a comment')
  assert.equal((body.match(/\{\{ \$labels\.component \}\}/g) ?? []).length, 16)
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

// TRD-205: quiet hours. Non-CRITICAL alerts are muted outside the operator's active hours (one digest when the
// window opens); CRITICAL alerts route first, with no time interval at all, and go out immediately.

test('TRD-205: the critical route carries no mute / active interval; the non-critical route is active only in active-hours', () => {
  assert.deepEqual(quietHoursViolations(POLICY, GRAFANA, TIMES), [])
  const routes = POLICY.policies[0].routes
  const crit = routes.find((r) => JSON.stringify(r.object_matchers) === '[["severity","=","critical"]]')
  assert.ok(crit, 'no severity=critical route')
  assert.equal(crit.receiver, 'platform')
  assert.equal(crit.mute_time_intervals, undefined)
  assert.equal(crit.active_time_intervals, undefined)
  const rest = routes.find((r) => JSON.stringify(r.object_matchers) === '[["severity","!=","critical"]]')
  assert.ok(rest, 'no severity!=critical route')
  assert.deepEqual(rest.active_time_intervals, ['active-hours'])
  assert.equal(rest.mute_time_intervals, undefined)
  // the critical route is listed first: Grafana takes the first matching route
  assert.equal(routes.indexOf(crit), 0)
  // the root (default route) is never time-limited, so an unlabelled alert is not silently lost
  assert.equal(POLICY.policies[0].active_time_intervals, undefined)
  assert.equal(POLICY.policies[0].mute_time_intervals, undefined)
})

test('TRD-205: the non-critical route groups into ONE digest and flushes when the window opens', () => {
  const rest = POLICY.policies[0].routes[1]
  assert.deepEqual(rest.group_by, ['severity'])
  assert.ok(seconds(rest.group_interval) > 0 && seconds(rest.group_interval) <= 300)
})

test('TRD-205 RED: a mute on the critical route, a missing non-critical route, an undefined interval, a missing default route each fail', () => {
  const a = copy(POLICY)
  a.policies[0].routes[0].mute_time_intervals = ['active-hours']
  assert.match(quietHoursViolations(a, GRAFANA, TIMES).join('\n'), /critical route .* time interval/)
  const b = copy(POLICY)
  b.policies[0].routes.pop()
  assert.match(quietHoursViolations(b, GRAFANA, TIMES).join('\n'), /no severity!=critical route/)
  const c = copy(TIMES)
  c.muteTimes[0].name = 'other'
  assert.match(quietHoursViolations(POLICY, GRAFANA, c).join('\n'), /active-hours is not defined/)
  const d = copy(POLICY)
  d.policies[0].receiver = ''
  assert.match(quietHoursViolations(d, GRAFANA, TIMES).join('\n'), /no default receiver/)
})

test('TRD-205: every Grafana rule carries severity critical or warning, so the routing is total', () => {
  for (const r of recs(GRAFANA)) assert.match(String(r.labels?.severity), /^(critical|warning)$/, `${r.title}: severity label`)
  const g = copy(GRAFANA)
  delete recs(g)[0].labels.severity
  assert.match(quietHoursViolations(POLICY, g, TIMES).join('\n'), /has no severity label/)
})

test('TRD-205: the committed default interval is the documented one and ops.env.tmpl names the operator keys', () => {
  const t = TIMES.muteTimes[0].time_intervals[0]
  assert.equal(t.location, 'Europe/Berlin')
  assert.deepEqual(t.weekdays, ['monday:friday'])
  assert.deepEqual(t.times, [{ start_time: '08:00', end_time: '20:00' }])
  const tmpl = readText('infra/host/templates/env/ops.env.tmpl')
  for (const k of ['OPS_ACTIVE_HOURS_TZ=Europe/Berlin', 'OPS_ACTIVE_HOURS_START=08:00', 'OPS_ACTIVE_HOURS_END=20:00', 'OPS_ACTIVE_HOURS_WEEKDAYS=monday:friday']) {
    assert.ok(tmpl.split('\n').includes(k), k)
  }
})
