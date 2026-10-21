// packages/events/src/test-hooks.ts (@gremion/events)
//
// The `hooks` options of createConsumer / createRelay are TEST SEAMS: a throw inside one aborts processing
// like a crash, and a consumer's presence of beforeDeadLetter changes its error handling. Production code
// must never be steerable by them, so they are honoured only under a test runner (VITEST) or an explicit
// EVENTS_TEST_HOOKS=1; anywhere else passing `hooks` is refused when the consumer/relay is created.
export function assertTestHooksAllowed(who: string, hooks: unknown): void {
  if (hooks === undefined) return
  if (process.env.VITEST || process.env.EVENTS_TEST_HOOKS === '1') return
  throw new Error(`[events] ${who}: the 'hooks' option is a test seam and is refused outside a test run (set EVENTS_TEST_HOOKS=1 to use it deliberately)`)
}
