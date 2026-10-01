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

import {
  PLACEMENT,
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
      image: `ghcr.io/hello-n00del/gremion-${name === 'tenant-create' ? 'migrate' : name.replace('gremion-', '')}:dist-v0.0.0`,
      deploy: lim(),
      labels: { 'traefik.enable': 'false' },
      environment: { COLOUR: colour },
      networks: Object.fromEntries(row.networks.map((n) => [n, ['edge', 'state'].includes(n) ? { aliases: [`${name}-${colour}`] } : null])),
    }
    if (name === 'gremion-ui' || name === 'gremion-public' || name === 'control-panel') svc.labels['gremion.evict'] = 'true'
    if (name === 'migrate' || name === 'tenant-create') {
      svc.profiles = [name]
      svc.restart = 'no'
    }
    services[name] = svc
  }
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
  }
  assert.deepEqual(isolationViolations(allRenders(), STACK), [])
})

// ── 1. limits (TRD-177) ────────────────────────────────────────────────────

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
  delete o.services.cadvisor.deploy
  assert.match(limitsViolations(o, 'ops').join('\n'), /ops\/cadvisor: no non-zero/)
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

for (const colour of ['blue', 'green']) {
  test(`app shape (${colour}): a missing colour alias fails`, () => {
    const r = appRender(colour)
    r.services['gremion-ui'].networks.state = { aliases: ['gremion-ui'] }
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), new RegExp(`gremion-ui: no gremion-ui-${colour} alias on ${STACK}_state`))
  })

  test(`app shape (${colour}): traefik.enable=true fails`, () => {
    const r = appRender(colour)
    r.services['gremion-public'].labels['traefik.enable'] = 'true'
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /gremion-public: traefik\.enable is "true"/)
  })

  test(`app shape (${colour}): no evict label on a long-running service fails`, () => {
    const r = appRender(colour)
    delete r.services['gremion-ui'].labels['gremion.evict']
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /gremion-ui: long-running service without gremion\.evict=true/)
  })

  test(`app shape (${colour}): a non-external volume fails, top-level and on the service`, () => {
    const r = appRender(colour)
    r.volumes['config-data'] = { name: `${STACK}-app-${colour}_config-data` }
    const v = appShapeViolations(r, colour, STACK).join('\n')
    assert.match(v, /volume config-data is not external/)
    assert.match(v, /top-level volume config-data is not external/)
    const a = appRender(colour)
    a.services['gremion-public'].volumes = [{ type: 'volume', target: '/cache' }]
    assert.match(appShapeViolations(a, colour, STACK).join('\n'), /gremion-public: anonymous volume at \/cache/)
  })

  test(`app shape (${colour}): depends_on postgres fails (a service this project does not contain)`, () => {
    const r = appRender(colour)
    r.services['gremion-ui'].depends_on = { postgres: { condition: 'service_healthy' } }
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /gremion-ui: depends_on postgres, which this project does not contain/)
  })

  test(`app shape (${colour}): migrate without its profile fails`, () => {
    const r = appRender(colour)
    delete r.services.migrate.profiles
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), /migrate: one-shot not gated under profiles: \[migrate\]/)
    const t = appRender(colour)
    t.services['tenant-create'].restart = 'unless-stopped'
    assert.match(appShapeViolations(t, colour, STACK).join('\n'), /tenant-create: one-shot restart is "unless-stopped"/)
  })

  test(`app shape (${colour}): a wrong or missing COLOUR fails`, () => {
    const r = appRender(colour)
    r.services['gremion-ui'].environment.COLOUR = colour === 'blue' ? 'green' : 'blue'
    assert.match(appShapeViolations(r, colour, STACK).join('\n'), new RegExp(`gremion-ui: environment\\.COLOUR is "(green|blue)", want ${colour}`))
  })
}

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
  assert.match(v, /ops\/alertmanager: non-council service shares \[teststack-ops_ops\]/)
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
  rs[3].render.services['grafana'] = { image: 'grafana:1', deploy: lim(), networks: { ops: null } }
  assert.match(isolationViolations(rs, STACK).join('\n'), /ops\/grafana: not in the placement table/)
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
  for (const s of ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create']) assert.ok(blue.services?.[s], `${s} is not in the all-profile app-blue render`)
})

test('real renders: the whole guard is clean over the repository, and it rendered services (not zero)', () => {
  const { problems, counts } = runAll()
  assert.deepEqual(problems, [])
  for (const id of ['state', 'app-blue', 'app-green', 'ops', 'mail']) assert.ok(counts[id] > 0, `${id} rendered ${counts[id]} services`)
})

test('real renders: the app project without its profiles lists no one-shot (up creates no migrate container)', () => {
  const blue = renderProject(PROJECTS[1], { env: { COMPOSE_PROFILES: 'production' } })
  // TASK-043 Q12: the control panel is long-running like the two apps.
  assert.deepEqual(Object.keys(blue.services ?? {}).sort(), ['control-panel', 'gremion-public', 'gremion-ui'])
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

test('real renders: the two colours are one document modulo the colour token and the app subnet', () => {
  const norm = (r, c) =>
    JSON.stringify(r)
      .replaceAll(c, '@C@')
      .replace(/"(subnet|app-v[46]-subnet)":"[^"]+"/g, '"$1":"@S@"')
  assert.equal(norm(renderProject(PROJECTS[1]), 'blue'), norm(renderProject(PROJECTS[2]), 'green'))
})
