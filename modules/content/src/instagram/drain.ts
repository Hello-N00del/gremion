// services/content/src/instagram/drain.ts
//
// Instagram publish-ops drain — disabled-by-default.
//
// Reconcile pending publish_ops rows against the Meta Graph API. Called by the
// scheduler's drainPublishOps work step. Disabled-by-default (L3 activation
// requires IG credentials + public slide host).
//
// NotConfigured seam (the brief's disabled-by-default contract):
//   resolveInstagramCredentials() → null
//   → resolvePublicSlideUrls() returns null
//   → op marked failed with 'instagram-not-configured' error
//   → no network call to Meta Graph is ever made.
//
// When configured (future activation):
//   1. drainPublishOps() from the store returns due pending ops.
//   2. For each op, resolvePublicSlideUrls() builds the slide image URLs.
//   3. The adapter.publishCarousel() is called.
//   4. On success, op is marked 'ok' + externalRef = mediaId.
//   5. On failure, op is marked 'failed' + last_error set.
//
// The drain is designed for idempotency: retry is safe (UNIQUE publish ops,
// external_ref stored on success, give-up via PUBLISH_OP_GIVE_UP_SECONDS).

import type { Sql } from '../tenant-store.js'
import { drainPublishOps, updatePublishOp } from '../store/index.js'
import { resolveInstagramCredentials, resolvePublicSlideUrls } from './credentials.js'
import { createInstagramAdapter, type FetchLike } from './adapter.js'

export interface DrainInstagramOpsResult {
  ok: number
  failed: number
  skipped: number
}

/**
 * Drain due Instagram publish ops for a single tenant.
 *
 * This is the NotConfigured seam path:
 *   - When credentials are null (the default): every pending op is immediately
 *     marked failed with 'instagram-not-configured'. No network call is made.
 *   - When configured: slide URLs are resolved + the Meta Graph carousel API
 *     is called via the adapter.
 *
 * The `slideCount` parameter is a stub (disabled path has no real rendering);
 * the production path would retrieve it from the post's media.
 */
export async function drainInstagramPublishOps(
  sql: Sql,
  opts: {
    fetchImpl?: FetchLike
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<DrainInstagramOpsResult> {
  const credentials = resolveInstagramCredentials(opts.env)
  const ops = await drainPublishOps(sql)

  if (ops.length === 0) {
    return { ok: 0, failed: 0, skipped: 0 }
  }

  // NotConfigured seam: all ops → failed (no Meta Graph calls).
  if (!credentials) {
    let failed = 0
    for (const op of ops) {
      await updatePublishOp(sql, op.id, {
        status: 'failed',
        attempts: op.attempts + 1,
        last_error: 'instagram-not-configured',
        first_failed_at: op.first_failed_at ?? new Date().toISOString(),
      }).catch((err) => {
        console.error(`[ig-drain] failed to mark op ${op.id} failed:`, err instanceof Error ? err.message : String(err))
      })
      failed++
    }
    return { ok: 0, failed, skipped: 0 }
  }

  // Configured path (future activation — when IG credentials are set).
  const adapter = createInstagramAdapter(opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike))
  let ok = 0
  let failed = 0

  for (const op of ops) {
    // resolvePublicSlideUrls with a stub slide count of 1 (real path would
    // use the post's media count from the store).
    const slideUrls = resolvePublicSlideUrls(credentials, op.post_id, 1)
    if (!slideUrls) {
      // Defensive: credentials resolved but URLs could not be built.
      await updatePublishOp(sql, op.id, {
        status: 'failed',
        attempts: op.attempts + 1,
        last_error: 'instagram-slide-urls-unavailable',
        first_failed_at: op.first_failed_at ?? new Date().toISOString(),
      }).catch(() => {})
      failed++
      continue
    }

    try {
      const result = await adapter.publishCarousel({
        accountId: credentials.instagramAccountId,
        accessToken: credentials.pageAccessToken,
        imageUrls: slideUrls,
        caption: `Post ${op.post_id}`,
      })
      await updatePublishOp(sql, op.id, {
        status: 'ok',
        attempts: op.attempts + 1,
        external_ref: result.mediaId,
      })
      ok++
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      await updatePublishOp(sql, op.id, {
        status: 'failed',
        attempts: op.attempts + 1,
        last_error: errMessage,
        first_failed_at: op.first_failed_at ?? new Date().toISOString(),
      }).catch(() => {})
      failed++
      console.error(`[ig-drain] publishCarousel failed for op ${op.id}:`, errMessage)
    }
  }

  return { ok, failed, skipped: 0 }
}
