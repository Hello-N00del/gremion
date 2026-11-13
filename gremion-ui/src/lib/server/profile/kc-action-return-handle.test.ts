import { describe, expect, test, vi } from 'vitest'

vi.mock('$app/paths', () => ({ base: '' }))

import { kcActionReturnHandle } from './kc-action-return-handle'
import { ACTION_COOKIE } from './account-actions'

function run(path: string, method = 'GET', pending = 'UPDATE_PASSWORD') {
  const store = new Map<string, string>([[ACTION_COOKIE, pending]])
  const cookies = {
    get: (n: string) => store.get(n),
    set: (n: string, v: string) => void store.set(n, v),
    delete: (n: string) => void store.delete(n),
  }
  const url = new URL('https://pilot.test' + path)
  const resolve = vi.fn(async () => new Response('ok'))
  const event = { request: new Request(url, { method }), url, cookies, locals: {}, decodedPath: url.pathname }
  return { store, resolve, run: () => kcActionReturnHandle({ event: event as never, resolve }) }
}

describe('kcActionReturnHandle', () => {
  test('records the status on the Keycloak callback and passes the request on untouched', async () => {
    const t = run('/auth/callback/keycloak?code=c&state=s&kc_action_status=cancelled')
    const res = await t.run()
    expect(await res.text()).toBe('ok')
    expect(t.resolve).toHaveBeenCalledTimes(1)
    expect(t.store.get(ACTION_COOKIE)).toBe('UPDATE_PASSWORD.cancelled')
  })

  test.each([
    ['another path', '/settings?kc_action_status=success', 'GET'],
    ['a POST', '/auth/callback/keycloak?kc_action_status=success', 'POST'],
  ])('does nothing for %s', async (_l, path, method) => {
    const t = run(path, method)
    await t.run()
    expect(t.store.get(ACTION_COOKIE)).toBe('UPDATE_PASSWORD')
    expect(t.resolve).toHaveBeenCalledTimes(1)
  })
})
