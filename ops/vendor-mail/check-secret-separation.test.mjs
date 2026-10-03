// TASK-015 TDD items 2 and 3: the TRD-251 separation guard.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  composeViolations,
  fixtureProjects,
  hostViolations,
  main,
  runCompose,
  staticViolations,
} from './check-secret-separation.mjs'
import { loadAllowances } from './lib/allowances.mjs'
import { readTemplates, REPO_ROOT } from './lib/env.mjs'
import { FIXTURE_REL, fixtureDrift } from './lib/fixture-env.mjs'

const ALLOW = loadAllowances()
const NONE = { ...ALLOW, separation: [] }
const real = () => readTemplates()
const withLine = (templates, file, line) => ({ ...templates, [file]: `${templates[file]}\n${line}\n` })

// ── (a) templates ──────────────────────────────────────────────────────────

test('(a) the real templates pass with the one transitional allowance', () => {
  const r = staticViolations(real(), ALLOW)
  assert.deepEqual(r.violations, [])
  assert.ok(r.used.has('platform-smtp-transitional'))
})

test('(a) without the allowance the real tree is RED on app.env.tmpl PLATFORM_SMTP_PASSWORD (platform_smtp)', () => {
  const r = staticViolations(real(), NONE)
  const line = real()['app.env.tmpl'].split('\n').findIndex((l) => l.startsWith('PLATFORM_SMTP_PASSWORD=')) + 1
  // both halves are true: the GROUP is shared, and the KEY is a vendor key
  assert.equal(r.violations.length, 2, r.violations.join('\n'))
  assert.match(r.violations[0], new RegExp(`^app\\.env\\.tmpl:${line} PLATFORM_SMTP_PASSWORD shares the vendor generator group 'platform_smtp' with PLATFORM_SMTP_PASSWORD \\(mail\\.env\\.tmpl:\\d+\\)`))
  assert.equal(r.violations[1], `app.env.tmpl:${line} declares the vendor key PLATFORM_SMTP_PASSWORD in the connector set`)
})

test('(a) a connector key seeded with a vendor group is RED (EMAIL_HOST_PASSWORD=..._vendor_smtp)', () => {
  const r = staticViolations(withLine(real(), 'app.env.tmpl', 'EMAIL_HOST_PASSWORD=CHANGE_ME_GEN_alnum32_vendor_smtp'), ALLOW)
  assert.equal(r.violations.length, 1)
  assert.match(r.violations[0], /EMAIL_HOST_PASSWORD shares the vendor generator group 'vendor_smtp'/)
})

test('(a) groups, not key names: a renamed connector key holding alert_smtp is RED', () => {
  const r = staticViolations(withLine(real(), 'app.env.tmpl', 'NOTIFY_SECRET=CHANGE_ME_GEN_alnum32_alert_smtp'), ALLOW)
  assert.match(r.violations.join('\n'), /NOTIFY_SECRET shares the vendor generator group 'alert_smtp'/)
})

test('(a) EMAIL_HOST_PASSWORD is in the connector set in ANY template, not only app.env.tmpl', () => {
  const r = staticViolations(withLine(real(), 'state.env.tmpl', 'EMAIL_HOST_PASSWORD=CHANGE_ME_GEN_alnum32_stalwart_admin'), ALLOW)
  assert.match(r.violations.join('\n'), /^state\.env\.tmpl:\d+ EMAIL_HOST_PASSWORD shares the vendor generator group 'stalwart_admin'/m)
})

test('(a) a vendor key name in the connector set is RED even with a fresh group', () => {
  const r = staticViolations(withLine(real(), 'app.env.tmpl', 'STALWART_API_KEY=CHANGE_ME_GEN_hex32_app_only'), ALLOW)
  assert.match(r.violations.join('\n'), /declares the vendor key STALWART_API_KEY in the connector set/)
})

test('(a) a stale allowance (its pair gone) is RED, never a silent pass', () => {
  const t = real()
  const noPair = { ...t, 'app.env.tmpl': t['app.env.tmpl'].replace(/^PLATFORM_SMTP_PASSWORD=.*$/m, '') }
  const r = staticViolations(noPair, ALLOW)
  assert.match(r.violations.join('\n'), /stale allowance 'platform-smtp-transitional'/)
})

