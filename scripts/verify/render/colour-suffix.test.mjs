// TASK-053: G-053-colour-suffix, the one reference predicate (brief S1, TDD 3/4).
// Synthetic renders shaped like `docker compose config --format json`; the
// real template (infra/host/templates/env/app.env.tmpl) is read where a case
// says so. No docker here: these files also run in verify's `unit` suite.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIRST_PARTY_IMAGE } from '../../check-pooled-stack.mjs'
import {
  appTierServiceNames,
  claimingName,
  colourSuffixGuard,
  FIRST_PARTY_PREFIX,
  hostTokens,
  longestFirst,
  MIN_DERIVED_NAMES,
  readAppTemplate,
  renderColourViolations,
  templateColourViolations,
  templateDerivedNames,
} from './colour-suffix.mjs'

const P = FIRST_PARTY_PREFIX

function appRender(colour, extraEnv = {}) {
  return {
    services: {
      'gremion-ui': {
        image: `${P}ui@sha256:1111`,
        environment: {
          COLOUR: colour,
          INTERNAL_BASE_URL: `http://gremion-ui-${colour}:3000`,
          DATABASE_URL: 'postgresql://u:p@pgbouncer-guardstack:6432/gremion',
          AUTH_KEYCLOAK_INTERNAL: 'https://keycloak:8443/auth/realms/gremion',
          ...extraEnv,
        },
      },
      'gremion-public': { image: `${P}public@sha256:2222`, environment: { COLOUR: colour } },
      migrate: { image: `${P}migrate@sha256:3333`, environment: { COLOUR: colour } },
      'tenant-create': { image: `${P}migrate:dist`, environment: { COLOUR: colour, INTERNAL_BASE_URL: `http://gremion-ui-${colour}:3000` } },
    },
  }
}

const TEMPLATE = [
  '# COLOUR RULE: a bare gremion-ui or content-service would resolve to either colour',
  'COLOUR=${COLOUR}',
  'INTERNAL_BASE_URL=http://gremion-ui-${COLOUR}:3000',
  'CONTENT_SERVICE_URL=http://content-service-${COLOUR}:8080',
  'VAULT_SERVICE_URL=http://vault-service-${COLOUR}:8080',
  'AUTH_KEYCLOAK_ID=gremion-ui',
  'GREMION_PUBLIC_DB_URL=postgresql://reader:x@postgres:5432/gremion',
  '',
].join('\n')

const guard = (appRenders, templateText = TEMPLATE) => colourSuffixGuard({ appRenders, templateText })
const problemsOf = (g) => g.checks.flatMap((c) => c.problems)
const both = (blueEnv = {}, greenEnv = {}) => ({ blue: appRender('blue', blueEnv), green: appRender('green', greenEnv) })

// ── G2 contract: one prefix, a leaf module ─────────────────────────────────

test('the declared prefix equals check-pooled-stack FIRST_PARTY_IMAGE', () => {
  assert.equal(FIRST_PARTY_IMAGE.source, `^${P.replace(/[.\/]/g, (c) => `\\${c}`)}`)
  assert.ok(FIRST_PARTY_IMAGE.test(`${P}anything`))
})

test('colour-suffix.mjs is a leaf: it imports neither check-pooled-stack nor the harness', () => {
  const src = readFileSync(path.join(import.meta.dirname, 'colour-suffix.mjs'), 'utf8')
  const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  for (const spec of imports) assert.match(spec, /^node:/, `colour-suffix.mjs imports ${spec}`)
})

// ── the real tree is GREEN ─────────────────────────────────────────────────

test('real app.env.tmpl: derives the eleven -${COLOUR} hosts and is clean; with app renders the guard is green', () => {
  const text = readAppTemplate()
  const fromTemplate = templateDerivedNames(text)
  assert.ok(fromTemplate.includes('gremion-ui'))
  assert.ok(fromTemplate.includes('content-service'))
  assert.ok(fromTemplate.length >= 10, fromTemplate.join(','))
  const g = guard(both(), text)
  assert.deepEqual(problemsOf(g), [])
  assert.ok(g.names.length >= MIN_DERIVED_NAMES)
  assert.deepEqual(g.checks.map((c) => c.id), ['app-blue', 'app-green', 'app.env.tmpl'])
})

