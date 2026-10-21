// The consumer/relay `hooks` are test seams: refused when not under a test runner.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createConsumer } from '../src/consumer.ts'
import { createRelay } from '../src/relay.ts'

afterEach(() => vi.unstubAllEnvs())

const consumer = (hooks?: object) =>
  createConsumer({ sql: {} as never, ctx: 'fin', tenant: 't1', module: 'finance', js: {} as never, stream: 'ORGUNIT', name: 'c1', handler: async () => {}, hooks } as never)
const relay = (hooks?: object) => createRelay({ sql: {} as never, ctx: 'idt', js: {} as never, subjects: () => 's', hooks } as never)

describe('test hooks cannot steer production code', () => {
  test('outside a test run, hooks are refused for the consumer and the relay', () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('EVENTS_TEST_HOOKS', '')
    expect(() => consumer({ beforeDeadLetter: () => {} })).toThrow(/test seam/)
    expect(() => relay({ afterPubAck: () => {} })).toThrow(/test seam/)
  })
  test('no hooks: fine anywhere', () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('EVENTS_TEST_HOOKS', '')
    expect(() => consumer()).not.toThrow()
    expect(() => relay()).not.toThrow()
  })
  test('under a test runner or an explicit opt-in they are honoured', () => {
    expect(() => consumer({ beforeDeadLetter: () => {} })).not.toThrow()
    vi.stubEnv('VITEST', '')
    vi.stubEnv('EVENTS_TEST_HOOKS', '1')
    expect(() => relay({ afterPubAck: () => {} })).not.toThrow()
  })
})
