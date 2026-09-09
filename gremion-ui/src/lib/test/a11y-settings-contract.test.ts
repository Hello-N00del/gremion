import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fontSizePx } from '$lib/stores/font-size';

const appCss = readFileSync(join(__dirname, '../../app.css'), 'utf8');

// Regression guard for #158 — the accessibility "Schriftgröße" / "Animationen"
// controls write --base-font-size and the .reduce-motion class onto <html>
// (lib/stores/theme.ts). These assertions ensure app.css actually consumes them
// so the controls have a visible effect end to end.
describe('a11y settings — Schriftgröße (font size)', () => {
	test('the body text size reads var(--base-font-size) with a 14px fallback', () => {
		// Match the body rule regardless of intervening declarations/comments.
		const bodyRule = appCss.match(/(^|\})\s*body\s*\{[\s\S]*?\}/m)?.[0] ?? '';
		expect(bodyRule).toMatch(/font-size:\s*var\(--base-font-size,\s*14px\)/);
	});
});

describe('a11y settings — Animationen (reduced motion)', () => {
	test('an unconditional html.reduce-motion block exists', () => {
		expect(appCss).toMatch(/html\.reduce-motion\s*\*/);
	});

	test('the reduce-motion block neutralises animations, transitions and scroll', () => {
		const block =
			appCss.match(/html\.reduce-motion\s*\*[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? '';
		expect(block).toMatch(/animation-duration:\s*\.001ms\s*!important/);
		expect(block).toMatch(/transition-duration:\s*\.001ms\s*!important/);
		expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
	});
});

describe('a11y settings — fontSizePx helper', () => {
	test('maps the three known keys to px values', () => {
		expect(fontSizePx('normal')).toBe('14px');
		expect(fontSizePx('large')).toBe('16px');
		expect(fontSizePx('xlarge')).toBe('18px');
	});

	test('falls back to the base size for unknown keys', () => {
		expect(fontSizePx('gross')).toBe('14px');
		expect(fontSizePx('')).toBe('14px');
	});
});
