// G-099 — CI smoke suite.
//
// The previous CI Playwright step ran `playwright test --list`, which only
// type-checks the spec source and exits before SvelteKit ever starts. A
// completely broken build (server can't boot, root page throws, login page
// blanks) shipped green. This file is the minimum viable smoke net: 3 tests
// that hit unauthenticated routes against a live `pnpm preview` instance
// and assert the server responded with usable HTML instead of 5xx.
//
// Scope: deliberately narrow. We are NOT replicating the full e2e suite
// here — that runs locally and in pre-release CI. Smoke just asks:
// "Does the server boot, serve the root, and render login?"
//
// Author tag: `@smoke` — selected in CI via `playwright test --grep '@smoke'`
// so the rest of the e2e suite (which needs Keycloak, Postgres seeds, etc.)
// stays out of the post-build smoke gate.

import { test, expect } from '@playwright/test'

test('@smoke root URL returns a usable response', async ({ page }) => {
  const response = await page.goto('/')
  expect(response, 'GET / must produce a response').not.toBeNull()
  // Anonymous root may render the landing/dashboard shell or redirect to
  // login; either is acceptable as long as the server didn't 5xx.
  const status = response!.status()
  expect(status, `GET / unexpected status ${status}`).toBeLessThan(500)
})

test('@smoke login route serves the Keycloak-redirect interstitial', async ({ page }) => {
  const response = await page.goto('/auth/login')
  expect(response).not.toBeNull()
  const status = response!.status()
  expect(status, `GET /auth/login unexpected status ${status}`).toBeLessThan(500)
  // v6 (CONFORMANCE §1): /auth/login is no longer an interstitial card with a
  // literal product-name heading — it bounces straight to the Keycloak login theme
  // (see +page.svelte: onMount → signIn('keycloak')). Assert the SSR response
  // carries the redirect interstitial markup. We check the *served HTML* rather
  // than the live DOM because the client-side signIn() redirect races a DOM
  // assertion, and we key on the ARIA role rather than the copy because the
  // smoke run has no locale cookie (the visible text is i18n-keyed).
  const html = await response!.text()
  expect(html, 'login route should serve the redirect interstitial').toContain('role="status"')
})

test('@smoke protected route redirects unauthenticated user to login', async ({ page }) => {
  // Smoke-tier proxy for "the auth wiring is alive": hitting a protected
  // route as an anonymous user must redirect into the login flow. If the
  // auth handler is broken, this lands on a 5xx or stays on the protected
  // URL — both surface as a smoke failure.
  //
  // We assert the SERVER redirect (hooks.server.ts → 302 /auth/login?callbackUrl)
  // via a no-follow request rather than the post-load browser URL. /auth/login's
  // onMount calls signIn('keycloak') immediately; with no reachable Keycloak in
  // CI that bounce lands the page on chrome-error before a toHaveURL() poll can
  // observe /auth/login, making a browser-URL assertion race-fail. The no-follow
  // request sees the deterministic 30x → /auth/login without running that bounce.
  //
  // Carve note: this originally hit /finance, a route that no longer exists in
  // the governance-only kernel (finance was carved out — see
  // src/lib/modules/manifests/{core,governance}.ts). /settings is a real kernel
  // route gated at Role.Member, so it exercises the same protected-route-redirect
  // wiring without depending on a carved feature.
  const res = await page.request.get('/settings', { maxRedirects: 0 })
  const status = res.status()
  expect(status, `GET /settings should redirect (30x), got ${status}`).toBeGreaterThanOrEqual(300)
  expect(status, `GET /settings unexpected status ${status}`).toBeLessThan(400)
  expect(
    res.headers()['location'] ?? '',
    'protected route must redirect anonymous users to /auth/login',
  ).toMatch(/\/auth\/login/)
})
