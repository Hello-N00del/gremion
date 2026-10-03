import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  return {
    user: session?.user as SessionUser | undefined
  }
}
