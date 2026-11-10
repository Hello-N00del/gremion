/**
 * The ACME edge guard (TASK-022, spec B "Edge" §2; TRD-039, TRD-042, TRD-178).
 *
 *   node --test scripts/check-compose-edge.test.mjs
 *
 * Three guards, each a post-condition read out of an artefact, never an exit
 * code:
 *
 *   1. RENDER. Every port the production traefik publishes carries an explicit
 *      host address: EDGE_BIND_IP / EDGE_BIND_IP6 for web and websecure,
 *      127.0.0.1 for the API and internaltest. A publish with no host address
 *      binds every interface -- an unauthenticated Traefik API on 0.0.0.0 is
 *      the whole routing graph.
 *   2. STATIC FILE. docker/traefik/traefik.yml declares the four entrypoints,
 *      the ping block, the le-http resolver and the directory file provider,
 *      carries the five @MARKER@s the start-up render substitutes, and holds no
 *      host literal. dynamic/tls.yml (the Cloudflare Origin default
 *      certificate) is gone.
 *   3. SERVICE. One read-only mount of /etc/traefik/dynamic, the external
 *      ${STACK}_traefik_acme volume, a ping healthcheck, and Traefik running
 *      from the rendered /tmp copy rather than the committed file.
 *
 * WHY A RENDER AND NOT THE SOURCE FILE. `docker compose config` is the only
 * artefact that is the deployed topology: an overlay, a profile or a merged
 * list can put back what the source file does not show. The render is taken
 * with the FIXED env file test/host/fixtures/edge-render/state.env, shaped like
 * the host's rendered state.env, and with a scrubbed environment, because a
 * shell variable outranks --env-file and the guard must measure the
 * repository, not the machine it runs on.
 *
 * renderState() is exported: TASK-034 (the edge routers) imports it, and it
 * survives TASK-040 moving the traefik block, because it renders whatever
 * COMPOSE_FILE the fixture names.
 */

import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FIXTURE, REPO_ROOT, bindRefusesMissingHostDir, parseYamlSubset, readEnvFile, renderState, socketIsolationViolations } from './compose-edge.mjs'

// The brief's contract: this file exports renderState. TASK-034 should import
// ./compose-edge.mjs directly -- importing a test file is what the entry guard
// below exists to make harmless, not a pattern to build on.
export { FIXTURE, REPO_ROOT, parseYamlSubset, readEnvFile, renderState }

const SELF = fileURLToPath(import.meta.url)

// TASK-034 imports renderState from this file. node:test registers every
// test() a module declares when it is IMPORTED, so without this the whole
// suite below would run again inside the importer's. The suite registers only
// when this file is the process entry -- which `node --test <file>` makes it
// (one process per file). If a runner ever changes that, the suite registers
// nothing and `make lint-edge-render` fails on its collected-count check
// rather than passing on zero tests. (`--test-isolation=none` with this file
// not first on the command line is such a runner; so is anything else that
// runs files in one process.)
const realpath = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const IS_ENTRY = process.argv[1] !== undefined && realpath(process.argv[1]) === realpath(SELF)
// A statement-bodied wrapper returns nothing: the oxlint ratchet's
// no-floating-promises flags every top-level `test(` whose callee returns the
// node:test promise (the node:test exemption does not see through a wrapper).
const test = (...args) => {
  if (IS_ENTRY) nodeTest(...args)
}
const TRAEFIK_YML = 'docker/traefik/traefik.yml'
const MARKERS = ['@ACME_EMAIL@', '@ACME_CA_SERVER@', '@EDGE_V4_SUBNET@', '@EDGE_V6_SUBNET@', '@STACK@']

// ── helpers over the render ────────────────────────────────────────────────

let cached
function state() {
  cached ??= renderState()
  return cached
}
function traefik() {
  const svc = state().services?.traefik
  assert.ok(svc, 'the production render has no traefik service -- is the fixture COMPOSE_PROFILES=production?')
  return svc
}
const fixtureEnv = () => readEnvFile(FIXTURE)
const WILDCARD = new Set(['', '0.0.0.0', '::'])
// Brackets off; an all-zero IPv6 spelling (`::0`, `0:0:0:0:0:0:0:0`, ...)
// normalised to `::` so it cannot slip past the wildcard set.
const normIp = (ip) => {
  const v = String(ip ?? '').replace(/^\[|\]$/g, '')
  return v.includes(':') && /^[0:]+$/.test(v) ? '::' : v
}
const commandText = (svc) => [].concat(svc.entrypoint ?? [], svc.command ?? []).join(' ')

