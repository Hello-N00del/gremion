// v12 apex topology — source guards for the build-time base path.
//
// The portal is mounted at `/` when BASE_PATH is unset (the kernel default) and
// under a prefix such as `/portal` when it is set (kit.paths.base in
// svelte.config.js). That only holds while EVERY internal link routes through
// `base` from `$app/paths`. A single `href="/protokolle"` slipping back in
// produces a link that works in the default build and silently 404s in a
// base-path build — exactly the class of bug a cheap source guard catches.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.svelte')) out.push(full);
  }
  return out;
}

const svelteFiles = walk(SRC);

// Root-relative URL in a markup attribute — i.e. NOT `{base}`-prefixed, not a
// fragment (`#x`), not a scheme (`https:`, `mailto:`), not an expression.
const ABSOLUTE_ATTR = /\b(?:href|action|src)\s*=\s*["']\/(?!\/)/g;

describe('v12 base path — no hardcoded root-relative links', () => {
  it('finds .svelte sources to scan (guards against a silently empty sweep)', () => {
    expect(svelteFiles.length).toBeGreaterThan(3);
  });

  it.each(svelteFiles.map((f) => [relative(SRC, f), f] as const))(
    '%s routes every internal link through `base`',
    (_label, file) => {
      const src = readFileSync(file, 'utf8');
      const hits = [...src.matchAll(ABSOLUTE_ATTR)].map((m) => {
        const line = src.slice(0, m.index).split('\n').length;
        return `line ${line}: ${src.slice(m.index, m.index! + 60).split('\n')[0]}`;
      });
      expect(hits, `use href="{base}/…" instead:\n${hits.join('\n')}`).toEqual([]);
    },
  );
});

// The kernel is UNBRANDED: it is a governance kernel that boots standalone, and
// StuRaOS is one instance on top of it. The v12 back-routes therefore ship as
// mechanism only — every string and target is instance-supplied, and an
// unconfigured kernel renders NOTHING rather than a link into a marketing site
// that does not exist for this operator.
describe('v12 back-routes — apex strip + footer colophon are opt-in and unbranded', () => {
  const header = readFileSync(
    fileURLToPath(new URL('../components/PortalHeader.svelte', import.meta.url)),
    'utf8',
  );
  const footer = readFileSync(
    fileURLToPath(new URL('../components/PortalFooter.svelte', import.meta.url)),
    'utf8',
  );

  it('the header carries the apex strip, gated on both target and label', () => {
    expect(header).toContain('apexHref = null');
    expect(header).toContain('apexLabel = null');
    expect(header).toContain('{#if apexHref && apexLabel}');
  });

  it('the footer carries the colophon, gated on both target and label', () => {
    expect(footer).toContain('apexHref = null');
    expect(footer).toContain('apexLabel = null');
    expect(footer).toContain('{#if apexHref && apexLabel}');
  });

  // The strings below are the instance's, not the kernel's. Comments in these
  // components legitimately DISCUSS the product they were ported from, so this
  // guard reads the code with comments stripped.
  const strip = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join('\n');

  it.each([
    ['PortalHeader.svelte', header],
    ['PortalFooter.svelte', footer],
  ])('%s hardcodes no instance branding', (_label, source) => {
    const code = strip(source);
    expect(code).not.toMatch(/sturaos/i);
    expect(code).not.toMatch(/Produkt\s*&(amp;)?\s*Info/i);
    expect(code).not.toMatch(/Läuft auf/i);
  });
});
