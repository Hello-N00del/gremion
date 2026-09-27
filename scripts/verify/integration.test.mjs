// TASK-045 round 2: the integration suite's two make-target sub-checks are
// judged by exit code AND the target's own printed post-condition, and their
// counts come from what the target says it proved, not a fixed 1.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeFreshInit, judgeNatsTest } from './suites/integration.mjs'

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
