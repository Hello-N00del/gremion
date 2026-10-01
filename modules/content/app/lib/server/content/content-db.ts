// Content Engine (Pillar-1 kernel module) — tenant-scoped CRUD for posts,
// media, and per-channel publishing state.
//
// Mirrors `news-db.ts`: all queries are parameterized postgres-js tagged-template
// statements via getDb() (the CURRENT tenant's pool, resolved from ALS by
// requireTenant() — see db.ts) with NO value interpolation, and rich HTML passes
// through `sanitizeRichHtml` before storage as defence-in-depth. Tenant isolation
// is the DB boundary: every query targets the per-tenant `content` schema
// (migration 044). Slug-generation helpers are exported pure functions so the
// unit suite can exercise them without Postgres.

import { getDb } from '../db'
import { getRunner } from '../db/tx'
import type { PgTransaction } from '../db/tx'
import { sanitizeRichHtml } from '../security/html-sanitize'
import type {
	ChannelId,
	ChannelStatus,
	MailingList,
	MailingListMember,
	MediaRole,
	Post,
	PostChannel,
	PostMedia,
	PostRecipient,
	Publication,
} from './types'

/** Minutes after which an uncompleted 'claimed' delivery row is considered stale. */
const STALE_CLAIM_MINUTES = 15

// ── Slug helpers (pure, exported for unit tests) ─────────────────────────────

/**
 * Derive a URL-safe slug from a post title: strip diacritics, lowercase,
 * drop non-alphanumerics, collapse whitespace to single hyphens. Mirrors
 * `news-db.generateSlug` so both surfaces slug identically. An all-symbol
 * title collapses to '' here; `freshSlug` falls back to 'post' in that case.
 */
export function generateSlug(title: string): string {
	return title
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '') // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '') // strip non-alphanumeric (except spaces)
		.trim()
		.replace(/\s+/g, '-') // spaces → hyphens
		.replace(/-+/g, '-') // collapse runs
		.replace(/^-|-$/g, '') // trim leading/trailing hyphens
}

/**
 * Given a base slug and the slugs already present, return a unique slug,
 * appending `-2`, `-3`, … on conflict. Pure; the DB path passes the rows
 * that LIKE the base prefix.
 */
export function deduplicateSlug(base: string, existing: string[]): string {
	if (!existing.includes(base)) return base
	let n = 2
	while (existing.includes(`${base}-${n}`)) n++
	return `${base}-${n}`
}

async function freshSlug(title: string): Promise<string> {
	const sql = getDb()
	const base = generateSlug(title) || 'post'
	const rows = await sql<{ slug: string }[]>`
		SELECT slug FROM content.posts WHERE slug LIKE ${base + '%'}
	`
	return deduplicateSlug(
		base,
		rows.map((r) => r.slug),
	)
}

// ── Row mappers ──────────────────────────────────────────────────────────────
// postgres-js returns timestamptz columns as JS Date; the locked Post/PostChannel
// contracts expose ISO strings. Normalise at the DB boundary.

interface PostRow {
	id: string
	slug: string
	title: string
	body_html: string
	created_by: string
	created_at: Date | string
	updated_at: Date | string
}

function toIso(v: Date | string | null): string {
	if (v === null) return ''
	return v instanceof Date ? v.toISOString() : v
}

function mapPost(row: PostRow): Post {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		body_html: row.body_html,
		created_by: row.created_by,
		created_at: toIso(row.created_at),
		updated_at: toIso(row.updated_at),
	}
}

interface ChannelRow {
	post_id: string
	channel: ChannelId
	enabled: boolean
	status: PostChannel['status']
	scheduled_at: Date | string | null
	overrides: Record<string, unknown>
}

function mapChannel(row: ChannelRow): PostChannel {
	return {
		post_id: row.post_id,
		channel: row.channel,
		enabled: row.enabled,
		status: row.status,
		scheduled_at: row.scheduled_at === null ? null : toIso(row.scheduled_at),
		overrides: row.overrides ?? {},
	}
}

// ── Posts ──────────────────────────────────────────────────────────────────

