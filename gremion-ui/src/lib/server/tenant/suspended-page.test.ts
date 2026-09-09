// src/lib/server/tenant/suspended-page.test.ts
// P2.1c (T6) — the suspended-tenant 503 body is a pure, neutral, data-plane-free
// static page. These pin: (a) the page carries a stable marker + human-readable
// suspension text; (b) it contains NO institution literal (it must pass T15's
// repo-wide no-institution-literal guard); (c) the Response factory yields a 503
// with text/html + Retry-After and no per-tenant data.
import { describe, expect, it } from 'vitest'
import {
  SUSPENDED_PAGE_HTML,
  SUSPENDED_PAGE_MARKER,
  suspendedTenantResponse,
} from './suspended-page'

// Mirror of T15's FORBIDDEN list (brand.guard.test.ts) — the suspended page is
// shipped source and must stay institution-neutral.
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'product "StuRaOS"', re: /StuRaOS/ },
  { label: 'org short "HS Harz"', re: /HS Harz/ },
  { label: 'org name "Hochschule Harz"', re: /Hochschule Harz/ },
  { label: 'domain / matrix homeserver', re: /stura\.hs-harz\.de/ },
]

describe('suspended-tenant page', () => {
  it('is a complete HTML document carrying the stable marker', () => {
    expect(SUSPENDED_PAGE_HTML).toMatch(/^<!DOCTYPE html>/)
    expect(SUSPENDED_PAGE_HTML).toContain(SUSPENDED_PAGE_MARKER)
  })

  it('carries human-readable suspension text', () => {
    expect(SUSPENDED_PAGE_HTML.toLowerCase()).toContain('suspended')
    expect(SUSPENDED_PAGE_HTML.toLowerCase()).toContain('unavailable')
  })

  for (const { label, re } of FORBIDDEN) {
    it(`contains NO institution literal: ${label}`, () => {
      expect(re.test(SUSPENDED_PAGE_HTML)).toBe(false)
    })
  }

  it('does NOT interpolate any per-tenant value (pure static string)', () => {
    // No template placeholders survived to the shipped constant.
    expect(SUSPENDED_PAGE_HTML).not.toMatch(/\$\{/)
  })

  describe('suspendedTenantResponse()', () => {
    it('is a 503 text/html response with Retry-After carrying the page body', async () => {
      const res = suspendedTenantResponse()
      expect(res.status).toBe(503)
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('Retry-After')).toBe('3600')
      expect(await res.text()).toBe(SUSPENDED_PAGE_HTML)
    })
  })
})
