#!/usr/bin/env node
// node --test scripts/check-access-reader-wired.test.mjs
//
// TRD-092 deploy wiring for the council-admin access-record view. The role
// (gremion_ui_oac) is made by `gremion-tenant init` (ensureAccessReader, gated
// on UI_OAC_DB_PASSWORD) and gremion-ui connects as it through
// PLATFORM_ACCESS_DATABASE_URL. This guard pins every hop: the password is
// generated once by the secrets bootstrap (one sentinel group, state.env + both
// colours), the init one-shot receives it, gremion-ui's URL is built from it
// (no inline secret), and the dev generator and docs know it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function serviceBlock(text, name) {
  const start = text.search(new RegExp(`^  ${name}:`, 'm'))
  assert.ok(start >= 0, `service ${name} not found`)
  const rest = text.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:/m)
  return next < 0 ? rest : rest.slice(0, next)
}

test('app.env and state.env templates share one generated sentinel group for UI_OAC_DB_PASSWORD', () => {
  for (const f of ['app.env.tmpl', 'state.env.tmpl']) {
    assert.match(read(`infra/host/templates/env/${f}`), /^UI_OAC_DB_PASSWORD=CHANGE_ME_GEN_alnum32_ui_oac_db$/m, f)
  }
})

test('compose tenant-create passes a required UI_OAC_DB_PASSWORD to init', () => {
  const b = serviceBlock(read('docker-compose.app.yml'), 'tenant-create')
  assert.match(b, /^\s+UI_OAC_DB_PASSWORD: \$\{UI_OAC_DB_PASSWORD:\?/m)
})

test('compose gremion-ui gets PLATFORM_ACCESS_DATABASE_URL built from the secret, direct to gremion_platform', () => {
  const b = serviceBlock(read('docker-compose.app.yml'), 'gremion-ui')
  const m = b.match(/^\s+PLATFORM_ACCESS_DATABASE_URL: (.+)$/m)
  assert.ok(m, 'PLATFORM_ACCESS_DATABASE_URL missing')
  assert.match(m[1], /^postgresql:\/\/gremion_ui_oac:\$\{UI_OAC_DB_PASSWORD:\?[^}]+\}@postgres-\$\{STACK:\?[^}]+\}:5432\/gremion_platform$/)
})

test('the dev generator mints UI_OAC_DB_PASSWORD (.env.example placeholder replaced by setup.sh)', () => {
  const m = read('.env.example').match(/^UI_OAC_DB_PASSWORD=(CHANGE_ME\w+)$/m)
  assert.ok(m, 'UI_OAC_DB_PASSWORD missing from .env.example')
  assert.ok(read('scripts/setup.sh').includes(m[1]), `${m[1]} not replaced by setup.sh`)
})

test('the pooled-stack proof renders UI_OAC_DB_PASSWORD into app env', () => {
  assert.match(read('test/host/integration/pooled-stack-proof.sh'), /^UI_OAC_DB_PASSWORD=/m)
})

test('the layout doc names the role and its variable', () => {
  const d = read('docs/ops/pooled-stack-layout.md')
  assert.ok(d.includes('UI_OAC_DB_PASSWORD') && d.includes('gremion_ui_oac'))
})
