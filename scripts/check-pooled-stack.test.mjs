#!/usr/bin/env node
// node --test suite for the pooled-stack guard (TASK-040).
//
//   node --test --test-reporter=tap scripts/check-pooled-stack.test.mjs
//
// Every rule is exercised against a synthetic render that is GOOD (must be
// clean) and one broken copy per failure the brief names (must produce the
// named problem) -- a guard that cannot be shown failing is not a guard. The
// last tests run the whole guard over the REAL renders of the repository
// (docker compose config, every profile on), which is the post-condition.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bindRefusesMissingHostDir } from './compose-edge.mjs'
import {
  PLACEMENT,
  LEAF_PROFILES,
  SERVICE_POSTGRES_IDS,
  portBindViolations,
  leafViolations,
  tenantMountsExposeGovernance,
  limitsViolations,
  statePurityViolations,
  appShapeViolations,
  colourSuffixViolations,
  isolationViolations,
  globalNameViolations,
  resolveNet,
  runAll,
  renderProject,
  PROJECTS,
  EVICT_IMPLEMENTERS,
} from './check-pooled-stack.mjs'

const STACK = 'teststack'
const lim = (memory = '268435456', cpus = 0.25) => ({ resources: { limits: { memory, cpus } } })

// ── synthetic renders shaped like `docker compose config --format json` ────

function netsFor(id, logicals) {
  const out = {}
  for (const l of logicals) out[l] = { name: resolveNet(l, STACK, id), ...(['state', 'edge'].includes(l) ? { external: true } : {}) }
  return out
}

function stateRender() {
  const services = {}
  for (const [name, row] of Object.entries(PLACEMENT.state)) {
    const svc = { image: name === 'vector' || name === 'legal' || name === 'fallback' ? `ghcr.io/hello-n00del/gremion-${name}:dist-v0.0.0` : `${name}:1`, deploy: lim() }
    if (row.networks[0] === 'none') svc.network_mode = 'none'
    else svc.networks = Object.fromEntries(row.networks.map((n) => [n, null]))
    if (name === 'mailpit') svc.profiles = ['dev']
    if (['keycloak', 'legal', 'fallback'].includes(name)) svc.labels = { 'traefik.enable': 'true', 'traefik.docker.network': `${STACK}_edge` }
    services[name] = svc
  }
  return { name: `${STACK}-state`, services, networks: netsFor('state', ['state', 'edge', 'socket']), volumes: { 'pg-data': { name: `${STACK}-state_pg-data` } } }
}

function appRender(colour) {
  const id = `app-${colour}`
  const services = {}
  for (const [name, row] of Object.entries(PLACEMENT.app)) {
    const svc = {
      image: `ghcr.io/hello-n00del/gremion-${name === 'tenant-create' ? 'migrate' : name === 'kernel-api-migrate' ? 'kernel-api' : name.replace('gremion-', '')}:dist-v0.0.0`,
      deploy: lim(),
      labels: { 'traefik.enable': 'false' },
      environment: { COLOUR: colour },
      networks: Object.fromEntries(row.networks.map((n) => [n, ['edge', 'state'].includes(n) ? { aliases: [`${name}-${colour}`] } : null])),
    }
    if (name === 'control-panel' || name === 'gremion-ui') svc.labels['gremion.evict'] = 'true'
    if (name === 'migrate' || name === 'tenant-create' || name === 'kernel-api-migrate') {
      svc.profiles = [name]
      svc.restart = 'no'
    }
    if (name in LEAF_PROFILES) {
      svc.profiles = [LEAF_PROFILES[name]]
      svc.labels['org.gremion.stack'] = STACK
      svc.environment.PORT = '8080'
      svc.networks = Object.fromEntries(row.networks.map((n) => [n, { aliases: [`${name}-${colour}`] }]))
    }
    services[name] = svc
  }
  const ui = services['gremion-ui'].environment
  for (const leaf of Object.keys(LEAF_PROFILES)) ui[`${leaf.replace(/-service$/, '').toUpperCase()}_SERVICE_URL`] = `http://${leaf}-${colour}:8080`
  services['gremion-ui'].environment.INTERNAL_BASE_URL = `http://gremion-ui-${colour}:3000`
  services['gremion-ui'].environment.DATABASE_URL = `postgresql://u:p@pgbouncer-${STACK}:6432/gremion`
  services['gremion-ui'].volumes = [{ type: 'volume', source: 'config-data', target: '/app/config' }]
  return {
    name: `${STACK}-${id}`,
    services,
    networks: netsFor(id, ['app', 'edge', 'state']),
    volumes: { 'config-data': { name: `${STACK}_config_data`, external: true } },
  }
}

function opsRender() {
  const services = Object.fromEntries(Object.keys(PLACEMENT.ops).map((n) => [n, { image: `prom/${n}:1`, deploy: lim(), networks: { ops: null } }]))
  return { name: `${STACK}-ops`, services, networks: netsFor('ops', ['ops']) }
}
function mailRender() {
  return { name: `${STACK}-mail`, services: { stalwart: { image: 'stalwart:1', deploy: lim(), networks: { mail: null } } }, networks: netsFor('mail', ['mail']) }
}
const allRenders = () => [
  { id: 'state', render: stateRender() },
  { id: 'app-blue', render: appRender('blue') },
  { id: 'app-green', render: appRender('green') },
  { id: 'ops', render: opsRender() },
  { id: 'mail', render: mailRender() },
]

// ── the synthetic good set is clean under every rule ───────────────────────

