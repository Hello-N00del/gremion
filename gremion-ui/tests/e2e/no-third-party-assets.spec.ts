// TASK-007 / TRD-337 — the acceptance's own falsifying test (PLAN.md:2586):
// "A network trace of the running pilot host's member web app, portal and
// sales site shows zero requests to any third-party font or icon host."
// This is the member-web-app leg the acceptance names explicitly.
//
// Review r1 HIGH (live CI-equivalent boot, --repeat-each=3): the original
// version drove the audit against `/`, but an anonymous `/` 302s straight to
// `/auth/login`, whose onMount immediately calls signIn('keycloak') and
// navigates away — 2 of 3 runs failed with "page.evaluate: Execution context
// was destroyed" because the audit's own page.evaluate() calls raced that
// client-side navigation. Fixed by auditing `/auth/login?loggedOut=1`
// instead: per +page.svelte, `loggedOut` short-circuits the onMount
// signIn() bounce (the user just signed out — don't immediately re-redirect
// them into Keycloak), so the page settles and stays put. The redirect
// itself is still asserted, just via a no-follow request (mirrors
// smoke.spec.ts's own precedent for the same race) instead of a DOM
// assertion on the page the audit navigates.
//
// A second, independent cause found live: document.fonts.check() reports
// `false` for a face the page never actually rendered any text in — the
// login/logged-out screen renders no monospace text, so the lazily-loaded
// JetBrains Mono @fontsource face is registered but never fetched. Force
// each face to load before checking it, rather than relying on it having
// been used somewhere on the audited route.
//
// Reuses the existing @smoke boot path (live `pnpm preview`) rather than
// inventing a new boot env — hooks.server.ts throws at boot if the default
// tenant cannot be resolved (brief Sec9), and the smoke.spec.ts precedent
// already solves that with SMOKE_TENANT_HOST.
import { test, expect } from '@playwright/test'
import { watchNetwork } from './support/no-third-party-network'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const pageOrigin = new URL(baseURL).origin

test('@smoke / redirects an anonymous request to login (no-follow, no client-side bounce race)', async ({
  page,
}) => {
  const res = await page.request.get('/', { maxRedirects: 0 })
  const status = res.status()
  expect(status, `GET / should redirect (30x), got ${status}`).toBeGreaterThanOrEqual(300)
  expect(status, `GET / unexpected status ${status}`).toBeLessThan(400)
  expect(
    res.headers()['location'] ?? '',
    'anonymous / must redirect toward /auth/login'
  ).toMatch(/\/auth\/login/)
})

test('@smoke /auth/login?loggedOut=1 — no third-party font/icon request, self-hosted faces load', async ({
  page,
}) => {
  const audit = watchNetwork(page, pageOrigin)

  // ?loggedOut=1 suppresses the onMount signIn('keycloak') bounce (see
  // +page.svelte), so this route settles instead of navigating away under
  // the audit — the redirect-race cause of the original HIGH finding.
  const response = await page.goto('/auth/login?loggedOut=1')
  expect(response, 'GET /auth/login?loggedOut=1 must produce a response').not.toBeNull()
  expect(
    response!.status(),
    `GET /auth/login?loggedOut=1 unexpected status ${response!.status()}`
  ).toBeLessThan(400)

  await page.evaluate(() => document.fonts.ready)

  expect(
    audit.crossOriginRequests,
    `cross-origin request(s) found — TRD-337 forbids any third-party font/icon ` +
      `host and the allowlist is empty:\n${audit.crossOriginRequests.join('\n')}`
  ).toEqual([])

  expect(
    audit.sameOriginFontRequests.length,
    'no same-origin font request observed — a page that loads no fonts at all ' +
      'would pass this audit vacuously, which the helper must not allow'
  ).toBeGreaterThan(0)

  // Force each face to actually fetch before checking it — this route
  // renders no monospace text, so JetBrains Mono is registered but never
  // loaded on its own; document.fonts.check() on an unloaded face reports
  // false regardless of whether the face is reachable same-origin.
  await page.evaluate(() => Promise.all([
    document.fonts.load('16px Inter'),
    document.fonts.load('16px "JetBrains Mono"'),
  ]))

  const interLoaded = await page.evaluate(() => document.fonts.check('16px Inter'))
  expect(interLoaded, "document.fonts.check('16px Inter') is false").toBe(true)

  const monoLoaded = await page.evaluate(() => document.fonts.check('16px "JetBrains Mono"'))
  expect(monoLoaded, 'document.fonts.check(\'16px "JetBrains Mono"\') is false').toBe(true)
})