// ── 0. the tools the guards stand on ───────────────────────────────────────

test('parseYamlSubset reads nesting, lists, quoting and comments, and refuses what it cannot read', () => {
  const doc = parseYamlSubset(
    ['# c', 'a:', '  b: "x # not a comment"  # comment', '  c:', '    - "1"', '    - two', '  d: {}', 'e: false'].join('\n'),
  )
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), { a: { b: 'x # not a comment', c: ['1', 'two'], d: {} }, e: false })
  assert.throws(() => parseYamlSubset('a: [1, 2]'), /unsupported/)
  assert.throws(() => parseYamlSubset('a: 1\na: 2'), /duplicate/)
  for (const bad of ['a: &x 1', 'a: *x', 'a: !!str 5', 'a:\n  - k: v', 'l:\n- x: 1', 'a: "q\\" x"', "a: 'it''s'", 'a: 0755', '<<: 1']) {
    assert.throws(() => parseYamlSubset(bad), /unsupported/, JSON.stringify(bad))
  }
  assert.deepEqual({ ...parseYamlSubset('constructor: 1\n__proto__: 2') }, { constructor: 1, ['__proto__']: 2 })
})

test('renderState renders the fixture through the production profile, independent of the caller shell', () => {
  const cfg = state()
  assert.ok(cfg.services?.traefik && cfg.services?.['docker-socket-proxy'], 'traefik and its socket proxy render')
  // A value in the caller's shell must not leak in: a shell variable outranks
  // --env-file in compose, so without the scrub this would decide the render.
  process.env.EDGE_BIND_IP = '198.51.100.99'
  try {
    const again = renderState()
    const ips = (again.services.traefik.ports ?? []).map((p) => normIp(p.host_ip))
    assert.ok(!ips.includes('198.51.100.99'), 'the caller shell decided a bind address')
  } finally {
    delete process.env.EDGE_BIND_IP
  }
})

