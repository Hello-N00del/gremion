// The live harness records every async error the server sends a connection
// from a floating status loop (test/live/harness.ts open()). Turning an
// error value into text must never throw there: a throw inside that loop
// would end it silently and later refusals would read as "no error" (house
// review r2 LOW harness.ts:437).
import { describe, expect, test } from 'vitest'
import { describeError } from './live/describe-error.ts'

describe('describeError', () => {
  test('an Error gives its message', () => {
    expect(describeError(new Error('Permissions Violation for Publish to "x"'))).toBe('Permissions Violation for Publish to "x"')
  })
  test('a string is returned as is', () => {
    expect(describeError('Authorization Violation')).toBe('Authorization Violation')
  })
  test('a plain object is JSON', () => {
    expect(describeError({ code: 503 })).toBe('{"code":503}')
  })
  test('a circular object does not throw', () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = o
    expect(() => describeError(o)).not.toThrow()
    expect(describeError(o)).toBe('[object Object]')
  })
  test('a BigInt does not throw', () => {
    expect(describeError(10n)).toBe('10')
  })
  test('undefined inside an object-less value still yields text', () => {
    expect(describeError(undefined)).toBe('undefined')
  })
})
