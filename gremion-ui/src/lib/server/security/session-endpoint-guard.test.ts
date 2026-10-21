// GET /auth/session answered the full sessionCallback
// result to browser JavaScript, including the raw Keycloak accessToken and
// idToken. Any XSS could lift a working bearer. Nothing in the client needs the
// endpoint (pages get { user, expires } from the root layout load, server code
// uses locals.auth(), which calls Auth() in-process, not over HTTP).
import { describe, it, expect, vi } from 'vitest'

vi.mock('$app/paths', () => ({ base: '' }))

import { sessionEndpointGuard } from './session-endpoint-guard'

function run(pathname: string, method = 'GET') {
  const resolve = vi.fn(async () => new Response('ok'))
  const event = { url: new URL(`https://app.example.org${pathname}`), request: new Request(`https://app.example.org${pathname}`, { method }) }
  return { resolve, res: sessionEndpointGuard({ event, resolve } as never) as Promise<Response> }
}

describe('sessionEndpointGuard', () => {
  it.each(['GET', 'POST'])('answers 404 for %s /auth/session without reaching Auth.js', async (method) => {
    const { resolve, res } = run('/auth/session', method)
    expect((await res).status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['/auth/session/', '/auth/session?x=1'])('also blocks %s', async (path) => {
    const { resolve, res } = run(path)
    expect((await res).status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['/auth/signin/keycloak', '/auth/callback/keycloak', '/auth/login', '/auth/csrf', '/dashboard', '/api/health'])(
    'passes %s through',
    async (path) => {
      const { resolve, res } = run(path)
      expect((await res).status).toBe(200)
      expect(resolve).toHaveBeenCalledOnce()
    },
  )
})
