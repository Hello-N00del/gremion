import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PAGE_ACCESS, PAGE_ACCESS_PUBLIC_SEGMENTS, canAccess, Role } from './index'

/**
 * G-072 — build-time PAGE_ACCESS coverage.
 *
 * SvelteKit's filesystem router treats every directory under `src/routes/`
 * (that is not a `(group)` route, parametric `[slug]`, or a special
 * `_underscore` private folder) as a top-level URL segment. `hooks.server.ts`
 * derives the segment from `path.split('/')[1]` and dispatches `canAccess` —
 * if there is no PAGE_ACCESS entry for that segment, the guard silently
 * redirects to /auth/login?error=forbidden, producing a confusing redirect
 * loop for new routes that simply forgot the access-map entry.
 *
 * This test is the forcing function from the gap-list: every top-level route
 * directory MUST either be in PAGE_ACCESS or in PAGE_ACCESS_PUBLIC_SEGMENTS.
 * Adding a new top-level route without doing one of those will fail CI.
 *
 * Companion: the runtime dev-only throw in `canAccess` is the local-dev
 * backstop for the same class of bug; the dedicated unit test below verifies
 * that throw path.
 */

// vitest runs with cwd = gremion-ui/, so the routes dir is a stable relative
// resolve. We avoid `fileURLToPath(import.meta.url)` because the jsdom
// environment exposes `import.meta.url` as an http:// URL, not file://.
const ROUTES_DIR = resolve(process.cwd(), 'src', 'routes')

/**
 * SvelteKit conventions we deliberately skip when enumerating top-level
 * "page" segments:
 *   - `[param]` and `[...rest]` — parametric segments are not their own
 *     top-level URL; they're parts of a parent route.
 *   - `(group)` — grouped/layout routes don't appear in the URL path. There
 *     are none today at the top level, but we guard for the convention.
 *   - leading `_` — Svelte's private-module convention. None at the top
 *     level today, but guarded.
 *   - leading `.` — dotfiles/hidden directories.
 */
function isPageSegmentDir(name: string): boolean {
  if (name.startsWith('[')) return false
  if (name.startsWith('(')) return false
  if (name.startsWith('_')) return false
  if (name.startsWith('.')) return false
  return true
}

function listTopLevelSegments(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => {
      const full = join(ROUTES_DIR, name)
      try {
        if (!statSync(full).isDirectory()) return false
      } catch {
        return false
      }
      return isPageSegmentDir(name)
    })
    .sort()
}

describe('PAGE_ACCESS coverage (G-072)', () => {
  const segments = listTopLevelSegments()

  it('discovers a non-trivial set of top-level route directories (sanity)', () => {
    // If this drops to zero we're scanning the wrong path — fail loudly
    // instead of silently passing every other assertion below.
    expect(segments.length).toBeGreaterThan(5)
  })

  it.each(segments)(
    'top-level route segment "%s" is either in PAGE_ACCESS or PAGE_ACCESS_PUBLIC_SEGMENTS',
    (segment) => {
      const inPageAccess = Object.prototype.hasOwnProperty.call(PAGE_ACCESS, segment)
      const inPublicAllowlist = PAGE_ACCESS_PUBLIC_SEGMENTS.has(segment)
      expect(
        inPageAccess || inPublicAllowlist,
        `Route directory gremion-ui/src/routes/${segment}/ has no PAGE_ACCESS entry and ` +
          `is not in PAGE_ACCESS_PUBLIC_SEGMENTS. Add an entry in src/lib/auth/index.ts ` +
          `or mark the segment public if it should bypass the page-level access check.`,
      ).toBe(true)
    },
  )

  it('every PAGE_ACCESS key that names a top-level page maps to a live route directory', () => {
    // Allow extra PAGE_ACCESS keys that are not top-level directories (e.g.
    // protokolle, beschluesse — nested under members/committees/[id]/ and
    // covered by their parent's guard). The contract here is one-way: the
    // routes directory MUST NOT contain an un-mapped segment. This sub-test
    // is informational — it surfaces dead entries but doesn't fail CI.
    const liveSegments = new Set(segments)
    const dead = Object.keys(PAGE_ACCESS).filter((page) => !liveSegments.has(page))
    if (dead.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[PAGE_ACCESS] ${dead.length} entries are not top-level route directories ` +
          `(may be nested-route aliases — verify intent): ${dead.join(', ')}`,
      )
    }
    expect(true).toBe(true)
  })
})

describe('PAGE_ACCESS.settings is member-reachable (#167)', () => {
  // #167 relaxed the /settings PAGE gate from it-admin → member so every signed-in
  // member reaches the page and sees the "Konto" sections; Verwaltung/System are
  // gated INSIDE the page by data.isITAdmin, and every /api/settings* endpoint
  // keeps its own it-admin gate. This locks the gate value against regression.
  it('maps settings to Role.Member', () => {
    expect(PAGE_ACCESS.settings).toBe(Role.Member)
  })

  it('lets a member and an it-admin reach /settings', () => {
    expect(canAccess([Role.Member], 'settings')).toBe(true)
    expect(canAccess([Role.ITAdmin], 'settings')).toBe(true)
  })

  it('still denies a guest', () => {
    expect(canAccess([Role.Guest], 'settings')).toBe(false)
  })
})

describe('canAccess dev-mode throw on unknown page (G-072)', () => {
  it('throws in development for an unknown page segment', () => {
    // vitest sets import.meta.env.DEV = true by default — confirm before
    // making the load-bearing assertion below.
    expect(import.meta.env.DEV).toBe(true)
    expect(() => canAccess([Role.ITAdmin], '__never-a-real-segment__')).toThrow(
      /PAGE_ACCESS missing for: __never-a-real-segment__/,
    )
  })

  it('does NOT throw for a known page segment (regression guard)', () => {
    expect(() => canAccess([Role.Guest], 'dashboard')).not.toThrow()
    expect(canAccess([Role.Guest], 'dashboard')).toBe(true)
  })
})
