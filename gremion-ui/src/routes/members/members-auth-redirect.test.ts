// #189 (part A): several layout guards redirected unauthenticated users to
// `/auth/signin`, a route that does not exist (the real sign-in entry is
// `/auth/login`, per hooks.server.ts). So the "please sign in" redirect itself
// 404'd. This asserts the members layout guard targets the live login route.
import { describe, it, expect } from 'vitest'
import { load } from './+layout.server'

describe('#189 members layout sign-in redirect', () => {
  it('redirects an unauthenticated user to the live /auth/login route', async () => {
    try {
      await load({ locals: { auth: async () => null } } as never)
      expect.fail('expected the loader to redirect')
    } catch (e) {
      const r = e as { status?: number; location?: string }
      expect(r.location).toBe('/auth/login')
    }
  })
})
