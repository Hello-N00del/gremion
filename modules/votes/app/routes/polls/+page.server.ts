import { redirect } from '@sveltejs/kit'
import { base } from '$app/paths'
import type { PageServerLoad } from './$types'

// #197: the standalone /polls list was folded into /votes, which already
// aggregates Nextcloud Polls alongside Helios elections and now also hosts the
// quick-poll create flow (reusing PollCreateForm). The route is kept as a
// permanent redirect so old links / bookmarks land on the consolidated page.
// Individual poll detail + vote-casting still lives at /polls/[id].
//
// #449(e): `base`-prefixed so the redirect stays inside the deployment's base
// path (a bare '/votes' would escape it and hit the default tenant).
export const load: PageServerLoad = async () => {
  redirect(308, `${base}/votes`)
}
