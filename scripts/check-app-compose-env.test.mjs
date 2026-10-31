// TASK-077 G7 regression guard: every `${VAR:?...}` of docker-compose.app.yml
// that is a secret/value an operator or a generator must supply needs a source
// in the dev .env.example, scripts/setup.sh's generated vars (via .env.example)
// and the host state.env template. Vars the host fills at deploy (STACK, COLOUR,
// PLATFORM_DOMAIN, IMAGE_TAG, subnets) are exempt: they come from app-<colour>.env.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
