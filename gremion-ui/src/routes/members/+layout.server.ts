import type { LayoutServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { redirect } from '@sveltejs/kit'

// WI-4B: the unified /members surface is open to every signed-in member. Non-
// admins get the basic view (placed + active people, no admin chrome); admins
// (Vorstand / IT-Team) additionally get the management view. We keep the
// sign-in gate but no longer 403 non-admins — `isAdmin` selects the view.
export const load: LayoutServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw redirect(303, '/auth/login')

  const isAdmin = hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin)
  return { user, isAdmin }
}
