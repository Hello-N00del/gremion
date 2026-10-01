// Content Engine (Pillar-1 kernel) — the email channel renderer (L1 derive).
//
// Email is the lowest-transform channel: the subject is the post title (or a
// hand-tightened `overrides.subject`) and the body is the post's already-
// sanitized `body_html`, re-sanitized here as defense-in-depth (mirroring the
// portal renderer — the renderer never trusts its input even though the body is
// sanitized on write and the editor preview iframe is sandboxed). No segmentation
// is needed for the preview. Pure and deterministic.

import { sanitizeRichHtml } from '../../security/html-sanitize'
import { getTenantMailContext, sendMailForTenant } from '$lib/server/mail/tenant-mail'
import { getTenant } from '$lib/server/tenant/context'
import { getContentBackend } from '../backend'
import { injectUnsubscribeFooter } from '../email-footer'
import { resolvePostRecipients } from '../recipients'
import type { Post, PostMedia, PostChannel } from '../types'
import type { ChannelRenderer, EmailArtifact, EmailPreview, PublishResult, RenderedArtifact } from './types'

/** Resolve the subject: a string `overrides.subject` wins, else the post title. */
function resolveSubject(post: Post, channel: PostChannel): string {
	const override = channel.overrides?.subject
	return typeof override === 'string' ? override : post.title
}

/**
 * The tenant's public origin for unsubscribe links (S1c#0, K5#33): an absolute
 * `https://<primary host>` so the link works from a mail client. A relative link
 * is dead in every inbox, so a tenant with no usable primary host gets NO link
 * at all — the publish fails closed before any recipient is claimed.
 */
function unsubscribeOrigin(): string | null {
	const host = getTenant().primaryHost
	if (!host) return null
	try {
		const url = new URL(`https://${host}`)
		if (url.host !== host.toLowerCase() || url.pathname !== '/') return null
		return url.origin
	} catch {
		return null
	}
}

