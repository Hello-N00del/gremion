// TASK-045 round 2: the integration suite's two make-target sub-checks are
// judged by exit code AND the target's own printed post-condition, and their
// counts come from what the target says it proved, not a fixed 1.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INTEGRATION_PARTS, integrationVitestEnv, judgeEventsTest, judgeFreshInit, judgeNatsAuthTest, judgeNatsTest } from './suites/integration.mjs'

const NATS_OK =
  '[nats-test] running the ports suite against nats://127.0.0.1:4222\n' +
  '[nats-test] 20 passing tests from src/nats-broker.integration.test.ts (minimum 12)\n' +
  '[nats-test] OK -- the JetStream proofs ran against a real server\n'

test('test-ports-nats: exit 0 plus both post-condition lines passes, counting the proofs it ran', () => {
  const p = judgeNatsTest({ code: 0, stdout: NATS_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 20)
  assert.equal(p.passed, 20)
  assert.equal(p.failed, 0)
})

test('test-ports-nats: exit 0 WITHOUT its post-condition line is untrusted, never a pass (round-1 MEDIUM)', () => {
  const p = judgeNatsTest({ code: 0, stdout: '[nats-test] running the ports suite\n', stderr: '' })
  assert.equal(p.unparseable, true)
})

test('test-ports-nats: a non-zero exit is a failure', () => {
  const p = judgeNatsTest({ code: 1, stdout: '[nats-test] FAILED: ports suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 || p.unparseable, JSON.stringify(p))
  assert.notEqual(p.unparseable === false && p.failed === 0, true)
})

// TASK-024: make test-nats-auth -- the package's unit suite, then
// packages/nats-auth/scripts/proof.sh --auth against a real broker.
const NATS_AUTH_OK =
  '      Tests  69 passed (69)\n' +
  '[nats-auth-proof] auth broker t024-0123abcd-nats-auth on 127.0.0.1:32768\n' +
  '      Tests  25 passed (25)\n' +
  '[nats-auth-proof] 25 passing (minimum 25)\n' +
  '[nats-auth-proof] OK -- the authenticated broker admits and refuses as specified\n'

test('test-nats-auth: exit 0 plus the unit summary and both proof lines passes, counting unit + live cases', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 94)
  assert.equal(p.passed, 94)
  assert.equal(p.failed, 0)
})

// One test, a loop inside it: scripts/verify/suites/unit.mjs compares node's collected count with the
// number of `test(` declarations, and a `test(` inside a loop declares 1 and collects N (judged
// unparseable). The message names the case that failed.
test('test-nats-auth: exit 0 without a proof line is untrusted, never a pass', () => {
  for (const [missing, drop] of [
    ['the "N passing" line', /^\[nats-auth-proof\] \d+ passing.*\n/m],
    ['the OK line', /^\[nats-auth-proof\] OK.*\n/m],
    ['the unit summary', /^\s+Tests  69 passed \(69\)\n/m],
  ]) {
    const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK.replace(drop, ''), stderr: '' })
    assert.equal(p.unparseable, true, `without ${missing}: ${JSON.stringify(p)}`)
  }
})

test('test-nats-auth: a proof run with its floor lowered below 25 is untrusted', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK.replace('25 passing (minimum 25)', '3 passing (minimum 3)'), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})

test('test-nats-auth: a non-zero exit is a failure', () => {
  const p = judgeNatsAuthTest({ code: 1, stdout: '[nats-auth-proof] FAILED: the live suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 && !p.unparseable, JSON.stringify(p))
})

test('the nats-auth part is registered beside nats', () => {
  assert.equal(typeof INTEGRATION_PARTS['nats-auth'], 'function')
  assert.deepEqual(Object.keys(INTEGRATION_PARTS).slice(-3), ['nats', 'nats-auth', 'events'])
})

// TASK-079: make test-events -- the unit suite, four live groups, three alert phases, the image check.
const EVENTS_OK =
  '      Tests  83 passed (83)\n' +
  '[events-proof] stack t079-0123abcd up\n' +
  '      Tests  16 passed (16)\n' +
  '[events-proof] 16 passing (minimum 15)\n' +
  '[events-proof] group core OK\n' +
  '[events-proof] 15 passing (minimum 15)\n' +
  '[events-proof] group consumer OK\n' +
  '[events-proof] 6 passing (minimum 6)\n' +
  '[events-proof] group deadletter OK\n' +
  '[events-proof] 2 passing (minimum 2)\n' +
  '[events-proof] group rebuild OK\n' +
  '[events-proof] group alert-red OK\n' +
  '[events-proof] group alert-fire OK\n' +
  '[events-proof] group alert-hold OK\n' +
  '[events-proof] group alert-resolve OK\n' +
  '[events-proof] OK\n' +
  '[events-image] OK -- pnpm exec events and the package import work in t079-0123abcd-migrate\n'

test('test-events: the unit summary, every group at its floor, the alert phases, OK and the image line pass, counting unit + live', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 83 + 16 + 15 + 6 + 2)
  assert.equal(p.failed, 0)
})

