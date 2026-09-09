import { describe, it, expect } from 'vitest'
import {
  isCollapsedWildcard,
  isProductionDomain,
  DEAD_WILDCARD_RE,
} from '../../scripts/check-domain-regex.mjs'

// These literals mirror the ACTUAL `docker compose -f docker-compose.yml -f
// docker-compose.prod.yml --profile production config` output captured 2026-06-15.
// compose re-escapes the runtime `$` end-anchor as `$$` on render, so the dead
// (collapsed) wildcard leg appears as `^[a-z0-9-]+\.$$`; the healthy leg embeds
// the regexp-escaped DOMAIN_REGEX (`council\.example`). Built with escaped template
// literals so the backslashes/dollars are literal, not test-source escapes.
const HOST = '`council.example`'
const COLLAPSED_COMPOSE = `Host(${HOST}) || HostRegexp(\`^[a-z0-9-]+\\.$$\`)`
const COLLAPSED_RUNTIME = `Host(${HOST}) || HostRegexp(\`^[a-z0-9-]+\\.$\`)`
const HEALTHY = `Host(${HOST}) || HostRegexp(\`^[a-z0-9-]+\\.council\\.example$$\`)`
const KC_ADMIN_COLLAPSED = `(${COLLAPSED_COMPOSE}) && PathPrefix(\`/auth/admin\`)`
const WELLKNOWN_HEALTHY = `(${HEALTHY}) && PathPrefix(\`/.well-known/matrix\`)`

describe('check-domain-regex — isCollapsedWildcard (the dead-pattern detector)', () => {
  it('flags the collapsed wildcard leg as rendered by compose ($$ end-anchor)', () => {
    expect(isCollapsedWildcard(COLLAPSED_COMPOSE)).toBe(true)
  })
  it('flags the collapsed leg with the single-$ runtime end-anchor too', () => {
    expect(isCollapsedWildcard(COLLAPSED_RUNTIME)).toBe(true)
  })
  it('flags a collapsed leg even when wrapped in a Host()-group + PathPrefix (keycloak-admin)', () => {
    expect(isCollapsedWildcard(KC_ADMIN_COLLAPSED)).toBe(true)
  })
  it('does NOT flag a healthy leg carrying the escaped DOMAIN_REGEX', () => {
    expect(isCollapsedWildcard(HEALTHY)).toBe(false)
  })
  it('does NOT flag a healthy wrapped leg (wellknown)', () => {
    expect(isCollapsedWildcard(WELLKNOWN_HEALTHY)).toBe(false)
  })
  it('does NOT flag an apex-only rule with no HostRegexp leg', () => {
    expect(isCollapsedWildcard('Host(`council.example`)')).toBe(false)
  })
  it('tolerates non-string input', () => {
    expect(isCollapsedWildcard(undefined as unknown as string)).toBe(false)
    expect(isCollapsedWildcard(null as unknown as string)).toBe(false)
  })
  it('exports a usable regexp source', () => {
    expect(DEAD_WILDCARD_RE.source).toContain('HostRegexp')
  })
})

describe('check-domain-regex — isProductionDomain (when DOMAIN_REGEX is mandatory)', () => {
  it('treats a real public domain as production (DOMAIN_REGEX required)', () => {
    expect(isProductionDomain('council.example')).toBe(true)
    expect(isProductionDomain('stura.example.edu')).toBe(true)
  })
  it('treats localhost / loopback / single-label / empty as dev (no DOMAIN_REGEX needed)', () => {
    expect(isProductionDomain('localhost')).toBe(false)
    expect(isProductionDomain('127.0.0.1')).toBe(false)
    expect(isProductionDomain('::1')).toBe(false)
    expect(isProductionDomain('myhost')).toBe(false)
    expect(isProductionDomain('')).toBe(false)
    expect(isProductionDomain(undefined as unknown as string)).toBe(false)
  })
  it('is case-insensitive and trims', () => {
    expect(isProductionDomain('  COUNCIL.EXAMPLE  ')).toBe(true)
    expect(isProductionDomain('  Localhost ')).toBe(false)
  })
})
