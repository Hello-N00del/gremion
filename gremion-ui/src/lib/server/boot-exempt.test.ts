import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// /api/internal/ skips the resolver's proxy-trust gate (for a request naming no
// tenant) and the session guard, so the handler's own check is the ONLY thing
// between the container network and the route. The decided default (Q4): a
// routes/api/internal/**/+server.{ts,js} must CALL isInternalTrustRequest or
// constantTimeEqual. A mention in a comment does not count.

const ROUTES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'routes')
const GUARD_CALL = /\b(?:isInternalTrustRequest|constantTimeEqual)\s*\(/

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Relative paths of every internal +server file under `routesRoot` that calls neither guard. */
function internalRouteViolations(routesRoot: string): { scanned: number; violations: string[] } {
  const base = join(routesRoot, 'api', 'internal')
  const out = { scanned: 0, violations: [] as string[] }
  if (!existsSync(base)) return out
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/^\+server\.(ts|js)$/.test(e.name)) {
        out.scanned++
        if (!GUARD_CALL.test(stripComments(readFileSync(full, 'utf8')))) {
          out.violations.push(relative(routesRoot, full).split('\\').join('/'))
        }
      }
    }
  }
  walk(base)
  return out
}

describe('Q4 static guard: internal routes authenticate themselves', () => {
  let fixture: string | null = null
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
    fixture = null
  })

  function route(root: string, rel: string, body: string): void {
    const dir = join(root, 'api', 'internal', rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '+server.ts'), body)
  }

  it('the scanner flags a guard-less route, a comment-only mention and a nested route, and passes guarded ones', () => {
    fixture = mkdtempSync(join(tmpdir(), 't023-internal-'))
    route(fixture, 'evict', "export const POST = ({ request }) => { if (!isInternalTrustRequest(request)) return new Response(null, { status: 403 }) }")
    route(fixture, 'push', "export const POST = ({ request }) => { if (!constantTimeEqual(a, b)) return deny() }")
    route(fixture, 'open', 'export const POST = () => new Response(null, { status: 204 })')
    route(fixture, 'commented', '// isInternalTrustRequest(request) is checked upstream\n/* constantTimeEqual( */\nexport const POST = () => new Response(null)')
    route(fixture, 'a/deep', 'export const GET = () => new Response(null)')
    const r = internalRouteViolations(fixture)
    expect(r.scanned).toBe(5)
    expect(r.violations.sort()).toEqual(['api/internal/a/deep/+server.ts', 'api/internal/commented/+server.ts', 'api/internal/open/+server.ts'])
  })

  it('the real routes tree has no guard-less internal route', () => {
    expect(existsSync(ROUTES_ROOT)).toBe(true)
    expect(internalRouteViolations(ROUTES_ROOT).violations).toEqual([])
  })
})
