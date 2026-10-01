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
const claimDelivery = vi.fn()
const mintSendToken = vi.fn()
const markDeliverySent = vi.fn()
const markDeliveryFailed = vi.fn()
const setChannelStatus = vi.fn()
const resolvePostRecipients = vi.fn()
const getTenant = vi.fn()

vi.mock('$lib/server/tenant/context', () => ({
	getTenant: (...a: unknown[]) => getTenant(...a),
}))
vi.mock('$lib/server/mail/tenant-mail', () => ({
	sendMailForTenant: (...a: unknown[]) => sendMailForTenant(...a),
	getTenantMailContext: (...a: unknown[]) => getTenantMailContext(...a),
	SmtpUnconfiguredError,
}))
vi.mock('../content-db', () => ({
	claimDelivery: (...a: unknown[]) => claimDelivery(...a),
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

const TOKEN = '1790000000000001'

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
	claimDelivery.mockResolvedValue({ result: 'fresh', claimToken: TOKEN })
	mintSendToken.mockResolvedValue('tok-1')
	markDeliverySent.mockResolvedValue(undefined)
	markDeliveryFailed.mockResolvedValue(undefined)
	setChannelStatus.mockResolvedValue({})
	sendMailForTenant.mockResolvedValue({ messageId: 'mid-1' })
	resolvePostRecipients.mockResolvedValue([])
	// SMTP configured by default; the unconfigured pre-check test flips this.
	getTenantMailContext.mockReturnValue({ configured: true })
	getTenant.mockReturnValue({ id: 't1', primaryHost: 'rat.example.org' })
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
		claimDelivery.mockResolvedValue({ result: 'already-sent', claimToken: null })

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
		claimDelivery.mockResolvedValue({ result: 'in-flight', claimToken: null })

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
		expect(claimDelivery).not.toHaveBeenCalled()
		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(setChannelStatus).not.toHaveBeenCalled()
		expect(markDeliverySent).not.toHaveBeenCalled()
		expect(markDeliveryFailed).not.toHaveBeenCalled()
	})

	it('no recipients resolved → failed result with a "no recipients" warning', async () => {
		resolvePostRecipients.mockResolvedValue([])

		const out = await emailRenderer.publish(post, [], channel())

		expect(sendMailForTenant).not.toHaveBeenCalled()
		expect(claimDelivery).not.toHaveBeenCalled()
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

		// The claim token keeps a late failure off a claim another worker took over.
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'a@x.de', 'mailbox full', TOKEN)
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'b@x.de', 'mailbox full', TOKEN)
		expect(markDeliverySent).not.toHaveBeenCalled()
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'failed')
		expect(out.status).toBe('failed')
		expect(out.recipientCount).toBe(0)
		expect(out.detail).toBe('all sends failed')
		expect(out.warnings).toContain('all sends failed')
	})

	it('isolates one recipient send failure: marks it failed, others still sent, channel NOT sent (H07)', async () => {
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
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'bad@x.de', 'mailbox full', TOKEN)
		// F1-FIX-07 H07: while a recipient is un-mailed the channel is not 'sent';
		// a re-publish re-claims the failed row (claimDelivery takes over 'failed').
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'failed')
		expect(setChannelStatus).not.toHaveBeenCalledWith('p1', 'email', 'sent')
		expect(out.status).toBe('failed')
		expect(out.recipientCount).toBe(2)
		expect(out.warnings).toEqual(expect.arrayContaining([expect.stringContaining('bad@x.de')]))
	})

	it('unsubscribe link is ABSOLUTE on the tenant primary host (S1c#0)', async () => {
		resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: null }])

		await emailRenderer.publish(post, [], channel())

		const html = sendMailForTenant.mock.calls[0]![0].html as string
		expect(html).toContain('href="https://rat.example.org/content/unsubscribe?token=tok-1"')
	})

	it('no primary host → failed result before any claim (no relative or localhost link is ever mailed)', async () => {
		getTenant.mockReturnValue({ id: 't1', primaryHost: null })
		resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: null }])

		const out = await emailRenderer.publish(post, [], channel())

		expect(out).toMatchObject({ channel: 'email', status: 'failed', detail: 'no public host for unsubscribe links' })
		expect(claimDelivery).not.toHaveBeenCalled()
		expect(sendMailForTenant).not.toHaveBeenCalled()
	})

	it('claim, token, and ledger all use the lowercased email (suppression cannot be bypassed by case)', async () => {
		// resolvePostRecipients now returns lowercased emails; even if a stray
		// mixed-case value arrived, the renderer lowercases at every boundary so
		// the claim/token/ledger lookups are byte-identical to the unsubscribe rows.
		resolvePostRecipients.mockResolvedValue([{ email: 'MixedCase@X.de', name: null }])

		await emailRenderer.publish(post, [], channel())

		expect(claimDelivery).toHaveBeenCalledWith('p1', 'mixedcase@x.de')
		// the send token is minted with the lowercased email (so send_tokens,
		// deliveries, and unsubscribes all agree on case)
		expect(mintSendToken).toHaveBeenCalledWith('p1', 'mixedcase@x.de')
		expect(markDeliverySent).toHaveBeenCalledWith('p1', 'mixedcase@x.de', 'mid-1')
	})

	// ── R29-LOW-07 L2: a mixed pass, "do not re-publish" always wins ───────────
	it('L2: one send throws AND another ledger write keeps failing → the do-not-re-publish result wins', async () => {
		resolvePostRecipients.mockResolvedValue([
			{ email: 'bad@x.de', name: null },
			{ email: 'ghost@x.de', name: null },
		])
		sendMailForTenant
			.mockRejectedValueOnce(new Error('mailbox full'))
			.mockResolvedValueOnce({ messageId: 'm2' })
		markDeliverySent.mockRejectedValue(new Error('ledger down'))
		// the channel flag is best-effort too: the DB is likely the thing failing
		setChannelStatus.mockRejectedValue(new Error('db down'))

		const out = await emailRenderer.publish(post, [], channel())

		expect(out.status).toBe('failed')
		expect(out.detail).toBe('delivery not recorded')
		expect(out.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('do not re-publish before checking the delivery log'),
			]),
		)
		expect(out.warnings.join('\n')).not.toContain('publish again to retry')
		// the definitive failure was still marked (with its token); the delivered-but-
		// unrecorded recipient was NEVER marked failed (that would re-send it)
		expect(markDeliveryFailed).toHaveBeenCalledTimes(1)
		expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'bad@x.de', 'mailbox full', TOKEN)
	}, 15_000)

	it('L2: a ledger write that fails once is retried and the recipient counts as sent', async () => {
		resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: null }])
		markDeliverySent.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(undefined)

		const out = await emailRenderer.publish(post, [], channel())

		expect(markDeliverySent).toHaveBeenCalledTimes(2)
		expect(markDeliveryFailed).not.toHaveBeenCalled()
		expect(out.status).toBe('sent')
		expect(out.recipientCount).toBe(1)
	})

	// ── R29-LOW-07 L3: an unknown outcome keeps the claim ───────────────────────
	function smtpError(over: Record<string, unknown>): Error {
		return Object.assign(new Error('smtp transport error'), over)
	}

	describe.each([
		// The shapes the installed nodemailer really emits (see smtp-outcome.test.ts, which
		// proves them against the real transport): every socket-level error says 'CONN'.
		['a socket timeout (ETIMEDOUT, CONN, "Timeout")', { code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' }],
		['an unexpected close (ECONNECTION, CONN)', { code: 'ECONNECTION', command: 'CONN', message: 'Connection closed unexpectedly' }],
		['a socket reset mid-session (ESOCKET, CONN, read)', { code: 'ESOCKET', command: 'CONN', syscall: 'read', errno: 'ECONNRESET' }],
	])('L3 unknown outcome: %s', (_label, over) => {
		it('keeps the claim (no markDeliveryFailed), counts it as unrecorded, never reports sent', async () => {
			resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: null }])
			sendMailForTenant.mockRejectedValue(smtpError(over))

			const out = await emailRenderer.publish(post, [], channel())

			expect(markDeliveryFailed).not.toHaveBeenCalled()
			expect(markDeliverySent).not.toHaveBeenCalled()
			expect(out.status).toBe('failed')
			expect(out.detail).toBe('delivery not recorded')
			expect(out.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining('do not re-publish before checking the delivery log'),
				]),
			)
			expect(setChannelStatus).not.toHaveBeenCalledWith('p1', 'email', 'sent')
		})
	})

	describe.each([
		['a refused connection (ESOCKET, CONN, connect)', { code: 'ESOCKET', command: 'CONN', syscall: 'connect', errno: 'ECONNREFUSED' }],
		['a connection timeout (ETIMEDOUT, CONN, "Connection timeout")', { code: 'ETIMEDOUT', command: 'CONN', message: 'Connection timeout' }],
		['a call on a destroyed connection (ECONNECTION, API)', { code: 'ECONNECTION', command: 'API' }],
		['a 550 rejection of the recipient', { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 no such user' }],
		['a 451 rejection of the message (DATA)', { code: 'EMESSAGE', command: 'DATA', responseCode: 451, response: '451 try later' }],
		['a connection error that carries an SMTP response code', { code: 'ECONNECTION', command: 'DATA', responseCode: 421, response: '421 closing' }],
	])('L3 definitive failure: %s', (_label, over) => {
		it('marks it failed with the claim token so a re-publish retries it', async () => {
			resolvePostRecipients.mockResolvedValue([{ email: 'a@x.de', name: null }])
			sendMailForTenant.mockRejectedValue(smtpError(over))

			const out = await emailRenderer.publish(post, [], channel())

			expect(markDeliveryFailed).toHaveBeenCalledWith('p1', 'a@x.de', expect.any(String), TOKEN)
			expect(out.status).toBe('failed')
			expect(out.detail).toBe('all sends failed')
		})
	})
})
