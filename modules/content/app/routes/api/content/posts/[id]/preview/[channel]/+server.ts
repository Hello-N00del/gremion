// GET /api/content/posts/[id]/preview/[channel] — the channel's derive()
// preview model as JSON (channel ∈ email|portal|instagram). Read-gated
// (Role.Member); never cached (no-store) since the preview reflects live,
// unsaved-on-the-server state of an actively edited post.
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentRead } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { emailRenderer } from '$lib/server/content/channels/email-renderer'
import { portalRenderer } from '$lib/server/content/channels/portal-renderer'
import { instagramRenderer } from '$lib/server/content/channels/instagram-renderer'
import type { ChannelId, PostChannel } from '$lib/server/content/types'
import type { ChannelRenderer } from '$lib/server/content/channels/types'

const RENDERERS: Record<ChannelId, ChannelRenderer> = {
  email: emailRenderer,
  portal: portalRenderer,
  instagram: instagramRenderer,
}

const NO_STORE = { 'Cache-Control': 'no-store' }

export const GET: RequestHandler = async (event) => {
  requireContentRead(event.locals.user)

  const channel = event.params.channel as ChannelId
  const renderer = RENDERERS[channel]
  if (!renderer) throw error(400, 'Invalid channel')

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const id = event.params.id
  const post = await backend.getPost(id)
  if (!post) throw error(404, 'Not found')

  const [media, channels] = await Promise.all([backend.listMedia(id), backend.getChannels(id)])
  const channelRow = channels.find((c) => c.channel === channel)
  if (!channelRow) throw error(404, 'Channel not found')

  const preview = renderer.derive(post, media, channelRow as PostChannel)
  return json(preview, { headers: NO_STORE })
}