/**
 * Create a post with a unique slug derived from `title`, then seed its three
 * channel rows (all `enabled = false`) via `ensureChannels`. body_html starts
 * empty; the editor PATCHes it through `updatePostBody` (sanitized).
 */
export async function createPost(input: {
	title: string
	created_by: string
}): Promise<Post> {
	const sql = getDb()
	const slug = await freshSlug(input.title)
	const rows = await sql<PostRow[]>`
		INSERT INTO content.posts (slug, title, created_by)
		VALUES (${slug}, ${input.title}, ${input.created_by})
		RETURNING *
	`
	const post = mapPost(rows[0]!)
	await ensureChannels(post.id)
	return post
}

export async function getPost(id: string): Promise<Post | null> {
	const sql = getDb()
	const rows = await sql<PostRow[]>`
		SELECT * FROM content.posts WHERE id = ${id}
	`
	return rows[0] ? mapPost(rows[0]) : null
}

export async function listPosts(): Promise<Post[]> {
	const sql = getDb()
	const rows = await sql<PostRow[]>`
		SELECT * FROM content.posts ORDER BY created_at DESC
	`
	return rows.map(mapPost)
}

/**
 * Update body_html. The value is sanitized with `sanitizeRichHtml` before
 * storage as defence-in-depth — the API route also sanitizes at the trust
 * boundary, but this second pass is idempotent and ensures no caller can
 * persist raw HTML. <h2> survives the allow-list (it is the segmentation
 * delimiter); <script> is stripped.
 */
export async function updatePostBody(id: string, bodyHtml: string): Promise<Post> {
	const safe = sanitizeRichHtml(bodyHtml)
	const sql = getDb()
	const rows = await sql<PostRow[]>`
		UPDATE content.posts
		SET body_html = ${safe}, updated_at = now()
		WHERE id = ${id}
		RETURNING *
	`
	return mapPost(rows[0]!)
}

export async function updatePostTitle(id: string, title: string): Promise<Post> {
	const sql = getDb()
	const rows = await sql<PostRow[]>`
		UPDATE content.posts
		SET title = ${title}, updated_at = now()
		WHERE id = ${id}
		RETURNING *
	`
	return mapPost(rows[0]!)
}

export async function deletePost(id: string): Promise<void> {
	const sql = getDb()
	await sql`DELETE FROM content.posts WHERE id = ${id}`
}

// ── Media ──────────────────────────────────────────────────────────────────

export async function listMedia(postId: string): Promise<PostMedia[]> {
	const sql = getDb()
	return sql<PostMedia[]>`
		SELECT * FROM content.post_media
		WHERE post_id = ${postId}
		ORDER BY role, position, id
	`
}

export async function addMedia(
	postId: string,
	m: { url: string; role: MediaRole; position?: number; alt?: string | null },
): Promise<PostMedia> {
	const sql = getDb()
	const rows = await sql<PostMedia[]>`
		INSERT INTO content.post_media (post_id, url, role, position, alt)
		VALUES (${postId}, ${m.url}, ${m.role}, ${m.position ?? 0}, ${m.alt ?? null})
		RETURNING *
	`
	return rows[0]!
}

// ── Channels ──────────────────────────────────────────────────────────────

const CHANNELS: readonly ChannelId[] = ['email', 'portal', 'instagram']

export async function getChannels(postId: string): Promise<PostChannel[]> {
	const sql = getDb()
	const rows = await sql<ChannelRow[]>`
		SELECT * FROM content.post_channels
		WHERE post_id = ${postId}
		ORDER BY channel
	`
	return rows.map(mapChannel)
}

export async function setChannelEnabled(
	postId: string,
	channel: ChannelId,
	enabled: boolean,
): Promise<PostChannel> {
	const sql = getDb()
	const rows = await sql<ChannelRow[]>`
		UPDATE content.post_channels
		SET enabled = ${enabled}
		WHERE post_id = ${postId} AND channel = ${channel}
		RETURNING *
	`
	return mapChannel(rows[0]!)
}

export async function setChannelOverrides(
	postId: string,
	channel: ChannelId,
	overrides: Record<string, unknown>,
): Promise<PostChannel> {
	const sql = getDb()
	const rows = await sql<ChannelRow[]>`
		UPDATE content.post_channels
		SET overrides = ${sql.json(overrides as never) as never}
		WHERE post_id = ${postId} AND channel = ${channel}
		RETURNING *
	`
	return mapChannel(rows[0]!)
}

