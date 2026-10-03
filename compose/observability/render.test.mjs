// TASK-039 TDD 1, 2, 3, 13 (static half), 14 (static half): the ops project
// as the host renders it (`docker compose --env-file ops.env config`, every
// profile on), from the fixed env file test/host/fixtures/pooled-stack/ops.env.
// Every guard runs on the real render (must be clean) and on one broken copy
// per failure the brief names (must name it).
//
//   node --test compose/observability/render.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROJECTS, renderProject } from '../../scripts/check-pooled-stack.mjs'
import { readEnvFile } from '../../scripts/compose-edge.mjs'
import { mountViolations, networkViolations, portViolations, renderShapeViolations } from './checks.mjs'

const OPS = PROJECTS.find((p) => p.id === 'ops')
const ENV = readEnvFile(OPS.envFile)
const HOST_IPS = { OPS_BIND_IP: ENV.OPS_BIND_IP, OPS_INGEST_BIND_IP: ENV.OPS_INGEST_BIND_IP }
const REAL = renderProject(OPS)
const clone = () => JSON.parse(JSON.stringify(REAL))

test('the ops project renders from compose/observability as <STACK>-ops with its six services', () => {
  assert.match(OPS.cwd, /^compose\/observability$/)
  assert.equal(REAL.name, `${ENV.STACK}-ops`)
  assert.deepEqual(Object.keys(REAL.services).sort(), ['alloy', 'blackbox', 'grafana', 'loki', 'prometheus', 'tempo'])
})

test('TDD 1: the real render is pinned, limited, probed and hardened', () => {
  assert.deepEqual(renderShapeViolations(REAL), [])
})

test('TDD 1 RED: unpinned, unlimited, unprobed, a dropped cap_drop and zero services each fail by name', () => {
  const r1 = clone()
  r1.services.loki.image = 'grafana/loki:3.7.0'
  assert.match(renderShapeViolations(r1).join('\n'), /ops\/loki: image grafana\/loki:3\.7\.0 is not digest-pinned/)
  const r2 = clone()
  delete r2.services.tempo.deploy
  assert.match(renderShapeViolations(r2).join('\n'), /ops\/tempo: no non-zero memory limit/)
  const r3 = clone()
  r3.services.alloy.healthcheck = { disable: true }
  assert.match(renderShapeViolations(r3).join('\n'), /ops\/alloy: no probing healthcheck/)
  const r4 = clone()
  delete r4.services.grafana.healthcheck
  assert.match(renderShapeViolations(r4).join('\n'), /ops\/grafana: no probing healthcheck/)
  const r5 = clone()
  r5.services.prometheus.cap_drop = []
  assert.match(renderShapeViolations(r5).join('\n'), /ops\/prometheus: cap_drop does not include ALL/)
  assert.match(renderShapeViolations({ services: {} }).join('\n'), /renders zero services/)
  const r6 = clone()
  r6.services.loki.volumes.find((v) => v.type === 'image').source = 'busybox:1.37.0-musl'
  assert.match(renderShapeViolations(r6).join('\n'), /ops\/loki: image mount busybox:1\.37\.0-musl is not digest-pinned/)
  const r7 = clone()
  r7.services.cadvisor = { ...r7.services.blackbox }
  assert.match(renderShapeViolations(r7).join('\n'), /services \[alloy, blackbox, cadvisor/)
})

test('TDD 3: no ops service mounts /, the Docker data root, the socket or a database volume; Alloy holds exactly its read-only allow-list', () => {
  assert.deepEqual(mountViolations(REAL), [])
})

test('TDD 3 RED: a seeded rootfs, /var/lib/docker/volumes, the socket, a *-pg-data volume, pid: host and a writable /proc each fail', () => {
  const fails = (mutate, re) => {
    const r = clone()
    mutate(r)
    assert.match(mountViolations(r).join('\n'), re)
  }
  fails((r) => r.services.alloy.volumes.push({ type: 'bind', source: '/', target: '/rootfs', read_only: true }), /ops\/alloy: binds \/, which is \/ or covers the Docker data root/)
  fails((r) => r.services.grafana.volumes.push({ type: 'bind', source: '/var/lib/docker/volumes', target: '/v', read_only: true }), /ops\/grafana: binds \/var\/lib\/docker\/volumes/)
  fails((r) => r.services.loki.volumes.push({ type: 'bind', source: '/var/lib', target: '/v', read_only: true }), /ops\/loki: binds \/var\/lib/)
  fails((r) => r.services.alloy.volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }), /binds the Docker socket/)
  fails((r) => {
    r.volumes['pg'] = { name: 'guardstack-state_pg-data', external: true }
    r.services.prometheus.volumes.push({ type: 'volume', source: 'pg', target: '/pg', read_only: true })
  }, /ops\/prometheus: mounts the data volume guardstack-state_pg-data/)
  fails((r) => { r.services.alloy.pid = 'host' }, /ops\/alloy: pid: host/)
  fails((r) => { r.services.alloy.volumes.find((v) => v.target === '/host/proc').read_only = false }, /\/proc is not mounted read-only at \/host\/proc/)
  fails((r) => { r.services.alloy.volumes.find((v) => v.target === '/vector-logs').read_only = false }, /Vector's output volume is not mounted read-only/)
  fails((r) => r.services.alloy.volumes.push({ type: 'bind', source: '/srv/guardstack/etc/secrets', target: '/s', read_only: true }), /bind \/srv\/guardstack\/etc\/secrets is outside the Q16 allow-list/)
})

