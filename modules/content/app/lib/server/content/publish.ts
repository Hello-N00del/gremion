// Content Engine (Pillar-1 kernel) — the publish orchestrator.
//
// `publishPost(postId, channel)` is the single in-kernel entry point that pushes
// ONE post to ONE channel. It loads the post + its media + the per-channel state
// row, enforces the channel guard, and dispatches to the matching
// ChannelRenderer's `publish()`:
//
//   - portal → idempotent publish onto the news pipeline (one news_posts row).
//   - email  → self-contained, restart-safe per-recipient send (SMTP-unconfigured
//              surfaces as a clean status:'failed' PublishResult, not a throw).
//   - instagram → L3: dispatches to the IG renderer's publish(), which enqueues a
//                 content.publish_ops outbox row when configured, or returns a
//                 'failed' / "Instagram not configured" PublishResult otherwise
//                 (disabled-by-default). The publish ROUTE still gates Instagram
//                 with the ungranted `content.publish.instagram` capability (a
//                 403/409 in normal operation), so this dispatch is only reached
//                 once that capability is granted in a later activation step.
//
// A missing or disabled channel row throws — you cannot publish a channel the
// operator has not turned on for the post. Idempotency lives in the renderers
// (the delivery ledger for email, content.publications for portal), so this
// orchestrator can be safely re-invoked (manually or by the scheduled worker).

import { getContentBackend } from './backend'
import { emailRenderer } from './channels/email-renderer'
import { portalRenderer } from './channels/portal-renderer'
import { instagramRenderer } from './channels/instagram-renderer'
import { ChannelNotPublishableError } from './publish-errors'
import type { ChannelId, PostChannel } from './types'
import type { ChannelRenderer, PublishResult } from './channels/types'

// Re-export so existing importers (`from '$lib/server/content/publish'`) keep
// working; the class itself lives in the dependency-free publish-errors module.
export { ChannelNotPublishableError }

const RENDERERS: Record<ChannelId, ChannelRenderer> = {
	email: emailRenderer,
	portal: portalRenderer,
	instagram: instagramRenderer,
}

/**
 * Publish ONE post to ONE channel. Returns the channel's PublishResult.
 * @throws if the post is unknown or the channel row is missing/disabled.
 *
 * Instagram dispatches to its renderer like every other channel — there is no
 * hard short-circuit here. The disabled-by-default gate lives in TWO places that
 * this orchestrator does not own: the publish ROUTE (the ungranted
 * `content.publish.instagram` capability 403/409s it) and the renderer itself
 * (which returns a 'failed' result without enqueuing when credentials are
 * absent). Both must flip to activate the path.
 */
export async function publishPost(postId: string, channel: ChannelId): Promise<PublishResult> {
	const backend = getContentBackend()
	const post = await backend.getPost(postId)
	if (!post) throw new ChannelNotPublishableError('post not found')

	const [media, channels] = await Promise.all([backend.listMedia(postId), backend.getChannels(postId)])
	const channelRow = channels.find((c) => c.channel === channel)
	if (!channelRow) throw new ChannelNotPublishableError('channel not found')
	if (!channelRow.enabled) throw new ChannelNotPublishableError('channel is disabled')

	const renderer = RENDERERS[channel]
	return renderer.publish(post, media, channelRow as PostChannel)
}