/**
 * Insert the three channel rows (email/portal/instagram) for a post, all
 * `enabled = false`, `status = 'draft'`. Idempotent: an existing row is left
 * untouched (ON CONFLICT DO NOTHING on the (post_id, channel) PK).
 */
export async function ensureChannels(postId: string): Promise<void> {
	const sql = getDb()
	for (const channel of CHANNELS) {
		await sql`
			INSERT INTO content.post_channels (post_id, channel)
			VALUES (${postId}, ${channel})
			ON CONFLICT (post_id, channel) DO NOTHING
		`
	}
}

/** Set a channel's publish-lifecycle status (L2 advances 'scheduled'/'sent'/'published'/'failed'). */
export async function setChannelStatus(
	postId: string,
	channel: ChannelId,
	status: ChannelStatus,
): Promise<PostChannel> {
	const sql = getDb()
	const rows = await sql<ChannelRow[]>`
		UPDATE content.post_channels
		SET status = ${status}
		WHERE post_id = ${postId} AND channel = ${channel}
		RETURNING *
	`
	return mapChannel(rows[0]!)
}

/**
 * Set (or clear) a channel's scheduled_at. Pass an ISO string to schedule, or
 * null to clear it. Does NOT touch status — the caller flips status='scheduled'
 * via setChannelStatus when arming a scheduled publish.
 */
export async function setChannelScheduledAt(
	postId: string,
	channel: ChannelId,
	scheduledAt: string | null,
): Promise<PostChannel> {
	const sql = getDb()
	const rows = await sql<ChannelRow[]>`
		UPDATE content.post_channels
		SET scheduled_at = ${scheduledAt}
		WHERE post_id = ${postId} AND channel = ${channel}
		RETURNING *
	`
	return mapChannel(rows[0]!)
}

// ── Mailing lists ────────────────────────────────────────────────────────────

interface MailingListRow {
	id: string
	name: string
	created_at: Date | string
}

function mapMailingList(row: MailingListRow): MailingList {
	return { id: row.id, name: row.name, created_at: toIso(row.created_at) }
}

interface MailingListMemberRow {
	id: string
	mailing_list_id: string
	email: string
	name: string | null
	source: 'manual' | 'csv'
	created_at: Date | string
}

function mapMember(row: MailingListMemberRow): MailingListMember {
	return {
		id: row.id,
		mailing_list_id: row.mailing_list_id,
		email: row.email,
		name: row.name,
		source: row.source,
		created_at: toIso(row.created_at),
	}
}

export async function createMailingList(name: string): Promise<MailingList> {
	const sql = getDb()
	const rows = await sql<MailingListRow[]>`
		INSERT INTO content.mailing_lists (name) VALUES (${name}) RETURNING *
	`
	return mapMailingList(rows[0]!)
}

export async function listMailingLists(): Promise<MailingList[]> {
	const sql = getDb()
	const rows = await sql<MailingListRow[]>`
		SELECT * FROM content.mailing_lists ORDER BY created_at DESC, name
	`
	return rows.map(mapMailingList)
}

export async function deleteMailingList(id: string): Promise<void> {
	const sql = getDb()
	await sql`DELETE FROM content.mailing_lists WHERE id = ${id}`
}

/**
 * Add a member to a mailing list. UNIQUE(mailing_list_id, email): re-adding the
 * same email is a no-op (ON CONFLICT DO NOTHING) so imports are idempotent.
 */
export async function addListMember(
	listId: string,
	m: { email: string; name?: string | null; source?: 'manual' | 'csv' },
): Promise<void> {
	const sql = getDb()
	await sql`
		INSERT INTO content.mailing_list_members (mailing_list_id, email, name, source)
		VALUES (${listId}, ${m.email}, ${m.name ?? null}, ${m.source ?? 'manual'})
		ON CONFLICT (mailing_list_id, email) DO NOTHING
	`
}