// ── RED cases ──────────────────────────────────────────────────────────────

test('an unsuffixed INTERNAL_BASE_URL template line fails, naming line and key', () => {
  const t = TEMPLATE.replace('INTERNAL_BASE_URL=http://gremion-ui-${COLOUR}:3000', 'INTERNAL_BASE_URL=http://gremion-ui:3000')
  const p = problemsOf(guard(both(), t))
  assert.equal(p.length, 1, p.join('\n'))
  assert.match(p[0], /^app\.env\.tmpl:3: INTERNAL_BASE_URL names gremion-ui without the -\$\{COLOUR\} suffix/)
})

test('a template line with a literal colour fails (it must be ${COLOUR})', () => {
  // gremion-ui stays derived (renders + INTERNAL_BASE_URL); a second line pins blue
  const t = `${TEMPLATE}KERNEL_BASE_URL=http://gremion-ui-blue:3000\n`
  assert.match(problemsOf(guard(both(), t)).join('\n'), /KERNEL_BASE_URL names gremion-ui without the -\$\{COLOUR\} suffix/)
})

test('CONTENT_SERVICE_URL=http://content-service:8080 in a render fails (a template-derived name)', () => {
  const p = problemsOf(guard(both({ CONTENT_SERVICE_URL: 'http://content-service:8080' })))
  assert.equal(p.length, 1, p.join('\n'))
  assert.match(p[0], /^app-blue\/gremion-ui: environment\.CONTENT_SERVICE_URL names content-service without the -blue suffix/)
})

test('KERNEL_API_URL=http://kernel-api:3000 fails when kernel-api is known only by its image', () => {
  const r = both({ KERNEL_API_URL: 'http://kernel-api:3000' })
  for (const c of ['blue', 'green']) r[c].services['kernel-api'] = { image: `${P}kernel-api:dist`, environment: { COLOUR: c } }
  const p = problemsOf(guard(r))
  assert.equal(p.length, 1, p.join('\n'))
  assert.match(p[0], /app-blue\/gremion-ui: environment\.KERNEL_API_URL names kernel-api without the -blue suffix: http:\/\/kernel-api:3000/)
})

test('DB_HOST=gremion-ui fails (the whole value of a *_HOST key is a host)', () => {
  assert.match(problemsOf(guard(both({ DB_HOST: 'gremion-ui' }))).join('\n'), /environment\.DB_HOST names gremion-ui without the -blue suffix/)
})

test('the other colour is as wrong as none: -green in blue fails', () => {
  const p = problemsOf(guard(both({ KERNEL_BASE_URL: 'http://gremion-ui-green:3000' })))
  assert.equal(p.length, 1)
  assert.match(p[0], /app-blue\/gremion-ui: environment\.KERNEL_BASE_URL names gremion-ui without the -blue suffix/)
})

test('a stack suffix is not a colour: gremion-ui-guardstack fails', () => {
  assert.match(problemsOf(guard(both({ X_URL: 'http://gremion-ui-guardstack:3000' }))).join('\n'), /names gremion-ui without the -blue suffix/)
})

test('fewer than 3 derived names is vacuous, on every check', () => {
  const tiny = { blue: { services: { 'gremion-ui': { image: `${P}ui:x`, environment: {} } } }, green: { services: {} } }
  const g = guard(tiny, 'COLOUR=${COLOUR}\n')
  assert.ok(g.names.length < MIN_DERIVED_NAMES)
  for (const c of g.checks) assert.match(c.problems.join('\n'), /vacuous/, c.id)
})

// ── GREEN cases ────────────────────────────────────────────────────────────

test('AUTH_KEYCLOAK_ID=gremion-ui passes: a client id is a name, not a host', () => {
  assert.deepEqual(problemsOf(guard(both({ AUTH_KEYCLOAK_ID: 'gremion-ui' }))), [])
})

