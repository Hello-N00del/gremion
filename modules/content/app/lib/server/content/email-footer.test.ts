// @vitest-environment node
// Unit tests for the email unsubscribe-footer injector.
import { describe, it, expect } from 'vitest'
import { injectUnsubscribeFooter } from './email-footer'

const URL = 'https://t.example.com/content/unsubscribe?token=abc-123'

describe('injectUnsubscribeFooter', () => {
	it('inserts the footer immediately before </body>', () => {
		const out = injectUnsubscribeFooter('<html><body><p>hi</p></body></html>', URL)
		expect(out).toContain('Abmelden')
		// footer sits before the closing body tag, after the original content
		const footerIdx = out.indexOf('Abmelden')
		const bodyIdx = out.indexOf('</body>')
		expect(footerIdx).toBeLessThan(bodyIdx)
		expect(out.indexOf('<p>hi</p>')).toBeLessThan(footerIdx)
	})

	it('appends the footer when there is no </body>', () => {
		const out = injectUnsubscribeFooter('<p>just a fragment</p>', URL)
		expect(out.startsWith('<p>just a fragment</p>')).toBe(true)
		expect(out).toContain('Abmelden')
	})

	it('matches </body> case-insensitively', () => {
		const out = injectUnsubscribeFooter('<BODY><p>x</p></BODY>', URL)
		expect(out.indexOf('Abmelden')).toBeLessThan(out.indexOf('</BODY>'))
	})

	it('links the unsubscribe URL (URI-encoded) in the footer href', () => {
		const out = injectUnsubscribeFooter('<body></body>', URL)
		expect(out).toContain(`href="${encodeURI(URL)}"`)
	})

	it('URI-encodes a url with characters that would break the href', () => {
		const out = injectUnsubscribeFooter(
			'<body></body>',
			'https://t.example.com/u?token=a b&"x"',
		)
		// raw spaces / quotes must not survive into the attribute
		expect(out).not.toContain('token=a b')
		expect(out).toContain('href="https://t.example.com/u?token=a%20b&%22x%22"')
	})
})