export async function listMembers(listId: string): Promise<MailingListMember[]> {
	const sql = getDb()
	const rows = await sql<MailingListMemberRow[]>`
		SELECT * FROM content.mailing_list_members
		WHERE mailing_list_id = ${listId}
		ORDER BY created_at, email
	`
	return rows.map(mapMember)
}

export async function removeListMember(listId: string, memberId: string): Promise<void> {
	const sql = getDb()
	await sql`
		DELETE FROM content.mailing_list_members
		WHERE mailing_list_id = ${listId} AND id = ${memberId}
	`
}

// ── Post recipients ──────────────────────────────────────────────────────────

interface PostRecipientRow {
	id: string
	post_id: string
	mailing_list_id: string | null
	keycloak_group_id: string | null
}

/**
 * Replace a post's recipient set wholesale. Each entry targets EXACTLY one of a
 * mailing list OR a KC group (the DB CHECK rejects both/neither). Done in one
 * transaction so a post never has a partially-applied recipient set.
 */
export async function setPostRecipients(
	postId: string,
	recips: { mailing_list_id?: string; keycloak_group_id?: string }[],
): Promise<void> {
	const sql = getDb()
	await sql.begin(async (tx) => {
		await tx`DELETE FROM content.post_recipients WHERE post_id = ${postId}`
		for (const r of recips) {
			await tx`
				INSERT INTO content.post_recipients (post_id, mailing_list_id, keycloak_group_id)
				VALUES (${postId}, ${r.mailing_list_id ?? null}, ${r.keycloak_group_id ?? null})
			`
		}
	})
}

export async function getPostRecipients(postId: string): Promise<PostRecipient[]> {
	const sql = getDb()
	return sql<PostRecipientRow[]>`
		SELECT id, post_id, mailing_list_id, keycloak_group_id
		FROM content.post_recipients
		WHERE post_id = ${postId}
		ORDER BY id
	`
}

// ── Unsubscribes + send tokens ───────────────────────────────────────────────

export async function isUnsubscribed(email: string): Promise<boolean> {
	const e = email.toLowerCase()
	const sql = getDb()
	const rows = await sql<{ c: string }[]>`
		SELECT COUNT(*) AS c FROM content.unsubscribes WHERE email = ${e}
	`
	return Number(rows[0]!.c) > 0
}

/**
 * Batch unsubscribe lookup: given a list of ALREADY-lowercased emails, return the
 * subset that is unsubscribed (one query, no N+1). The caller lowercases before
 * passing in; storage is lowercased too, so the `= ANY(...)` comparison agrees on
 * case. An empty input short-circuits to an empty set (no needless round-trip).
 */
export async function filterUnsubscribed(emailsLower: string[]): Promise<Set<string>> {
	if (emailsLower.length === 0) return new Set()
	const sql = getDb()
	const rows = await sql<{ email: string }[]>`
		SELECT email FROM content.unsubscribes WHERE email = ANY(${emailsLower})
	`
	return new Set(rows.map((r) => r.email))
}

/** Direct (non-token) unsubscribe. Idempotent via the PK ON CONFLICT DO NOTHING. */
export async function addUnsubscribe(email: string): Promise<void> {
	const e = email.toLowerCase()
	const sql = getDb()
	await sql`
		INSERT INTO content.unsubscribes (email) VALUES (${e})
		ON CONFLICT (email) DO NOTHING
	`
}

/**
 * Mint (or reuse) the unsubscribe token for (post_id, email) and return the
 * EFFECTIVE persisted token. send_tokens has UNIQUE(post_id, email), so a
 * re-send hits the conflict and keeps the original — we read it back so the
 * caller always uses the persisted token in the email footer link. expires_at
 * defaults to now()+7d from the column DEFAULT.
 */
export async function mintSendToken(postId: string, email: string): Promise<string> {
	const e = email.toLowerCase()
	const sql = getDb()
	const token = crypto.randomUUID()
	await sql`
		INSERT INTO content.send_tokens (token, post_id, email)
		VALUES (${token}, ${postId}, ${e})
		ON CONFLICT (post_id, email) DO NOTHING
	`
	const rows = await sql<{ token: string }[]>`
		SELECT token FROM content.send_tokens WHERE post_id = ${postId} AND email = ${e}
	`
	return rows[0]!.token
}

