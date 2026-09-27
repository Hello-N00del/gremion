// TASK-045 fixture: a vitest file whose only test is `it.skip`. Vitest
// reports this file's run as `success: true` (proved empirically while
// building this suite -- numTotalTests: 1, numPendingTests: 1, success: true)
// -- the same all-skipped-is-still-green shape packages/ports/scripts/
// nats-test.sh's header names for JetStream. See
// scripts/verify/verify.zero-collected.test.mjs.
import { it } from 'vitest'

it.skip('never runs', () => {
  throw new Error('this test must never execute')
})
