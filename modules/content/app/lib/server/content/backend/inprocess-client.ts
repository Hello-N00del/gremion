// gremion-ui/src/lib/server/content/backend/inprocess-client.ts
//
// branch-by-abstraction default path; byte-identical to current behavior until
// the deliberate cutover to 'service'.
//
// Every method is a thin async delegate to the corresponding content-db export.
// No business logic lives here — the point is to be a transparent proxy so that
// getContentBackend() can return this class when CONTENT_SERVICE_URL is unset,
// and all callers remain unchanged.
//
// Signature notes:
//   - enqueuePublishOp: the port carries (postId, channel, op) for the future
//     HTTP service; content-db's function only takes (postId) because it
//     hardcodes 'instagram'/'publish'. The channel/op args are ignored here
//     (they are always 'instagram'/'publish' in this implementation).
//   - markPublishOpOk: the port makes externalRef optional; content-db requires
//     it. Callers that omit it (L2 non-Instagram paths) pass '' here — the DB
//     update sets external_ref to '' which is safe for those paths.
//   - setPublication: the port omits the optional PgTransaction arg that
//     content-db accepts. The inprocess client calls without it, which is
//     correct for all non-transactional callers.

import type {
	ChannelId,
	ChannelStatus,
	ClaimResult,
	ContentBackendPort,
	MailingList,
	MailingListMember,
	MediaRole,
	Post,
	PostChannel,
	PostMedia,
	PostRecipient,
	Publication,
	PublishOp,
} from './port'

import * as db from '../content-db'
import type { PublishResult } from './port'

export class InprocessContentClient implements ContentBackendPort {
	readonly kind = 'inprocess' as const

	// ── Post CRUD ──────────────────────────────────────────────────────────────

	createPost(input: { title: string; created_by: string }): Promise<Post> {
		return db.createPost(input)
	}

	getPost(id: string): Promise<Post | null> {
		return db.getPost(id)
	}

	listPosts(): Promise<Post[]> {
		return db.listPosts()
	}

	updatePostTitle(id: string, title: string): Promise<Post> {
		return db.updatePostTitle(id, title)
	}

	updatePostBody(id: string, bodyHtml: string): Promise<Post> {
		return db.updatePostBody(id, bodyHtml)
	}

	deletePost(id: string): Promise<void> {
		return db.deletePost(id)
	}

	// ── Media ──────────────────────────────────────────────────────────────────

	listMedia(postId: string): Promise<PostMedia[]> {
		return db.listMedia(postId)
	}

	addMedia(
		postId: string,
		m: { url: string; role: MediaRole; position?: number; alt?: string | null },
	): Promise<PostMedia> {
		return db.addMedia(postId, m)
	}

	// ── Channels ───────────────────────────────────────────────────────────────

	getChannels(postId: string): Promise<PostChannel[]> {
		return db.getChannels(postId)
	}

	ensureChannels(postId: string): Promise<void> {
		return db.ensureChannels(postId)
	}

	setChannelEnabled(postId: string, channel: ChannelId, enabled: boolean): Promise<PostChannel> {
		return db.setChannelEnabled(postId, channel, enabled)
	}

	setChannelStatus(postId: string, channel: ChannelId, status: ChannelStatus): Promise<PostChannel> {
		return db.setChannelStatus(postId, channel, status)
	}

	setChannelScheduledAt(
		postId: string,
		channel: ChannelId,
		scheduledAt: string | null,
	): Promise<PostChannel> {
		return db.setChannelScheduledAt(postId, channel, scheduledAt)
	}

	setChannelOverrides(
		postId: string,
		channel: ChannelId,
		overrides: Record<string, unknown>,
	): Promise<PostChannel> {
		return db.setChannelOverrides(postId, channel, overrides)
	}

	// ── Mailing lists ──────────────────────────────────────────────────────────

	createMailingList(name: string): Promise<MailingList> {
		return db.createMailingList(name)
	}

	listMailingLists(): Promise<MailingList[]> {
		return db.listMailingLists()
	}

	deleteMailingList(id: string): Promise<void> {
		return db.deleteMailingList(id)
	}

	// ── Mailing list members ───────────────────────────────────────────────────

