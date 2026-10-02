import { redirect } from '@sveltejs/kit'
import { base } from '$app/paths'
import type { PageServerLoad } from './$types'

// #197: quick-poll creation moved onto /votes (inline PollCreateForm in the
// shared Dialog). The standalone /polls/new form is gone; redirect to the
// consolidated page so old links/bookmarks still work.
//
// #449(e): `base`-prefixed so the redirect stays inside the deployment's base
// path (a bare '/votes' would escape it and hit the default tenant).
export const load: PageServerLoad = async () => {
  redirect(308, `${base}/votes`)
}
