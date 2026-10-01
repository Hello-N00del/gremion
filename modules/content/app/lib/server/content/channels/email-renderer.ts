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

/** SMTP commands that precede the message body: a transport failure there means nothing was handed over. */
const PRE_DATA_COMMANDS = new Set(['CONN', 'EHLO', 'HELO', 'LHLO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'])
/** nodemailer transport-level error codes (connection drop, timeout, socket error). */
const TRANSPORT_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET'])

/**
 * Whether a sendMailForTenant throw leaves the outcome UNKNOWN (R29-LOW-07 L3),
 * mirroring the content leaf's MailOutcomeUnknownError: a connection drop,
 * timeout or socket error AFTER the message was handed to the server (nodemailer
 * `command` DATA or later, or no command at all) with NO SMTP response. The
 * server may have accepted the message, so the caller keeps the claim.
 *
 * Definitive (the mail was not accepted): any error that carries an SMTP response
 * code (a 4xx/5xx rejection on RCPT/MAIL/DATA), a transport error before the body
 * was sent (CONN / EHLO / AUTH / MAIL FROM / RCPT TO), and every non-transport
 * error (EENVELOPE, EAUTH, unconfigured, plain Error).
 */
function isOutcomeUnknown(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false
	const { code, command, responseCode } = err as {
		code?: unknown
		command?: unknown
		responseCode?: unknown
	}
	if (typeof code !== 'string' || !TRANSPORT_ERROR_CODES.has(code)) return false
	if (responseCode !== undefined && responseCode !== null) return false // the server answered
	if (typeof command === 'string' && PRE_DATA_COMMANDS.has(command)) return false
	return true
}

/** Total markDeliverySent attempts for a delivered mail, and the pause before each retry. */
const RECORD_DELIVERED_ATTEMPTS = 3
const RECORD_DELIVERED_BACKOFF_MS = 50

/**
 * Record a mail the transport has ALREADY delivered. The ledger write is retried a
 * bounded number of times; if it still fails the row is LEFT 'claimed' and this
 * returns false. It never calls markDeliveryFailed: a 'failed' row is re-claimed
 * by the next publish, which would mail a delivered recipient again.
 */
async function recordDelivered(
	backend: ReturnType<typeof getContentBackend>,
	postId: string,
	emailLower: string,
	messageId: string,
): Promise<boolean> {
	let lastError: unknown
	for (let attempt = 1; attempt <= RECORD_DELIVERED_ATTEMPTS; attempt++) {
		try {
			await backend.markDeliverySent(postId, emailLower, messageId)
			return true
		} catch (err) {
			lastError = err
			if (attempt < RECORD_DELIVERED_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, RECORD_DELIVERED_BACKOFF_MS * attempt))
			}
		}
	}
	console.error(
		`[email-renderer] ${emailLower} (post ${postId}) was DELIVERED (message ${messageId}) but the ledger ` +
			`write failed ${RECORD_DELIVERED_ATTEMPTS}x; its claim is left in place (not marked failed):`,
		lastError instanceof Error ? lastError.message : String(lastError),
	)
	return false
}

/**
 * Flag the email channel 'failed', best-effort: the database is likely the thing
 * failing, and a failed flag must never mask the publish result the operator needs.
 */