test('importing renderState from another test file registers none of this suite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-import-'))
  try {
    const importer = path.join(dir, 'importer.test.mjs')
    writeFileSync(
      importer,
      [
        `import { renderState } from ${JSON.stringify(pathToFileURL(SELF).href)}`,
        `import { test } from 'node:test'`,
        `test('importer probe', () => { if (typeof renderState !== 'function') throw new Error('no renderState') })`,
        '',
      ].join('\n'),
    )
    // A child `node --test` that inherits NODE_TEST_CONTEXT reports to THIS
    // runner instead of to its stdout; it must run as a standalone runner.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    // Bounded: if the entry guard ever misfired, the child would re-register
    // this very test and recurse -- that must be a failure, not a hang.
    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', importer], { encoding: 'utf8', env, timeout: 60_000 })
    assert.equal(res.signal, null, `the importer run was killed (${res.signal}) -- recursion or hang`)
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /^1\.\.1$/m, `the importer ran more than its own test:\n${res.stdout}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 1. render guard: every publish is bound ────────────────────────────────

test('guard 1: every traefik publish carries an explicit, non-wildcard host address', () => {
  const ports = traefik().ports ?? []
  assert.ok(ports.length > 0, 'traefik publishes nothing -- the guard would pass vacuously')
  for (const p of ports) {
    assert.ok(!WILDCARD.has(normIp(p.host_ip)), `publish ${p.published}->${p.target} binds all interfaces (host_ip=${JSON.stringify(p.host_ip ?? '')})`)
  }
})

test('guard 1: web and websecure bind EDGE_BIND_IP and EDGE_BIND_IP6, and nothing else', () => {
  const env = fixtureEnv()
  const want = [
    `${env.EDGE_BIND_IP} ${env.EDGE_HTTP_PORT}->80`,
    `${env.EDGE_BIND_IP6} ${env.EDGE_HTTP_PORT}->80`,
    `${env.EDGE_BIND_IP} ${env.EDGE_HTTPS_PORT}->443`,
    `${env.EDGE_BIND_IP6} ${env.EDGE_HTTPS_PORT}->443`,
  ].sort()
  const got = (traefik().ports ?? [])
    .filter((p) => p.target === 80 || p.target === 443)
    .map((p) => `${normIp(p.host_ip)} ${p.published}->${p.target}`)
    .sort()
  assert.deepEqual(got, want)
})

test('guard 1: the API (:8080) and internaltest (:8081) publish on 127.0.0.1 only; ping (:8082) is not published', () => {
  const env = fixtureEnv()
  const ports = traefik().ports ?? []
  const of = (target) => ports.filter((p) => p.target === target).map((p) => `${normIp(p.host_ip)}:${p.published}`)
  assert.deepEqual(of(8080), [`127.0.0.1:${env.TRAEFIK_API_PORT}`])
  assert.deepEqual(of(8081), [`127.0.0.1:${env.INTERNALTEST_PORT}`])
  assert.deepEqual(of(8082), [])
  const unexpected = ports.filter((p) => ![80, 443, 8080, 8081].includes(p.target))
  assert.deepEqual(unexpected, [], 'traefik publishes a port no guard reasons about')
})

test('guard 1: an empty bind address is refused at render, never published on every interface', () => {
  for (const key of ['EDGE_BIND_IP', 'EDGE_BIND_IP6']) {
    assert.throws(() => renderState({ env: { [key]: '' } }), new RegExp(`${key} required`), `${key}='' rendered`)
  }
})


// ── 2. the static file ─────────────────────────────────────────────────────

const staticText = () => readFileSync(path.join(REPO_ROOT, TRAEFIK_YML), 'utf8')
const staticDoc = () => parseYamlSubset(staticText())

test('guard 2: exactly the four entrypoints, at their fixed addresses, with the :80 -> :443 redirect', () => {
  const ep = staticDoc().entryPoints
  assert.deepEqual(Object.keys(ep ?? {}).sort(), ['internaltest', 'ping', 'web', 'websecure'])
  assert.equal(ep.web.address, ':80')
  assert.equal(ep.websecure.address, ':443')
  assert.equal(ep.ping.address, ':8082')
  assert.equal(ep.internaltest.address, ':8081')
  assert.deepEqual(ep.web.http?.redirections?.entryPoint, { to: 'websecure', scheme: 'https', permanent: true })
  // Only websecure is a default entrypoint: a router naming no entryPoints must
  // never also attach to internaltest (or ping, or web).
  assert.equal(ep.websecure.asDefault, true)
  for (const name of ['web', 'ping', 'internaltest']) assert.equal(ep[name].asDefault, undefined, `${name} is a default entrypoint`)
})

test('guard 2: the ping block, the API without dashboard, the le-http resolver and the directory provider', () => {
  const doc = staticDoc()
  assert.deepEqual(doc.ping, { entryPoint: 'ping' })
  assert.equal(doc.api?.dashboard, false)
  assert.equal(doc.api?.insecure, true, 'the API must answer on the traefik entrypoint, which only a loopback publish exposes')
  const acme = doc.certificatesResolvers?.['le-http']?.acme
  assert.equal(acme?.storage, '/letsencrypt/acme.json')
  assert.deepEqual(acme?.httpChallenge, { entryPoint: 'web' })
  assert.deepEqual(doc.providers?.file, { directory: '/etc/traefik/dynamic', watch: true })
})

test('guard 2: the five markers sit where the render substitutes them, and no other marker exists', () => {
  const doc = staticDoc()
  const acme = doc.certificatesResolvers?.['le-http']?.acme
  assert.equal(acme?.email, '@ACME_EMAIL@')
  assert.equal(acme?.caServer, '@ACME_CA_SERVER@')
  assert.deepEqual(doc.entryPoints?.websecure?.forwardedHeaders?.trustedIPs, ['127.0.0.1/32', '@EDGE_V4_SUBNET@', '@EDGE_V6_SUBNET@'])
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const found = [...new Set(staticText().match(/@[A-Z][A-Z0-9_]*@/g) ?? [])].sort(byCodeUnit)
  assert.deepEqual(found, [...MARKERS].sort(byCodeUnit))
  // Incident 2026-10-29: the docker provider reads only its own stack's containers.
  assert.equal(doc.providers?.docker?.constraints, 'Label(`org.gremion.stack`,`@STACK@`)')
})

test('guard 2: no host literal -- 127.0.0.1 or :8081 appears exactly twice (TRD-039)', () => {
  const hits = staticText()
    .split(/\r?\n/)
    .filter((l) => /127\.0\.0\.1|:8081/.test(l))
    .map((l) => l.trim())
  assert.deepEqual(hits, ['- "127.0.0.1/32"', 'address: ":8081"'])
})

test('guard 2: dynamic/tls.yml and every Cloudflare Origin certificate reference are gone (TRD-042)', () => {
  assert.equal(existsSync(path.join(REPO_ROOT, 'docker/traefik/dynamic/tls.yml')), false, 'docker/traefik/dynamic/tls.yml exists')
  assert.doesNotMatch(staticText(), /tls\.yml|cf-origin|\/certs\//)
})

// ── 3. the service ─────────────────────────────────────────────────────────

test('guard 3: exactly one mount targets /etc/traefik/dynamic, read-only, from ${GREMION_ROOT}/etc/edge', () => {
  const mounts = (traefik().volumes ?? []).filter((v) => v.target === '/etc/traefik/dynamic')
  assert.equal(mounts.length, 1, `${mounts.length} mounts target /etc/traefik/dynamic`)
  // Compose MERGES mounts that share a target (the last wins), so the render
  // alone can never show two. Count the declarations in every compose SOURCE
  // too: a second one is the defect even when the merge hides it.
  const decl = /^\s*(?:-\s*"?[^"#\s]*:\/etc\/traefik\/dynamic(?::[a-z,]+)?"?|target:\s*\/etc\/traefik\/dynamic)\s*$/
  const sources = readdirSync(REPO_ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
  const declared = sources.flatMap((f) =>
    readFileSync(path.join(REPO_ROOT, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => decl.test(l))
      .map((l) => `${f}: ${l.trim()}`),
  )
  assert.deepEqual(declared, ['docker-compose.yml: target: /etc/traefik/dynamic'])
  assert.equal(mounts[0].type, 'bind')
  assert.equal(mounts[0].read_only, true)
  assert.equal(mounts[0].source, `${fixtureEnv().GREMION_ROOT}/etc/edge`)
  // A missing router directory must refuse `up`, not become an empty dir.
  assert.ok(bindRefusesMissingHostDir(mounts[0]), `a missing \${GREMION_ROOT}/etc/edge would be created empty (rendered bind: ${JSON.stringify(mounts[0].bind)})`)
})

test('guard 3: ACME state lives only in the external ${STACK}_traefik_acme volume, mounted at /letsencrypt', () => {
  const svc = traefik()
  const acme = (svc.volumes ?? []).filter((v) => v.target === '/letsencrypt')
  assert.equal(acme.length, 1)
  assert.equal(acme[0].type, 'volume')
  assert.equal(acme[0].source, 'traefik-acme')
  assert.deepEqual(state().volumes?.['traefik-acme'], { name: 'guardstack_traefik_acme', external: true })
  const cf = (svc.volumes ?? []).filter((v) => /cf-origin/.test(String(v.source)) || String(v.target).startsWith('/certs'))
  assert.deepEqual(cf, [], 'a Cloudflare Origin certificate is still mounted')
})

test('guard 3: the healthcheck probes the ping entrypoint (TRD-178)', () => {
  const hc = traefik().healthcheck
  assert.ok(hc && !hc.disable, 'traefik has no healthcheck')
  assert.match([].concat(hc.test).join(' '), /http:\/\/127\.0\.0\.1:8082\/ping/)
})

test('guard 3: Traefik runs from the rendered /tmp copy of the read-only committed file, on the pinned image', () => {
  const svc = traefik()
  assert.match(svc.image, /^traefik:v3\.7\.17@sha256:[0-9a-f]{64}$/)
  const cmd = commandText(svc)
  assert.match(cmd, /\/etc\/traefik\/traefik\.yml > \/tmp\/traefik\.yml/)
  assert.match(cmd, /exec \/entrypoint\.sh traefik --configFile=\/tmp\/traefik\.yml/)
  const stat = (svc.volumes ?? []).filter((v) => v.target === '/etc/traefik/traefik.yml')
  assert.equal(stat.length, 1)
  assert.equal(stat[0].read_only, true)
})

// ── 5. the Docker API proxy is isolated (F1-FIX-11, H21, S5#28) ───────────
//
// docker-socket-proxy runs CONTAINERS=1, so any container beside it can read
// /containers/{id}/json (every injected secret). The proxy must sit on its own
// internal network that only it and traefik join, and on no other network.
// Rendered, never read off the source: an overlay or a merged list can put the
// proxy back on a shared network without the source file showing it.

const COMPOSITIONS = [
  ['the production fixture (docker-compose.yml + docker-compose.prod.yml)', undefined],
  ['the base file alone', { COMPOSE_FILE: 'docker-compose.yml', COMPOSE_PROFILES: 'production' }],
  ['the base file with the dev override', { COMPOSE_FILE: 'docker-compose.yml:docker-compose.override.yml', COMPOSE_PROFILES: 'production' }],
]

// One top-level test (the Makefile's lint-edge-render counts `^test(` lines
// against what node collected, so no test may be declared in a loop).
test('guard 5: every composition puts exactly {docker-socket-proxy, traefik} on an internal socket network, the proxy on no other', () => {
  for (const [label, env] of COMPOSITIONS) {
    const render = env ? renderState({ env }) : state()
    assert.deepEqual(socketIsolationViolations(render), [], label)
  }
  // The proxy's address resolves by service name on that network: traefik's
  // provider endpoint must name it, not an IP or a shared-network alias.
  assert.match(readFileSync(path.join(REPO_ROOT, TRAEFIK_YML), 'utf8'), /endpoint:\s*"tcp:\/\/docker-socket-proxy:2375"/)
})

test('guard 5: the check fails on each way the isolation can be undone (guard efficacy, on synthetic renders)', () => {
  const clone = () => JSON.parse(JSON.stringify(state()))
  const fails = (mutate, re) => {
    const r = clone()
    mutate(r)
    assert.match(socketIsolationViolations(r).join('\n'), re)
  }
  fails((r) => { r.services['docker-socket-proxy'].networks.edge = null }, /docker-socket-proxy is on \[.*edge.*\]/)
  fails((r) => { r.services['docker-socket-proxy'].networks.state = null }, /docker-socket-proxy is on \[.*state.*\]/)
  fails((r) => { r.services['docker-socket-proxy'].network_mode = 'host' }, /network_mode host/)
  fails((r) => { r.services.keycloak.networks.socket = null }, /members are \[docker-socket-proxy, keycloak, traefik\]/)
  fails((r) => { delete r.services.traefik.networks.socket }, /members are \[docker-socket-proxy\]/)
  fails((r) => { delete r.networks.socket.internal }, /not internal: true/)
  fails((r) => { r.networks.socket.external = true }, /is external/)
  fails((r) => { delete r.networks.socket }, /networks\.socket is not declared/)
  fails((r) => { delete r.services['docker-socket-proxy'] }, /not in the render/)
  // Joining the proxy's or traefik's network namespace reaches it without
  // being listed under `networks:`.
  fails((r) => { r.services.keycloak.network_mode = 'service:traefik' }, /keycloak shares the network namespace of service:traefik/)
  fails((r) => { r.services.keycloak.network_mode = 'service:docker-socket-proxy' }, /keycloak shares the network namespace of service:docker-socket-proxy/)
  fails((r) => { r.services.keycloak.network_mode = 'container:gremion-traefik' }, /keycloak shares the network namespace of container:gremion-traefik/)
  fails((r) => { r.services.keycloak.network_mode = 'container:docker-socket-proxy' }, /keycloak shares the network namespace of container:docker-socket-proxy/)
})

// ── 4. no middleware keys security on a client-supplied header ────────────
//
// TASK-022 round-1/round-2 HIGH: Traefik is now the first hop (guard 2's own
// header says so -- "nothing keyed on security may read a forwarded header").
// A ratelimit middleware's sourceCriterion.requestHeaderName reads ANY header
// verbatim, regardless of forwardedHeaders.trustedIPs, so a label still
// keying on CF-Connecting-IP (a Cloudflare-edge holdover) lets any client mint
// a fresh bucket per request by rotating the header value it sends itself.
// Same failure mode for X-Forwarded-For / X-Real-IP. This guard reads every
// service's rendered labels -- not just gremion-public's -- so it catches the
// same mistake wherever it is made, not only at today's one call site.

const SPOOFABLE_HEADERS = new Set(['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'])

test('guard 4: no ratelimit middleware in the production render keys its bucket on a client-supplied header', () => {
  const services = state().services ?? {}
  const offenders = []
  for (const [name, svc] of Object.entries(services)) {
    for (const [key, value] of Object.entries(svc.labels ?? {})) {
      if (/^traefik\.http\.middlewares\.[^.]+\.ratelimit\.sourceCriterion\.requestHeaderName$/.test(key) && SPOOFABLE_HEADERS.has(String(value).toLowerCase())) {
        offenders.push(`${name}: ${key}=${value}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `a ratelimit bucket keys on a spoofable client header (Traefik is the first hop, so remote-address keying is what makes the bucket real): ${offenders.join(', ')}`)
})