test('the synthetic good renders are clean under every rule (the RED cases below differ by one mutation)', () => {
  for (const { id, render } of allRenders()) assert.deepEqual(limitsViolations(render, id), [], id)
  assert.deepEqual(statePurityViolations(stateRender()), [])
  for (const c of ['blue', 'green']) {
    assert.deepEqual(appShapeViolations(appRender(c), c, STACK), [], c)
    assert.deepEqual(colourSuffixViolations(appRender(c), c), [], c)
    assert.deepEqual(leafViolations(appRender(c), c, STACK), [], c)
  }
  for (const { id, render } of allRenders()) assert.deepEqual(portBindViolations(render, id), [], id)
  assert.deepEqual(isolationViolations(allRenders(), STACK), [])
})

// ── 1. limits (TRD-177) ────────────────────────────────────────────────────

test('TASK-084-a: governance-postgres is a council-store on the state network only', () => {
  // The pilot adds nextcloud-postgres: a SERVICE server (label service:nextcloud), never a module's.
  assert.deepEqual([...SERVICE_POSTGRES_IDS], ['governance', 'nextcloud'])
  assert.deepEqual(PLACEMENT.state['governance-postgres'], { class: 'council-store', networks: ['state'] })
  assert.deepEqual(PLACEMENT.state['nextcloud-postgres'], { class: 'council-store', networks: ['state'] })
  assert.equal(PLACEMENT.app['governance-postgres'], undefined)
})

test('pilot services: the placement rows are the contract (networks per service), and a module leaf is app-tier only', () => {
  assert.deepEqual(PLACEMENT.state.nextcloud.networks, ['state'])
  assert.deepEqual(PLACEMENT.state['nextcloud-redis'].networks, ['state'])
  assert.deepEqual(PLACEMENT.state.collabora.networks, ['edge', 'state'])
  assert.deepEqual(PLACEMENT.state.livekit.networks, ['edge'])
  assert.deepEqual(PLACEMENT.state['element-call'].networks, ['state'])
  assert.deepEqual(PLACEMENT.state.matrix.networks, ['edge', 'state'])
  assert.deepEqual(Object.keys(LEAF_PROFILES).sort(), ['calendar-service', 'content-service', 'newsletter-service'])
  for (const leaf of Object.keys(LEAF_PROFILES)) {
    assert.deepEqual(PLACEMENT.app[leaf], { class: 'council-app', networks: ['app', 'state'] }, leaf)
    assert.equal(PLACEMENT.state[leaf], undefined, leaf)
  }
})

test('publishes: a port with no host address (or a wildcard, in any spelling) is refused, an edge-address publish is clean', () => {
  const r = stateRender()
  r.services.livekit.ports = [
    { mode: 'ingress', host_ip: '203.0.113.10', target: 7881, published: '7881', protocol: 'tcp' },
    { mode: 'ingress', host_ip: '2001:db8::10', target: 45000, published: '45000-45100', protocol: 'udp' },
  ]
  assert.deepEqual(portBindViolations(r, 'state'), [])
  for (const bad of [undefined, '', '0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0']) {
    const w = structuredClone(r)
    w.services.livekit.ports = [{ mode: 'ingress', ...(bad === undefined ? {} : { host_ip: bad }), target: 7881, published: '7881', protocol: 'tcp' }]
    const v = portBindViolations(w, 'state')
    assert.equal(v.length, 1, `${JSON.stringify(bad)}: ${v.join(' | ')}`)
    assert.match(v[0], /state\/livekit: publishes 7881->7881\/tcp with no host address/)
  }
})

test('leaves: each way a leaf stops being internal-only, or its URL stops resolving, is named', () => {
  const cases = [
    [(r) => delete r.services['calendar-service'], /leaf calendar-service is absent/],
    [(r) => (r.services['content-service'].networks.edge = null), /content-service: networks .*, want/],
    [(r) => (r.services['newsletter-service'].ports = [{ target: 8080, published: '8080' }]), /newsletter-service: publishes a port/],
    [(r) => delete r.services['calendar-service'].labels['org.gremion.stack'], /calendar-service: no org\.gremion\.stack label/],
    [(r) => (r.services['content-service'].environment.PORT = '3000'), /content-service: environment\.PORT is "3000"/],
    [(r) => (r.services['newsletter-service'].networks.state = null), /newsletter-service: no newsletter-service-blue alias on teststack_state/],
    [(r) => (r.services['gremion-ui'].environment.CALENDAR_SERVICE_URL = 'http://calendar-service:8080'), /CALENDAR_SERVICE_URL http:\/\/calendar-service:8080 does not name calendar-service-blue:8080/],
    [(r) => (r.services['gremion-ui'].environment.CONTENT_SERVICE_URL = 'http://content-service-blue:3000'), /CONTENT_SERVICE_URL .* does not name content-service-blue:8080/],
    [(r) => delete r.services['gremion-ui'].environment.NEWSLETTER_SERVICE_URL, /NEWSLETTER_SERVICE_URL is "", not a URL/],
    [(r) => (r.services['gremion-ui'].environment.CALENDAR_SERVICE_URL = 'http://calendar-service-green:8080'), /does not name calendar-service-blue:8080/],
  ]
  for (const [mutate, want] of cases) {
    const r = appRender('blue')
    mutate(r)
    const v = leafViolations(r, 'blue', STACK)
    assert.ok(v.some((x) => want.test(x)), `${want.source}: not caught; got ${JSON.stringify(v)}`)
  }
})

test('leaves: a long-running leaf is profile-gated by exactly its own profile; any other long-running service is not', () => {
  const r = appRender('blue')
  assert.deepEqual(appShapeViolations(r, 'blue', STACK), [])
  r.services['calendar-service'].profiles = ['content']
  assert.match(appShapeViolations(r, 'blue', STACK).join('\n'), /calendar-service: leaf not gated under profiles: \[calendar\] \(has \[content\]\)/)
  r.services['calendar-service'].profiles = []
  assert.match(appShapeViolations(r, 'blue', STACK).join('\n'), /calendar-service: leaf not gated under profiles: \[calendar\]/)
  const w = appRender('blue')
  w.services['gremion-ui'].profiles = ['x']
  assert.match(appShapeViolations(w, 'blue', STACK).join('\n'), /gremion-ui: long-running service is profile-gated/)
})