/** The L1 email renderer + L2 final artifact + self-contained, restart-safe send. */
export const emailRenderer: ChannelRenderer<EmailPreview> = {
	channel: 'email',

	derive(post: Post, _media: PostMedia[], channel: PostChannel): EmailPreview {
		// Contract: subject = channel.overrides.subject ?? post.title. The override
		// is typed `unknown` (JSONB), so honour it only when it is a string;
		// anything else (absent / wrong type) falls back to the post title.
		return {
			subject: resolveSubject(post, channel),
			html: sanitizeRichHtml(post.body_html),
			warnings: [],
		}
	},

	/** The final email artifact: subject + re-sanitized body HTML. */
	render(post: Post, _media: PostMedia[], channel: PostChannel): Promise<RenderedArtifact> {
		const artifact: EmailArtifact = {
			kind: 'email',
			subject: resolveSubject(post, channel),
			html: sanitizeRichHtml(post.body_html),
		}
		return Promise.resolve(artifact)
	},

	/**
	 * Self-contained, restart-safe email send. The post's recipient set resolves
	 * from content mailing lists + KC groups (minus unsubscribes); each recipient
	 * is gated by the per-recipient delivery ledger so a re-publish (or a restart)
	 * never double-sends:
	 *   claimRecipient → only 'fresh' proceeds (already-sent / in-flight skip) →
	 *   mint a send token → inject the unsubscribe footer → sendMailForTenant →
	 *   markDeliverySent. A per-recipient send throw is isolated (markDeliveryFailed
	 *   + continue), so one bad address never aborts the pass or re-sends the rest.
	 *
	 * SMTP being unconfigured is surfaced as a clean 'failed' PublishResult (not a
	 * throw). It is checked BEFORE the recipient loop so NO delivery row is claimed
	 * when SMTP is down — a later retry, once SMTP is configured, sees every
	 * recipient still 'fresh' (no orphaned 'claimed' rows to stale-out first).
	 *
	 * The terminal status reflects what actually happened: 'sent' only when no
	 * send failed this pass and at least one recipient was sent this pass OR was
	 * already sent on a prior pass (a re-publish of an all-already-sent post is a
	 * success, not a failure); 'failed' when no recipients resolved at all, when
	 * any attempted send failed (F1-FIX-07 H07: the next publish retries exactly
	 * those), or when the tenant has no public host for the unsubscribe link.
	 */
	async publish(post: Post, _media: PostMedia[], channel: PostChannel): Promise<PublishResult> {
		const backend = getContentBackend()
		const subject = resolveSubject(post, channel)
		const html = sanitizeRichHtml(post.body_html)
		const warnings: string[] = []

		// Pre-check SMTP BEFORE claiming any delivery slot: if it is unconfigured,
		// return a clean failed result without orphaning a 'claimed' row.
		if (!getTenantMailContext().configured) {
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: 0,
				warnings,
				detail: 'SMTP not configured',
			}
		}

		// Same pre-check shape for the unsubscribe link base: no usable public
		// host → a clean failed result, nothing claimed, nothing mailed.
		const origin = unsubscribeOrigin()
		if (!origin) {
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: 0,
				warnings,
				detail: 'no public host for unsubscribe links',
			}
		}

		const recipients = await resolvePostRecipients(post.id)

		// No recipients resolved → nothing to send; surface as a failed result so
		// the operator notices the empty audience (rather than a silent 'sent').
		if (recipients.length === 0) {
			await backend.setChannelStatus(post.id, 'email', 'failed')
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: 0,
				warnings: ['no recipients resolved'],
				detail: 'no recipients',
			}
		}

		let sentCount = 0 // fresh sends that succeeded this pass
		let alreadySentCount = 0 // recipients already delivered on a prior pass
		let failedCount = 0 // fresh sends that threw this pass

		// Recipients are already lowercased by resolvePostRecipients; emailLower
		// keeps the claim/token/ledger lookups byte-identical regardless of source.
		for (const { email } of recipients) {
			const emailLower = email.toLowerCase()

			// The double-send gate: only a 'fresh' claim sends.
			const claim = await backend.claimRecipient(post.id, emailLower)
			if (claim === 'already-sent') {
				alreadySentCount += 1
				continue
			}
			if (claim !== 'fresh') continue // 'in-flight' — another worker owns it

			const token = await backend.mintSendToken(post.id, emailLower)
			const unsubUrl = `${origin}/content/unsubscribe?token=${encodeURIComponent(token)}`
			const personalizedHtml = injectUnsubscribeFooter(html, unsubUrl)

			try {
				const { messageId } = await sendMailForTenant({
					to: email,
					subject,
					html: personalizedHtml,
				})
				await backend.markDeliverySent(post.id, emailLower, messageId)
				sentCount += 1
			} catch (err) {
				// Per-recipient send failure: isolate it and keep sending the others.
				// The 'failed' row is re-claimed by the next publish (claimRecipient
				// takes over failed rows, F1-FIX-07 H07), so it is retried, not lost.
				const message = err instanceof Error ? err.message : String(err)
				await backend.markDeliveryFailed(post.id, emailLower, message)
				failedCount += 1
				warnings.push(`send to ${emailLower} failed: ${message}`)
			}
		}

		// PARTIAL (F1-FIX-07 H07): some recipients delivered, some sends threw.
		// The channel must not read 'sent' while a recipient is un-mailed.
		if (failedCount > 0 && sentCount + alreadySentCount > 0) {
			await backend.setChannelStatus(post.id, 'email', 'failed')
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: sentCount,
				warnings: [...warnings, `${failedCount} recipient(s) not delivered — publish again to retry them`],
				detail: `${failedCount} send(s) failed`,
			}
		}

		// Success iff at least one recipient was delivered (this pass or a prior
		// one). If every attempted send failed and nothing was already sent, the
		// channel is genuinely failed.
		const delivered = sentCount + alreadySentCount
		if (delivered === 0) {
			await backend.setChannelStatus(post.id, 'email', 'failed')
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: 0,
				warnings: failedCount > 0 ? [...warnings, 'all sends failed'] : warnings,
				detail: 'all sends failed',
			}
		}

		await backend.setChannelStatus(post.id, 'email', 'sent')
		return {
			channel: 'email',
			status: 'sent',
			recipientCount: sentCount,
			warnings,
		}
	},
}
