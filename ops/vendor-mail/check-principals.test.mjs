// TASK-015 TDD item 8: the principal guard.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE_DIR, main, principalViolations } from './check-principals.mjs'
import { loadAllowances } from './lib/allowances.mjs'

const ALLOW = loadAllowances()
const load = () => ({
  principals: JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'principals.json'), 'utf8')),
  realms: JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'realms.json'), 'utf8')),
})
const realm = (name, user, from = user) => ({ realm: name, smtp: { user, from, host: 'mail.example.org' } })
const withRealm = (r) => {
  const x = load()
  x.realms = x.realms.filter((y) => y.realm !== r.realm).concat(r)
  return x
}
const check = (x, o) => principalViolations(x, ALLOW, o)

test('the committed fixtures are separate (verify mode passes)', () => {
  assert.deepEqual(check(load()), { unparseable: null, violations: [] })
  assert.equal(main([], { log() {}, error() {} }), 0)
})

test('kc-a@ on two customer realms is RED', () => {
  const r = check(withRealm(realm('gamma_council', 'kc-alpha_council@example.org')))
  assert.deepEqual(r.violations, ['customer realms alpha_council, gamma_council share the principal kc-alpha_council@example.org'])
})

test('a customer realm on system@ (the vendor principal) is RED', () => {
  const r = check(withRealm(realm('gamma_council', 'system@example.org')))
  assert.deepEqual(r.violations, ['customer realm gamma_council shares the vendor\'s own principal system@example.org'])
})

test('a customer realm on alerts@ or roles@ is RED too', () => {
  assert.match(check(withRealm(realm('gamma_council', 'alerts@example.org'))).violations.join('\n'), /shares the vendor's own principal alerts@/)
  assert.match(check(withRealm(realm('gamma_council', 'roles@example.org'))).violations.join('\n'), /shares the vendor's own principal roles@/)
})

test('a vendor realm on a customer principal is RED', () => {
  const x = load()
  x.realms = x.realms.map((r) => (r.realm === 'master' ? realm('master', 'kc-alpha_council@example.org') : r))
  assert.match(check(x).violations.join('\n'), /vendor realm master sends as kc-alpha_council@example\.org, not as a vendor principal/)
})

test('a realm user with no principal is RED', () => {
  assert.deepEqual(check(withRealm(realm('gamma_council', 'kc-gamma_council@example.org'))).violations, ['realm gamma_council: SMTP user kc-gamma_council@example.org is no principal on the vendor\'s Stalwart'])
})

test('a realm whose From is not its user is RED (must-match-sender)', () => {
  assert.match(check(withRealm(realm('beta_council', 'kc-beta_council@example.org', 'no-reply@example.org'))).violations.join('\n'), /From no-reply@example\.org is not its SMTP user/)
})

test('an orphan kc-* principal is RED', () => {
  const x = load()
  x.principals.push({ name: 'kc-delta_council@example.org', emails: ['kc-delta_council@example.org'], roles: ['user'] })
  assert.deepEqual(check(x).violations, ['orphan principal kc-delta_council@example.org: no realm sends as it -- revoke it (principals.mjs revoke)'])
})

test('platform@ on customer realms: allowed while transitional, RED under --no-allowances', () => {
  const x = withRealm(realm('gamma_council', 'platform@example.org'))
  x.realms.push(realm('delta_council', 'platform@example.org'))
  assert.deepEqual(check(x).violations, [])
  const r = check(x, { useAllowances: false })
  assert.match(r.violations.join('\n'), /customer realm gamma_council sends as the transitional platform@ principal \(--no-allowances\)/)
  assert.match(r.violations.join('\n'), /customer realms gamma_council, delta_council share the principal platform@example\.org/)
})

test('vendor realms stay allowed under --no-allowances (structural, not transitional)', () => {
  assert.deepEqual(check(load(), { useAllowances: false }).violations, [])
})

test('an API {"error":...} body, zero principals or zero realms on a host are unparseable (exit 2)', () => {
  assert.match(check({ principals: { error: 'forbidden' }, realms: [] }).unparseable, /principals is not an array \(API error: forbidden\)/)
  assert.match(check({ principals: [], realms: load().realms }, { host: true }).unparseable, /zero principals/)
  assert.match(check({ principals: load().principals, realms: [] }, { host: true }).unparseable, /zero realms/)
  assert.equal(main(['--host', '--dir', '/nonexistent-t015'], { log() {}, error() {} }), 2)
})

test('host mode: the vendor realm master with no SMTP user is RED (realm-smtp never ran, or was undone)', () => {
  const x = load()
  x.realms = x.realms.map((r) => (r.realm === 'master' ? { realm: 'master', smtp: { user: null, from: null, host: null } } : r))
  assert.deepEqual(check(x, { host: true }).violations, ['vendor realm master has no SMTP user: run gremion-vendor-mail realm-smtp'])
})

test('a realm with a From or a host but no user (an unauthenticated or third-party sender) is RED', () => {
  const r = check(withRealm({ realm: 'gamma_council', smtp: { user: '', from: 'system@example.org', host: 'mail.example.org' } }))
  assert.match(r.violations.join('\n'), /realm gamma_council: sends \(host mail\.example\.org, From system@example\.org\) without an SMTP user/)
  const q = check(withRealm({ realm: 'gamma_council', smtp: { user: null, from: null, host: 'smtp.relay.example.com' } }))
  assert.match(q.violations.join('\n'), /realm gamma_council: sends \(host smtp\.relay\.example\.com, From <none>\) without an SMTP user/)
})

test('a customer realm on a principal that is neither kc-* nor transitional is RED', () => {
  const x = withRealm(realm('gamma_council', 'billing@example.org'))
  x.principals.push({ name: 'billing@example.org', emails: ['billing@example.org'], roles: ['user'] })
  assert.deepEqual(check(x).violations, ['customer realm gamma_council sends as billing@example.org, not as a kc-<tenant token>@ principal'])
})

test('--dir without a value is a usage error, not the default directory', () => {
  assert.equal(main(['--dir'], { log() {}, error() {} }), 2)
})
