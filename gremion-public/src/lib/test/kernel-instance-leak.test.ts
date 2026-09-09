import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// gremion-public instance-leak + prototype-residue guard.
//
// Why this file exists at all: gremion-ui has `src/lib/brand.guard.test.ts`,
// but it scans `resolve(process.cwd(), 'src')` with vitest's cwd at gremion-ui/.
// gremion-public is a SEPARATE workspace package with its own vitest run, so it
// was never covered by that guard — which is exactly why a hardcoded 'StuRaOS'
// default survived here. This is the missing counterpart.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // gremion-public/src
const SCANNED = new Set(['.svelte', '.ts', '.js']);

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) collect(abs, out);
    else if (SCANNED.has(abs.slice(abs.lastIndexOf('.')))) out.push(abs);
  }
  return out;
}

const FILES = collect(SRC).filter((f) => !/\.test\.ts$/.test(f));
const rel = (f: string) => relative(SRC, f).split('\\').join('/');
const body = (f: string) => readFileSync(f, 'utf8');

describe('gremion-public leak guard: the scan itself is not vacuous', () => {
  test('the scan actually collected source files', () => {
    // A guard that collected zero files "passes". Pin the floor.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.map(rel)).toContain('routes/+layout.server.ts');
    expect(FILES.map(rel)).toContain('lib/components/PortalHeader.svelte');
  });
});

// ── (i) instance-name leaks: unconfigured must render NOTHING ───────────────
//
// The kernel ships as a governance product that any body can deploy. An
// unconfigured deploy must render an EMPTY slot, never another instance's
// name — a wrong name is worse than no name. This mirrors the `apexUrl` /
// `apexLabel` treatment already documented in +layout.server.ts.
//
// Explicitly OUT OF SCOPE and deliberately not asserted here: the hardcoded 'S'
// brand mark in PortalHeader.svelte. That is a Design call (the design owner owns
// StuRaOS visual identity), not a mechanical code fix.

describe('(i) no instance name is baked in as a fallback', () => {
  test("no source file defaults a value to 'StuRaOS'", () => {
    const offenders = FILES.filter((f) => /StuRaOS/.test(body(f))).map(rel);
    expect(offenders, `parameterise these — the kernel must not name an instance`).toEqual([]);
  });

  test("PUBLIC_PRODUCT_NAME renders nothing when unconfigured", () => {
    const f = body(join(SRC, 'routes/+layout.server.ts'));
    expect(f).toMatch(/product:\s*env\.PUBLIC_PRODUCT_NAME\s*\|\|\s*null/);
    expect(f).not.toMatch(/PUBLIC_PRODUCT_NAME\s*\?\?\s*['"]/);
  });

  test("the product chip is conditional, so a null product renders no chrome", () => {
    const f = body(join(SRC, 'routes/+layout.svelte'));
    expect(f).toMatch(/\{#if data\.product\}/);
  });

  test("no 'Studierendenschaft' fallback in the portal chrome", () => {
    const h = body(join(SRC, 'lib/components/PortalHeader.svelte'));
    expect(h).not.toMatch(/\?\?\s*['"]Studierendenschaft['"]/);
    // the label slot must be conditional rather than defaulted
    expect(h).toMatch(/\{#if legislatureLabel\}/);
  });
});

// ── (h) #haushalt prototype budget block ────────────────────────────────────
//
// v5 Task 4.8 shipped a public budget SECTION FRAME with no data behind it:
// no budget table, only a "Haushaltsplan-PDF noch nicht hinterlegt" note and
// copy about a Semesterbeitrag. It is prototype residue in a governance-only
// kernel — removed along with the PUBLIC_PORTAL_BUDGET optional-section
// plumbing that gated it.

describe('(h) the #haushalt prototype budget block is gone', () => {
  // Live references only. `+page.server.ts` keeps a tombstone COMMENT naming the
  // two retired env vars so an operator who still has them in .env can find out
  // what happened to them; these needles are the executable forms
  // (`env.X` reads, `data.X` fields, the section anchor, the rendered copy),
  // none of which a comment can produce.
  test.each([
    'showBudget',
    'budgetPdfUrl',
    'env\\.PUBLIC_PORTAL_BUDGET',
    'env\\.PUBLIC_BUDGET_PDF_URL',
    'id="haushalt"',
    '#haushalt',
    'Haushaltsplan',
    'Semesterbeitrag',
  ])('no live %s reference anywhere in gremion-public source', (needle) => {
    const re = new RegExp(needle, 'i');
    const offenders = FILES.filter((f) => re.test(body(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  test('the surrounding page still renders its real sections', () => {
    const p = body(join(SRC, 'routes/+page.svelte'));
    expect(p).toContain('protokolle');
    expect(p.length).toBeGreaterThan(2000);
  });

  test('the remaining optional section (#antrag) still works', () => {
    const s = body(join(SRC, 'routes/+page.server.ts'));
    expect(s).toContain('showAntrag');
    expect(s).toContain('PUBLIC_PORTAL_ANTRAG');
  });
});
