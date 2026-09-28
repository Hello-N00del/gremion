// TASK-015 TDD item 4: identity check (ALERT_SMTP_USER = ALERT_EMAIL_FROM = alerts@<domain>).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { identityViolations, main } from './check-identities.mjs'
import { envMap } from './lib/env.mjs'
import { generateFixtureEnvs } from './lib/fixture-env.mjs'

const mail = { PLATFORM_DOMAIN: 'example.org', ALERT_SMTP_PASSWORD: 'fixture-alert-smtp-value' }
const ops = {
  PLATFORM_DOMAIN: 'example.org',
  ALERT_SMTP_HOST: 'mail.example.org',
  ALERT_SMTP_USER: 'alerts@example.org',
  ALERT_EMAIL_FROM: 'alerts@example.org',
  ALERT_SMTP_PASSWORD: 'fixture-alert-smtp-value',
}

test('a consistent alerts@ identity passes', () => {
  assert.deepEqual(identityViolations(mail, ops), { unparseable: null, violations: [] })
})

test('the fixtures generated from the real templates are consistent (both operator keys answered alerts@)', () => {
  const f = generateFixtureEnvs()
  assert.deepEqual(identityViolations(envMap(f['mail.env']), envMap(f['ops.env'])).violations, [])
})

test('ALERT_EMAIL_FROM differing from ALERT_SMTP_USER is RED (the old alerts@example.org default)', () => {
  const r = identityViolations({ ...mail, PLATFORM_DOMAIN: 'vendor.example' }, { ...ops, PLATFORM_DOMAIN: 'vendor.example', ALERT_SMTP_HOST: 'mail.vendor.example', ALERT_SMTP_USER: 'alerts@vendor.example' })
  assert.deepEqual(r.violations, ['ops.env ALERT_EMAIL_FROM is alerts@example.org; it must be alerts@vendor.example (the alerts@ principal; must-match-sender refuses anything else with 5.7.1)'])
})

test('an operator sentinel left in either key is RED, naming the key', () => {
  const r = identityViolations(mail, { ...ops, ALERT_SMTP_USER: 'CHANGE_ME_OPERATOR_alert_smtp_user' })
  assert.match(r.violations.join('\n'), /ALERT_SMTP_USER still holds its operator sentinel/)
})

test('alert_smtp drift between mail.env and ops.env is RED without printing either value', () => {
  const r = identityViolations(mail, { ...ops, ALERT_SMTP_PASSWORD: 'fixture-other-value' })
  assert.match(r.violations.join('\n'), /ALERT_SMTP_PASSWORD differs between mail\.env and ops\.env/)
  assert.ok(!r.violations.join('\n').includes('fixture-'))
})

test('a foreign submission host and a domain disagreement are RED', () => {
  const r = identityViolations(mail, { ...ops, PLATFORM_DOMAIN: 'other.example', ALERT_SMTP_HOST: 'smtp.relay.example' })
  assert.equal(r.violations.length, 2)
})

test('the CLI exits 1 on a mismatch and 2 on an unreadable file', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 't015-id-'))
  try {
    writeFileSync(path.join(d, 'mail.env'), 'PLATFORM_DOMAIN=example.org\nALERT_SMTP_PASSWORD=x\n')
    writeFileSync(path.join(d, 'ops.env'), 'PLATFORM_DOMAIN=example.org\nALERT_SMTP_USER=alerts@example.org\nALERT_EMAIL_FROM=ops@example.org\nALERT_SMTP_PASSWORD=x\n')
    const quiet = { log() {}, error() {} }
    assert.equal(main(['--mail-env', path.join(d, 'mail.env'), '--ops-env', path.join(d, 'ops.env')], quiet), 1)
    assert.equal(main(['--mail-env', path.join(d, 'nope.env'), '--ops-env', path.join(d, 'ops.env')], quiet), 2)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