// ── 6. every <name>@docker a tenant router chains is declared on traefik ──
//
// TASK-043c (P1). The byte-exact tenant render fixtures the edge-proto drill
// runs (test/host/fixtures/edge-proto/dynamic/tenant-*.yml, asserted equal to
// the emitter's output by @gremion/edge-routers' tests) chain middlewares
// `<name>@docker`. The edge-proto fixture compose declared them; the PRODUCTION
// compose did not, so the drill was green while every tenant router on a real
// host reported `middleware "edge-ratelimit-app@docker" does not exist` and the
// customer host answered 404. This reads the names out of the fixtures (no TS
// import) and demands each one on the production render's traefik labels --
// the artefact that is the deployed topology. (Numbered 6 because guard 5 above
// is the socket isolation.)

const TENANT_FIXTURE_DIR = path.join(REPO_ROOT, 'test/host/fixtures/edge-proto/dynamic')
const chainedDockerMiddlewares = (yaml) => [...yaml.matchAll(/^\s*-\s*"([A-Za-z0-9._-]+)@docker"\s*$/gm)].map((m) => m[1])

test('guard 6: the production traefik labels declare every <name>@docker the tenant router fixtures chain', () => {
  const files = readdirSync(TENANT_FIXTURE_DIR).filter((f) => /^tenant-.+\.yml$/.test(f))
  assert.ok(files.length >= 2, `only ${files.length} tenant fixture(s) found in ${TENANT_FIXTURE_DIR} -- the guard would pass vacuously`)
  const chained = new Set(files.flatMap((f) => chainedDockerMiddlewares(readFileSync(path.join(TENANT_FIXTURE_DIR, f), 'utf8'))))
  // The names the emitter chains today: a fixture that lost them would also
  // empty this guard.
  for (const must of ['edge-hsts-custom', 'edge-ratelimit-app', 'gremion-ui-proxytrust']) {
    assert.ok(chained.has(must), `the tenant fixtures no longer chain ${must}@docker -- is the fixture stale?`)
  }
  const declared = new Set(
    Object.keys(traefik().labels ?? {})
      .map((k) => /^traefik\.http\.middlewares\.([^.]+)\./.exec(k)?.[1])
      .filter(Boolean),
  )
  const missing = [...chained].filter((n) => !declared.has(n)).sort((a, b) => a.localeCompare(b))
  assert.deepEqual(missing, [], `tenant routers chain ${missing.map((n) => `${n}@docker`).join(', ')}, which the production traefik service does not declare: Traefik reports "middleware does not exist", disables the router and the customer host answers 404`)
})