async function flagChannelFailed(
	backend: ReturnType<typeof getContentBackend>,
	postId: string,
): Promise<void> {
	try {
		await backend.setChannelStatus(postId, 'email', 'failed')
	} catch (err) {
		console.error(
			`[email-renderer] post ${postId}: flagging the email channel failed ALSO failed:`,
			err instanceof Error ? err.message : String(err),
		)
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
	 *   claimDelivery → only 'fresh' proceeds (already-sent / in-flight skip) →
	 *   mint a send token → inject the unsubscribe footer → sendMailForTenant →
	 *   markDeliverySent. A per-recipient send throw is isolated (markDeliveryFailed
	 *   with the claim token + continue), so one bad address never aborts the pass or
	 *   re-sends the rest. A throw that leaves the outcome unknown (connection drop
	 *   after the message was handed over) keeps the claim instead, and a delivered
	 *   mail whose ledger write fails is never marked failed: both count as
	 *   "unrecorded" and the result says not to re-publish before checking the log.
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
		let failedCount = 0 // fresh sends that threw definitively this pass
		// Delivered (or possibly delivered) this pass, but with no ledger row: the
		// claim is kept, never 'failed' (a 'failed' row is re-sent by the next publish).
		let unrecordedCount = 0

		// Recipients are already lowercased by resolvePostRecipients; emailLower
		// keeps the claim/token/ledger lookups byte-identical regardless of source.
		for (const { email } of recipients) {
			const emailLower = email.toLowerCase()

			// The double-send gate: only a 'fresh' claim sends. claimToken identifies
			// THIS claim, so a late failure of ours cannot fail one that took over.
			const { result: claim, claimToken } = await backend.claimDelivery(post.id, emailLower)
			if (claim === 'already-sent') {
				alreadySentCount += 1
				continue
			}
			if (claim !== 'fresh') continue // 'in-flight' — another worker owns it

			const token = await backend.mintSendToken(post.id, emailLower)
			const unsubUrl = `${origin}/content/unsubscribe?token=${encodeURIComponent(token)}`
			const personalizedHtml = injectUnsubscribeFooter(html, unsubUrl)

			// ONLY the transport send is inside this try: a throw from the ledger
			// write AFTER a delivered send must never reach markDeliveryFailed.
			let messageId: string
			try {
				;({ messageId } = await sendMailForTenant({
					to: email,
					subject,
					html: personalizedHtml,
				}))
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (isOutcomeUnknown(err)) {
					// The connection dropped AFTER the message was handed to the server: it
					// MAY have been delivered. Keep the claim (no markDeliveryFailed), so a
					// re-publish does not double-send it; the 15-min stale-claim takeover
					// retries it (bounded at-least-once). Counted like an unrecorded delivery.
					unrecordedCount += 1
					warnings.push(
						`send to ${emailLower} has an unknown outcome — its claim is kept, retried only after the 15-min stale window: ${message}`,
					)
					continue
				}
				// Definitive per-recipient failure (SMTP rejection / never connected):
				// isolate it and keep sending the others. The 'failed' row is re-claimed
				// by the next publish (claimDelivery takes over failed rows, F1-FIX-07
				// H07), so it is retried, not lost.
				await backend.markDeliveryFailed(post.id, emailLower, message, claimToken ?? undefined)
				failedCount += 1
				warnings.push(`send to ${emailLower} failed: ${message}`)
				continue
			}

			// Delivered. Record it (bounded retry); if the ledger write still fails the
			// claim stays in place and the recipient counts as not recorded.
			if (await recordDelivered(backend, post.id, emailLower, messageId)) {
				sentCount += 1
			} else {
				unrecordedCount += 1
				warnings.push(
					`${emailLower} was delivered but the delivery ledger write failed — not re-sent; its claim is kept (retried only after the 15-min stale window)`,
				)
			}
		}

		// "Do not re-publish" always wins (R29-LOW-07 L2): while any recipient was
		// delivered (or may have been) without a ledger row, a re-publish could mail
		// it again, so this beats the "publish again to retry" advice below even when
		// other recipients failed definitively in the same pass. The channel flag is
		// best-effort (the DB is likely what is failing) and must not mask the result.
		if (unrecordedCount > 0) {
			await flagChannelFailed(backend, post.id)
			return {
				channel: 'email',
				status: 'failed',
				recipientCount: sentCount,
				warnings: [
					...warnings,
					`${unrecordedCount} recipient(s) delivered but not recorded in the delivery ledger — do not re-publish before checking the delivery log`,
				],
				detail: 'delivery not recorded',
			}
		}

		// PARTIAL (F1-FIX-07 H07): some recipients delivered, some sends threw.
		// The channel must not read 'sent' while a recipient is un-mailed.
		if (failedCount > 0 && sentCount + alreadySentCount > 0) {
			await flagChannelFailed(backend, post.id)
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
			await flagChannelFailed(backend, post.id)
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
