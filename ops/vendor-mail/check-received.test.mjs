// TASK-015 TDD item 9: the Received / Authentication-Results check.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { checkReceived, loadReceivers, main, parseAuthResults, unfoldHeaders } from './check-received.mjs'

const FX = path.join(import.meta.dirname, '__fixtures__', 'received')
const read = (n) => readFileSync(path.join(FX, n), 'utf8')
const { espMarkers } = loadReceivers()
const OPTS = { domain: 'example.org', bindIps: ['192.0.2.25', '2001:db8::25'], authservIds: ['mx.example.net'], espMarkers }
const check = (text, o = {}) => checkReceived(text, { ...OPTS, ...o })

// The substring greps gremion-mail-bringup ran before TASK-015 (6a: :618-625,
// 6b: :678-682), reproduced verbatim in intent: every verdict string and the
// bind address anywhere in the pasted file.
const oldGreps = (text) => ['dkim=pass', 'spf=pass', 'dmarc=pass', '192.0.2.25'].every((s) => text.includes(s))

test('recorded: the old substring greps PASS a message relayed through sendgrid', () => {
  assert.equal(oldGreps(read('esp-sendgrid.eml')), true)
})

test('the relayed (sendgrid) message is RED: foreign d=, ESP hop, no accepting hop from IP-B', () => {
  const r = check(read('esp-sendgrid.eml'))
  const s = r.reasons.join('\n')
  assert.match(s, /no dkim=pass with header\.d=example\.org/)
  assert.match(s, /third-party relay sendgrid\.net in Received/)
  assert.match(s, /third-party relay marker header X-SG-EID/)
  assert.match(s, /no Received hop accepted the message from 192\.0\.2\.25/)
})

test('an own-server delivery through two receiver gateway hops passes', () => {
  assert.deepEqual(check(read('good-two-gateway-hops.eml')), { unparseable: null, reasons: [] })
})

test('the IP-B address only in the BODY is RED (the header block ends at the first empty line)', () => {
  const t = read('ip-only-in-body.eml')
  assert.equal(oldGreps(t), true)
  assert.match(check(t).reasons.join('\n'), /no Received hop accepted the message from 192\.0\.2\.25/)
})

test('an Authentication-Results from a foreign authserv-id does not count', () => {
  const r = check(read('foreign-authserv-id.eml'))
  assert.match(r.reasons.join('\n'), /no Authentication-Results from the receiver \(mx\.example\.net\); saw mx\.attacker\.example/)
})

test('spf=pass for another domain is RED', () => {
  assert.deepEqual(check(read('spf-other-domain.eml')).reasons, ['no spf=pass for a mailfrom in example.org'])
})

test('a foreign dkim d= (header.d=example.com) is RED even with every verdict "pass"', () => {
  const t = read('good-two-gateway-hops.eml').replace('header.i=@example.org', 'header.i=@example.com')
  assert.deepEqual(check(t).reasons, ['no dkim=pass with header.d=example.org'])
})

test('an address that merely CONTAINS IP-B (192.0.2.250) is not the accepting hop', () => {
  const t = read('good-two-gateway-hops.eml').replace('[192.0.2.25])', '[192.0.2.250])')
  assert.match(check(t).reasons.join('\n'), /no Received hop accepted the message/)
})

test('a hop below the accepting one that is not by mail.<domain> is RED', () => {
  const t = read('good-two-gateway-hops.eml').replace('by mail.example.org (Stalwart SMTP)', 'by smtp.relay.example.com (Postfix)')
  assert.match(check(t).reasons.join('\n'), /a hop below the accepting one is by smtp\.relay\.example\.com, not mail\.example\.org/)
})

test('an accepting hop over IPv6 (IPv6: address literal) passes', () => {
  const t = read('good-two-gateway-hops.eml').replace('[192.0.2.25])', '[IPv6:2001:db8::25])')
  assert.deepEqual(check(t).reasons, [])
})

test('folded headers are unfolded before parsing (RFC 5322 2.2.3)', () => {
  const f = unfoldHeaders('Authentication-Results: mx.example.net;\n\tspf=pass\n smtp.mailfrom=a@example.org\n\nbody: x\n')
  assert.equal(f.length, 1)
  assert.equal(parseAuthResults(f[0].value).results[0].props['smtp.mailfrom'], 'a@example.org')
})

test('comments inside Authentication-Results cannot smuggle a verdict', () => {
  const r = parseAuthResults(' mx.example.net; spf=fail (was dkim=pass header.d=example.org) smtp.mailfrom=a@example.org')
  assert.deepEqual(r.results.map((x) => `${x.method}=${x.result}`), ['spf=fail'])
})

test('the CLI: exit 0 on a proof, 1 on a relay, 2 without --file', () => {
  const quiet = { log() {}, error() {} }
  const base = ['--domain', 'example.org', '--bind-ip', '192.0.2.25', '--authserv-id', 'mx.example.net']
  assert.equal(main(['--file', path.join(FX, 'good-two-gateway-hops.eml'), ...base], quiet), 0)
  assert.equal(main(['--file', path.join(FX, 'esp-sendgrid.eml'), ...base], quiet), 1)
  assert.equal(main(base, quiet), 2)
})