// ── (b) rendered compose ───────────────────────────────────────────────────

const VENDOR = {
  STALWART_ADMIN_PASSWORD: 'fixture-stalwart-admin-value',
  STALWART_API_KEY: 'fixture-stalwart-api-value',
  VENDOR_SMTP_PASSWORD: 'fixture-vendor-smtp-value',
  ALERT_SMTP_PASSWORD: 'fixture-alert-smtp-value',
  PLATFORM_SMTP_PASSWORD: 'fixture-platform-smtp-value',
}
const svc = (environment) => ({ services: { 'gremion-ui': { environment } } })
const renders = (over = {}) =>
  [
    { id: 'state', render: { services: { keycloak: { environment: { A: 'x' } } } } },
    { id: 'app-blue', render: svc({ B: 'y' }) },
    { id: 'app-green', render: svc({ B: 'y' }) },
    { id: 'ops', render: { services: { grafana: { environment: {} } } } },
    { id: 'mail', render: { services: { stalwart: { environment: { STALWART_PATH: '/opt/stalwart' } } } } },
  ].map((r) => (r.id in over ? { id: r.id, render: over[r.id] } : r))

test('(b) the committed fixtures are what the generator makes of the current templates', () => {
  assert.deepEqual(fixtureDrift(), [], 'regenerate with node ops/vendor-mail/lib/fixture-env.mjs --write')
})

test('(b) the real five-project render from the fixtures is GREEN, with app services present', async () => {
  const r = await runCompose()
  assert.equal(r.unparseable, null)
  assert.deepEqual(r.violations, [])
  assert.ok(r.appServices > 0)
})

test('(b) an override `environment: X: ${STALWART_API_KEY}` on an app service is RED', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 't015-sep-'))
  try {
    const base = readFileSync(path.join(REPO_ROOT, FIXTURE_REL, 'app-blue.env'), 'utf8')
    const override = path.join(dir, 'override.yml')
    writeFileSync(override, 'services:\n  gremion-ui:\n    environment:\n      X: ${STALWART_API_KEY}\n')
    const env = path.join(dir, 'app-blue.env')
    // The override is an ABSOLUTE path, which on Windows carries a drive
    // colon: join the list with the OS delimiter and declare it, so compose
    // splits it the same way on every OS.
    const withOverride = base
      .replace(/^COMPOSE_PATH_SEPARATOR=.*\r?\n/m, '')
      .replace(/^COMPOSE_FILE=(.*)$/m, (_, v) => `COMPOSE_FILE=${[...v.split(':'), override].join(path.delimiter)}\nCOMPOSE_PATH_SEPARATOR=${path.delimiter}`)
    writeFileSync(env, withOverride + 'STALWART_API_KEY=fixture-stalwart-api-value\n')
    const projects = (await fixtureProjects()).map((p) => (p.id === 'app-blue' ? { ...p, envFile: env } : p))
    const r = await runCompose({ projects })
    assert.equal(r.unparseable, null)
    assert.deepEqual(r.violations, ['app-blue/gremion-ui: environment X resolves to the vendor secret STALWART_API_KEY'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('(b) an embedded vendor value (a URL password) is RED too', () => {
  const r = composeViolations(renders({ 'app-blue': svc({ SMTP_URL: 'smtp://system:fixture-vendor-smtp-value@mail' }) }), VENDOR, ALLOW)
  assert.match(r.violations.join('\n'), /SMTP_URL resolves to the vendor secret VENDOR_SMTP_PASSWORD/)
})

test('(b) an ops service holding the alerts@ password in its environment is RED', () => {
  const r = composeViolations(renders({ ops: { services: { grafana: { environment: { P: 'fixture-alert-smtp-value' } } } } }), VENDOR, ALLOW)
  assert.match(r.violations.join('\n'), /ops\/grafana: environment P resolves to the vendor secret ALERT_SMTP_PASSWORD/)
})

test('(b) zero app services is RED (the arm read nothing)', () => {
  const r = composeViolations(renders({ 'app-blue': { services: {} }, 'app-green': { services: {} } }), VENDOR, ALLOW)
  assert.match(r.violations.join('\n'), /zero app services rendered/)
})

test('(b) a render failure is unparseable, never "no finding"', async () => {
  const r = await runCompose({
    render: (p) => {
      if (p.id === 'ops') throw new Error('docker compose config refused (exit 15)')
      return { services: { x: {} } }
    },
  })
  assert.match(r.unparseable, /ops: render failed: docker compose config refused/)
})

test('(b) collapsed vendor values (one value for every group) are RED as vacuous', () => {
  const same = Object.fromEntries(Object.keys(VENDOR).map((k) => [k, 'fixture-one-value']))
  const r = composeViolations(renders(), same, ALLOW)
  assert.match(r.violations.join('\n'), /share one fixture value -- the comparison cannot tell them apart \(vacuous\)/)
})

// ── --host ─────────────────────────────────────────────────────────────────

function hostTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 't015-host-'))
  const env = path.join(root, 'env')
  const sec = path.join(root, 'secrets')
  mkdirSync(env)
  mkdirSync(path.join(sec, 'mail'), { recursive: true })
  mkdirSync(path.join(sec, 'tenants', 'alpha'), { recursive: true })
  writeFileSync(path.join(env, 'mail.env'), Object.entries(VENDOR).map(([k, v]) => `${k}=${v}`).join('\n') + '\nPLATFORM_DOMAIN=example.org\n')
  for (const c of ['blue', 'green']) writeFileSync(path.join(env, `app-${c}.env`), 'PLATFORM_DOMAIN=example.org\nPLATFORM_SMTP_PASSWORD=fixture-platform-smtp-value\nAUTH_SECRET=other\n')
  writeFileSync(path.join(env, 'state.env'), 'PLATFORM_DOMAIN=example.org\n')
  writeFileSync(path.join(env, 'ops.env'), 'PLATFORM_DOMAIN=example.org\nALERT_SMTP_PASSWORD=fixture-alert-smtp-value\nSTALWART_API_KEY=fixture-stalwart-api-value\n')
  writeFileSync(path.join(sec, 'mail', 'g2026a.private'), 'dkim-key-fixture')
  writeFileSync(path.join(sec, 'tenants', 'alpha', 'smtp-password'), 'tenant-own-value')
  return { root, env, sec }
}

