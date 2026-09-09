import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

function walkSvelte(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const s = statSync(p);
		if (s.isDirectory()) entries.push(...walkSvelte(p));
		else if (entry.endsWith('.svelte')) entries.push(p);
	}
	return entries;
}

describe('pill-icon contract', () => {
	const dir = join(__dirname, '../../../src/lib/components/pills');
	const files = walkSvelte(dir);

	test('pill components exist — the contract is active, not skipped', () => {
		expect(files.length).toBeGreaterThan(0);
	});
	for (const file of files) {
		test(`${file.split(/[\\/]/).slice(-2).join('/')} renders an icon alongside text`, () => {
			const src = readFileSync(file, 'utf8');
			// Accept lucide-svelte, the repo's own Icon component, or an icon slot.
			expect(src).toMatch(
				/from\s+['"](?:lucide-svelte|\$lib\/components\/ui\/Icon\.svelte)['"]|<slot\s+name=['"]icon['"]\s*\/>/,
			);
		});
	}

	// CR-3 (HANDOVER-v8 Part A): pin the tone→glyph map so the colourblind
	// disambiguation contract (success→check · warn→clock · danger→alert-triangle,
	// mirrors the prototype window.Pill) can't be silently changed. The map lives
	// in Pill.svelte's STATE_ICON const; assert it by source so a glyph swap fails.
	test('Pill.svelte STATE_ICON pins the tone→glyph map (success/check · warn/clock · danger/alert-triangle)', () => {
		const pill = join(dir, 'Pill.svelte');
		expect(existsSync(pill)).toBe(true);
		const src = readFileSync(pill, 'utf8');
		expect(src).toMatch(/success:\s*'check'/);
		expect(src).toMatch(/warn:\s*'clock'/);
		expect(src).toMatch(/danger:\s*'alert-triangle'/);
	});
});