// ── 7. the pilot's services: routers, ports and the labels that make them live ──
//
// The pilot adds three Traefik-labelled containers to the state project: matrix (/_matrix on the
// platform host), livekit (/livekit-sfu on the platform host, RTC ports on the edge addresses)
// and collabora (a docker-label SERVICE the per-tenant /office routers of @gremion/edge-routers
// target). Rendered with their profiles on, never read off the source:
//   - every one carries traefik.enable, org.gremion.stack (a stack-constrained Traefik never sees
//     a container without it: a silent 404), traefik.docker.network=${STACK}_edge and is ON that
//     network (a container on two networks must name the one Traefik reaches it on);
//   - a public router names an explicit tls.certresolver (tls=true alone serves the default
//     certificate, silently), websecure, and a chain whose every member the TRAEFIK service
//     declares (spec B B-09: a state container's own middleware vanishes with it);
//   - /_matrix and /livekit-sfu are the only prefixes, and neither is /_synapse, /livekit or a bare
//     host rule; collabora has NO public router at all, only its service and a loopback-only anchor;
//   - LiveKit publishes 7881/tcp and 45000-45100/udp on EDGE_BIND_IP and [EDGE_BIND_IP6] only.

const PILOT_PROFILES = 'production,messaging,nextcloud,collabora,video'
const pilotState = () => renderState({ env: { COMPOSE_PROFILES: PILOT_PROFILES } })
const routerKeys = (labels, router) =>
  Object.fromEntries(
    Object.entries(labels)
      .filter(([k]) => k.startsWith(`traefik.http.routers.${router}.`))
      .map(([k, v]) => [k.slice(`traefik.http.routers.${router}.`.length), String(v)]),
  )