test('ports: Grafana alone on OPS_BIND_IP:3000 and the OTLP ingest alone on OPS_INGEST_BIND_IP:4317/4318; no store publishes', () => {
  assert.deepEqual(portViolations(REAL, HOST_IPS), [])
  for (const s of ['prometheus', 'loki', 'tempo', 'blackbox']) assert.deepEqual(REAL.services[s].ports ?? [], [], s)
})

test('ports RED: a published Prometheus, Loki or Tempo, a wildcard Grafana and an ingest on the UI address each fail', () => {
  for (const [svc, target] of [['prometheus', 9090], ['loki', 3100], ['tempo', 3200]]) {
    const r = clone()
    r.services[svc].ports = [{ host_ip: '127.0.0.1', target, published: String(target), protocol: 'tcp' }]
    assert.match(portViolations(r, HOST_IPS).join('\n'), new RegExp(`ops/${svc}: publishes 1 port\\(s\\), want 0`))
  }
  const w = clone()
  w.services.grafana.ports[0].host_ip = '0.0.0.0'
  assert.match(portViolations(w, HOST_IPS).join('\n'), /ops\/grafana: port 3000 binds a wildcard address/)
  const i = clone()
  i.services.alloy.ports[0].host_ip = '127.0.0.1'
  assert.match(portViolations(i, HOST_IPS).join('\n'), /ops\/alloy: port 4317 binds 127\.0\.0\.1, not OPS_INGEST_BIND_IP/)
  const n = clone()
  n.services.alloy.ports = []
  assert.match(portViolations(n, HOST_IPS).join('\n'), /ops\/alloy: publishes 0 port\(s\), want 2/)
})

test('TDD 2 / TDD 14 static: every ops service is on <STACK>-ops_ops only; joining _state or an external network fails', () => {
  assert.deepEqual(networkViolations(REAL, ENV.STACK), [])
  const r = clone()
  r.networks.state = { name: `${ENV.STACK}_state`, external: true }
  r.services.alloy.networks.state = null
  const v = networkViolations(r, ENV.STACK).join('\n')
  assert.match(v, /ops\/alloy: networks \[guardstack-ops_ops, guardstack_state\], want \[guardstack-ops_ops\] only/)
  assert.match(v, /network state \(guardstack_state\) is external/)
  const h = clone()
  h.services.grafana.network_mode = 'host'
  assert.match(networkViolations(h, ENV.STACK).join('\n'), /ops\/grafana: network_mode host/)
})