test('limits: a service without limits fails, by name, for memory and cpus', () => {
  const r = stateRender()
  delete r.services.keycloak.deploy
  const v = limitsViolations(r, 'state')
  assert.equal(v.length, 2, v.join('\n'))
  assert.match(v[0], /state\/keycloak: no non-zero deploy\.resources\.limits\.memory/)
  assert.match(v[1], /state\/keycloak: no non-zero deploy\.resources\.limits\.cpus/)
})

test('limits: cpus "0" and memory "0" are not limits', () => {
  const r = stateRender()
  r.services.postgres.deploy = lim('0', '0')
  const v = limitsViolations(r, 'state')
  assert.equal(v.length, 2, v.join('\n'))
  r.services.postgres.deploy = lim('268435456', 0)
  assert.match(limitsViolations(r, 'state').join('\n'), /postgres: no non-zero deploy\.resources\.limits\.cpus \(got 0\)/)
})

test('limits: a render with zero services fails instead of passing vacuously', () => {
  assert.match(limitsViolations({ services: {} }, 'state').join('\n'), /renders zero services/)
  assert.match(limitsViolations({}, 'x').join('\n'), /renders zero services/)
})

test('limits: an unlimited profile-gated calendar-postgres fails', () => {
  const r = stateRender()
  r.services['calendar-postgres'].profiles = ['calendar']
  delete r.services['calendar-postgres'].deploy.resources.limits
  assert.match(limitsViolations(r, 'state').join('\n'), /state\/calendar-postgres: no non-zero deploy\.resources\.limits\.memory/)
})

test('limits: an ops or mail service without limits fails', () => {
  const o = opsRender()
  delete o.services.loki.deploy
  assert.match(limitsViolations(o, 'ops').join('\n'), /ops\/loki: no non-zero/)
  const m = mailRender()
  m.services.stalwart.deploy = { resources: { limits: { memory: '536870912' } } }
  assert.match(limitsViolations(m, 'mail').join('\n'), /mail\/stalwart: no non-zero deploy\.resources\.limits\.cpus/)
})

// ── 2. state purity ────────────────────────────────────────────────────────

test('state purity: gremion-ui in the state render fails', () => {
  const r = stateRender()
  r.services['gremion-ui'] = { image: 'ghcr.io/hello-n00del/gremion-ui:x', deploy: lim() }
  assert.match(statePurityViolations(r).join('\n'), /carries the app-tier service gremion-ui/)
})

test('state purity: a global name: gremion_x fails, on a volume or a network', () => {
  const r = stateRender()
  r.volumes['pg-data'].name = 'gremion_x'
  assert.match(statePurityViolations(r).join('\n'), /volumes\.pg-data carries the global name gremion_x/)
  const n = stateRender()
  n.networks.socket.name = 'gremion_net'
  assert.match(globalNameViolations(n, 'state').join('\n'), /networks\.socket carries the global name gremion_net/)
})

test('state purity: a first-party service with no image: fails', () => {
  const r = stateRender()
  delete r.services.legal.image
  r.services.legal.build = { context: 'docker/legal' }
  assert.match(statePurityViolations(r).join('\n'), /state\/legal: first-party service without an image: key/)
})

test('state purity: mailpit without profiles: [dev] fails', () => {
  const r = stateRender()
  delete r.services.mailpit.profiles
  assert.match(statePurityViolations(r).join('\n'), /mailpit: not gated under profiles: \[dev\]/)
})

test('state purity: cloudflared present fails', () => {
  const r = stateRender()
  r.services.cloudflared = { image: 'cloudflare/cloudflared:1', deploy: lim() }
  assert.match(statePurityViolations(r).join('\n'), /carries cloudflared/)
})

// ── 3. app shape, both colours (TRD-038) ───────────────────────────────────

// Each case is ONE test with the colour loop INSIDE it: scripts/verify/suites/unit.mjs compares node's collected count with the
// number of `test(` declarations, and a `test(` inside a loop declares 1 and collects N (judged unparseable).
// A failure names its colour through the assertion message.
test('app shape (both colours): a missing colour alias fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.services['gremion-ui'].networks.state = { aliases: ['gremion-ui'] }
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), new RegExp(`gremion-ui: no gremion-ui-${colour} alias on ${STACK}_state`), colour)
  }
})

test('app shape (both colours): traefik.enable=true fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.services['gremion-public'].labels['traefik.enable'] = 'true'
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /gremion-public: traefik\.enable is "true"/, colour)
  }
})

test('app shape (both colours): no evict label on a long-running service fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    delete r.services['control-panel'].labels['gremion.evict']
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /control-panel: long-running service without gremion\.evict=true/, colour)
  }
})

test('app shape (both colours): evict label on a service with no evict route fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.services['kernel-api'].labels['gremion.evict'] = 'true'
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /kernel-api: carries gremion\.evict=true but is not a known evict implementer/, colour)
  }
})

test('app shape (both colours): a non-external volume fails, top-level and on the service', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.volumes['config-data'] = { name: `${STACK}-app-${colour}_config-data` }
    const v = appShapeViolations(r, colour, STACK).join('\n')
    assert.match(v, /volume config-data is not external/, colour)
    assert.match(v, /top-level volume config-data is not external/, colour)
    const a = appRender(colour)
    a.services['gremion-public'].volumes = [{ type: 'volume', target: '/cache' }]
    assert.match(appShapeViolations(a, colour, STACK).join('\n'), /gremion-public: anonymous volume at \/cache/, colour)
  }
})

