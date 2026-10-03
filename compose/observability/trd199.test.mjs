// TASK-039 TDD 15: TRD-199 (static half). The ops stack exposes no
// member-facing surface: no state or app render references an ops service,
// network or port, and no member-facing source (gremion-ui, gremion-public,
// modules/*/app -- not apps/control-panel, the operator's own shell) links
// Grafana. Each guard reads something (vacuity) and is watched RED on a
// planted fixture. The live half (no route from the edge) needs the host.
//
//   node --test compose/observability/trd199.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { PROJECTS, renderProject } from '../../scripts/check-pooled-stack.mjs'
import { readEnvFile } from '../../scripts/compose-edge.mjs'
import { REPO_ROOT, memberSourceRoots, renderReferenceViolations, sourceReferenceScan } from './checks.mjs'

const STACK = readEnvFile('test/host/fixtures/pooled-stack/state.env').STACK
const COUNCIL = PROJECTS.filter((p) => p.id === 'state' || p.id.startsWith('app-')).map((p) => ({ id: p.id, render: renderProject(p) }))
const FIXTURE = path.join(REPO_ROOT, 'test/host/fixtures/observability/trd199')

test('no state or app render names an ops service, the ops network or an ops store port', () => {
  assert.equal(COUNCIL.length, 3)
  for (const { id, render } of COUNCIL) assert.ok(Object.keys(render.services ?? {}).length > 0, `${id} rendered no service (vacuous)`)
  assert.deepEqual(renderReferenceViolations(COUNCIL, STACK), [])
})

test('RED: a council service pointed at the ops collector, the ops store or joined to the ops network is reported', () => {
  const planted = JSON.parse(JSON.stringify(COUNCIL))
  planted[1].render.services['gremion-ui'].environment.OTEL_URL = 'http://alloy:4318'
  planted[0].render.services.keycloak.environment.LOG_SINK = 'http://loki:3100/loki/api/v1/push'
  planted[2].render.networks.ops = { name: `${STACK}-ops_ops`, external: true }
  const v = renderReferenceViolations(planted, STACK).join('\n')
  assert.match(v, /app-blue\/gremion-ui: references the ops side \(alloy:4318\)/)
  assert.match(v, /state\/keycloak: references the ops side \(loki:3100\)/)
  assert.match(v, new RegExp(`app-green: joins the ops network ${STACK}-ops_ops`))
})

test('no member-facing source links Grafana or an ops store, and the scan read files (vacuity)', () => {
  const roots = memberSourceRoots()
  assert.ok(roots.includes('gremion-ui/src') && roots.includes('gremion-public/src'), roots.join(', '))
  assert.ok(!roots.some((r) => r.startsWith('apps/')), 'the control panel is the operator shell, not member-facing')
  const { files, hits } = sourceReferenceScan()
  assert.ok(files > 100, `scanned only ${files} files`)
  assert.deepEqual(hits, [])
})

test('RED: the planted member page linking Grafana is found', () => {
  const { files, hits } = sourceReferenceScan(FIXTURE, ['gremion-ui/src'])
  assert.equal(files, 1)
  assert.deepEqual(hits, ['gremion-ui/src/routes/admin/+page.svelte'])
})
