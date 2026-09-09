// #189 (part B): /members/committees had no index route, so navigating to it
// 404'd (only /members/committees/[id]/* and /members/committees/new existed).
// The canonical org-tree browser lives at the top-level /committees route, so
// the index should redirect there.
import { describe, it, expect } from 'vitest'
import { load } from './+page.server'

describe('#189 /members/committees index', () => {
  it('redirects to the canonical /committees page', async () => {
    try {
      await load({} as never)
      expect.fail('expected the loader to redirect')
    } catch (e) {
      const r = e as { status?: number; location?: string }
      expect(r.status).toBe(302)
      expect(r.location).toBe('/committees')
    }
  })
})