/**
 * Consume an unsubscribe token atomically.
 * - Missing → { ok:false, reason:'invalid' } (no changes).
 * - Expired → deletes the token + returns { ok:false, reason:'expired' } WITHOUT
 *   recording an unsubscribe (an expired link must not silently succeed).
 * - Valid → records the unsubscribe + deletes the token (single-use), { ok:true }.
 * The token delete and the unsubscribe insert run in one transaction.
 */
export async function consumeUnsubscribeToken(
	token: string,
): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
	const sql = getDb()
	return sql.begin(async (tx) => {
		const rows = await tx<{ email: string; expires_at: Date | string | null }[]>`
			SELECT email, expires_at FROM content.send_tokens WHERE token = ${token}
		`
		if (rows.length === 0) return { ok: false as const, reason: 'invalid' as const }

		const row = rows[0]!
		const expiresAt = row.expires_at === null ? null : new Date(row.expires_at)
		if (expiresAt !== null && expiresAt < new Date()) {
			await tx`DELETE FROM content.send_tokens WHERE token = ${token}`
			return { ok: false as const, reason: 'expired' as const }
		}

		await tx`
			INSERT INTO content.unsubscribes (email) VALUES (${row.email.toLowerCase()})
			ON CONFLICT (email) DO NOTHING
		`
		await tx`DELETE FROM content.send_tokens WHERE token = ${token}`
		return { ok: true as const }
	})
}

// ── Delivery ledger (per-recipient double-send gate) ─────────────────────────

export type ClaimResult = 'fresh' | 'already-sent' | 'in-flight'

/**
 * Attempt to claim a delivery slot for (postId, emailLower). Mirrors the
 * newsletter leaf's deliveries.claimRecipient:
 *  - 'fresh'        → caller must send (row freshly inserted OR stale-taken-over).
 *  - 'in-flight'    → a non-stale 'claimed' row exists; another worker is sending — skip.
 *  - 'already-sent' → a 'sent' row exists; do NOT re-send.
 * The INSERT and the stale-takeover UPDATE are both atomic, so two concurrent
 * callers racing the same pair are safe: at most one wins 'fresh'.
 */
export async function claimRecipient(
	postId: string,
	emailLower: string,
): Promise<ClaimResult> {
	const sql = getDb()
	// Step 1: optimistic INSERT — fast path for a brand-new recipient.
	const inserted = await sql<{ id: string }[]>`
		INSERT INTO content.deliveries (post_id, email)
		VALUES (${postId}, ${emailLower})
		ON CONFLICT (post_id, email) DO NOTHING
		RETURNING id
	`
	if (inserted.length > 0) return 'fresh'

	// Step 2: row exists — try an atomic takeover FIRST (one UPDATE … RETURNING,
	// so exactly one concurrent caller wins): a STALE 'claimed' row, or a 'failed'
	// row (F1-FIX-07 H07: the send threw, the recipient was not mailed — without
	// this a transient SMTP error dropped them for good). Back to 'claimed' with
	// the error cleared, so a second concurrent claimer sees 'in-flight'.
	const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString()
	const taken = await sql<{ id: string }[]>`
		UPDATE content.deliveries
		SET status = 'claimed', claimed_at = now(), failed_at = NULL, error_message = NULL
		WHERE post_id = ${postId}
			AND email = ${emailLower}
			AND (
				status = 'failed'
				OR (status = 'claimed' AND claimed_at < ${cutoff}::timestamptz)
			)
		RETURNING id
	`
	if (taken.length > 0) return 'fresh'

	// Step 3: inspect the current row to decide 'already-sent' vs 'in-flight'.
	const rows = await sql<{ status: string }[]>`
		SELECT status FROM content.deliveries
		WHERE post_id = ${postId} AND email = ${emailLower}
	`
	if (rows.length === 0) return 'in-flight'
	return rows[0]!.status === 'sent' ? 'already-sent' : 'in-flight'
}

/**
 * Mark a delivery successfully sent (status='sent', sent_at=now(), message id).
 * Any non-'sent' row may become 'sent' (the mail went out, even if a superseded
 * claimer's late failure already flipped the claim); a 'sent' row keeps its
 * first sent_at and message id. Mirrors the leaf's markSent (F1-FIX-07 r2).
 */
