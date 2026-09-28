// Content Engine (Pillar-1 kernel) — the authoring post list.
//
// Read-gated (Role.Member view gate, mirroring contentManifest.pages[].minRole
// and the /api/content routes' requireContentRead). The `content` module-disable
// gate is enforced upstream in hooks.server.ts over the /content prefix, so a
// tenant with the module toggled OFF never reaches this load. We load the posts
// via the ContentBackendPort (same tenant scope for flag OFF) and the per-channel
// state so the list can show which channels each post fans out to.
import type { PageServerLoad } from './$types'
import { requireContentRead } from '$lib/server/content/route-auth'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'
import type { ChannelId } from '$lib/server/content/types'

export const load: PageServerLoad = async ({ locals }) => {
  requireContentRead(locals.user)

  const backend = resolveContentBackendForPage()
  const posts = await backend.listPosts()
  const channelsByPost = await Promise.all(posts.map((p) => backend.getChannels(p.id)))

  const postsWithChannels = posts.map((p, i) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    updated_at: p.updated_at,
    enabledChannels: channelsByPost[i]
      .filter((c) => c.enabled)
      .map((c) => c.channel as ChannelId),
  }))

  return { posts: postsWithChannels }
}