test('--host: separate stores pass (the transitional platform@ pair is allowed)', () => {
  const t = hostTree()
  try {
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW })
    assert.equal(r.unparseable, null)
    assert.deepEqual(r.violations, [])
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: a tenant secret equal to VENDOR_SMTP_PASSWORD is RED, and no value is printed', async () => {
  const t = hostTree()
  try {
    writeFileSync(path.join(t.sec, 'tenants', 'alpha', 'smtp-password'), 'fixture-vendor-smtp-value\n')
    const lines = []
    const log = { log: (s) => lines.push(s), error: (s) => lines.push(s) }
    const code = await main(['--host', '--env-dir', t.env, '--secrets-dir', t.sec, '--ui-env', path.join(t.root, 'none.tsv')], log)
    // the ui-env file is absent: that alone is unparseable (exit 2) ...
    assert.equal(code, 2)
    writeFileSync(path.join(t.root, 'ui.tsv'), '')
    lines.length = 0
    const code2 = await main(['--host', '--env-dir', t.env, '--secrets-dir', t.sec, '--ui-env', path.join(t.root, 'ui.tsv')], log)
    assert.equal(code2, 1)
    assert.match(lines.join('\n'), /FAIL secrets\/tenants\/alpha\/smtp-password holds the vendor secret mail\.env VENDOR_SMTP_PASSWORD/)
    for (const v of Object.values(VENDOR)) assert.ok(!lines.join('\n').includes(v), `printed ${v}`)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: a gremion-ui container env value equal to ALERT_SMTP_PASSWORD (by hash) is RED', async () => {
  const t = hostTree()
  try {
    const { createHash } = await import('node:crypto')
    const h = createHash('sha256').update('fixture-alert-smtp-value').digest('hex')
    writeFileSync(path.join(t.root, 'ui.tsv'), `green\tMAILER_PW\t${h}\n`)
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: path.join(t.root, 'ui.tsv'), allowances: ALLOW })
    assert.deepEqual(r.violations, ['gremion-ui (green) env MAILER_PW holds the vendor secret mail.env ALERT_SMTP_PASSWORD'])
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('verify mode runs the compose arm: a compose finding fails main() with exit 1', async () => {
  const lines = []
  const log = { log: (x) => lines.push(x), error: (x) => lines.push(x) }
  let called = 0
  const code = await main([], log, {
    compose: async () => {
      called++
      return { unparseable: null, violations: ['app-blue/gremion-ui: environment X resolves to the vendor secret STALWART_API_KEY'], appServices: 8 }
    },
  })
  assert.equal(called, 1)
  assert.equal(code, 1)
  assert.match(lines.join('\n'), /FAIL \(b\) app-blue\/gremion-ui/)
  const code2 = await main([], log, { compose: async () => ({ unparseable: 'ops: render failed', violations: [], appServices: 0 }) })
  assert.equal(code2, 2)
})

test('--host: an unreadable NESTED tenant directory is unparseable too', () => {
  const t = hostTree()
  try {
    const lister = (d) => {
      if (d.endsWith(`${path.sep}alpha`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return readdirSyncReal(d)
    }
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW, io: { lister } })
    assert.match(r.unparseable ?? '', /secrets\/tenants: EACCES/)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: two vendor keys sharing one value are RED, and cannot ride the platform allowance (review A1/B3/C1)', () => {
  const t = hostTree()
  try {
    // system@'s password equal to platform@'s: the app tier's allowed
    // PLATFORM_SMTP_PASSWORD would then BE system@'s password.
    writeFileSync(path.join(t.env, 'mail.env'), readFileSync(path.join(t.env, 'mail.env'), 'utf8').replace('VENDOR_SMTP_PASSWORD=fixture-vendor-smtp-value', 'VENDOR_SMTP_PASSWORD=fixture-platform-smtp-value'))
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW })
    assert.match(r.violations.join('\n'), /mail\.env PLATFORM_SMTP_PASSWORD holds the same value as mail\.env VENDOR_SMTP_PASSWORD -- two vendor secrets are one/)
    assert.match(r.violations.join('\n'), /app-blue\.env PLATFORM_SMTP_PASSWORD holds the vendor secret mail\.env VENDOR_SMTP_PASSWORD/)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: a vendor value EMBEDDED in a connector value (a URL password) is RED', () => {
  const t = hostTree()
  try {
    writeFileSync(path.join(t.env, 'app-green.env'), 'PLATFORM_DOMAIN=example.org\nSMTP_URL=smtp://alerts:fixture-alert-smtp-value@mail.example.org:587\n')
    writeFileSync(path.join(t.sec, 'tenants', 'alpha', 'config.json'), '{"smtp":{"password":"fixture-stalwart-api-value"}}')
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW })
    assert.match(r.violations.join('\n'), /app-green\.env SMTP_URL holds the vendor secret mail\.env ALERT_SMTP_PASSWORD/)
    assert.match(r.violations.join('\n'), /secrets\/tenants\/alpha\/config\.json holds the vendor secret mail\.env STALWART_API_KEY/)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: ops.env may hold its two vendor keys, and nothing else of the vendor', () => {
  const t = hostTree()
  try {
    writeFileSync(path.join(t.env, 'ops.env'), readFileSync(path.join(t.env, 'ops.env'), 'utf8') + 'EXTRA=fixture-stalwart-admin-value\n')
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW })
    assert.deepEqual(r.violations, ['ops.env EXTRA holds the vendor secret mail.env STALWART_ADMIN_PASSWORD'])
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: state.env (the council tier) is in the connector set', () => {
  const t = hostTree()
  try {
    writeFileSync(path.join(t.env, 'state.env'), 'KEYCLOAK_SMTP_PASSWORD=fixture-vendor-smtp-value\n')
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW })
    assert.deepEqual(r.violations, ['state.env KEYCLOAK_SMTP_PASSWORD holds the vendor secret mail.env VENDOR_SMTP_PASSWORD'])
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('--host: an unreadable store is unparseable, not empty', () => {
  const t = hostTree()
  try {
    const lister = (d) => {
      if (d.endsWith(`${path.sep}tenants`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return readdirSyncReal(d)
    }
    const r = hostViolations({ envDir: t.env, secretsDir: t.sec, uiEnvFile: null, allowances: ALLOW, io: { lister } })
    assert.match(r.unparseable ?? '', /cannot read the connector store secrets\/tenants: EACCES/)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

import { readdirSync as readdirSyncReal } from 'node:fs'
