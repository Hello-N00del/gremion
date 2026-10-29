// The integration judges read a make target's text with line-anchored regexes. On a CI runner vitest
// colours its summary although stdout is a pipe (CI is set), so the unit step's
// "Tests  N passed (N)" line arrives wrapped in SGR escapes and a raw regex never matches: both
// `make test-nats-auth` and `make test-events` read "exit 0 but ... untrusted" on ubuntu-latest while
// every case had passed. The judges strip terminal control sequences first; a post-condition line
// that is genuinely missing must still be untrusted afterwards.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capturedText, judgeEventsTest, judgeNatsAuthTest } from './suites/integration.mjs'

const ESC = String.fromCharCode(27)
// The exact shape vitest 5 printed on the runner (SGR dim / bold-green / grey around the counts).
const coloured = (n) => `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m${n} passed${ESC}[39m${ESC}[22m${ESC}[90m (${n})${ESC}[39m\n`

const NATS_AUTH_COLOURED =
  coloured(171) +
  '[nats-auth-proof] auth broker t024-0123abcd-nats-auth on 127.0.0.1:32768\n' +
  '      Tests  26 passed (26)\n' +
  '[nats-auth-proof] 26 passing (minimum 25)\n' +
  '[nats-auth-proof] OK -- the authenticated broker admits and refuses as specified\n'

const EVENTS_COLOURED =
  coloured(83) +
  '[events-proof] 17 passing (minimum 15)\n[events-proof] group core OK\n' +
  '[events-proof] 18 passing (minimum 15)\n[events-proof] group consumer OK\n' +
  '[events-proof] 6 passing (minimum 6)\n[events-proof] group deadletter OK\n' +
  '[events-proof] 2 passing (minimum 2)\n[events-proof] group rebuild OK\n' +
  '[events-proof] group alert-red OK\n[events-proof] group alert-fire OK\n' +
  '[events-proof] group alert-hold OK\n[events-proof] group alert-resolve OK\n' +
  '[events-proof] OK\n' +
  '[events-image] OK -- pnpm exec events and the package import work in t079-0123abcd-migrate\n'

test('capturedText strips colour from stdout and stderr', () => {
  assert.equal(capturedText({ stdout: `${ESC}[32mok${ESC}[39m`, stderr: `${ESC}[31mbad${ESC}[39m` }), 'ok\nbad')
})

test('test-nats-auth: a colour-wrapped unit summary (the CI runner) still counts, unit + live', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_COLOURED, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 171 + 26)
  assert.equal(p.failed, 0)
})

test('test-nats-auth: colour does not hide a MISSING unit summary', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_COLOURED.replace(coloured(171), ''), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})

test('test-events: a colour-wrapped unit summary (the CI runner) still counts, unit + live', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_COLOURED, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 83 + 17 + 18 + 6 + 2)
  assert.equal(p.failed, 0)
})

test('test-events: colour does not hide a MISSING unit summary', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_COLOURED.replace(coloured(83), ''), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})
