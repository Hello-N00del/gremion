// Unit suite for content-db PURE logic only — runs under `test:unit`, which
// has NO Postgres (vite.config.ts excludes *.integration.test.ts). The DB
// round-trips (create→get, ensureChannels inserts 3 rows, slug dedupe on a real
// UNIQUE conflict, body persistence) live in content-db.integration.test.ts.
import { describe, it, expect } from 'vitest'
import { generateSlug, deduplicateSlug, PUBLISH_OP_GIVE_UP_AFTER_SECONDS } from './content-db'
import { sanitizeRichHtml } from '../security/html-sanitize'

describe('generateSlug', () => {
	it('lowercases and replaces spaces with hyphens', () => {
		expect(generateSlug('Hello World')).toBe('hello-world')
	})

	it('removes diacritics (German umlauts)', () => {
		expect(generateSlug('Öffentliche Ankündigung')).toBe('offentliche-ankundigung')
	})

	it('strips non-alphanumeric characters', () => {
		expect(generateSlug('StuRa 2026: Update!')).toBe('stura-2026-update')
	})

	it('collapses multiple hyphens', () => {
		expect(generateSlug('foo  --  bar')).toBe('foo-bar')
	})

	it('trims leading and trailing hyphens', () => {
		expect(generateSlug('  hello  ')).toBe('hello')
	})

	it('returns empty string for an all-symbol title (freshSlug falls back to "post")', () => {
		expect(generateSlug('!!! ???')).toBe('')
	})
})

describe('deduplicateSlug', () => {
	it('returns base slug when no conflict', () => {
		expect(deduplicateSlug('hello', [])).toBe('hello')
	})

	it('appends -2 on first conflict', () => {
		expect(deduplicateSlug('hello', ['hello'])).toBe('hello-2')
	})

	it('increments until unique', () => {
		expect(deduplicateSlug('hello', ['hello', 'hello-2', 'hello-3'])).toBe('hello-4')
	})

	it('skips occupied numeric suffixes', () => {
		expect(deduplicateSlug('hello', ['hello', 'hello-3'])).toBe('hello-2')
	})
})

// updatePostBody() sanitizes via sanitizeRichHtml before storage. The DB write
// itself is covered in the integration suite; here we assert the pure sanitize
// contract content-db depends on: a literal <script> is stripped while the <h2>
// section delimiter (the segmentation boundary) survives the allow-list.
describe('updatePostBody sanitize contract (pure path)', () => {
	it('strips <script> from a literal body string', () => {
		const raw = '<p>hi</p><script>alert(1)</script>'
		const safe = sanitizeRichHtml(raw)
		expect(safe).not.toContain('<script')
		expect(safe).not.toContain('alert(1)')
		expect(safe).toContain('<p>hi</p>')
	})

	it('preserves <h2> section delimiters through sanitization', () => {
		const raw = '<h2>Section A</h2><p>body</p>'
		const safe = sanitizeRichHtml(raw)
		expect(safe).toContain('<h2>Section A</h2>')
	})
})

// The Instagram publish-outbox give-up window must mirror the proven provisioning
// ledger (24h wall-clock) so a long-but-transient outage self-heals rather than
// retrying forever. The backoff/give-up SQL behaviour is exercised in
// content-db.publish-ops.integration.test.ts against a real Postgres.
describe('publish-ops outbox give-up window', () => {
	it('mirrors the provisioning ledger 24h give-up window', () => {
		expect(PUBLISH_OP_GIVE_UP_AFTER_SECONDS).toBe(24 * 60 * 60)
	})
})
