// services/content/src/store/channels.ts
//
// Per-channel publish-state helpers on content.post_channels (enabled + status
// lifecycle). The HTTP PATCH route (routes.ts patchChannelRow) owns the general
// channel patch; these two narrow ops are what the per-channel publish path
// (publish-channel.ts) needs: read one channel's (enabled,status) to gate the
// publish, and advance its status after a publish completes.

import type { Sql } from '../tenant-store.js'

export type ChannelId = 'email' | 'portal' | 'instagram'
export type ChannelStatus = 'draft' | 'scheduled' | 'sent' | 'published' | 'failed'

export interface ChannelRow {
  post_id: string
  channel: ChannelId
  enabled: boolean
  status: ChannelStatus
}

/**
 * Read one post_channels row (enabled + status). Returns null when the author
 * never opted the channel in (no row) — the publish path treats that as
 * "channel not found".
 */
export async function getChannelRow(
  sql: Sql,
  postId: string,
  channel: ChannelId,
): Promise<ChannelRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT post_id, channel, enabled, status
    FROM content.post_channels
    WHERE post_id = ${postId} AND channel = ${channel}
  `
  if (rows.length === 0) return null
  const r = rows[0]!
  return {
    post_id: String(r['post_id']),
    channel: r['channel'] as ChannelId,
    enabled: Boolean(r['enabled']),
    status: r['status'] as ChannelStatus,
  }
}

/**
 * Advance one channel's publish status (mirrors the kernel renderer's
 * backend.setChannelStatus call). A no-op if the row does not exist (the publish
 * path only calls this for a row it already read + gated).
 */
export async function setChannelStatus(
  sql: Sql,
  postId: string,
  channel: ChannelId,
  status: ChannelStatus,
): Promise<void> {
  await sql`
    UPDATE content.post_channels
    SET status = ${status}
    WHERE post_id = ${postId} AND channel = ${channel}
  `
}