// One test, a loop inside it (see the test-nats-auth note above for why).
test('test-events: exit 0 without a proof line is untrusted, never a pass', () => {
  for (const [missing, drop] of [
    ['the unit summary', /^\s+Tests  83 passed \(83\)\n/m],
    ['the rebuild group', /^\[events-proof\] 2 passing \(minimum 2\)\n\[events-proof\] group rebuild OK\n/m],
    ['an alert phase', /^\[events-proof\] group alert-hold OK\n/m],
    ['the final OK line', /^\[events-proof\] OK\n/m],
    ['the image line', /^\[events-image\] OK.*\n/m],
  ]) {
    const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK.replace(drop, ''), stderr: '' })
    assert.equal(p.unparseable, true, `without ${missing}: ${JSON.stringify(p)}`)
  }
})

test('test-events: a group run with its floor lowered below the pinned one is untrusted', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK.replace('6 passing (minimum 6)', '1 passing (minimum 1)'), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})

test('test-events: a non-zero exit is a failure', () => {
  const p = judgeEventsTest({ code: 1, stdout: '[events-proof] FAILED: the core suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 && !p.unparseable, JSON.stringify(p))
})

const FRESH_OK = '  ok tables exist\n  ok column present\n  ok check definition\n[fresh-init] all post-conditions hold\n'

test('fresh-init-proof: exit 0 plus its post-condition line passes, counting its ok checks', () => {
  const p = judgeFreshInit({ code: 0, stdout: FRESH_OK, stderr: '' })
  assert.equal(p.collected, 3)
  assert.equal(p.passed, 3)
  assert.equal(p.failed, 0)
})

test('fresh-init-proof: exit 0 without its post-condition line is untrusted', () => {
  assert.equal(judgeFreshInit({ code: 0, stdout: '  ok tables exist\n', stderr: '' }).unparseable, true)
})

test('fresh-init-proof: a non-zero exit is a failure even with ok lines printed', () => {
  const p = judgeFreshInit({ code: 1, stdout: '  ok a\nFAIL b: expected x\n[fresh-init] FAILED\n', stderr: '' })
  assert.ok(p.failed > 0, JSON.stringify(p))
})

// TASK-028 intake round 3 (verify-r1/r2 HIGH 2): gremion-ui's integration
// config has NO default for GREMION_PRODUCTION_STACK (D2) and refuses to load
// while it is unset. This suite is a whole-tree caller: it points DATABASE_URL
// at a throwaway container IT started on an ephemeral loopback port, so it
// declares `none` itself -- and must do so even over an ambient value, since
// the guard refuses loopback on a host that declares a production stack.
const DB = { password: 'fake-pw-0000', port: 54321 }

test('integrationVitestEnv declares GREMION_PRODUCTION_STACK=none for the harness-owned database', () => {
  const env = integrationVitestEnv({ baseEnv: {}, db: DB, uiDir: '/ui' })
  assert.equal(env.GREMION_PRODUCTION_STACK, 'none')
})

test('integrationVitestEnv overrides an ambient GREMION_PRODUCTION_STACK (the URL is the run-owned container)', () => {
  const env = integrationVitestEnv({ baseEnv: { GREMION_PRODUCTION_STACK: 'gremion' }, db: DB, uiDir: '/ui' })
  assert.equal(env.GREMION_PRODUCTION_STACK, 'none')
})

test('integrationVitestEnv points both URLs at the loopback test container and drops the raw password keys', () => {
  const env = integrationVitestEnv({ baseEnv: { POSTGRES_PASSWORD: 'x', PGPASSWORD: 'y', KEEP: 'k' }, db: DB, uiDir: '/ui' })
  assert.equal(env.DATABASE_URL, 'postgres://gremion_test:fake-pw-0000@127.0.0.1:54321/gremion')
  assert.equal(env.CONTROL_DATABASE_URL, 'postgres://gremion_test:fake-pw-0000@127.0.0.1:54321/control')
  assert.equal(env.POSTGRES_PASSWORD, undefined)
  assert.equal(env.PGPASSWORD, undefined)
  assert.equal(env.KEEP, 'k')
})
