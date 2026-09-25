import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOT_AND_RESOLVE_EXEMPT_PATHS, isBootAndResolveExempt, isResolveExemptRequest } from './boot-exempt'

/**
 * TASK-023 (B-05 option 1): the CLOSED allow-list of paths that skip BOTH the
 * tenant resolver and the process-wide boot 503. Every entry is a request that
 * reaches a handler with no tenant context and before boot completes, so the
 * list is pinned by value: adding a third entry must turn this RED and force
 * the addition through review.
 */
describe('BOOT_AND_RESOLVE_EXEMPT_PATHS', () => {
  it('is exactly the two B-05 entries, in order', () => {
    expect([...BOOT_AND_RESOLVE_EXEMPT_PATHS]).toEqual(['/healthz', '/api/internal/'])
  })

  it('is frozen, so no module can widen it at runtime', () => {
    expect(Object.isFrozen(BOOT_AND_RESOLVE_EXEMPT_PATHS)).toBe(true)
    expect(() => (BOOT_AND_RESOLVE_EXEMPT_PATHS as string[]).push('/x')).toThrow(TypeError)
  })
})

describe('isBootAndResolveExempt', () => {
  it('matches an entry without a trailing slash exactly', () => {
    expect(isBootAndResolveExempt('/healthz')).toBe(true)
  })

  it('treats an entry ending in / as a prefix', () => {
    expect(isBootAndResolveExempt('/api/internal/evict')).toBe(true)
    expect(isBootAndResolveExempt('/api/internal/a/b')).toBe(true)
  })

  it('does not match a path that merely extends an entry', () => {
    expect(isBootAndResolveExempt('/healthzx')).toBe(false)
    expect(isBootAndResolveExempt('/api/internalx')).toBe(false)
    expect(isBootAndResolveExempt('/api/internalx/evict')).toBe(false)
  })

  it('does not treat an exact entry as a prefix, nor a prefix entry as exact', () => {
    expect(isBootAndResolveExempt('/healthz/')).toBe(false)
    expect(isBootAndResolveExempt('/healthz/deep')).toBe(false)
    expect(isBootAndResolveExempt('/api/internal')).toBe(false)
  })

  it('does not match unrelated or near-miss paths', () => {
    for (const p of ['/', '', '/api/health', '/api/healthz', '/HEALTHZ', '/x/healthz', '/api/public/internal/']) {
      expect(isBootAndResolveExempt(p), p).toBe(false)
    }
  })
})

describe('isResolveExemptRequest', () => {
  const none = new Headers()
  const host = new Headers({ 'x-forwarded-host': 'tenant.example.org' })
  const id = new Headers({ 'x-tenant-id': 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' })

  it('/healthz is exempt whatever it carries (it reads the host itself)', () => {
    expect(isResolveExemptRequest('/healthz', none)).toBe(true)
    expect(isResolveExemptRequest('/healthz', host)).toBe(true)
    expect(isResolveExemptRequest('/healthz', id)).toBe(true)
  })

  it('an /api/internal/ request that names no tenant is exempt', () => {
    expect(isResolveExemptRequest('/api/internal/evict', none)).toBe(true)
  })

  it('an /api/internal/ request that names a tenant is resolved (leaf callbacks, internalFetch hops, the edge)', () => {
    expect(isResolveExemptRequest('/api/internal/evict', host)).toBe(false)
    expect(isResolveExemptRequest('/api/internal/newsletter/render', id)).toBe(false)
  })

  it('a path off the list is never exempt', () => {
    expect(isResolveExemptRequest('/api/health', none)).toBe(false)
    expect(isResolveExemptRequest('/healthzx', none)).toBe(false)
  })
})

// ── Q4: every /api/internal/ handler authenticates its caller itself ────────
//
// /api/internal/ skips the resolver's proxy-trust gate and the session guard for
// a request naming no tenant, so the handler's own check is the ONLY thing
// between the container network and the route. The decided default (Q4): an
// endpoint that can serve a path under /api/internal/ must CALL
// isInternalTrustRequest or constantTimeEqual, and no page or layout may live
// there at all. "Can serve" is decided on the route's URL shape, so route groups
// `(g)`, params `[x]`, optional params `[[x]]` and rest params `[...x]` are all
// seen through. Comments and string literals do not count as a call.
//
// A tripwire, not a proof: a call whose result is ignored still passes. Review
// of every /api/internal/ handler remains required.

const ROUTES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'routes')
const GUARD_CALL = /\b(?:isInternalTrustRequest|constantTimeEqual)\s*\(/
const ENDPOINT = /^\+server\.(ts|js)$/
const PAGE_OR_LAYOUT = /^\+(page|layout)(\.server)?\.(ts|js|svelte)$/

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const isGroup = (seg: string) => /^\(.*\)$/.test(seg)
const isRest = (seg: string) => /^\[{1,2}\.\.\./.test(seg)
const isOptional = (seg: string) => seg.startsWith('[[')
const hasParam = (seg: string) => seg.includes('[')

/** Can a route with these (group-free) directory segments serve some /api/internal/<...> URL? */
function servesUnderInternal(segs: string[], j = 0, t = 0): boolean {
  const prefix = ['api', 'internal']
  if (t === prefix.length) return true // past the prefix, anything may follow
  if (j === segs.length) return false
  const seg = segs[j]
  if (isRest(seg)) return true
  if (isOptional(seg)) return servesUnderInternal(segs, j + 1, t) || servesUnderInternal(segs, j + 1, t + 1)
  if (hasParam(seg) || seg === prefix[t]) return servesUnderInternal(segs, j + 1, t + 1)
  return false
}

/** Every route file under `routesRoot` that could serve /api/internal/ and is not an endpoint calling a guard. */
function internalRouteViolations(routesRoot: string): { routeFiles: number; violations: string[] } {
  const out = { routeFiles: 0, violations: [] as string[] }
  const walk = (dir: string, segs: string[]): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, isGroup(e.name) ? segs : [...segs, e.name])
        continue
      }
      const endpoint = ENDPOINT.test(e.name)
      if (!endpoint && !PAGE_OR_LAYOUT.test(e.name)) continue
      out.routeFiles++
      if (!servesUnderInternal(segs)) continue
      const rel = relative(routesRoot, full).split('\\').join('/')
      if (!endpoint) out.violations.push(`${rel} (no page or layout may serve /api/internal/)`)
      else if (!GUARD_CALL.test(stripCommentsAndStrings(readFileSync(full, 'utf8')))) out.violations.push(rel)
    }
  }
  walk(routesRoot, [])
  return out
}

