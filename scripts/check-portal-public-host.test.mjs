// The public portal on a customer's own host (docs/runbooks/public-portal-host.md).
//
//   node --test scripts/check-portal-public-host.test.mjs
//
// On a pooled single-customer install the read-only portal (gremion-public) has to
//   (1) read the CUSTOMER's database, not the platform's default one,
//   (2) link Login and the protocol PDFs to the customer's APP host, and
//   (3) be reachable under one extra host name that carries the portal ONLY.
//
// Two halves are pinned here, each against the thing that actually ships:
//
//   compose   the three fallbacks of the gremion-public block, read from
//             `docker compose config` (the render the host runs), never from a
//             regexp over the YAML alone. Unset keys keep the values the block
//             had before the keys existed; a set key wins.
//   router    infra/host/templates/edge/public-host.example.yml, parsed, held to
//             the router contract gremion-verify asserts on the running edge:
//             a resolver, one literal Host, its own pin first with an equal
//             X-Forwarded-Host, HSTS, the portal rate limit, service public@file,
//             and names no tenant file can produce.
//
// Top-level test() calls only: the verify suite counts them from the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { renderState } from './compose-edge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const FIXTURE = 'test/host/fixtures/pooled-stack/app-blue.env'
const TEMPLATE = 'infra/host/templates/edge/public-host.example.yml'
/** Every key whose presence or absence a case decides. The fixture's own values for them never leak into a case. */
const MANAGED = ['PILOT_TENANT_HOST', 'GREMION_DB_NAME', 'PUBLIC_PORTAL_HOST', 'PUBLIC_PORTAL_DB_NAME', 'PUBLIC_MAIN_APP_URL']
const PLATFORM = 'guard.example.org'

/**
 * The rendered environments of gremion-public and gremion-ui for the pooled-stack
 * fixture with exactly `keys` as the managed keys. A key that is absent from
 * `keys` is absent from the env file (unset, not empty); `''` writes `KEY=`.
 */
