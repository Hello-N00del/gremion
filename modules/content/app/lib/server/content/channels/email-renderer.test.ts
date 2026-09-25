// @vitest-environment node
// Unit tests for the email channel renderer (L1 derive + L2 render/publish).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mocks (hoisted) ───────────────────────────────────────────────────────────
// SmtpUnconfiguredError is defined inside vi.hoisted so the mock factory (also
// hoisted above the import) can reference it without a TDZ error.
const { SmtpUnconfiguredError } = vi.hoisted(() => {
	class SmtpUnconfiguredError extends Error {
		constructor() {
			super('smtp-unconfigured')
			this.name = 'SmtpUnconfiguredError'
		}
	}
	return { SmtpUnconfiguredError }
})
const sendMailForTenant = vi.fn()
const getTenantMailContext = vi.fn()
const claimRecipient = vi.fn()
const mintSendToken = vi.fn()
const markDeliverySent = vi.fn()
const markDeliveryFailed = vi.fn()
const setChannelStatus = vi.fn()
const resolvePostRecipients = vi.fn()

vi.mock('$lib/server/mail/tenant-mail', () => ({
	sendMailForTenant: (...a: unknown[]) => sendMailForTenant(...a),
	getTenantMailContext: (...a: unknown[]) => getTenantMailContext(...a),
	SmtpUnconfiguredError,
}))
vi.mock('../content-db', () => ({
	claimRecipient: (...a: unknown[]) => claimRecipient(...a),
	mintSendToken: (...a: unknown[]) => mintSendToken(...a),
	markDeliverySent: (...a: unknown[]) => markDeliverySent(...a),
	markDeliveryFailed: (...a: unknown[]) => markDeliveryFailed(...a),
	setChannelStatus: (...a: unknown[]) => setChannelStatus(...a),
}))
vi.mock('../recipients', () => ({
	resolvePostRecipients: (...a: unknown[]) => resolvePostRecipients(...a),
}))

import { emailRenderer } from './email-renderer'
import type { Post, PostChannel } from '../types'

const post: Post = {
	id: 'p1',
	slug: 'hello',
	title: 'Hello World',
	body_html: '<p>Body</p>',
	created_by: 'u1',
	created_at: '2026-06-29T00:00:00.000Z',
	updated_at: '2026-06-29T00:00:00.000Z',
}

function channel(overrides: Record<string, unknown> = {}): PostChannel {
	return {
		post_id: 'p1',
		channel: 'email',
		enabled: true,
		status: 'draft',
		scheduled_at: null,
		overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	claimRecipient.mockResolvedValue('fresh')
	mintSendToken.mockResolvedValue('tok-1')
	markDeliverySent.mockResolvedValue(undefined)
	markDeliveryFailed.mockResolvedValue(undefined)
	setChannelStatus.mockResolvedValue({})
	sendMailForTenant.mockResolvedValue({ messageId: 'mid-1' })
	resolvePostRecipients.mockResolvedValue([])
	// SMTP configured by default; the unconfigured pre-check test flips this.
	getTenantMailContext.mockReturnValue({ configured: true })
})

describe('emailRenderer.derive', () => {
	it('uses the post title as subject and the body verbatim', () => {
		const out = emailRenderer.derive(post, [], channel())
		expect(out).toEqual({ subject: 'Hello World', html: '<p>Body</p>', warnings: [] })
	})

	it('honours an overrides.subject string', () => {
		const out = emailRenderer.derive(post, [], channel({ subject: 'Custom Subject' }))
		expect(out.subject).toBe('Custom Subject')
	})

	it('falls back to the title when overrides.subject is not a string', () => {
		const out = emailRenderer.derive(post, [], channel({ subject: 42 }))
		expect(out.subject).toBe('Hello World')
	})

	it('is deterministic — calling twice is deep-equal', () => {
		const c = channel({ subject: 'X' })
		expect(emailRenderer.derive(post, [], c)).toEqual(emailRenderer.derive(post, [], c))
	})

	it('reports email as its channel', () => {
		expect(emailRenderer.channel).toBe('email')
	})
})

describe('emailRenderer.render', () => {
	it('returns the email artifact with subject + re-sanitized body', async () => {
		const dirty: Post = { ...post, body_html: '<p>ok</p><script>alert(1)</script>' }
		const out = await emailRenderer.render(dirty, [], channel())
		expect(out.kind).toBe('email')
		if (out.kind !== 'email') throw new Error('expected email artifact')
		expect(out.subject).toBe('Hello World')
		expect(out.html).toContain('<p>ok</p>')
		expect(out.html).not.toContain('<script>')
		expect(out.html).not.toContain('alert(1)')
	})

	it('honours overrides.subject', async () => {
		const out = await emailRenderer.render(post, [], channel({ subject: 'S' }))
		if (out.kind !== 'email') throw new Error('expected email artifact')
		expect(out.subject).toBe('S')
	})
})

