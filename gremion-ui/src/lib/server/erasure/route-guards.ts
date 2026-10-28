// Shared by the erasure API routes (settings/erasure and settings/erasure/search).
import { json } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'

// A Keycloak user id. The Nextcloud account id is the same string (user_oidc --unique-uid=0),
// so nothing else may reach an erasure; the tenant binding itself is subject.ts.
const KEYCLOAK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isKeycloakId = (v: string): boolean => KEYCLOAK_ID.test(v)

export async function adminOrNull(locals: App.Locals): Promise<SessionUser | null> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  return user && hasRole(user.roles, Role.ITAdmin) ? user : null
}

export const forbidden = () => json({ success: false, error: 'Forbidden' }, { status: 403 })
