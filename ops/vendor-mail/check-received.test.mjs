// TASK-015 TDD item 9: the Received / Authentication-Results check.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { checkReceived, loadReceivers, main, parseAuthResults, unfoldHeaders } from './check-received.mjs'

const FX = path.join(import.meta.dirname, '__fixtures__', 'received')
const read = (n) => readFileSync(path.join(FX, n), 'utf8')
const { espMarkers } = loadReceivers()
const OPTS = { domain: 'example.org', bindIps: ['192.0.2.25', '2001:db8::25'], authservIds: ['mx.example.net'], receiverSuffixes: ['example.net'], espMarkers }
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

test('no receiver named is unparseable: trusting every known authserv-id is how a forged one gets in', () => {
  assert.match(check(read('good-two-gateway-hops.eml'), { authservIds: [] }).unparseable, /no receiver named/)
  const quiet = { log() {}, error() {} }
  assert.equal(main(['--file', path.join(FX, 'good-two-gateway-hops.eml'), '--domain', 'example.org', '--bind-ip', '192.0.2.25'], quiet), 2)
})

test("an A-R carrying ANOTHER known receiver's authserv-id does not count at this receiver", () => {
  const t = read('good-two-gateway-hops.eml').replace('Authentication-Results: mx.example.net;', 'Authentication-Results: mx.google.com;')
  assert.match(check(t).reasons.join('\n'), /no Authentication-Results from the receiver \(mx\.example\.net\); saw mx\.google\.com/)
})

test("an unlisted smarthost between the vendor and the receiver is RED (the accepting hop is not the receiver's)", () => {
  const r = check(read('unlisted-smarthost.eml'))
  assert.match(r.reasons.join('\n'), /the accepting hop is by smarthost\.example\.com, not a host of the receiver \(example\.net\)/)
})

test("a hop above the accepting one that is neither the receiver's nor an address literal is RED", () => {
  const t = read('good-two-gateway-hops.eml').replace('by relay-7.example.net', 'by relay-7.example.com')
  assert.match(check(t).reasons.join('\n'), /a hop above the accepting one is by relay-7\.example\.com, not the receiver's/)
})

test('a bare address in the from-clause comment (no brackets) is an exact match too', () => {
  const t = read('good-two-gateway-hops.eml').replace('(mail.example.org. [192.0.2.25])', '(192.0.2.25)')
  assert.deepEqual(check(t).reasons, [])
  const u = read('good-two-gateway-hops.eml').replace('(mail.example.org. [192.0.2.25])', '(192.0.2.250)')
  assert.match(check(u).reasons.join('\n'), /no Received hop accepted the message/)
})

test('IPv6 bind addresses are compared normalised (2001:db8:0::25 = 2001:db8::25)', () => {
  const t = read('good-two-gateway-hops.eml').replace('[192.0.2.25])', '[IPv6:2001:DB8::25])')
  assert.deepEqual(check(t, { bindIps: ['192.0.2.99', '2001:db8:0:0::25'] }).reasons, [])
})

test("--receiver <name> trusts that receiver's authserv-ids and host suffixes from receivers.json", () => {
  const quiet = { log() {}, error() {} }
  const base = ['--domain', 'example.org', '--bind-ip', '192.0.2.25']
  assert.equal(main(['--file', path.join(FX, 'good-two-gateway-hops.eml'), ...base, '--receiver', 'google'], quiet), 1)
  const g = read('good-two-gateway-hops.eml').replaceAll('example.net', 'google.com').replace('Authentication-Results: mx.google.com;', 'Authentication-Results: mx.google.com;')
  assert.deepEqual(checkReceived(g, { ...OPTS, authservIds: ['mx.google.com'], receiverSuffixes: ['google.com'] }).reasons, [])
  assert.equal(main(['--file', path.join(FX, 'good-two-gateway-hops.eml'), ...base, '--receiver', 'nope'], quiet), 2)
})