	addListMember(
		listId: string,
		m: { email: string; name?: string | null; source?: 'manual' | 'csv' },
	): Promise<void> {
		return db.addListMember(listId, m)
	}

	listMembers(listId: string): Promise<MailingListMember[]> {
		return db.listMembers(listId)
	}

	removeListMember(listId: string, memberId: string): Promise<void> {
		return db.removeListMember(listId, memberId)
	}

	// ── Recipients ─────────────────────────────────────────────────────────────

	setPostRecipients(
		postId: string,
		recips: { mailing_list_id?: string; keycloak_group_id?: string }[],
	): Promise<void> {
		return db.setPostRecipients(postId, recips)
	}

	getPostRecipients(postId: string): Promise<PostRecipient[]> {
		return db.getPostRecipients(postId)
	}

	// ── Unsubscribe ────────────────────────────────────────────────────────────

	isUnsubscribed(email: string): Promise<boolean> {
		return db.isUnsubscribed(email)
	}

	filterUnsubscribed(emailsLower: string[]): Promise<Set<string>> {
		return db.filterUnsubscribed(emailsLower)
	}

	addUnsubscribe(email: string): Promise<void> {
		return db.addUnsubscribe(email)
	}

	// ── Send tokens ────────────────────────────────────────────────────────────

	mintSendToken(postId: string, email: string): Promise<string> {
		return db.mintSendToken(postId, email)
	}

	consumeUnsubscribeToken(
		token: string,
	): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
		return db.consumeUnsubscribeToken(token)
	}

	// ── Delivery ledger ────────────────────────────────────────────────────────

	claimRecipient(postId: string, emailLower: string): Promise<ClaimResult> {
		return db.claimRecipient(postId, emailLower)
	}

	markDeliverySent(postId: string, emailLower: string, messageId: string): Promise<void> {
		return db.markDeliverySent(postId, emailLower, messageId)
	}

	markDeliveryFailed(postId: string, emailLower: string, error: string): Promise<void> {
		return db.markDeliveryFailed(postId, emailLower, error)
	}

	// ── Publications ───────────────────────────────────────────────────────────

	getPublication(postId: string, channel: ChannelId): Promise<Publication | null> {
		return db.getPublication(postId, channel)
	}

	setPublication(postId: string, channel: ChannelId, externalRef: string | null): Promise<void> {
		return db.setPublication(postId, channel, externalRef)
	}

	clearPublication(postId: string, channel: ChannelId): Promise<void> {
		return db.clearPublication(postId, channel)
	}

	// ── Publish operations ─────────────────────────────────────────────────────

	// channel/op are always 'instagram'/'publish' in the content-db implementation;
	// the port carries them for the future HTTP service. Ignored here.
	enqueuePublishOp(postId: string, _channel: 'instagram', _op: 'publish'): Promise<void> {
		return db.enqueuePublishOp(postId)
	}

	listDuePublishOps(): Promise<PublishOp[]> {
		return db.listDuePublishOps()
	}

	// externalRef is optional on the port; content-db requires it. Default to '' for
	// callers that omit it (non-Instagram paths that don't publish a media ref).
	markPublishOpOk(opId: string, externalRef?: string): Promise<void> {
		return db.markPublishOpOk(opId, externalRef ?? '')
	}

	markPublishOpFailed(opId: string, error: string): Promise<void> {
		return db.markPublishOpFailed(opId, error)
	}

	// ── Per-channel publish ──────────────────────────────────────────────────────

	// The inprocess publish IS the in-kernel orchestrator: publishPost loads the
	// post/media/channel row through this same backend and dispatches to the
	// matching renderer's publish(). Byte-identical to the pre-seam route call.
	// (publishPost throws ChannelNotPublishableError for a missing/disabled channel.)
	//
	// LAZY import (not a top-level one): publish.ts pulls the whole renderer chain
	// (email → mail/tenant-mail/config, portal → news-db, IG → carousel), so a
	// static import would drag that stack into EVERY content-route module graph via
	// getContentBackend() — breaking unit tests that load a content route without
	// stubbing the mail/config stack (and closing an import cycle at module init).
	// publish() is the only path that needs the orchestrator, so load it on call.
	async publish(postId: string, channel: ChannelId): Promise<PublishResult> {
		const { publishPost } = await import('../publish')
		return publishPost(postId, channel)
	}
}
