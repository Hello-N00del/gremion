// POST /api/content/posts/[id]/publish/[channel] — publish ONE post to ONE
// channel (channel ∈ email|portal|instagram). Gated by the `content.publish`
// capability (heavier than authoring); Instagram is gated by a SECOND,
// channel-specific `content.publish.instagram` capability that ships UNGRANTED
// (disabled-by-default), so Instagram 403s in normal operation. Dispatches to
// the publish orchestrator and maps its outcome to HTTP:
//
//   - 200 → the PublishResult JSON (email 'sent' / portal 'published' /
//           instagram 'scheduled' once activated).
//   - 403 → Instagram while `content.publish.instagram` is ungranted
//           ("Instagram publishing is not enabled for this tenant.").
//   - 409 → a missing/disabled channel row.
//   - 422 → the email channel could not send because SMTP is unconfigured
//           (status 'failed' + detail) — a recoverable operator-config gap.
//   - 400 → an invalid channel param.
//
// Mirrors the auth/error shape of the sibling content routes (requireContent*,
// @sveltejs/kit `error`/`json`).
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
  requireContentPublish,
  requireContentPublishInstagram,
} from '$lib/server/content/route-auth'
import { getContentBackend } from '$lib/server/content/backend'
import { ChannelNotPublishableError } from '$lib/server/content/publish-errors'
import type { ChannelId } from '$lib/server/content/types'

const CHANNELS: readonly ChannelId[] = ['email', 'portal', 'instagram']

export const POST: RequestHandler = async (event) => {
  requireContentPublish(event.locals.user)

  const channel = event.params.channel as ChannelId
  if (!CHANNELS.includes(channel)) throw error(400, 'Invalid channel')

  // Instagram is disabled-by-default: a second, channel-specific capability
  // (ungranted by the content manifest) must be held. This 403s every caller
  // until an operator grants it as a separate activation step.
  if (channel === 'instagram') requireContentPublishInstagram(event.locals.user)

  // Per-channel publish delegates through the content backend seam:
  //   - inprocess → the in-kernel publishPost orchestrator (renderers write the
  //     kernel DB). Byte-identical to the pre-seam direct call.
  //   - service   → the leaf's synchronous per-channel publish endpoint
  //     (POST /api/v1/posts/:id/publish/:channel); the leaf runs the same
  //     per-channel path against ITS OWN DB + kernel callbacks and returns the
  //     PublishResult. No more split-brain write against a stale kernel DB, and
  //     no more 503 — the delegation is wired. See docs/runbooks/content-cutover.md.
  const backend = getContentBackend(event.locals.correlationId)

  let result
  try {
    result = await backend.publish(event.params.id, channel)
  } catch (err) {
    if (err instanceof ChannelNotPublishableError) throw error(409, err.message)
    throw err
  }

  // Email could not send because SMTP is unconfigured — a recoverable operator
  // gap. Surface it as a 422 (with the result body) rather than a generic 200,
  // while leaving the delivery ledger intact for a retry once SMTP is set up.
  if (result.status === 'failed' && channel === 'email') {
    return json(result, { status: 422 })
  }

  return json(result)
}