export async function markDeliverySent(
	postId: string,
	emailLower: string,
	messageId: string,
): Promise<void> {
	const sql = getDb()
	await sql`
		UPDATE content.deliveries
		SET status = 'sent', sent_at = now(), smtp_message_id = ${messageId}
		WHERE post_id = ${postId} AND email = ${emailLower} AND status <> 'sent'
	`
}

/**
 * Mark a delivery failed (status='failed', failed_at=now(), error message).
 * Only a 'claimed' row can fail (F1-FIX-07 r2): 'failed' rows are re-claimed, so
 * overwriting a 'sent' row (a worker that hung past the stale window, failing
 * after a takeover delivered) would mail the recipient again.
 */
export async function markDeliveryFailed(
	postId: string,
	emailLower: string,
	error: string,
): Promise<void> {
	const sql = getDb()
	await sql`
		UPDATE content.deliveries
		SET status = 'failed', failed_at = now(), error_message = ${error}
		WHERE post_id = ${postId} AND email = ${emailLower} AND status = 'claimed'
	`
}

// ── Publications (channel publish linkage) ───────────────────────────────────

interface PublicationRow {
	post_id: string
	channel: ChannelId
	external_ref: string | null
	published_at: Date | string | null
}

function mapPublication(row: PublicationRow): Publication {
	return {
		post_id: row.post_id,
		channel: row.channel,
		external_ref: row.external_ref,
		published_at: row.published_at === null ? null : toIso(row.published_at),
	}
}

export async function getPublication(
	postId: string,
	channel: ChannelId,
): Promise<Publication | null> {
	const sql = getDb()
	const rows = await sql<PublicationRow[]>`
		SELECT * FROM content.publications
		WHERE post_id = ${postId} AND channel = ${channel}
	`
	return rows[0] ? mapPublication(rows[0]) : null
}

/**
 * Upsert a channel's publication linkage, stamping published_at=now(). For
 * portal this records the owned news_posts id (externalRef) so a re-publish
 * targets the SAME row. PK(post_id, channel) → ON CONFLICT updates in place.
 */
export async function setPublication(
	postId: string,
	channel: ChannelId,
	externalRef: string | null,
	tx?: PgTransaction,
): Promise<void> {
	const sql = getRunner(tx, getDb)
	await sql`
		INSERT INTO content.publications (post_id, channel, external_ref, published_at)
		VALUES (${postId}, ${channel}, ${externalRef}, now())
		ON CONFLICT (post_id, channel) DO UPDATE
		SET external_ref = EXCLUDED.external_ref, published_at = now()
	`
}

export async function clearPublication(postId: string, channel: ChannelId): Promise<void> {
	const sql = getDb()
	await sql`
		DELETE FROM content.publications
		WHERE post_id = ${postId} AND channel = ${channel}
	`
}

// ── Instagram publish outbox (content.publish_ops, migration 046) ────────────
// A transactional-outbox ledger for the L3 Instagram publish path. publish()
// enqueues a row (instead of sending inline); a per-minute per-tenant drain
// reconciles due rows via the Meta carousel adapter. Mirrors the governance
// provisioning_member_ops idiom (ledger.ts / member-ops.ts): status
// pending|ok|failed, attempts, capped exponential backoff, time-based give-up,
// and a UNIQUE(post_id, op) domain key so a re-arm is idempotent and the drain
// never double-publishes. Shipped DISABLED-BY-DEFAULT in L3.

/** A failing publish op goes terminal (stops being due) after this wall-clock
 *  age, so a long-but-transient outage self-heals rather than retrying forever.
 *  Mirrors the provisioning ledger's GIVE_UP_AFTER_SECONDS. */
export const PUBLISH_OP_GIVE_UP_AFTER_SECONDS = 24 * 60 * 60

export interface PublishOp {
	readonly id: string
	readonly post_id: string
	readonly channel: 'instagram'
	readonly op: 'publish'
	readonly status: 'pending' | 'ok' | 'failed'
	readonly attempts: number
	readonly next_attempt_at: string | null
	readonly first_failed_at: string | null
	readonly last_error: string | null
	readonly external_ref: string | null
	readonly created_at: string
	readonly updated_at: string
}

