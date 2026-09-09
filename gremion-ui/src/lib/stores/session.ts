/**
 * Client-side session store.
 * Use this in Svelte components that need reactive access to the session
 * without a server load function. Pass the session from a +layout.server.ts
 * load result to createSessionStore() in the component's $effect or onMount.
 *
 * Example:
 *   import { createSessionStore } from '$lib/stores/session'
 *   const session = createSessionStore(data.session)
 */
import { derived, readable } from 'svelte/store'
import type { Role, SessionUser } from '$lib/auth/types'

export function createSessionStore(initial: { user?: Record<string, unknown> | null } | null) {
  const session = readable(initial)

  return derived(session, ($s) => {
    const user = ($s?.user as unknown as SessionUser) ?? null
    return {
      user,
      roles: user?.roles ?? ([] as Role[])
    }
  })
}
