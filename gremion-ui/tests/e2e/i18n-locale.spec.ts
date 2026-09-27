// TASK-062 TDD 8 (gremion-ui): the locale is decided by the server and the
// browser never rewrites it.
//   (a) no cookie + Accept-Language en-US -> the RAW response has lang="en"
//       on a page that renders from the catalogue (the login interstitial),
//       and lang="de" on a German-only page (R26-TRAIN4-FIX r3, WCAG 3.1.1);
//   (b) signed in, switch to English through the settings form (POST + 303),
//       reload, open a second route: every document is English, and a
//       MutationObserver on <html lang> records zero changes on each of them.
//
// Needs a running app (PLAYWRIGHT_BASE_URL) booted against a migrated DB, as
// the @smoke job does (SMOKE_TENANT_HOST selects the tenant), plus the app's
// AUTH_SECRET: "sign in" mints the Auth.js session cookie for a member, since
// the e2e stack has no Keycloak. The session claims mirror what jwtCallback
// stores after a real Keycloak login (roles, uid, tokenIss, token expiry).
// Boot a plain-http stack with ORIGIN=<PLAYWRIGHT_BASE_URL>: without it
// adapter-node reports event.url as https, Auth.js then only reads the
// `__Secure-authjs.session-token` cookie, and the minted session is ignored.
import { test, expect, type Page } from '@playwright/test'

// src/lib/auth/auth.d.ts declares '@auth/core/jwt' as an ambient module (to
// extend JWT), which hides the package's real exports from the type checker.
// The runtime module is the real one; type the one function used here.
type EncodeJwt = (params: { token: Record<string, unknown>; secret: string; salt: string; maxAge?: number }) => Promise<string>
async function encodeJwt(params: Parameters<EncodeJwt>[0]): Promise<string> {
  const mod = (await import('@auth/core/jwt')) as unknown as { encode: EncodeJwt }
  return mod.encode(params)
}

const SESSION_COOKIE = 'authjs.session-token'
const ISSUER = process.env.AUTH_KEYCLOAK_ISSUER ?? 'http://localhost/realms/gremion'

async function signInAsMember(page: Page, baseURL: string): Promise<void> {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET must be set to the app’s value to mint the e2e session')
  const now = Math.floor(Date.now() / 1000)
  const value = await encodeJwt({
    salt: SESSION_COOKIE,
    secret,
    maxAge: 3600,
    token: {
      sub: 'e2e-locale-subject',
      uid: 'e2e-locale-subject',
      name: 'E2E Locale',
      email: 'e2e-locale@example.test',
      roles: ['member'],
      groups: [],
      accessToken: 'e2e-placeholder',
      accessTokenExpires: Date.now() + 3_600_000,
      tokenIss: ISSUER,
      iat: now,
      exp: now + 3600
    }
  })
  await page.context().addCookies([{ name: SESSION_COOKIE, value, url: baseURL, httpOnly: true, sameSite: 'Lax' }])
}

/** Counts every change of <html lang> from the first script onwards, per document. */
async function watchLang(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __langMutations: string[] }
    w.__langMutations = []
    new MutationObserver((records) => {
      for (const r of records) w.__langMutations.push(String((r.target as Element).getAttribute('lang')))
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  })
}

async function langMutations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __langMutations: string[] }).__langMutations)
}

test.describe('server-decided locale (TASK-062)', () => {
  test.describe('(a) Accept-Language en-US, no cookie', () => {
    test.use({ locale: 'en-US' })

    // R26-TRAIN4-FIX r3 (WCAG 3.1.1): the legal pages are written in German
    // only (src/lib/i18n/content-locale.ts), so an en-US visitor gets them
    // declared German, with the person's locale aside in data-ui-locale. A
    // public page (no session, no sign-in bounce); the browser context's
    // locale makes Chromium send Accept-Language: en-US.
    test('a German-only page is declared German, and the browser never changes it', async ({ page }) => {
      await watchLang(page)
      const response = await page.goto('/legal/impressum')
      expect(response!.status()).toBe(200)
      expect(await response!.request().headerValue('accept-language')).toMatch(/^en-US/)
      expect(await response!.text()).toContain('<html lang="de" data-ui-locale="en">')
      await page.waitForLoadState('networkidle')
      expect(await langMutations(page)).toEqual([])
      await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    })

    test('an English login interstitial renders its text, not its key', async ({ page }) => {
      const response = await page.request.get('/auth/login', { headers: { 'accept-language': 'en-US' } })
      const html = await response.text()
      expect(html).toContain('<html lang="en">')
      expect(html).toContain('Redirecting you to sign in')
      expect(html).not.toContain('auth.login.redirecting')
    })
  })

  test.describe('(b) signed-in switch', () => {
    test.use({ locale: 'de-DE' })

    test('switch to English, reload, second route: all English, zero lang mutations', async ({ page, baseURL }) => {
      await signInAsMember(page, baseURL!)
      await watchLang(page)

      const settings = await page.goto('/settings/darstellung')
      expect(settings!.status()).toBe(200)
      expect(await settings!.text()).toContain('<html lang="de">')
      await expect(page.locator('html')).toHaveAttribute('lang', 'de')

      // The switch: a plain form submit answered by a 303.
      const [post] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/settings?/locale')),
        page.getByRole('button', { name: 'English' }).click()
      ])
      expect(post.status()).toBe(303)
      expect(post.headers()['location']).toBe('/settings/darstellung')
      await page.waitForURL('**/settings/darstellung')
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
      const cookie = (await page.context().cookies()).find((c) => c.name === 'gremion.locale')
      expect(cookie).toMatchObject({ value: 'en', path: '/', httpOnly: true, sameSite: 'Lax' })
      await page.waitForLoadState('networkidle')
      expect(await langMutations(page)).toEqual([])

      const reloaded = await page.reload()
      expect(await reloaded!.text()).toContain('<html lang="en">')
      await page.waitForLoadState('networkidle')
      expect(await langMutations(page)).toEqual([])

      const second = await page.goto('/')
      expect(second!.status()).toBe(200)
      const html = await second!.text()
      expect(html).toContain('<html lang="en">')
      // $t-rendered shell strings arrive in English on the server, never as raw keys.
      expect(html).toContain('aria-label="Main navigation"')
      expect(html).not.toMatch(/(>|=")(nav|a11y|topbar)\.[a-z][a-zA-Z.]*(<|")/)
      await page.waitForLoadState('networkidle')
      expect(await langMutations(page)).toEqual([])
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    })
  })
})
