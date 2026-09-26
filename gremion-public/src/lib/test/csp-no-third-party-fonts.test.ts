import { describe, test, expect } from 'vitest';
import { CSP_HEADER_VALUE } from '../../hooks.server';

// TASK-007 / TRD-337: self-hosted fonts, no third-party CDN. Once app.html no
// longer loads the Google stylesheet, the CSP must stop allowlisting either
// Google Fonts host too — an allowlist entry with nothing left to allow is
// exactly the kind of directive that silently rots.
describe("gremion-public's CSP no longer allowlists Google Fonts (TASK-007)", () => {
	const directives = Object.fromEntries(
		CSP_HEADER_VALUE.split(';').map((d) => {
			const [name, ...rest] = d.trim().split(' ');
			return [name, rest.join(' ')];
		})
	);

	test('style-src does not allowlist fonts.googleapis.com', () => {
		expect(directives['style-src']).toBeDefined();
		expect(directives['style-src'].includes('fonts.googleapis.com')).toBe(false);
	});

	test('font-src does not allowlist fonts.gstatic.com', () => {
		expect(directives['font-src']).toBeDefined();
		expect(directives['font-src'].includes('fonts.gstatic.com')).toBe(false);
	});

	test("style-src keeps 'self' and 'unsafe-inline' (no functional loss beyond the removed host)", () => {
		expect(directives['style-src']).toContain("'self'");
		expect(directives['style-src']).toContain("'unsafe-inline'");
	});

	test("font-src keeps 'self' and data: (no functional loss beyond the removed host)", () => {
		expect(directives['font-src']).toContain("'self'");
		expect(directives['font-src']).toContain('data:');
	});
});
