// Content Engine (Pillar-1 kernel module) — domain DTOs and enums.
//
// These are the LOCKED L1 contracts shared across the content-db, the
// segmentation/caption helpers, the ChannelRenderer port, and the API routes.
// Names/types here cross task boundaries — keep them verbatim. Row shapes mirror
// the `content` schema (migration 044); timestamps are ISO strings as returned
// to the app layer (postgres-js dates serialized at the DB boundary).

/** The three fan-out channels a post can be published to. */
export type ChannelId = 'email' | 'portal' | 'instagram'

/** Per-channel publish lifecycle state. L1 only ever sets 'draft'. */
export type ChannelStatus = 'draft' | 'scheduled' | 'sent' | 'published' | 'failed'

/** Role of a piece of media relative to a post. */
export type MediaRole = 'hero' | 'slide' | 'inline'

/** A single authored piece of content (content.posts). */
export interface Post {
	id: string
	slug: string
	title: string
	/** Sanitized rich HTML; <h2> delimits sections for the channel renderers. */
	body_html: string
	created_by: string
	created_at: string
	updated_at: string
}

/** Media attached to a post (content.post_media). */
export interface PostMedia {
	id: string
	post_id: string
	url: string
	role: MediaRole
	position: number
	alt: string | null
}

/** Per-channel publishing state for a post (content.post_channels). */
export interface PostChannel {
	post_id: string
	channel: ChannelId
	enabled: boolean
	status: ChannelStatus
	scheduled_at: string | null
	/** JSONB; per-channel hand-tightened edits (subject, slide reorders, …). */
	overrides: Record<string, unknown>
}

// ── L2 publish/email contracts (content schema, migration 045) ───────────────

/** A named bucket of email recipients the operator manages (content.mailing_lists). */
export interface MailingList {
	id: string
	name: string
	created_at: string
}

/** A single member of a mailing list (content.mailing_list_members). */
export interface MailingListMember {
	id: string
	mailing_list_id: string
	email: string
	name: string | null
	source: 'manual' | 'csv'
	created_at: string
}

/**
 * What a post's email channel sends to (content.post_recipients): EXACTLY one of
 * a content mailing list OR a Keycloak group (XOR enforced by the DB CHECK).
 */
export interface PostRecipient {
	id: string
	post_id: string
	mailing_list_id: string | null
	keycloak_group_id: string | null
}

/**
 * Per-channel publish linkage (content.publications). For portal, `external_ref`
 * is the owned news_posts id as a string; re-publishing updates that same row.
 */
export interface Publication {
	post_id: string
	channel: ChannelId
	external_ref: string | null
	published_at: string | null
}
