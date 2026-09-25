// GET / PATCH / DELETE /api/content/posts/[id].
//
// - GET    → the post (Role.Member view gate).
// - PATCH  → update title and/or body_html and/or toggle a channel enabled.
//            Accepts either a `content.author` session OR a trusted internal
//            Bearer header (from internalFetch — the editor page action calls
//            this endpoint in-process for debounced autosave). Mirrors the
//            news/[id] G-075 dual-auth shape.
// - DELETE → remove the post (content.author capability).
//
// body_html is sanitized at this trust boundary before storage; content-db's
// updatePostBody sanitizes again as a defensive second layer (both idempotent).
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { isInternalBearerRequest } from '$lib/server/internal-fetch'
import { requireContentRead, requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize'
import type { ChannelId } from '$lib/server/content/types'

const CHANNELS: readonly ChannelId[] = ['email', 'portal', 'instagram']

export const GET: RequestHandler = async (event) => {
  requireContentRead(event.locals.user)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const post = await backend.getPost(event.params.id)
  if (!post) throw error(404, 'Not found')
  return json(post)
}

export const PATCH: RequestHandler = async (event) => {
  // Accept either a trusted internal Bearer request OR a content.author session
  // (mirrors news/[id] G-075). The Bearer path short-circuits the capability
  // check because the in-process producer holding the shared secret is trusted.
  if (!isInternalBearerRequest(event.request)) {
    requireContentAuthor(event.locals.user)
  }

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const id = event.params.id
  const post = await backend.getPost(id)
  if (!post) throw error(404, 'Not found')

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }

  const { title, body_html, channel, enabled, scheduled_at } = body as {
    title?: string
    body_html?: string
    channel?: string
    enabled?: boolean
    // ISO string → arm a scheduled publish; null → clear the schedule.
    scheduled_at?: string | null
  }

  let applied = false

  if (title !== undefined) {
    if (!title.trim()) throw error(400, 'title cannot be empty')
    await backend.updatePostTitle(id, title.trim())
    applied = true
  }

  if (body_html !== undefined) {
    await backend.updatePostBody(id, sanitizeRichHtml(body_html))
    applied = true
  }

  // A channel-scoped edit. Two mutually-usable sub-ops:
  //   - enabled (boolean)         → toggle the channel on/off.
  //   - scheduled_at (ISO|null)   → arm/clear a scheduled publish. Arming sets
  //                                 scheduled_at + status='scheduled'; clearing
  //                                 (null) wipes scheduled_at + status='draft'.
  // At least one must be present alongside the channel.
  if (channel !== undefined) {
    if (!CHANNELS.includes(channel as ChannelId)) throw error(400, 'Invalid channel')
    const ch = channel as ChannelId
    let touchedChannel = false

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean')
        throw error(400, 'enabled must be a boolean')
      await backend.setChannelEnabled(id, ch, enabled)
      touchedChannel = true
    }

    if (scheduled_at !== undefined) {
      if (scheduled_at === null) {
        await backend.setChannelScheduledAt(id, ch, null)
        await backend.setChannelStatus(id, ch, 'draft')
      } else {
        if (typeof scheduled_at !== 'string' || Number.isNaN(Date.parse(scheduled_at)))
          throw error(400, 'scheduled_at must be an ISO timestamp or null')
        await backend.setChannelScheduledAt(id, ch, scheduled_at)
        await backend.setChannelStatus(id, ch, 'scheduled')
      }
      touchedChannel = true
    }

    if (!touchedChannel)
      throw error(400, 'channel requires enabled (boolean) and/or scheduled_at (ISO|null)')
    applied = true
  }

  if (!applied)
    throw error(400, 'Invalid PATCH body — provide title, body_html, or channel+enabled')

  return json({ ok: true })
}

export const DELETE: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const id = event.params.id
  const post = await backend.getPost(id)
  if (!post) throw error(404, 'Not found')

  await backend.deletePost(id)
  return json({ ok: true })
}
