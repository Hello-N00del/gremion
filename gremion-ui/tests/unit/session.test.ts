import { describe, it, expect } from 'vitest'
import { get } from 'svelte/store'
import { createSessionStore } from '$lib/stores/session'
import { Role } from '$lib/auth'

describe('session store', () => {
  it('initialises with null user', () => {
    const store = createSessionStore(null)
    expect(get(store).user).toBeNull()
  })

  it('exposes roles from session user', () => {
    const store = createSessionStore({
      user: { id: '1', email: 'a@b.de', name: 'A', roles: [Role.Member], groups: [] }
    })
    expect(get(store).roles).toEqual([Role.Member])
  })

  it('returns empty roles when no user', () => {
    const store = createSessionStore(null)
    expect(get(store).roles).toEqual([])
  })
})
