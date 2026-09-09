import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// __dirname = src/lib/test  →  ../../  = src/  (same pattern as design-tokens-presence.test.ts)
const srcDir = join(__dirname, '../..');
const appCss = readFileSync(join(srcDir, 'app.css'), 'utf8');
const appHtml = readFileSync(join(srcDir, 'app.html'), 'utf8');
const rootLayout = readFileSync(join(srcDir, 'routes/+layout.svelte'), 'utf8');

/** Extract the first quoted family from a `--font-*: "Family", fallback...;` declaration. */
function primaryFamily(varName: string): string {
	const m = appCss.match(new RegExp(`${varName}\\s*:\\s*"([^"]+)"`));
	if (!m) throw new Error(`${varName} not found (or not quoted) in app.css`);
	return m[1];
}

// #177: fonts are self-hosted via @fontsource (imported in routes/+layout.svelte),
// not loaded from Google. The guard now asserts each declared family has a
// matching @fontsource import — so a family can never be declared-but-unloaded —
// and that app.html carries no third-party Google Fonts request.
describe('font-loading consistency — every --font-* primary family is self-hosted', () => {
	for (const varName of ['--font-display', '--font-body', '--font-mono'] as const) {
		test(`${varName}'s primary family is imported from @fontsource in the root layout`, () => {
			const family = primaryFamily(varName); // e.g. "Archivo Narrow"
			const slug = family.toLowerCase().replace(/ /g, '-'); // "archivo-narrow"
			expect(
				new RegExp(`@fontsource/${slug}/`).test(rootLayout),
				`app.css ${varName} is "${family}" but routes/+layout.svelte never imports ` +
					`"@fontsource/${slug}/…" — the font is unloaded and will fall back to system-ui`
			).toBe(true);
		});
	}

	test('app.html makes no third-party Google Fonts request (#177)', () => {
		expect(
			appHtml.includes('fonts.googleapis.com') || appHtml.includes('fonts.gstatic.com'),
			'app.html still references Google Fonts — fonts must be self-hosted via @fontsource (#177)'
		).toBe(false);
	});
});