test('app shape (both colours): depends_on postgres fails (a service this project does not contain)', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.services['gremion-ui'].depends_on = { postgres: { condition: 'service_healthy' } }
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /gremion-ui: depends_on postgres, which this project does not contain/, colour)
  }
})

test('app shape (both colours): migrate without its profile fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    delete r.services.migrate.profiles
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /migrate: one-shot not gated under profiles: \[migrate\]/, colour)
    const t = appRender(colour)
    t.services['tenant-create'].restart = 'unless-stopped'
    assert.match(appShapeViolations(t, colour, STACK).join('\n'), /tenant-create: one-shot restart is "unless-stopped"/, colour)
  }
})

test('app shape (both colours): a wrong or missing COLOUR fails', () => {
  for (const colour of ['blue', 'green']) {
    const r = appRender(colour)
    r.services['gremion-ui'].environment.COLOUR = colour === 'blue' ? 'green' : 'blue'
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), new RegExp(`gremion-ui: environment\\.COLOUR is "(green|blue)", want ${colour}`), colour)
  }
})

test('app shape: a docker-provider router label on the app tier fails', () => {
  const r = appRender('blue')
  r.services['gremion-ui'].labels['traefik.http.routers.x.rule'] = 'Host(`a`)'
  assert.match(appShapeViolations(r, 'blue', STACK).join('\n'), /carries docker-provider labels traefik\.http\.routers\.x\.rule/)
})

// ── 4. colour suffix ───────────────────────────────────────────────────────

test('colour suffix: KERNEL_BASE_URL=http://gremion-ui:3000 fails; the suffixed value and state hosts pass', () => {
  const r = appRender('blue')
  r.services['gremion-ui'].environment.KERNEL_BASE_URL = 'http://gremion-ui:3000'
  const v = colourSuffixViolations(r, 'blue')
  assert.equal(v.length, 1, v.join('\n'))
  assert.match(v[0], /environment\.KERNEL_BASE_URL names gremion-ui without the -blue suffix/)
  // the other colour's suffix is as wrong as none
  r.services['gremion-ui'].environment.KERNEL_BASE_URL = 'http://gremion-ui-green:3000'
  assert.equal(colourSuffixViolations(r, 'blue').length, 1)
  r.services['gremion-ui'].environment.KERNEL_BASE_URL = 'http://content-service:8080'
  assert.match(colourSuffixViolations(r, 'blue').join('\n'), /names content-service without the -blue suffix/)
  r.services['gremion-ui'].environment.KERNEL_BASE_URL = 'http://gremion-ui-blue:3000'
  assert.deepEqual(colourSuffixViolations(r, 'blue'), [])
})

test('colour suffix: only HOST tokens count -- a client id passes, a bare *_HOST value and a user@host fail', () => {
  const r = appRender('blue')
  r.services['gremion-ui'].environment.AUTH_KEYCLOAK_ID = 'gremion-ui'
  assert.deepEqual(colourSuffixViolations(r, 'blue'), [], 'the OIDC client id is a name, not a host')
  r.services['gremion-ui'].environment.SMTP_HOST = 'gremion-ui'
  assert.match(colourSuffixViolations(r, 'blue').join('\n'), /environment\.SMTP_HOST names gremion-ui without the -blue suffix/)
  delete r.services['gremion-ui'].environment.SMTP_HOST
  r.services['gremion-ui'].environment.PUSH_URL = 'amqp://u:p@gremion-ui:5672'
  assert.match(colourSuffixViolations(r, 'blue').join('\n'), /environment\.PUSH_URL names gremion-ui/)
})

// ── 5. static isolation (TRD-045) ──────────────────────────────────────────

test('isolation: a non-council service on ${STACK}_state fails, both as a placement drift and as shared membership', () => {
  const rs = allRenders()
  const ops = rs.find((x) => x.id === 'ops').render
  ops.services.prometheus.networks.state = null
  ops.networks.state = { name: `${STACK}_state`, external: true }
  const v = isolationViolations(rs, STACK).join('\n')
  assert.match(v, /ops\/prometheus: networks \[teststack-ops_ops, teststack_state\], placement table says \[teststack-ops_ops\]/)
  assert.match(v, /ops\/prometheus: non-council service shares \[[^\]]*teststack_state\] with a service on teststack_state/)
  // ...and prometheus now ALSO puts the ops network next to a state-network
  // member, so every ops peer is reported, not only the moved service.
  assert.match(v, /ops\/grafana: non-council service shares \[teststack-ops_ops\]/)
})

test('isolation: stalwart on ${STACK}_edge fails (keycloak, which is on _state, is on _edge too)', () => {
  const rs = allRenders()
  const mail = rs.find((x) => x.id === 'mail').render
  mail.services.stalwart.networks.edge = null
  mail.networks.edge = { name: `${STACK}_edge`, external: true }
  assert.match(isolationViolations(rs, STACK).join('\n'), /mail\/stalwart: non-council service shares \[teststack_edge\]/)
})

test('isolation: vector on any network fails', () => {
  const rs = allRenders()
  const st = rs[0].render
  delete st.services.vector.network_mode
  st.services.vector.networks = { state: null }
  assert.match(isolationViolations(rs, STACK).join('\n'), /state\/vector: networks \[teststack_state\], placement table says \[none\]/)
})

test('isolation: the socket proxy on _edge or _state fails', () => {
  for (const extra of ['edge', 'state']) {
    const rs = allRenders()
    rs[0].render.services['docker-socket-proxy'].networks[extra] = null
    assert.match(isolationViolations(rs, STACK).join('\n'), /state\/docker-socket-proxy: networks \[.*teststack_(edge|state).*\], placement table says \[teststack-state_socket\]/)
  }
})