const routerNames = (labels) => [...new Set(Object.keys(labels).map((k) => /^traefik\.http\.routers\.([^.]+)\./.exec(k)?.[1]).filter(Boolean))]

test('guard 7: matrix, livekit and collabora are routed by label correctly, and LiveKit binds the edge addresses only', () => {
  const r = pilotState()
  const env = fixtureEnv()
  const stack = env.STACK
  const domain = env.PLATFORM_DOMAIN
  const declaredOnTraefik = new Set(
    Object.keys(r.services.traefik.labels ?? {})
      .map((k) => /^traefik\.http\.middlewares\.([^.]+)\./.exec(k)?.[1])
      .filter(Boolean),
  )
  for (const name of ['matrix', 'livekit', 'collabora']) {
    const svc = r.services[name]
    assert.ok(svc, `${name} is absent from the profile-on render`)
    const l = svc.labels ?? {}
    assert.equal(l['traefik.enable'], 'true', `${name}: traefik.enable`)
    assert.equal(l['org.gremion.stack'], stack, `${name}: org.gremion.stack`)
    assert.equal(l['traefik.docker.network'], `${stack}_edge`, `${name}: traefik.docker.network`)
    assert.ok(Object.keys(svc.networks ?? {}).includes('edge'), `${name} is not on the edge network it is routed on`)
  }
  // matrix: /_matrix only (federation is off; /_synapse carries the admin API and is never public)
  const mx = routerKeys(r.services.matrix.labels, 'matrix')
  assert.equal(mx.rule, `Host(\`${domain}\`) && PathPrefix(\`/_matrix\`)`)
  assert.deepEqual(routerNames(r.services.matrix.labels), ['matrix'])
  assert.equal(r.services.matrix.labels['traefik.http.services.matrix.loadbalancer.server.port'], '8008')
  // livekit: /livekit-sfu, deliberately not /livekit (gremion-ui's /livekit/jwt), signalling port 7880 only
  const lk = routerKeys(r.services.livekit.labels, 'livekit')
  assert.equal(lk.rule, `Host(\`${domain}\`) && PathPrefix(\`/livekit-sfu\`)`)
  assert.deepEqual(routerNames(r.services.livekit.labels), ['livekit'])
  assert.equal(r.services.livekit.labels['traefik.http.services.livekit.loadbalancer.server.port'], '7880')
  for (const [name, rt] of Object.entries({ matrix: mx, livekit: lk })) {
    assert.equal(rt.entrypoints, 'websecure', `${name}: entrypoints`)
    assert.equal(rt.tls, 'true', `${name}: tls`)
    assert.equal(rt['tls.certresolver'], env.TRAEFIK_CERT_RESOLVER, `${name}: an explicit tls.certresolver (tls=true alone serves the default certificate)`)
    const chain = rt.middlewares.split(',')
    assert.equal(chain[0], 'edge-hostpin-apex@docker', `${name}: the host pin is first`)
    assert.ok(chain.includes('edge-hsts-platform@docker') && chain.includes('edge-ratelimit-app@docker'), `${name}: HSTS and a rate limit`)
    for (const m of chain) {
      const [base, provider] = m.split('@')
      assert.ok(provider === undefined || provider === 'docker', `${name}: ${m} is not a docker-provider middleware`)
      assert.ok(declaredOnTraefik.has(base), `${name}: chains ${m}, which the traefik service does not declare (B-09)`)
    }
  }
  // the pin stamps the platform host, and the strip middleware removes exactly /livekit-sfu
  const tl = r.services.traefik.labels
  assert.equal(tl['traefik.http.middlewares.edge-hostpin-apex.headers.customrequestheaders.X-Forwarded-Host'], domain)
  assert.equal(tl['traefik.http.middlewares.livekit-sfu-strip.stripprefix.prefixes'], '/livekit-sfu')
  assert.ok(lk.middlewares.split(',').includes('livekit-sfu-strip@docker'))
  // collabora: a service the tenant routers target, and NO public router (a default router would be
  // generated for a labelled container with none): one anchor on the loopback-only internaltest entrypoint
  const cl = r.services.collabora.labels
  assert.equal(cl['traefik.http.services.collabora.loadbalancer.server.port'], '9980')
  assert.deepEqual(routerNames(cl), ['collabora-anchor'])
  const anchor = routerKeys(cl, 'collabora-anchor')
  assert.equal(anchor.entrypoints, 'internaltest')
  assert.equal(anchor.service, 'collabora')
  assert.match(anchor.rule, /^Host\(`[a-z0-9.-]+\.invalid`\)$/)
  // livekit publishes only the RTC ports, only on the edge addresses
  const got = (r.services.livekit.ports ?? []).map((p) => `${normIp(p.host_ip)} ${p.published}->${p.target}/${p.protocol}`).sort()
  // compose renders a published range one port at a time
  const media = Array.from({ length: 101 }, (_, i) => 45000 + i)
  const want = [
    `${env.EDGE_BIND_IP} 7881->7881/tcp`,
    `${env.EDGE_BIND_IP6} 7881->7881/tcp`,
    ...media.flatMap((p) => [`${env.EDGE_BIND_IP} ${p}->${p}/udp`, `${env.EDGE_BIND_IP6} ${p}->${p}/udp`]),
  ].sort()
  assert.deepEqual(got, want)
  assert.ok(!(r.services.livekit.ports ?? []).some((p) => WILDCARD.has(normIp(p.host_ip))), 'livekit publishes on a wildcard address')
})

