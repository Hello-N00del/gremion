// #189 (part B): /members/committees had no index route, so navigating to it
// 404'd (only /members/committees/[id]/* and /members/committees/new existed).
// The canonical org-tree browser lives at the top-level /committees route, so
// the index should redirect there.
import { describe, it, expect } from 'vitest'
import { load } from './+page.server'

describe('#189 /members/committees index', () => {
  it('redirects to the canonical /committees page', async () => {
    await expect(load({} as never)).rejects.toMatchObject({
      status: 302,
      location: '/committees',
    })
  })
})
