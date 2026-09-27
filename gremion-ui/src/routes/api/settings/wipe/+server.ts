import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import type { ApiResponse } from '$lib/api-response'

// POST — intentionally returns 501 Not Implemented
// A full data wipe must be initiated from the server CLI for safety.
// This endpoint exists as a stub that documents the required safety gate.
export const POST: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  return json(
    {
      success: false,
      error: 'Wipe must be initiated from the server CLI for safety',
    },
    { status: 501 },
  )
}