test('a # comment naming a bare gremion-ui passes (comments are skipped)', () => {
  const t = `${TEMPLATE}# INTERNAL_BASE_URL=http://gremion-ui:3000 was the old value\n`
  assert.deepEqual(problemsOf(guard(both(), t)), [])
})

test('state-tier hosts pass: postgres, keycloak, and legal referenced from the app tier', () => {
  const p = problemsOf(guard(both({ PG: 'postgresql://u:p@postgres:5432/x', KC: 'https://keycloak:8443', LEGAL_URL: 'http://legal:3000' })))
  assert.deepEqual(p, [])
})

test('longest name first: kernel-api-migrate-blue passes when kernel-api and kernel-api-migrate are both derived', () => {
  const r = both({ MIGRATE_URL: 'http://kernel-api-migrate-blue:3000', KERNEL_API_URL: 'http://kernel-api-blue:3000' }, {
    MIGRATE_URL: 'http://kernel-api-migrate-green:3000',
    KERNEL_API_URL: 'http://kernel-api-green:3000',
  })
  for (const c of ['blue', 'green']) {
    r[c].services['kernel-api'] = { image: `${P}kernel-api:x`, environment: { COLOUR: c } }
    r[c].services['kernel-api-migrate'] = { image: `${P}kernel-api:x`, environment: { COLOUR: c } }
  }
  const g = guard(r)
  assert.ok(g.names.indexOf('kernel-api-migrate') < g.names.indexOf('kernel-api'))
  assert.deepEqual(problemsOf(g), [])
  // ...and a bare kernel-api-migrate is judged as kernel-api-migrate, not kernel-api
  r.blue.services['gremion-ui'].environment.MIGRATE_URL = 'http://kernel-api-migrate:3000'
  assert.match(problemsOf(guard(r)).join('\n'), /names kernel-api-migrate without the -blue suffix/)
})

test('template-only names are judged by (b) only: no service of that name has to render', () => {
  const g = guard(both())
  assert.ok(g.names.includes('content-service'))
  assert.deepEqual(problemsOf(g), [])
})

// ── units ──────────────────────────────────────────────────────────────────

test('hostTokens: authority after // or @, the whole value of a *HOST key, nothing else', () => {
  assert.deepEqual(hostTokens('X_URL', 'postgresql://u:p@db-x:5432/y'), ['u', 'db-x'])
  assert.deepEqual(hostTokens('SMTP_HOST', 'gremion-ui'), ['gremion-ui'])
  assert.deepEqual(hostTokens('AUTH_KEYCLOAK_ID', 'gremion-ui'), [])
})

test('claimingName and longestFirst', () => {
  const names = longestFirst(['kernel-api', 'kernel-api-migrate', 'gremion-ui', 'kernel-api'])
  assert.deepEqual(names, ['kernel-api-migrate', 'gremion-ui', 'kernel-api'])
  assert.equal(claimingName('kernel-api-migrate-blue', names), 'kernel-api-migrate')
  assert.equal(claimingName('kernel-apix', names), null)
  assert.equal(claimingName('gremion-uiblue', names), null)
})

test('appTierServiceNames: app renders + template + caller extras, deduplicated', () => {
  const names = appTierServiceNames({ renders: [appRender('blue')], templateText: TEMPLATE, extra: ['files-service'] })
  for (const n of ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create', 'content-service', 'vault-service', 'files-service']) assert.ok(names.includes(n), n)
  assert.equal(new Set(names).size, names.length)
})

test('renderColourViolations and templateColourViolations keep TASK-040 message shapes', () => {
  const r = appRender('blue', { KERNEL_BASE_URL: 'http://gremion-ui:3000' })
  assert.deepEqual(renderColourViolations(r, 'blue', ['gremion-ui']), [
    'app-blue/gremion-ui: environment.KERNEL_BASE_URL names gremion-ui without the -blue suffix: http://gremion-ui:3000',
  ])
  assert.deepEqual(templateColourViolations('A_URL=http://x-svc:1\n', ['x-svc']), ['app.env.tmpl:1: A_URL names x-svc without the -${COLOUR} suffix: http://x-svc:1'])
})