describe('emailRenderer.publish', () => {
	it('sends to every fresh recipient and marks each sent, then sets channel sent', async () => {
		resolvePostRecipients.mockResolvedValue([
			{ email: 'a@x.de', name: 'A' },
			{ email: 'b@x.de', name: null },
		])

		const out = await emailRenderer.publish(post, [], channel())

		expect(sendMailForTenant).toHaveBeenCalledTimes(2)
		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'a@x.de', 'mid-1')
		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'b@x.de', 'mid-1')
		// the unsubscribe footer linking the minted token is injected into the html
		const firstHtml = sendMailForTenant.mock.calls[0]![0].html as string
		expect(firstHtml).toContain('/content/unsubscribe?token=tok-1')
		expect(firstHtml).toContain('Abmelden')
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'sent')

		expect(out).toEqual({
			channel: 'email',
			status: 'sent',
			recipientCount: 2,
			warnings: [],
		})
	})

	it('does not double-send: an all-already-sent re-publish sends 0', async () => {
		resolvePostRecipients.mockResolvedValue([
			{ email: 'a@x.de', name: 'A' },
			{ email: 'b@x.de', name: null },
		])
		claimRecipient.mockResolvedValue('already-sent')

		const out = await emailRenderer.publish(post, [], channel())

		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(markDeliverySent).not.toHaveBeenCalled()
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'sent')
		expect(out).toEqual({
			channel: 'email',
			status: 'sent',
			recipientCount: 0,
			warnings: [],
		})
	})

	it('skips an in-flight claim (no send, no double-send)', async () => {
		resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: 'A' }])
		claimRecipient.mockResolvedValue('in-flight')

		const out = await emailRenderer.publish(post, [], channel())

		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(out.recipientCount).toBe(0)
	})

	it('SMTP unconfigured → failed result, no throw, NO claim taken (pre-check before the loop)', async () => {
		// The pre-check sees SMTP unconfigured BEFORE resolving/claiming recipients,
		// so no delivery row is orphaned in 'claimed' state.
		getTenantMailContext.mockReturnValue({ configured: false })
		resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: 'A' }])

		const out = await emailRenderer.publish(post, [], channel())

		expect(out).toEqual({
			channel: 'email',
			status: 'failed',
			recipientCount: 0,
			warnings: [],
			detail: 'SMTP not configured',
		})
		// no claim taken (pre-check short-circuits before the loop), no send,
		// no ledger writes, and the channel status is left untouched
		expect(claimRecipient).not.toHaveBeenCalled()
		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(setChannelStatus).not.toHaveBeenCalled()
		expect(markDeliverySent).not.toHaveBeenCalled()
		expect(markDeliveryFailed).not.toHaveBeenCalled()
	})

	it('no recipients resolved → failed result with a "no recipients" warning', async () => {
		resolvePostRecipients.mockResolvedValue([])

		const out = await emailRenderer.publish(post, [], channel())

		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(claimRecipient).not.toHaveBeenCalled()
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'failed')
		expect(out).toEqual({
			channel: 'email',
			status: 'failed',
			recipientCount: 0,
			warnings: ['no recipients resolved'],
			detail: 'no recipients',
		})
	})

	it('every send failing → failed result (not "sent"), all marked failed', async () => {
		resolvePostRecipients.mockResolvedValue([
			{ email: 'a@x.de', name: null },
			{ email: 'b@x.de', name: null },
		])
		sendMailForTenant.mockRejectedValue(new Error('mailbox full'))

		const out = await emailRenderer.publish(post, [], channel())

		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'a@x.de', 'mailbox full')
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'b@x.de', 'mailbox full')
		expect(markDeliverySent).not.toHaveBeenCalled()
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'failed')
		expect(out.status).toBe('failed')
		expect(out.recipientCount).toBe(0)
		expect(out.detail).toBe('all sends failed')
		expect(out.warnings).toContain('all sends failed')
	})

	it('isolates one recipient send failure: marks it failed, others still sent', async () => {
		resolvePostRecipients.mockResolvedValue([
			{ email: 'good@x.de', name: null },
			{ email: 'bad@x.de', name: null },
			{ email: 'good2@x.de', name: null },
		])
		sendMailForTenant
			.mockResolvedValueOnce({ messageId: 'm1' })
			.mockRejectedValueOnce(new Error('mailbox full'))
			.mockResolvedValueOnce({ messageId: 'm3' })

		const out = await emailRenderer.publish(post, [], channel())

		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'good@x.de', 'm1')
		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'good2@x.de', 'm3')
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'bad@x.de', 'mailbox full')
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'sent')
		expect(out.status).toBe('sent')
		expect(out.recipientCount).toBe(2)
		expect(out.warnings).toEqual([expect.stringContaining('bad@x.de')])
	})

	it('claim, token, and ledger all use the lowercased email (suppression cannot be bypassed by case)', async () => {
		// resolvePostRecipients now returns lowercased emails; even if a stray
		// mixed-case value arrived, the renderer lowercases at every boundary so
		// the claim/token/ledger lookups are byte-identical to the unsubscribe rows.
		resolvePostRecipients.mockResolvedValue([{ email: 'MixedCase@X.de', name: null }])

		await emailRenderer.publish(post, [], channel())

		expect(claimRecipient).toHaveBeenCalledWith('p1', 'mixedcase@x.de')
		// the send token is minted with the lowercased email (so send_tokens,
		// deliveries, and unsubscribes all agree on case)
		expect(mintSendToken).toHaveBeenCalledWith('p1', 'mixedcase@x.de')
		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'mixedcase@x.de', 'mid-1')
	})
})
