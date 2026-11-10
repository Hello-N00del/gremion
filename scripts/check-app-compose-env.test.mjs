// TASK-077 G7 regression guard: every `${VAR:?...}` of docker-compose.app.yml
// that is a secret/value an operator or a generator must supply needs a source
// in the dev .env.example, scripts/setup.sh's generated vars (via .env.example)
// and the host state.env template. Vars the host fills at deploy (STACK, COLOUR,
// PLATFORM_DOMAIN, IMAGE_TAG, subnets) are exempt: they come from app-<colour>.env.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile, renderState } from './compose-edge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const HOST_FILLED = new Set(['STACK', 'COLOUR', 'PLATFORM_DOMAIN', 'IMAGE_TAG', 'APP_V4_SUBNET', 'APP_V6_SUBNET'])

const required = [...new Set([...read('docker-compose.app.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1]))].filter((v) => !HOST_FILLED.has(v))
const defined = (text) => new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))

test('the guard sees the :? vars of the app compose', () => {
  assert.ok(required.length >= 4, `only ${required.length} found`)
  assert.ok(required.includes('KERNEL_API_DB_PASSWORD'))
})

test('every :? var of docker-compose.app.yml has a source in .env.example', () => {
  const have = defined(read('.env.example'))
  assert.deepEqual(required.filter((v) => !have.has(v)), [])
})

test('every :? var of docker-compose.app.yml has a source in the host app.env or state.env template', () => {
  const have = new Set([...defined(read('infra/host/templates/env/app.env.tmpl')), ...defined(read('infra/host/templates/env/state.env.tmpl'))])
  const missing = required.filter((v) => !have.has(v))
  assert.deepEqual(missing, [])
})

test('state.env carries the generated DB passwords app.env carries (one sentinel group, one value)', () => {
  const state = defined(read('infra/host/templates/env/state.env.tmpl'))
  for (const v of ['PLATFORM_DB_PASSWORD', 'PANEL_DB_PASSWORD', 'KERNEL_API_DB_PASSWORD']) assert.ok(state.has(v), `${v} missing from state.env.tmpl`)
})

test('pooled-stack-proof.sh and setup.sh generate every :? secret of the app compose', () => {
  const proof = read('test/host/integration/pooled-stack-proof.sh')
  const setup = read('scripts/setup.sh')
  const envEx = read('.env.example')
  for (const v of required.filter((x) => /PASSWORD|SECRET/.test(x))) {
    assert.ok(new RegExp(`^${v}=`, 'm').test(proof), `${v} not rendered by pooled-stack-proof.sh`)
    const m = envEx.match(new RegExp(`^${v}=(CHANGE_ME\\w+)`, 'm'))
    if (m) assert.ok(setup.includes(m[1]), `${v} placeholder ${m[1]} not replaced by setup.sh`)
  }
})

test('kernel-api-migrate does not reference POSTGRES_PASSWORD (the direct url carries host/port only)', () => {
  const text = read('docker-compose.app.yml')
  const start = text.search(/^  kernel-api-migrate:/m)
  assert.ok(start >= 0, 'kernel-api-migrate not found')
  const rest = text.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:|^# =/m)
  const block = (next < 0 ? rest : rest.slice(0, next)).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join(' ')
  assert.doesNotMatch(block, /POSTGRES_PASSWORD/)
  assert.match(block, /GREMION_KERNEL_PG_DIRECT_URL: postgresql:\/\/postgres-\$\{STACK:\?STACK required\}:5432\/postgres/)
})

// Issue #87: the gremion-ui service must not carry AUTH_KEYCLOAK_ISSUER / AUTH_KEYCLOAK_BASE.
// gremion-ui no longer reads them (the issuer, the external base and the internal base
// come from the resolved tenant). A compose `${AUTH_KEYCLOAK_ISSUER:-}` pass-through puts
// the EMPTY STRING into the container on a host install, where Auth.js's env default
// shadowed the per-tenant issuer and every page behind auth returned 500.
function serviceBlockWithoutComments(file, name) {
  const text = read(file)
  const start = text.search(new RegExp(`^  ${name}:`, 'm'))
  assert.ok(start >= 0, `${name} not found in ${file}`)
  const rest = text.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:|^# =/m)
  return (next < 0 ? rest : rest.slice(0, next)).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
}

// One test() per compose file, written out: the verify suite counts test() calls in the source.
function assertNoIssuerKeys(file) {
  const block = serviceBlockWithoutComments(file, 'gremion-ui')
  assert.match(block, /environment:/, 'the guard sees the gremion-ui environment block')
  assert.doesNotMatch(block, /AUTH_KEYCLOAK_ISSUER/)
  assert.doesNotMatch(block, /AUTH_KEYCLOAK_BASE/)
}

test('gremion-ui environment of docker-compose.app.yml carries no AUTH_KEYCLOAK_ISSUER / AUTH_KEYCLOAK_BASE (#87)', () => {
  assertNoIssuerKeys('docker-compose.app.yml')
})

test('gremion-ui environment of docker-compose.app.dev.yml carries no AUTH_KEYCLOAK_ISSUER / AUTH_KEYCLOAK_BASE (#87)', () => {
  assertNoIssuerKeys('docker-compose.app.dev.yml')
})

// ── the pilot's service endpoints (infra/host/module-profiles.json, docs/ops/pilot-services.md) ──
//
// gremion-ui carries the endpoint and credential names the in-process halves of the files, votes and
// messaging modules and the three leaf clients already read, and the BACKEND TABLE of the evidence
// contract: calendar, content and newsletter run as leaves (CALENDAR_BACKEND, CONTENT_BACKEND,
// NEWSLETTER_BACKEND = service), votes/files/messages stay in-process (no *_BACKEND key at all) and
// board stays default. The isolation evidence's case table describes exactly these paths, so a
// drift in either is a proof about code that is not running.

/** The `KEY: value` pairs of one service's environment block, comments and blank lines dropped. */
function environmentOf(file, service) {
  const block = serviceBlockWithoutComments(file, service)
  const start = block.indexOf('    environment:')
  assert.ok(start >= 0, `${service} has no environment block in ${file}`)
  const out = {}
  for (const line of block.slice(start).split('\n').slice(1)) {
    if (/^ {4}\S/.test(line)) break
    const m = /^ {6}([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const PILOT_UI_ENV = [
  'NEXTCLOUD_URL', 'NEXTCLOUD_ADMIN_USER', 'NEXTCLOUD_ADMIN_PASSWORD', 'MATRIX_URL', 'SYNAPSE_SERVER_NAME', 'LIVEKIT_URL',
  'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'SYNAPSE_ADMIN_TOKEN', 'SYNAPSE_ADMIN_BOT_USER_ID', 'MATRIX_PUBLIC_URL',
  'PUBLIC_ELEMENT_CALL_URL', 'COLLABORA_URL', 'ELEMENT_CALL_INTERNAL_URL', 'CALENDAR_BACKEND', 'CONTENT_BACKEND', 'NEWSLETTER_BACKEND',
  'CALENDAR_SERVICE_URL', 'CONTENT_SERVICE_URL', 'NEWSLETTER_SERVICE_URL', 'INTERNAL_CALENDAR_SECRET', 'INTERNAL_CONTENT_SECRET',
  'INTERNAL_NEWSLETTER_SECRET', 'PUBLIC_BASE_URL',
]

test('pilot env: gremion-ui carries every endpoint name the module code reads, and every secret is a ${VAR}, never a literal', () => {
  const env = environmentOf('docker-compose.app.yml', 'gremion-ui')
  assert.deepEqual(PILOT_UI_ENV.filter((k) => !(k in env)), [])
  for (const [k, v] of Object.entries(env)) {
    if (/PASSWORD|SECRET|TOKEN|API_KEY/.test(k)) assert.match(v, /^\$\{[A-Z0-9_]+(:-[^}]*)?\}$/, `${k} is not a \${VAR} reference: ${v}`)
  }
  // the browser receives these two: never the in-network names
  assert.match(env.LIVEKIT_URL, /^wss:\/\/\$\{PLATFORM_DOMAIN:\?PLATFORM_DOMAIN required\}\/livekit-sfu$/)
  assert.match(env.PUBLIC_ELEMENT_CALL_URL, /^https:\/\/\$\{PILOT_TENANT_HOST:-\}\/element-call$/)
  assert.match(env.MATRIX_PUBLIC_URL, /^https:\/\/\$\{PLATFORM_DOMAIN:\?PLATFORM_DOMAIN required\}$/)
  // Nextcloud's admin login stays out of gremion-public (#241)
  assert.doesNotMatch(serviceBlockWithoutComments('docker-compose.app.yml', 'gremion-public'), /NEXTCLOUD_ADMIN/)
})

test('backend table: exactly the three leaf backends are `service`; no FILES_, VOTES_, MESSAGES_ or BOARD_BACKEND key exists in any app compose', () => {
  for (const file of ['docker-compose.app.yml', 'docker-compose.app.dev.yml']) {
    const text = read(file).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
    assert.doesNotMatch(text, /\b(FILES|VOTES|MESSAGES|MESSAGING|BOARD|ELECTIONS|FINANCE|VAULT|HANDOVER)_BACKEND\b/, file)
  }
  const env = environmentOf('docker-compose.app.yml', 'gremion-ui')
  const backends = Object.entries(env).filter(([k]) => /_BACKEND$/.test(k))
  assert.deepEqual(backends, [['CALENDAR_BACKEND', 'service'], ['CONTENT_BACKEND', 'service'], ['NEWSLETTER_BACKEND', 'service']])
})

test('leaf urls: every <ID>_SERVICE_URL of the rendered gremion-ui resolves to a declared alias of a leaf, on the leaf\'s own port', () => {
  const fx = readEnvFile('test/host/fixtures/pooled-stack/app-blue.env')
  const r = renderState({ envFile: 'test/host/fixtures/pooled-stack/app-blue.env', env: { COMPOSE_PROFILES: '*' } })
  const ui = r.services['gremion-ui'].environment
  const aliases = new Map()
  for (const [name, svc] of Object.entries(r.services)) {
    for (const att of Object.values(svc.networks ?? {})) for (const a of att?.aliases ?? []) aliases.set(a, name)
  }
  for (const [key, leaf] of [['CALENDAR_SERVICE_URL', 'calendar-service'], ['CONTENT_SERVICE_URL', 'content-service'], ['NEWSLETTER_SERVICE_URL', 'newsletter-service']]) {
    const u = new URL(ui[key])
    assert.equal(u.hostname, `${leaf}-${fx.COLOUR}`, `${key} names this colour's ${leaf}`)
    assert.equal(aliases.get(u.hostname), leaf, `${key}: no service of the render answers to ${u.hostname}`)
    assert.equal(u.port, String(r.services[leaf].environment.PORT), `${key} names the port ${leaf} listens on`)
  }
  // the three BACKEND values reach the container as rendered
  assert.deepEqual([ui.CALENDAR_BACKEND, ui.CONTENT_BACKEND, ui.NEWSLETTER_BACKEND], ['service', 'service', 'service'])
})

test('calendar leaf: the rendered environment gives the CalDAV drain a per-tenant target the leaf itself accepts', async () => {
  const r = renderState({ envFile: 'test/host/fixtures/pooled-stack/app-blue.env', env: { COMPOSE_PROFILES: '*' } })
  const env = r.services['calendar-service'].environment
  // the leaf's own resolver, not a copy of its rules: without a per-tenant target the drain refuses every tenant
  const { resolveCaldavTarget } = await import('../modules/calendar/src/caldav/target.ts')
  const res = resolveCaldavTarget({ slug: 'pilot' }, env)
  assert.equal(res.ok, true, res.ok ? '' : res.reason)
  assert.match(env.CALDAV_CALENDAR_TEMPLATE ?? '', /\{slug\}/)
  assert.equal(res.target.calendar, env.CALDAV_CALENDAR_TEMPLATE.split('{slug}').join('pilot'))
  // the collection is created by `gremion-services wire` for that same name: one shared definition, no second spelling
  assert.match(read('infra/host/bin/gremion-services'), /dav:create-calendar/)
})

test('release templates: every docker/**/*.tmpl renders to a path git ignores, so a host render never dirties the release tree', () => {
  const tmpls = []
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tmpl')) tmpls.push(p)
    }
  }
  walk('docker')
  assert.ok(tmpls.includes('docker/element-call/config.json.tmpl'), `the guard sees the Element Call template (${tmpls.join(', ')})`)
  for (const t of tmpls) {
    const out = t.slice(0, -'.tmpl'.length)
    // git is the oracle: it reads the repository's own ignore rules (exit 0: ignored, 1: not)
    const r = spawnSync('git', ['check-ignore', '-q', '--', out], { cwd: ROOT })
    assert.equal(r.status, 0, `${out} (rendered by gremion-render from ${t}) is not gitignored: a render would dirty the release tree`)
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--', t], { cwd: ROOT }).status, 1, `${t} itself must not be ignored`)
  }
})
