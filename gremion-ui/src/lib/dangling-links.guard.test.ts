// src/lib/dangling-links.guard.test.ts
// Guard: every static internal link resolves to a route this build has.
//
// The carve removed whole feature modules but left their links behind. The
// dashboard offered "Zu den Abstimmungen" to every ordinary user and the
// Beschluesse empty state — the first screen a fresh instance shows — linked to
// /votes. Neither route exists. A 404 dressed as navigation is worse than an
// absent card, because the user cannot tell which of the two it is.
//
// SCOPE: static href="/…" literals in non-test .svelte files under
// gremion-ui/src. Dynamic hrefs are out of scope, except that a literal prefix
// (href="/members/{id}") still has its first segment checked.
//
// A destination is legitimate when EITHER the kernel ships the route
// (src/routes/<segment>) OR a registered module owns the segment through its
// manifest (moduleOwnsSegment). The second arm is what lets a re-attached
// module bring its own links back without editing this file.
//
// This is why a link INTO a module is written `href={moduleHref('votes')}` and
// rendered only when that returns non-null, rather than `href="/votes"`. The
// guard reads static attributes, so a hardcoded module path would either fail
// it forever or force it to be weakened; routing module links through the
// registry keeps the check strict and puts the decision where the truth is.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { moduleOwnsSegment } from './modules/registry'

const SRC = resolve(process.cwd(), 'src')
const ROUTES = resolve(SRC, 'routes')

// Prefixes that are not page routes: endpoints and platform paths.
const NON_PAGE_PREFIXES = ['/api/', '/auth/', '/.well-known/']

const HREF_RE = new RegExp('href="(/[^"]*)"', 'g')
const posix = (p: string) => p.split(sep).join('/')

function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (name.endsWith('.svelte') && !name.includes('.test.')) out.push(full)
  }
}

/** First path segment of an internal href, or null when it is not checkable. */
function segmentOf(href: string): string | null {
  if (href === '/' || NON_PAGE_PREFIXES.some((p) => href.startsWith(p))) return null
  const seg = href.slice(1).split(/[/?#]/)[0]
  if (!seg || seg.includes('{')) return null // dynamic first segment
  return seg
}

const routeExists = (seg: string) => existsSync(join(ROUTES, seg))

describe('no dangling internal links', () => {
  const files: string[] = []
  collect(SRC, files)

  it('finds .svelte files to scan (an empty scan would pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('every static href="/…" points at a shipped route or a registered module', () => {
    const dangling: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(HREF_RE)) {
        const seg = segmentOf(m[1])
        if (seg === null) continue
        if (routeExists(seg) || moduleOwnsSegment(seg)) continue
        dangling.push(`${posix(relative(process.cwd(), file))} -> ${m[1]}`)
      }
    }
    expect(
      dangling,
      'These links go nowhere: no src/routes/<segment> and no registered module ' +
        'owns the segment. Either gate the link on moduleOwnsSegment(<segment>) ' +
        'so it renders only where the module runs, or drop it:\n  ' +
        dangling.join('\n  '),
    ).toEqual([])
  })

  it('recognises a segment a module owns even without a route folder', () => {
    // Pins the second arm: without it the guard would force every module link
    // out of the kernel instead of letting a manifest re-enable it.
    expect(moduleOwnsSegment('committees')).toBe(true)
    expect(moduleOwnsSegment('votes')).toBe(false)
  })
})