describe('Q4 static guard: internal routes authenticate themselves', () => {
  let fixture: string | null = null
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
    fixture = null
  })

  function file(root: string, relDir: string, name: string, body: string): void {
    const dir = join(root, relDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
  }

  it('flags guard-less, comment-only, string-only, nested, grouped, param and page routes; passes guarded ones', () => {
    fixture = mkdtempSync(join(tmpdir(), 't023-internal-'))
    const open = 'export const POST = () => new Response(null, { status: 204 })'
    file(fixture, 'api/internal/evict', '+server.ts', "export const POST = ({ request }) => { if (!isInternalTrustRequest(request)) return new Response(null, { status: 403 }) }")
    file(fixture, 'api/internal/push', '+server.js', 'export const POST = () => { if (!constantTimeEqual(a, b)) return deny() }')
    file(fixture, 'api/internal/open', '+server.ts', open)
    file(fixture, 'api/internal/commented', '+server.ts', '// isInternalTrustRequest(request) is checked upstream\n/* constantTimeEqual( */\n' + open)
    file(fixture, 'api/internal/stringly', '+server.ts', "const note = 'isInternalTrustRequest(request)'\n" + open)
    file(fixture, 'api/internal/a/deep', '+server.ts', open)
    file(fixture, '(svc)/api/internal/grp', '+server.ts', open)
    file(fixture, 'api/(inner)/internal/grp2', '+server.ts', open)
    file(fixture, 'api/[kind]/x', '+server.ts', open)
    file(fixture, '[...rest]', '+server.ts', open)
    file(fixture, 'api/[[opt]]/internal/y', '+server.ts', open)
    file(fixture, 'api/internal/form', '+page.server.ts', 'export const actions = {}')
    // Not under /api/internal/: never flagged.
    file(fixture, 'api/members/[handle]', '+server.ts', open)
    file(fixture, 'api/health', '+server.ts', open)
    file(fixture, '', '+layout.server.ts', 'export const load = () => ({})')
    const r = internalRouteViolations(fixture)
    expect(r.routeFiles).toBe(15)
    expect(r.violations.sort()).toEqual(
      [
        '(svc)/api/internal/grp/+server.ts',
        '[...rest]/+server.ts',
        'api/(inner)/internal/grp2/+server.ts',
        'api/[[opt]]/internal/y/+server.ts',
        'api/[kind]/x/+server.ts',
        'api/internal/a/deep/+server.ts',
        'api/internal/commented/+server.ts',
        'api/internal/form/+page.server.ts (no page or layout may serve /api/internal/)',
        'api/internal/open/+server.ts',
        'api/internal/stringly/+server.ts',
      ].sort(),
    )
  })

  it('the real routes tree has no route that could serve /api/internal/ unguarded', () => {
    const r = internalRouteViolations(ROUTES_ROOT)
    // Non-vacuous: the whole tree was walked. (No /api/internal/ route exists on
    // this base yet -- TASK-035's evict route arrives later -- so the list being
    // empty is expected today; the fixture case above proves the scanner.)
    expect(r.routeFiles).toBeGreaterThan(50)
    expect(r.violations).toEqual([])
  })
})
