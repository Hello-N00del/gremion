import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { navSchema, type NavItem } from './nav-schema';

/**
 * Phantom-href guard (issue #155).
 *
 * The nav rail once linked "Portal-Verwaltung" to `/portal-admin`, a route that
 * never existed (the real admin landing is `/portal`). Because the page-level
 * guard 403s/redirects on an unknown segment, a fully-authorised CouncilAdmin
 * (e.g. dev.admin) appeared to be "denied access" when in fact the link was a
 * routing typo.
 *
 * This test is the forcing function for that whole class of bug: every
 * `item.href` in `navSchema` MUST resolve to a real SvelteKit route on disk.
 * Adding a nav item that points at a phantom route now fails CI.
 *
 * Resolution mirrors SvelteKit's filesystem router:
 *   `/`         -> src/routes/+page.svelte
 *   `/foo`      -> src/routes/foo/+page.svelte  (or +page.server.ts)
 *   `/foo/bar`  -> src/routes/foo/bar/+page.svelte (or +page.server.ts)
 *
 * We deliberately avoid `fileURLToPath(import.meta.url)` because the jsdom env
 * exposes `import.meta.url` as an http:// URL, not file:// — vitest runs with
 * cwd = gremion-ui/, so `process.cwd()` is a stable anchor (matches the sibling
 * page-access-coverage.test.ts).
 */
const ROUTES_DIR = resolve(process.cwd(), 'src', 'routes');

/** A page route is "live" if its directory holds a +page.svelte or +page.server.ts. */
function routeExistsOnDisk(href: string): boolean {
  const segments = href.split('/').filter(Boolean);
  const dir = join(ROUTES_DIR, ...segments);
  return existsSync(join(dir, '+page.svelte')) || existsSync(join(dir, '+page.server.ts'));
}

/** Flatten navSchema into a {label, href} list, recursing into sections. */
function collectHrefs(items: NavItem[]): { label: string; href: string }[] {
  return items.flatMap((item) =>
    item.kind === 'section'
      ? collectHrefs(item.children)
      : [{ label: item.label, href: item.href }],
  );
}

describe('navSchema hrefs resolve to real routes (issue #155)', () => {
  const hrefs = collectHrefs(navSchema);

  it('discovers a non-trivial set of nav hrefs (sanity)', () => {
    // If this collapses to zero we're walking the wrong structure — fail loudly
    // instead of vacuously passing every per-href assertion below.
    expect(hrefs.length).toBeGreaterThan(5);
  });

  it.each(hrefs)('"$label" ($href) points at a route that exists on disk', ({ label, href }) => {
    expect(
      routeExistsOnDisk(href),
      `Nav item "${label}" links to ${href}, but there is no ` +
        `src/routes${href === '/' ? '' : href}/+page.svelte (or +page.server.ts). ` +
        `Phantom hrefs make a fully-authorised user look "denied" (issue #155). ` +
        `Fix the href in nav-schema.ts or add the missing route.`,
    ).toBe(true);
  });
});
