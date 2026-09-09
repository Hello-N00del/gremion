import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const appCss = readFileSync(join(__dirname, '../../app.css'), 'utf8');

const required = [
	// Neutrals
	'--paper', '--surface', '--surface-2', '--surface-3',
	'--ink', '--ink-2', '--ink-muted', '--ink-faint',
	'--border', '--border-strong',
	// Accents
	'--accent', '--accent-ink', '--accent-soft', '--accent-faint',
	'--ember', '--ember-soft', '--ember-ink',
	'--pine', '--pine-soft', '--pine-ink',
	'--rust', '--rust-soft', '--rust-ink',
	// Shadow / radius / spacing / motion
	'--sh-1', '--sh-2', '--sh-3',
	'--r-xs', '--r-sm', '--r-md', '--r-lg',
	'--s-1', '--s-2', '--s-3', '--s-4', '--s-5', '--s-6', '--s-7', '--s-8',
	'--e-out', '--d-fast', '--d-med',
	// Sanity-check additions
	'--touch-target-min', '--focus-ring',
	// Type
	'--font-display', '--font-body', '--font-mono',
] as const;

describe('design tokens — light mode :root presence', () => {
	for (const token of required) {
		test(`${token} is declared`, () => {
			const re = new RegExp(`(^|[\\s;{])${token.replace('-', '\\-')}\\s*:`, 'm');
			expect(appCss).toMatch(re);
		});
	}
});

describe('design tokens — dark mode .dark overrides', () => {
	const darkRequired = required.filter((t) =>
		t.startsWith('--paper') || t.startsWith('--surface') || t.startsWith('--ink') ||
		t.startsWith('--border') || t.startsWith('--accent') || t.startsWith('--ember') ||
		t.startsWith('--pine') || t.startsWith('--rust') || t.startsWith('--sh-')
	);
	const darkBlock = appCss.match(/\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';
	for (const token of darkRequired) {
		test(`${token} is overridden in .dark block`, () => {
			const re = new RegExp(`${token.replace('-', '\\-')}\\s*:`, 'm');
			expect(darkBlock).toMatch(re);
		});
	}
});

describe('design tokens — prefers-reduced-motion handling', () => {
	test('@media (prefers-reduced-motion: reduce) block exists', () => {
		expect(appCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
	});
	test('reduced-motion block sets --d-fast and --d-med to 1ms', () => {
		const block = appCss.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\}\s*\}/)?.[0] ?? '';
		expect(block).toMatch(/--d-fast\s*:\s*1ms/);
		expect(block).toMatch(/--d-med\s*:\s*1ms/);
	});
});

describe('design tokens — colorblind variants', () => {
	test('html.cb-rg block exists', () => {
		expect(appCss).toMatch(/html\.cb-rg\s*\{/);
	});
	test('html.cb-by block exists', () => {
		expect(appCss).toMatch(/html\.cb-by\s*\{/);
	});
});