function renderWith(keys) {
  const kept = read(FIXTURE).split(/\r?\n/).filter((l) => !MANAGED.some((k) => l.startsWith(`${k}=`)))
  assert.match(kept.join('\n'), new RegExp(`^PLATFORM_DOMAIN=${PLATFORM.replaceAll('.', '\\.')}$`, 'm'), 'the fixture still names the platform domain this file asserts on')
  const dir = mkdtempSync(join(tmpdir(), 'portal-public-host-'))
  try {
    const envFile = join(dir, 'app-blue.env')
    writeFileSync(envFile, [...kept, ...Object.entries(keys).map(([k, v]) => `${k}=${v}`), ''].join('\n'))
    const childEnv = { COMPOSE_PROFILES: '*' }
    const r = renderState({ envFile, env: childEnv })
    return { portal: r.services['gremion-public'].environment, ui: r.services['gremion-ui'].environment }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── compose: the three fallbacks ────────────────────────────────────────────

test('portal compose, no key set: ORIGIN, the database and the main-app link keep the values they had before the keys existed', () => {
  const { portal } = renderWith({})
  assert.equal(portal.ORIGIN, `https://public.${PLATFORM}`)
  assert.equal(portal.PUBLIC_MAIN_APP_URL, `https://${PLATFORM}`)
  const dsn = new URL(portal.GREMION_PUBLIC_DB_URL)
  assert.equal(dsn.pathname, '/gremion')
  assert.equal(dsn.username, 'gremion_public_reader')
  assert.equal(dsn.host, 'postgres-guardstack:5432')
})

test('portal compose, keys present but empty: an empty value falls back exactly like an absent one', () => {
  const { portal } = renderWith({ PILOT_TENANT_HOST: '', GREMION_DB_NAME: '', PUBLIC_PORTAL_HOST: '', PUBLIC_PORTAL_DB_NAME: '', PUBLIC_MAIN_APP_URL: '' })
  assert.equal(portal.ORIGIN, `https://public.${PLATFORM}`)
  assert.equal(portal.PUBLIC_MAIN_APP_URL, `https://${PLATFORM}`)
  assert.equal(new URL(portal.GREMION_PUBLIC_DB_URL).pathname, '/gremion')
})

test('portal compose, database: PUBLIC_PORTAL_DB_NAME wins, then GREMION_DB_NAME, and only the database name moves', () => {
  const tenantDb = 't_0123456789abcdef0123456789abcdef__kernel'
  const legacy = new URL(renderWith({ GREMION_DB_NAME: 'kernel_default' }).portal.GREMION_PUBLIC_DB_URL)
  assert.equal(legacy.pathname, '/kernel_default', 'GREMION_DB_NAME alone still selects the database')
  const dsn = new URL(renderWith({ GREMION_DB_NAME: 'kernel_default', PUBLIC_PORTAL_DB_NAME: tenantDb }).portal.GREMION_PUBLIC_DB_URL)
  assert.equal(dsn.pathname, `/${tenantDb}`, 'the portal reads the database PUBLIC_PORTAL_DB_NAME names')
  assert.equal(dsn.username, 'gremion_public_reader', 'still the read-only role')
  assert.equal(dsn.host, legacy.host, 'still the same server')
  assert.equal(dsn.password, legacy.password, 'still the same credential reference')
})

test('portal compose, main-app link: an explicit PUBLIC_MAIN_APP_URL wins, else the customer host, else the platform domain', () => {
  const pilot = renderWith({ PILOT_TENANT_HOST: 'pilot.guard.example.org' })
  assert.equal(pilot.portal.PUBLIC_MAIN_APP_URL, 'https://pilot.guard.example.org', 'Login and the protocol PDFs go to the customer host')
  assert.equal(pilot.portal.PUBLIC_MAIN_APP_URL, pilot.ui.PUBLIC_BASE_URL, 'the portal names the same app origin the app names for itself')
  const explicit = renderWith({ PILOT_TENANT_HOST: 'pilot.guard.example.org', PUBLIC_MAIN_APP_URL: 'https://app.customer.example' })
  assert.equal(explicit.portal.PUBLIC_MAIN_APP_URL, 'https://app.customer.example')
  const bare = renderWith({})
  assert.equal(bare.portal.PUBLIC_MAIN_APP_URL, bare.ui.PUBLIC_BASE_URL, 'with neither key both fall back to the platform domain')
})

test('portal compose, own host: PUBLIC_PORTAL_HOST becomes ORIGIN and moves nothing else', () => {
  const base = renderWith({ PILOT_TENANT_HOST: 'pilot.guard.example.org' }).portal
  const own = renderWith({ PILOT_TENANT_HOST: 'pilot.guard.example.org', PUBLIC_PORTAL_HOST: 'portal.customer.example' }).portal
  assert.equal(own.ORIGIN, 'https://portal.customer.example')
  assert.deepEqual({ ...own, ORIGIN: base.ORIGIN }, base, 'only ORIGIN differs')
})

test('portal env keys: the app env template names all three, commented, so an existing host file still passes template-key parity', () => {
  const tmpl = read('infra/host/templates/env/app.env.tmpl')
  for (const k of ['PUBLIC_PORTAL_HOST', 'PUBLIC_PORTAL_DB_NAME', 'PUBLIC_MAIN_APP_URL']) {
    assert.match(tmpl, new RegExp(`^# ?${k}=`, 'm'), `${k} is not offered (commented) in app.env.tmpl`)
    assert.doesNotMatch(tmpl, new RegExp(`^${k}=`, 'm'), `${k} is declared uncommented: gremion-validate-env would then demand it of every existing host`)
  }
})

// ── router: the example file against the contract gremion-verify asserts ────

/** A middleware name `<base>@<provider>` split in two. */
const ref = (s) => ({ base: s.slice(0, s.lastIndexOf('@')), provider: s.slice(s.lastIndexOf('@') + 1) })

test('portal router template: one websecure router on one literal example host, with a resolver, targeting public@file', () => {
  const text = read(TEMPLATE)
  assert.doesNotMatch(text, /\r/, 'LF line endings: gremion-verify reads the placed file line by line')
  const doc = parseYaml(text)
  assert.deepEqual(Object.keys(doc), ['http'])
  assert.deepEqual(Object.keys(doc.http).sort(), ['middlewares', 'routers'], 'no service, no TLS store, nothing but a router and its pin')
  const routers = Object.entries(doc.http.routers)
  assert.equal(routers.length, 1)
  const [name, r] = routers[0]
  assert.equal(name, 'public-host')
  assert.doesNotMatch(name, /^tenant-/, 'a tenant-* router name belongs to the emitter')
  assert.deepEqual(r.entryPoints, ['websecure'])
  assert.equal(r.service, 'public@file', 'the colour-bound portal service of active.yml: a colour switch never rewrites this router')
  assert.equal(r.tls?.certResolver, 'le-http', 'a bare tls: {} serves the default certificate')
  const m = /^Host\(`([a-z0-9.-]+)`\)$/.exec(r.rule)
  assert.ok(m, `the rule is exactly one literal lower-case Host(): ${r.rule}`)
  assert.match(m[1], /(^|\.)example(\.(org|com|net))?$/, `the template names an RFC 2606 host, never a real one: ${m[1]}`)
  // the runbook's own check after substituting the host: `grep -c` prints 2, the rule and the pin
  assert.equal(text.split(/\n/).filter((l) => l.includes(m[1])).length, 2, 'the placeholder host stands on exactly two lines, so the runbook count of 2 holds')
  // the line shape gremion-verify's reader of etc/edge files understands
  assert.match(text, /^ {4}public-host:$/m)
  assert.match(text, /^ {6}rule: "Host\(`[a-z0-9.-]+`\)"$/m)
})

test('portal router template: its own pin first with the router host, then HSTS and the portal rate limit, and nothing else', () => {
  const doc = parseYaml(read(TEMPLATE))
  const r = doc.http.routers['public-host']
  const host = /^Host\(`([a-z0-9.-]+)`\)$/.exec(r.rule)[1]
  const declared = Object.keys(doc.http.middlewares)
  assert.equal(declared.length, 1, 'the file declares its pin and no other middleware')
  const pin = declared[0]
  assert.match(pin, /^edge-hostpin-./, 'gremion-verify fails any file-provider middleware that is not edge-hostpin-* or edge-perip-*')
  assert.doesNotMatch(pin, /^edge-hostpin-[a-z0-9-]+$/, 'a name inside the tenant-slug alphabet is one a tenant file (edge-hostpin-<slug>[-i]) could also declare')
  assert.deepEqual(r.middlewares, [`${pin}@file`, 'edge-hsts-custom@docker', 'edge-ratelimit-portal@docker'])
  const headers = doc.http.middlewares[pin].headers?.customRequestHeaders ?? {}
  assert.deepEqual(Object.keys(headers), ['X-Forwarded-Host'])
  assert.equal(headers['X-Forwarded-Host'], host, 'the pin stamps the router\'s own host')
  assert.ok(!r.middlewares.includes('gremion-ui-proxytrust@docker'), 'the app\'s proxy-trust secret never reaches the portal')
})

test('portal router template: every @docker middleware it chains is declared on the traefik container, and the verifier knows its names', () => {
  const doc = parseYaml(read(TEMPLATE))
  const r = doc.http.routers['public-host']
  const prod = read('docker-compose.prod.yml')
  const viaDocker = r.middlewares.map(ref).filter((x) => x.provider === 'docker')
  assert.equal(viaDocker.length, 2)
  for (const { base } of viaDocker) {
    assert.match(prod, new RegExp(`^\\s+- "traefik\\.http\\.middlewares\\.${base}\\.`, 'm'), `${base} is not a label of the traefik service in docker-compose.prod.yml`)
  }
  assert.match(prod, /^\s+- "traefik\.http\.middlewares\.edge-ratelimit-portal\.ratelimit\.average=[1-9]\d*"$/m, 'the portal tier is a real limiter')
  assert.match(prod, /^\s+- "traefik\.http\.middlewares\.edge-hsts-custom\.headers\.stsseconds=[1-9]\d*"$/m, 'the HSTS middleware sends a max-age')
  const verify = read('infra/host/bin/gremion-verify')
  const pin = Object.keys(doc.http.middlewares)[0]
  assert.ok(verify.includes('"public-host.yml"'), 'gremion-verify does not name the placed file')
  assert.ok(verify.includes(`"${pin}"`), `gremion-verify does not name the pin ${pin}`)
})
