import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

// #189: /members/committees has no index of its own — the canonical org-tree
// browser is the top-level /committees route. Redirect there so the bare index
// no longer 404s (the /[id]/* committee detail routes are unaffected).
export const load: PageServerLoad = async () => {
  throw redirect(302, '/committees')
}
