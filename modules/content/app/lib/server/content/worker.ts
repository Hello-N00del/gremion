// Content Engine (Pillar-1 kernel) — the scheduled-publish worker.
//
// `drainScheduledPublishes()` is the per-tenant tick body: it finds every
// channel the operator has SCHEDULED whose `scheduled_at` has arrived and pushes
// it through the in-kernel `publishPost` orchestrator. It is booted from
// `hooks.server.ts` once a minute via `forEachActiveTenant('content-publish', …)`
// so it runs inside each ACTIVE tenant's explicit ALS scope (getDb() resolves
// THAT tenant's pool).
//
// Idempotency / restart-safety is NOT this function's job — it lives one layer
// down: the email channel's per-recipient delivery ledger (UNIQUE(post_id,email),
// claim→send→mark-sent + 15-min stale takeover) and the portal channel's
// content.publications linkage row both make a re-run a no-op / same-row update.
// So a row that is still 'scheduled' when the next tick fires (e.g. publishPost
// threw mid-pass) is simply retried; double-send cannot happen.
//
// Per-row fault isolation: each due row is published inside its own try/catch so
// one channel's failure (SMTP down, unknown post, …) logs and the tick continues
// with the rest. A whole-tick failure (the SELECT itself throwing) is left to
// propagate to forEachActiveTenant, which catches+logs per-tenant.

import { getDb } from '../db'
import { isInstagramConfigured } from './instagram/credentials'
import { publishPost } from './publish'
import type { ChannelId } from './types'

interface DueChannelRow {
	post_id: string
	channel: ChannelId
}

/**
 * Publish every channel that is enabled, in status 'scheduled', and whose
 * `scheduled_at` has arrived (≤ now()) for the CURRENT tenant. Each row is
 * published independently; a throwing row is logged and skipped so it never
 * aborts the others. Resolves once every due row has been attempted.
 *
 * The instagram channel is EXCLUDED from the due set UNLESS Instagram is
 * configured. When NOT configured (the shipping default), a scheduled instagram
 * row's publish path returns a disabled result (publish()) or throws
 * (publishPost in L2/pre-L3-T5), so it would never advance and would churn the
 * worker — excluding it keeps the tick clean. When configured (activation),
 * instagram joins the due set and routes through the same `publishPost` →
 * `instagramRenderer.publish` → `enqueuePublishOp` path, where the IG drain
 * (drainInstagramPublishOps) reconciles the enqueued op. The exclusion is gated
 * on the config check so the disabled build stays churn-free.
 */
export async function drainScheduledPublishes(): Promise<void> {
	const sql = getDb()
	const includeInstagram = await isInstagramConfigured()
	const due = await sql<DueChannelRow[]>`
		SELECT post_id, channel
		FROM content.post_channels
		WHERE enabled
		  AND status = 'scheduled'
		  AND scheduled_at IS NOT NULL
		  AND scheduled_at <= now()
		  AND (${includeInstagram} OR channel <> 'instagram')
		ORDER BY scheduled_at
	`

	for (const row of due) {
		try {
			await publishPost(row.post_id, row.channel)
		} catch (err) {
			console.error(
				`[content-publish] scheduled publish failed for post ${row.post_id} channel ${row.channel}:`,
				err,
			)
		}
	}
}
