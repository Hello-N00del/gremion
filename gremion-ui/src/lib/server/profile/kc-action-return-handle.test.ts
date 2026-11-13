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
    // The pending-action cookie is only READ here; the new value travels on the response (see below).
    expect(t.store.get(ACTION_COOKIE)).toBe('UPDATE_PASSWORD')
  })

  // Auth.js answers the callback with a Response of its own. SvelteKit adds event.cookies only to
  // responses its own resolve() builds, so a cookie set through event.cookies here would never reach
  // the browser and a cancelled action would look like nothing happened.
  test('puts the recorded status on the response Auth.js returns, not only in event.cookies', async () => {
    const t = run('/auth/callback/keycloak?code=c&state=s&kc_action_status=cancelled')
    t.resolve.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/settings/profil', 'set-cookie': 'authjs.session-token=abc; Path=/' } }))
    const res = await t.run()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/profil')
    const cookies = res.headers.getSetCookie()
    expect(cookies).toContain('authjs.session-token=abc; Path=/')
    const ours = cookies.find((c) => c.startsWith(ACTION_COOKIE + '='))
    expect(ours).toBeDefined()
    expect(ours).toContain(`${ACTION_COOKIE}=UPDATE_PASSWORD.cancelled`)
    expect(ours).toMatch(/Path=\//)
    expect(ours).toMatch(/HttpOnly/i)
    expect(ours).toMatch(/SameSite=Lax/i)
    expect(ours).toMatch(/Max-Age=900/i)
    expect(ours).toMatch(/Secure/i)
  })

  test('sets no cookie when there is no pending action or no status', async () => {
    const noStatus = run('/auth/callback/keycloak?code=c&state=s')
    expect((await noStatus.run()).headers.getSetCookie()).toEqual([])
    const noPending = run('/auth/callback/keycloak?kc_action_status=success')
    noPending.store.clear()
    expect((await noPending.run()).headers.getSetCookie()).toEqual([])
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
