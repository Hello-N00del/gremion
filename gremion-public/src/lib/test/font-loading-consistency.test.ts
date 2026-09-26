import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// __dirname = src/lib/test  →  ../../  = src/  (mirrors gremion-ui's own guard)
const srcDir = join(__dirname, '../..');
const appHtml = readFileSync(join(srcDir, 'app.html'), 'utf8');
const rootLayout = readFileSync(join(srcDir, 'routes/+layout.svelte'), 'utf8');

// TASK-007 / TRD-337: self-hosted fonts, no third-party CDN.
//
// Weight list is fixed per the brief's §5 Q2 decision: it mirrors exactly the
// weights the Google `css2?family=` request being removed actually loaded
// today (verified string:
// `Archivo+Narrow:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&Inter:wght@400;500;600&JetBrains+Mono:wght@400;500`),
// NOT `app.css`'s `--font-display` value (which stays "Outfit", a pre-existing
// declared-but-never-loaded token this task must not touch or lock in).
const EXPECTED_FONTSOURCE_IMPORTS = [
	'@fontsource/archivo-narrow/400.css',
	'@fontsource/archivo-narrow/400-italic.css',
	'@fontsource/archivo-narrow/500.css',
	'@fontsource/archivo-narrow/600.css',
	'@fontsource/archivo-narrow/700.css',
	'@fontsource/archivo-narrow/700-italic.css',
	'@fontsource/inter/400.css',
	'@fontsource/inter/500.css',
	'@fontsource/inter/600.css',
	'@fontsource/jetbrains-mono/400.css',
	'@fontsource/jetbrains-mono/500.css'
];

// Review r1 LOW: a plain `.includes(importPath)` also matches a
// commented-out import line (e.g. `// import '@fontsource/inter/400.css';`),
// so deleting the real import while leaving a stale comment behind would
// still pass. Anchor on an actual `import '<path>';` statement, allowing
// leading whitespace but not a `//` (or `/*`) comment prefix on that line.
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function importsFontsourceFile(source: string, importPath: string): boolean {
	const re = new RegExp(`^[ \\t]*import\\s+['"]${escapeRegExp(importPath)}['"]`, 'm');
	return re.test(source);
}

describe('font-loading consistency — gremion-public self-hosts every family it requests (TASK-007)', () => {
	for (const importPath of EXPECTED_FONTSOURCE_IMPORTS) {
		test(`root layout imports "${importPath}"`, () => {
			expect(
				importsFontsourceFile(rootLayout, importPath),
				`routes/+layout.svelte does not import "${importPath}" — this weight/style ` +
					`will fall back to faux-bold/faux-italic instead of loading its real face`
			).toBe(true);
		});
	}

	test('app.html makes no third-party Google Fonts request (TASK-007 / TRD-337)', () => {
		expect(
			appHtml.includes('fonts.googleapis.com') || appHtml.includes('fonts.gstatic.com'),
			'app.html still references Google Fonts — fonts must be self-hosted via @fontsource (TASK-007)'
		).toBe(false);
	});
});