// ── 8. the video relay: TURN over TLS on 443 ───────────────────────────────
//
// With a customer host (PILOT_TENANT_HOST in state.env) livekit carries ONE TCP router on websecure:
// HostSNI(`turn.<host>`), TLS terminated by Traefik with the same resolver as the HTTP routers (never
// passthrough), to LiveKit's TURN port 5349. Without a customer host the install is what it was before
// the relay: no label Traefik reads as a TCP router, so no router and no certificate order for any
// name. The CPU limit is one core with the memory limit unchanged, and the rendered LiveKit config is
// a bind that refuses to be created empty.

const tcpLabels = (labels) => Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => k.startsWith('traefik.tcp.')))

test('guard 8: with a customer host livekit carries exactly the one TLS-terminating TURN router on websecure', () => {
  const r = renderState({ env: { COMPOSE_PROFILES: PILOT_PROFILES, PILOT_TENANT_HOST: 'customer.example.org' } })
  const l = r.services.livekit.labels
  assert.deepEqual(tcpLabels(l), {
    'traefik.tcp.routers.livekit-turn.rule': 'HostSNI(`turn.customer.example.org`)',
    'traefik.tcp.routers.livekit-turn.entrypoints': 'websecure',
    'traefik.tcp.routers.livekit-turn.tls': 'true',
    'traefik.tcp.routers.livekit-turn.tls.certresolver': fixtureEnv().TRAEFIK_CERT_RESOLVER,
    'traefik.tcp.routers.livekit-turn.service': 'livekit-turn',
    'traefik.tcp.services.livekit-turn.loadbalancer.server.port': '5349',
  })
  // the HTTP router of the signalling socket is untouched
  assert.deepEqual(routerNames(l), ['livekit'])
})

