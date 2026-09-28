// Content Engine — the post editor.
//
// Read-gated load (Role.Member); the browser-side autosave / channel-toggle /
// preview fetches hit the /api/content endpoints which enforce the
// content.author capability for writes themselves. We hydrate the editor with
// the post, its per-channel enabled state, and its media (for the hero/preview).
import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { requireContentRead } from '$lib/server/content/route-auth'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'
import type { ChannelId, ChannelStatus } from '$lib/server/content/types'

const CHANNELS: readonly ChannelId[] = ['email', 'portal', 'instagram']

export const load: PageServerLoad = async ({ params, locals }) => {
  requireContentRead(locals.user)

  const backend = resolveContentBackendForPage()
  const post = await backend.getPost(params.id)
  if (!post) throw error(404, 'Not found')

  const [channels, media] = await Promise.all([backend.getChannels(post.id), backend.listMedia(post.id)])

  // Normalise to a fixed { channel -> enabled } shape so the UI always renders
  // all three toggles even if a row is somehow absent. Alongside it we carry the
  // per-channel publish lifecycle (status + scheduled_at) so the editor can show
  // the channel state and pre-fill the schedule control.
  const enabled: Record<ChannelId, boolean> = { email: false, portal: false, instagram: false }
  const channelState: Record<ChannelId, { status: ChannelStatus; scheduled_at: string | null }> = {
    email: { status: 'draft', scheduled_at: null },
    portal: { status: 'draft', scheduled_at: null },
    instagram: { status: 'draft', scheduled_at: null },
  }
  for (const c of channels) {
    if (CHANNELS.includes(c.channel)) {
      enabled[c.channel] = c.enabled
      channelState[c.channel] = { status: c.status, scheduled_at: c.scheduled_at }
    }
  }

  return { post, channelEnabled: enabled, channelState, media }
}