interface PublishOpRow {
	id: string
	post_id: string
	channel: 'instagram'
	op: 'publish'
	status: 'pending' | 'ok' | 'failed'
	attempts: number
	next_attempt_at: Date | string | null
	first_failed_at: Date | string | null
	last_error: string | null
	external_ref: string | null
	created_at: Date | string
	updated_at: Date | string
}

function mapPublishOp(row: PublishOpRow): PublishOp {
	return {
		id: row.id,
		post_id: row.post_id,
		channel: row.channel,
		op: row.op,
		status: row.status,
		attempts: row.attempts,
		next_attempt_at: row.next_attempt_at === null ? null : toIso(row.next_attempt_at),
		first_failed_at: row.first_failed_at === null ? null : toIso(row.first_failed_at),
		last_error: row.last_error,
		external_ref: row.external_ref,
		created_at: toIso(row.created_at),
		updated_at: toIso(row.updated_at),
	}
}

/**
 * Enqueue (or re-arm) the Instagram publish op for a post. Idempotent via
 * UNIQUE(post_id, op) — re-calling for the same post is a no-op (ON CONFLICT DO
 * NOTHING), so an already-queued op is never duplicated or reset. A fresh row
 * starts pending with next_attempt_at NULL = immediately due.
 */
export async function enqueuePublishOp(postId: string): Promise<void> {
	const sql = getDb()
	await sql`
		INSERT INTO content.publish_ops (post_id, channel, op)
		VALUES (${postId}, 'instagram', 'publish')
		ON CONFLICT (post_id, op) DO NOTHING
	`
}

/**
 * Due publish ops the drain should reconcile: not yet ok, whose retry time has
 * arrived (or has never failed), and which have NOT been failing longer than
 * the give-up window (terminal — stops retry storms; resets on success).
 * Ordered oldest-first.
 */
export async function listDuePublishOps(): Promise<PublishOp[]> {
	const sql = getDb()
	const rows = await sql<PublishOpRow[]>`
		SELECT * FROM content.publish_ops
		WHERE status <> 'ok'
			AND (next_attempt_at IS NULL OR next_attempt_at <= now())
			AND (first_failed_at IS NULL OR now() - first_failed_at < make_interval(secs => ${PUBLISH_OP_GIVE_UP_AFTER_SECONDS}))
		ORDER BY created_at
	`
	return rows.map(mapPublishOp)
}

/** Read the publish op for a post (there is at most one — UNIQUE(post_id, op)). */
export async function getPublishOp(postId: string): Promise<PublishOp | null> {
	const sql = getDb()
	const rows = await sql<PublishOpRow[]>`
		SELECT * FROM content.publish_ops WHERE post_id = ${postId} AND op = 'publish'
	`
	return rows[0] ? mapPublishOp(rows[0]) : null
}

/** Mark a publish op successfully reconciled: status='ok', clear failure state,
 *  and record the published Meta media id in external_ref. */
export async function markPublishOpOk(id: string, externalRef: string): Promise<void> {
	const sql = getDb()
	await sql`
		UPDATE content.publish_ops
		SET status = 'ok', external_ref = ${externalRef}, last_error = NULL,
			next_attempt_at = NULL, first_failed_at = NULL, updated_at = now()
		WHERE id = ${id}
	`
}

/** Mark a publish op failed: increment attempts, stamp first_failed_at (once),
 *  and schedule the next retry with capped exponential backoff
 *  (LEAST(3600, 30 * 2^min(attempts+1, 12)) seconds). Mirrors member-ops. */
export async function markPublishOpFailed(id: string, error: string): Promise<void> {
	const sql = getDb()
	await sql`
		UPDATE content.publish_ops
		SET status = 'failed', last_error = ${error.slice(0, 2000)}, attempts = attempts + 1,
			first_failed_at = COALESCE(first_failed_at, now()),
			next_attempt_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts + 1, 12))::int)),
			updated_at = now()
		WHERE id = ${id}
	`
}