// Measured on the scratch proof (Docker 29, Docker Desktop): publishing
// postgres on 127.0.0.1 made 10.231.1.2:5432 answer pg_isready from the ops
// network; without the publish it did not. A host port on a _state service is
// a route from every other bridge network.
test('isolation: a service on ${STACK}_state that publishes a host port fails, in any project', () => {
  const rs = allRenders()
  rs[0].render.services.postgres.ports = [{ host_ip: '127.0.0.1', target: 5432, published: '5433', protocol: 'tcp' }]
  assert.match(isolationViolations(rs, STACK).join('\n'), /state\/postgres: on teststack_state and publishes host port\(s\) 127\.0\.0\.1:5433->5432/)
  const rs2 = allRenders()
  rs2[1].render.services['gremion-ui'].ports = [{ host_ip: '127.0.0.1', target: 3000, published: '3001', protocol: 'tcp' }]
  assert.match(isolationViolations(rs2, STACK).join('\n'), /app-blue\/gremion-ui: on teststack_state and publishes/)
  const rs3 = allRenders()
  rs3[0].render.services.legal.ports = [{ host_ip: '127.0.0.1', target: 8080, published: '8083', protocol: 'tcp' }]
  assert.doesNotMatch(isolationViolations(rs3, STACK).join('\n'), /publishes/, 'legal is on _edge only')
})

test('isolation: traefik on _state fails', () => {
  const rs = allRenders()
  rs[0].render.services.traefik.networks.state = null
  assert.match(isolationViolations(rs, STACK).join('\n'), /state\/traefik: networks \[teststack-state_socket, teststack_edge, teststack_state\]/)
})

test('isolation: a docker-routed service without traefik.docker.network fails', () => {
  const rs = allRenders()
  delete rs[0].render.services.keycloak.labels['traefik.docker.network']
  assert.match(isolationViolations(rs, STACK).join('\n'), /state\/keycloak: docker-routed without traefik\.docker\.network=teststack_edge/)
})

test('isolation: a service missing from the placement table fails, and so does an unclassified project', () => {
  const rs = allRenders()
  rs[3].render.services['pushgateway'] = { image: 'pushgateway:1', deploy: lim(), networks: { ops: null } }
  assert.match(isolationViolations(rs, STACK).join('\n'), /ops\/pushgateway: not in the placement table/)
  const withSales = [...allRenders(), { id: 'sales', render: { services: { web: { networks: { default: null } } }, networks: { default: { name: `${STACK}-sales_default` } } } }]
  assert.match(isolationViolations(withSales, STACK).join('\n'), /sales: a project the placement table does not classify/)
})

test('isolation: a project that renders zero services fails', () => {
  const rs = allRenders()
  rs[4].render.services = {}
  assert.match(isolationViolations(rs, STACK).join('\n'), /mail: renders zero services/)
})

// ── 6. the real renders (the post-condition) ───────────────────────────────