test('guard 8: without a customer host (unset or empty) no label of livekit is a Traefik TCP router and no name is ordered', () => {
  for (const env of [{}, { PILOT_TENANT_HOST: '' }]) {
    const r = renderState({ env: { COMPOSE_PROFILES: PILOT_PROFILES, ...env } })
    const l = r.services.livekit.labels
    assert.deepEqual(tcpLabels(l), {}, `a TCP router label with PILOT_TENANT_HOST=${JSON.stringify(env.PILOT_TENANT_HOST)}`)
    const traefikLabels = Object.entries(l).filter(([k]) => k.startsWith('traefik.'))
    assert.ok(!traefikLabels.some(([, v]) => /(^|[^a-z])turn\./.test(String(v))), 'a turn.* name is carried by a traefik label')
    assert.deepEqual(routerNames(l), ['livekit'])
  }
})

test('guard 8: livekit has one CPU core and the memory limit it had, and its rendered config is a bind that refuses an empty create', () => {
  const svc = pilotState().services.livekit
  assert.equal(Number(svc.deploy.resources.limits.cpus), 1)
  assert.equal(Number(svc.deploy.resources.limits.memory), 512 * 1024 * 1024)
  const cfg = (svc.volumes ?? []).filter((v) => v.target === '/etc/livekit/livekit.yaml')
  assert.equal(cfg.length, 1)
  assert.equal(cfg[0].read_only, true)
  assert.ok(String(cfg[0].source).replaceAll('\\', '/').endsWith('/docker/livekit/livekit.yaml'), `source ${cfg[0].source}`)
  assert.ok(bindRefusesMissingHostDir(cfg[0]), `a config that was not rendered would be created empty (rendered bind: ${JSON.stringify(cfg[0].bind)})`)
})
