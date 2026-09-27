// TASK-062 TDD 8 (gremion-public): the portal's raw server response carries
// the locale the server resolved, and the browser never changes it.
//   (a) locale en-US, no cookie -> <html lang="en">; de-DE -> lang="de";
//   (b) the gremion.locale cookie gremion-ui's switch sets (Path=/) wins over
//       Accept-Language, so a same-origin portal follows the person's choice.
// The portal has no sign-in; (b) sets the cookie the switch would have set.
import { test, expect, type Page } from '@playwright/test'

async function watchLang(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __langMutations: string[] }
    w.__langMutations = []
    new MutationObserver((records) => {
      for (const r of records) w.__langMutations.push(String((r.target as Element).getAttribute('lang')))
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  })
}

async function expectNoLangMutation(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  expect(await page.evaluate(() => (window as unknown as { __langMutations: string[] }).__langMutations)).toEqual([])
}

test.describe('(a) Accept-Language en-US, no cookie', () => {
  test.use({ locale: 'en-US' })

  test('raw response lang="en", unchanged after hydration', async ({ page }) => {
    await watchLang(page)
    const response = await page.goto('./kontakt')
    expect(response!.status()).toBe(200)
    expect(await response!.request().headerValue('accept-language')).toMatch(/^en-US/)
    expect(await response!.text()).toContain('<html lang="en">')
    await expectNoLangMutation(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})

test.describe('(a) Accept-Language de-DE', () => {
  test.use({ locale: 'de-DE' })

  test('raw response lang="de"', async ({ page }) => {
    const response = await page.goto('./kontakt')
    expect(await response!.text()).toContain('<html lang="de">')
  })
})

test.describe('(b) the switch cookie outranks Accept-Language', () => {
  test.use({ locale: 'de-DE' })

  test('gremion.locale=en -> lang="en" on every route, no mutation', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'gremion.locale', value: 'en', url: baseURL!, httpOnly: true, sameSite: 'Lax' }])
    await watchLang(page)
    for (const path of ['./kontakt', './']) {
      const response = await page.goto(path)
      expect(await response!.text()).toContain('<html lang="en">')
      await expectNoLangMutation(page)
    }
  })
})