test('real renders: every project renders, with every profile on, and every profile-gated service is in the render', () => {
  const state = renderProject(PROJECTS[0])
  const names = Object.keys(state.services ?? {})
  for (const id of ['board', 'calendar', 'content', 'finance', 'newsletter', 'vault']) assert.ok(names.includes(`${id}-postgres`), `${id}-postgres is not in the all-profile render`)
  for (const s of ['traefik', 'docker-socket-proxy', 'pgbouncer', 'fallback', 'mailpit']) assert.ok(names.includes(s), `${s} is not in the all-profile render`)
  const blue = renderProject(PROJECTS[1])
  for (const s of ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create', 'kernel-api', 'kernel-api-migrate']) assert.ok(blue.services?.[s], `${s} is not in the all-profile app-blue render`)
})

test('real renders: the whole guard is clean over the repository, and it rendered services (not zero)', () => {
  const { problems, counts } = runAll()
  assert.deepEqual(problems, [])
  for (const id of ['state', 'app-blue', 'app-green', 'ops', 'mail']) assert.ok(counts[id] > 0, `${id} rendered ${counts[id]} services`)
})

test('real renders: the app project without its profiles lists no one-shot (up creates no migrate container)', () => {
  const blue = renderProject(PROJECTS[1], { env: { COMPOSE_PROFILES: 'production' } })
  // TASK-043 Q12: the control panel is long-running like the two apps.
  assert.deepEqual(Object.keys(blue.services ?? {}).sort(), ['control-panel', 'gremion-public', 'gremion-ui', 'kernel-api'])
})

// TASK-043 TDD 17 (Q12): the ops shell of each colour publishes no port, has no
// Traefik route, sits on app + state only, and is hardened.
test('real renders: blue and green control-panel publish no ports, carry traefik.enable=false, sit on the app and state networks only', () => {
  const byName = (a, b) => a.localeCompare(b)
  for (const { project, colour } of [
    { project: PROJECTS[1], colour: 'blue' },
    { project: PROJECTS[2], colour: 'green' },
  ]) {
    const render = renderProject(project)
    const svc = render.services?.['control-panel']
    assert.ok(svc, `control-panel is not in the ${colour} render`)
    assert.deepEqual(svc.ports ?? [], [], `${colour} control-panel publishes a port`)
    assert.equal(String(svc.labels?.['traefik.enable']), 'false')
    assert.deepEqual(
      Object.keys(svc.networks ?? {}).map((k) => render.networks?.[k]?.name ?? k).sort(byName),
      // the fixture env files' STACK (test/host/fixtures/pooled-stack)
      [`guardstack-app-${colour}_app`, 'guardstack_state'].sort(byName),
    )
    assert.equal(svc.read_only, true)
    assert.deepEqual(svc.cap_drop, ['ALL'])
    assert.match(String(svc.image), /^ghcr\.io\/hello-n00del\/gremion-control-panel:/)
  }
})

// TASK-043b F1: the one-shot read its provisioner credential from the CLI's
// default /repo/secrets/tenant_provisioner, which nothing mounted, so every verb
// died "provisioner credential file ... not found". It is wired exactly like the
// other one-shot secrets: a file under the read-only etc/secrets/tenant-create
// mount, never under the tenant data plane's /run/secrets/tenants, and that
// directory is mounted into tenant-create ONLY.
test('real renders: tenant-create reads TENANT_PROVISIONER_SECRET_FILE from its read-only etc/secrets/tenant-create mount, which no other app service mounts', () => {
  for (const { project, colour } of [
    { project: PROJECTS[1], colour: 'blue' },
    { project: PROJECTS[2], colour: 'green' },
  ]) {
    const render = renderProject(project)
    const tc = render.services?.['tenant-create']
    assert.ok(tc, `tenant-create is not in the ${colour} render`)
    const file = tc.environment?.TENANT_PROVISIONER_SECRET_FILE
    assert.equal(file, '/run/secrets/tenant-create/tenant_provisioner', `${colour}: TENANT_PROVISIONER_SECRET_FILE`)
    const isSecretsDir = (v) => v.type === 'bind' && String(v.source).replaceAll('\\', '/').endsWith('/etc/secrets/tenant-create')
    const mounts = (tc.volumes ?? []).filter((v) => v.target === '/run/secrets/tenant-create')
    assert.equal(mounts.length, 1, `${colour}: tenant-create mounts /run/secrets/tenant-create ${mounts.length} times`)
    assert.ok(isSecretsDir(mounts[0]), `${colour}: /run/secrets/tenant-create is not the etc/secrets/tenant-create bind (${JSON.stringify(mounts[0])})`)
    assert.equal(mounts[0].read_only, true, `${colour}: the etc/secrets/tenant-create mount is writable`)
    assert.ok(!file.startsWith('/run/secrets/tenants/'), `${colour}: the provisioner credential sits in the tenant data plane's directory`)
    for (const [name, svc] of Object.entries(render.services ?? {})) {
      if (name === 'tenant-create') continue
      assert.ok(!(svc.volumes ?? []).some(isSecretsDir), `${colour}: ${name} mounts etc/secrets/tenant-create`)
      assert.equal(svc.environment?.TENANT_PROVISIONER_SECRET_FILE, undefined, `${colour}: ${name} names the provisioner credential`)
    }
  }
})

// TASK-084-a: the governance admin credential and the per-customer credential
// directory reach tenant-create ONLY. The directory is a host path of its own,
// mounted read-write there; no other service mounts it, and no
// /run/secrets/tenants mount (read-only on the other containers) may be the
// directory or a parent of it.
const GOV_DIR = 'etc/secrets/governance'
const isGovDir = (v) => v.type === 'bind' && String(v.source).replaceAll('\\', '/').endsWith(`/${GOV_DIR}`)
test('real renders: tenant-create carries GOVERNANCE_PG_ADMIN_FILE and GOVERNANCE_SECRETS_DIR; the etc/secrets/governance mount is read-write on tenant-create and on NO other service', () => {
  for (const { project, colour } of [
    { project: PROJECTS[1], colour: 'blue' },
    { project: PROJECTS[2], colour: 'green' },
  ]) {
    const render = renderProject(project)
    const tc = render.services?.['tenant-create']
    assert.equal(tc.environment?.GOVERNANCE_PG_ADMIN_FILE, '/run/secrets/tenant-create/governance_pg_admin', `${colour}: GOVERNANCE_PG_ADMIN_FILE`)
    assert.equal(tc.environment?.GOVERNANCE_SECRETS_DIR, '/run/secrets/governance', `${colour}: GOVERNANCE_SECRETS_DIR`)
    const mounts = (tc.volumes ?? []).filter((v) => v.target === '/run/secrets/governance')
    assert.equal(mounts.length, 1, `${colour}: tenant-create mounts /run/secrets/governance ${mounts.length} times`)
    assert.ok(isGovDir(mounts[0]), `${colour}: not the ${GOV_DIR} bind (${JSON.stringify(mounts[0])})`)
    assert.notEqual(mounts[0].read_only, true, `${colour}: the governance credential directory must be writable by tenant-create`)
    for (const [name, svc] of Object.entries(render.services ?? {})) {
      if (name === 'tenant-create') continue
      assert.ok(!(svc.volumes ?? []).some(isGovDir), `${colour}: ${name} mounts ${GOV_DIR}`)
      assert.ok(!(svc.volumes ?? []).some((v) => v.target === '/run/secrets/governance'), `${colour}: ${name} mounts /run/secrets/governance`)
      assert.equal(svc.environment?.GOVERNANCE_SECRETS_DIR, undefined, `${colour}: ${name} names GOVERNANCE_SECRETS_DIR`)
    }
  }
})

test('real renders: no /run/secrets/tenants mount is the governance directory or a parent of it', () => {
  for (const { project, colour } of [
    { project: PROJECTS[1], colour: 'blue' },
    { project: PROJECTS[2], colour: 'green' },
  ]) {
    const render = renderProject(project)
    const gov = (render.services['tenant-create'].volumes ?? []).find((v) => v.target === '/run/secrets/governance')
    assert.deepEqual(tenantMountsExposeGovernance(render, String(gov.source)), [], `${colour}: a tenant mount exposes the governance credentials`)
  }
})

test('guard drill: TENANT_SECRETS_DIR as a parent of etc/secrets/governance is reported on every service that mounts it', () => {
  const base = renderProject(PROJECTS[1])
  const gov = String(base.services['tenant-create'].volumes.find((v) => v.target === '/run/secrets/governance').source)
  const parent = gov.slice(0, gov.lastIndexOf(`/${GOV_DIR}`)) + '/etc/secrets'
  const bad = renderProject(PROJECTS[1], { env: { TENANT_SECRETS_DIR: parent } })
  const gov2 = String(bad.services['tenant-create'].volumes.find((v) => v.target === '/run/secrets/governance').source)
  assert.deepEqual(
    tenantMountsExposeGovernance(bad, gov2).sort(),
    ['gremion-ui', 'kernel-api', 'kernel-api-migrate', 'migrate', 'tenant-create'].sort(),
  )
})

// TASK-084-a Task 10: the tenant-create environment table in
// docs/ops/pooled-stack-layout.md names every *_FILE / *_DIR variable of the
// rendered block (per-module rows are written once with <ID>). Two older
// variables are documented in docs/runbooks/tenant-lifecycle.md and are exempt.
test('docs: every *_FILE / *_DIR variable of the tenant-create block appears in the pooled-stack-layout env table', async () => {
  const { readFileSync } = await import('node:fs')
  const doc = readFileSync(new URL('../docs/ops/pooled-stack-layout.md', import.meta.url), 'utf8')
  const exempt = new Set(['TENANT_PROVISIONER_SECRET_FILE', 'TENANT_SECRETS_DIR'])
  const env = renderProject(PROJECTS[1]).services['tenant-create'].environment
  const missing = []
  for (const key of Object.keys(env).filter((k) => /_(FILE|DIR)$/.test(k) && !exempt.has(k))) {
    const documented = key.replace(/^(MODULE_(?:PG_ADMIN|APP_PASSWORD))_[A-Z]+_FILE$/, '$1_<ID>_FILE')
    if (!doc.includes(`\`${documented}\``)) missing.push(documented)
  }
  assert.deepEqual([...new Set(missing)], [], 'tenant-create variables missing from the env table of docs/ops/pooled-stack-layout.md')
})

test('tenantMountsExposeGovernance: pure path math (equal, parent, sibling, child)', () => {
  const r = (src) => ({ services: { a: { volumes: [{ type: 'bind', source: src, target: '/run/secrets/tenants' }] } } })
  const gov = '/opt/gremion/etc/secrets/governance'
  assert.deepEqual(tenantMountsExposeGovernance(r(gov), gov), ['a'])
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion/etc/secrets'), gov), ['a'])
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion'), gov), ['a'])
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion/secrets/tenants'), gov), [])
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion/etc/secrets/governance-other'), gov), [])
  // a directory whose NAME starts with two dots is a child, not a parent step
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion/etc/secrets'), '/opt/gremion/etc/secrets/..gov'), ['a'])
  assert.deepEqual(tenantMountsExposeGovernance(r('/opt/gremion/etc/secrets/governance'), '/opt/gremion/etc/secrets/..gov'), [])
})

// TASK-075: init and phase B write release_ref into every ledger row they
// apply (gremion_platform, the module databases); tenant-provision refuses to
// start without GREMION_RELEASE_REF, which must be the colour's own release.
test('real renders: tenant-create carries GREMION_RELEASE_REF = the colour\'s IMAGE_TAG (its own image tag)', () => {
  for (const { project, colour } of [
    { project: PROJECTS[1], colour: 'blue' },
    { project: PROJECTS[2], colour: 'green' },
  ]) {
    const tc = renderProject(project).services?.['tenant-create']
    assert.ok(tc, `tenant-create is not in the ${colour} render`)
    const tag = String(tc.image).split(':').at(-1)
    assert.ok(tag && tag.length > 0, `${colour}: tenant-create image ${tc.image} has no tag`)
    assert.equal(tc.environment?.GREMION_RELEASE_REF, tag, `${colour}: GREMION_RELEASE_REF`)
  }
})

// TASK-077 G7: the kernel API (tenancy + module registry). Internal only: app +
// state networks, no edge, no published port, no Traefik router; the migrate
// job shares its image and is a profile-gated one-shot that talks to postgres
// DIRECT (never the pooler).
const COLOURS = [
  { project: PROJECTS[1], colour: 'blue' },
  { project: PROJECTS[2], colour: 'green' },
]
test('real renders: kernel-api is internal (app + state, no port, no router), hardened, NOT evictable, aliased per colour on state', () => {
  const byName = (a, b) => a.localeCompare(b)
  for (const { project, colour } of COLOURS) {
    const render = renderProject(project)
    const svc = render.services?.['kernel-api']
    assert.ok(svc, `kernel-api is not in the ${colour} render`)
    assert.deepEqual(svc.ports ?? [], [], `${colour} kernel-api publishes a port`)
    assert.equal(String(svc.labels?.['traefik.enable']), 'false')
    assert.equal(svc.labels?.['gremion.evict'], undefined, `${colour}: kernel-api serves no /api/internal/evict (TASK-035's route); the label would make every switch abort on a non-204`)
    assert.deepEqual(Object.keys(svc.networks ?? {}).map((k) => render.networks?.[k]?.name ?? k).sort(byName), [`guardstack-app-${colour}_app`, 'guardstack_state'].sort(byName))
    const state = Object.entries(svc.networks).find(([k]) => (render.networks?.[k]?.name ?? k) === 'guardstack_state')[1]
    assert.ok((state?.aliases ?? []).includes(`kernel-api-${colour}`), `${colour}: no kernel-api-${colour} alias on state`)
    assert.equal(svc.read_only, true)
    assert.deepEqual(svc.cap_drop, ['ALL'])
    assert.ok((svc.security_opt ?? []).includes('no-new-privileges:true'), `${colour}: no-new-privileges`)
    assert.equal(svc.environment?.COLOUR, colour)
    assert.match(String(svc.image), /^ghcr\.io\/hello-n00del\/gremion-kernel-api:/)
    assert.equal(svc.profiles, undefined, `${colour}: kernel-api is long-running, not profile-gated`)
    assert.ok((svc.volumes ?? []).some((v) => v.target === '/run/secrets/tenants' && v.read_only === true), `${colour}: tenant secrets not mounted read-only`)
    assert.ok((svc.volumes ?? []).every((v) => v.type !== 'volume' || render.volumes?.[v.source]?.external), `${colour}: a non-external volume`)
    assert.match(String(svc.environment?.KERNEL_API_CONTROL_DB_URL), /@postgres-guardstack:5432\//, `${colour}: control URL`)
  }
})

test('real renders: kernel-api-migrate is a profile-gated one-shot on the kernel-api image, DIRECT postgres, with a 0700 dump dir and the release ref; it is not evictable', () => {
  for (const { project, colour } of COLOURS) {
    const render = renderProject(project)
    const m = render.services?.['kernel-api-migrate']
    const api = render.services?.['kernel-api']
    assert.ok(m && api, `kernel-api-migrate / kernel-api missing from the ${colour} render`)
    assert.deepEqual(m.profiles, ['kernel-api-migrate'])
    assert.equal(m.restart, 'no')
    assert.equal(m.image, api.image, `${colour}: migrate and serve share one image`)
    assert.equal(m.labels?.['gremion.evict'], undefined)
    assert.equal(String(m.labels?.['traefik.enable']), 'false')
    assert.deepEqual(m.ports ?? [], [])
    const tag = String(m.image).split(':').at(-1)
    assert.equal(m.environment?.GREMION_RELEASE_REF, tag, `${colour}: GREMION_RELEASE_REF`)
    assert.match(String(m.environment?.GREMION_KERNEL_PG_DIRECT_URL), /^postgresql?:\/\/postgres-guardstack:5432\//, `${colour}: not DIRECT postgres, or carries userinfo`)
    assert.equal(new URL(String(m.environment?.GREMION_KERNEL_PG_DIRECT_URL)).username, '', `${colour}: the direct url must be credential-less`)
    assert.equal(Object.keys(m.environment ?? {}).filter((k) => /^POSTGRES_PASSWORD$/.test(k)).length, 0, `${colour}: migrate must not hold the superuser password`)
    assert.doesNotMatch(String(m.environment?.GREMION_KERNEL_PG_DIRECT_URL), /pgbouncer|6432/)
    const dump = m.environment?.GREMION_MIGRATION_DUMP_DIR
    assert.ok(dump && dump.startsWith('/'), `${colour}: GREMION_MIGRATION_DUMP_DIR`)
    // The dump dir is DURABLE host disk bind-mounted at the SAME path the host tooling uses
    // (state.env GREMION_MIGRATION_DUMP_DIR): never a tmpfs (lost on --rm, charged to the 512M limit).
    assert.equal(dump, '/opt/gremion/migration-dumps', `${colour}: the dump path is the host's`)
    const mount = (m.volumes ?? []).find((v) => v.target === dump)
    assert.ok(mount, `${colour}: dump dir has no backing mount`)
    assert.equal(mount.type, 'bind', `${colour}: dump dir must be a host bind, not ${mount.type}`)
    assert.equal(mount.source, dump, `${colour}: host and container path must be the same`)
    assert.ok(!mount.read_only, `${colour}: the dump dir must be writable`)
    assert.ok(bindRefusesMissingHostDir(mount), `${colour}: a missing host dir must fail, not be created root-owned (rendered bind: ${JSON.stringify(mount.bind)})`)
    const tmpTargets = (m.tmpfs ?? []).map((x) => String(x).split(':')[0]).concat((m.volumes ?? []).filter((v) => v.type === 'tmpfs').map((v) => v.target))
    assert.ok(!tmpTargets.includes(dump), `${colour}: dump dir is still a tmpfs`)
    assert.equal(m.read_only, true)
    assert.deepEqual(m.cap_drop, ['ALL'])
  }
})

test('real renders: the two colours are one document modulo the colour token and the app subnet', () => {
  const norm = (r, c) =>
    JSON.stringify(r)
      .replaceAll(c, '@C@')
      .replace(/"(subnet|app-v[46]-subnet)":"[^"]+"/g, '"$1":"@S@"')
  assert.equal(norm(renderProject(PROJECTS[1]), 'blue'), norm(renderProject(PROJECTS[2]), 'green'))
})

test('real renders: every service carrying gremion.evict=true is a known evict implementer whose source exists', async () => {
  const { existsSync } = await import('node:fs')
  for (const { project, colour } of COLOURS) {
    const render = renderProject(project)
    for (const [name, svc] of Object.entries(render.services ?? {})) {
      if (String(svc.labels?.['gremion.evict']) !== 'true') continue
      assert.ok(name in EVICT_IMPLEMENTERS, `${colour}/${name} carries gremion.evict=true but no source declares its evict route`)
    }
  }
  const { readFileSync } = await import('node:fs')
  for (const [name, file] of Object.entries(EVICT_IMPLEMENTERS)) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${name}: evidence file ${file} is missing`)
    // The evidence must be the HTTP route itself, not a neighbour (a pg_notify listener or a Dockerfile
    // is not a POST /api/internal/evict that answers gremion-switch's 204).
    assert.match(file, /\/routes\/api\/internal\/evict\/\+server\.ts$/, `${name}: evidence ${file} is not the /api/internal/evict route file`)
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /export (const|async function|function) POST[: =]/, `${name}: ${file} exports no POST handler`)
  }
})
