/**
 * Responsive navigation shell — signed-in spec (TASK-208, UX-071a).
 *
 * Written here, EXECUTED by TASK-209 on the test environment as a seeded member
 * and a seeded council admin over a fixed route list: '/', one route per
 * visible nav item, and /messages/manage for the admin. The component suite
 * (src/lib/components/layout/*.browser.test.ts) proves the same items against
 * fixture navigation; this spec proves them against the real app, including
 * what only a real router and a real reload can show (the skip-link landing
 * after a route change, and the pre-paint width at DOMContentLoaded).
 *
 * Reads E2E_BASE_URL, E2E_MEMBER_USER / E2E_MEMBER_PASS and E2E_ADMIN_USER /
 * E2E_ADMIN_PASS from the environment. A missing variable FAILS every test —
 * it never skips — so an unconfigured run cannot pass vacuously.
 */
import { test, expect, type Page } from '@playwright/test'
import { NAV_STORAGE_KEY } from '../../src/lib/components/layout/nav-constants'

const ENV_KEYS = ['E2E_BASE_URL', 'E2E_MEMBER_USER', 'E2E_MEMBER_PASS', 'E2E_ADMIN_USER', 'E2E_ADMIN_PASS'] as const
const missingEnv = ENV_KEYS.filter((k) => !process.env[k])

type Who = 'member' | 'admin'
const CREDS: Record<Who, { user: string; pass: string }> = {
  member: { user: process.env.E2E_MEMBER_USER ?? '', pass: process.env.E2E_MEMBER_PASS ?? '' },
  admin: { user: process.env.E2E_ADMIN_USER ?? '', pass: process.env.E2E_ADMIN_PASS ?? '' }
}
const ADMIN_EXTRA_ROUTES = ['/messages/manage']
const NAV_KEY = NAV_STORAGE_KEY

test.use({ baseURL: process.env.E2E_BASE_URL })

function requireEnv() {
  expect(missingEnv, `missing environment: ${missingEnv.join(', ')}`).toEqual([])
}

async function signIn(page: Page, who: Who) {
  requireEnv()
  await page.goto('/')
  // The app bounces to the Keycloak login theme (docker/keycloak/themes/gremion).
  await page.locator('#username').waitFor()
  await page.locator('#username').fill(CREDS[who].user)
  await page.locator('#password').fill(CREDS[who].pass)
  await page.locator('button[name="login"]').click()
  await page.waitForURL((url) => url.origin === new URL(process.env.E2E_BASE_URL!).origin && !url.pathname.startsWith('/auth'))
  await expect(page.locator('.app-shell[data-nav-ready]')).toBeAttached()
}

/** '/' plus one route per nav item visible to this user, plus the extras. */
async function routeList(page: Page, extras: string[] = []): Promise<string[]> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const hrefs = await page.locator('.nav-col a.sb-item').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))
  expect(hrefs.length).toBeGreaterThan(0)
  return [...new Set(['/', ...hrefs, ...extras])]
}

/** UX-071a AC-1's three clauses, measured in the page. */
async function reflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const limit = doc.clientWidth + 0.5
    const root = document.querySelector('.app-shell')!
    const main = document.getElementById('main-content')!
    const col = root.querySelector('aside')
    const offenders: string[] = []
    for (const el of root.querySelectorAll('*')) {
      if (main.contains(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.right > limit) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${r.right.toFixed(1)}`)
    }
    return {
      sidebarWidth: !col || getComputedStyle(col).display === 'none' ? 0 : col.getBoundingClientRect().width,
      documentOverflow: doc.scrollWidth - doc.clientWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      offenders
    }
  })
}

async function reflowOverRoutes(page: Page, routes: string[]) {
  const failures: string[] = []
  for (const [w, h] of [[320, 640], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h })
    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('.app-shell[data-nav-ready]')).toBeAttached()
      const r = await reflow(page)
      if (r.sidebarWidth !== 0) failures.push(`${w} ${route}: sidebar ${r.sidebarWidth}`)
      if (r.documentOverflow > 0) failures.push(`${w} ${route}: document overflow ${r.documentOverflow}`)
      if (r.mainOverflow > 0) failures.push(`${w} ${route}: #main-content overflow ${r.mainOverflow}`)
      for (const o of r.offenders) failures.push(`${w} ${route}: ${o}`)
    }
  }
  expect(failures).toEqual([])
}

const hamburger = (page: Page) => page.locator('.nav-hamburger')
const drawer = (page: Page) => page.getByRole('dialog')

async function openDrawer(page: Page) {
  await hamburger(page).focus()
  await page.keyboard.press('Enter')
  await expect(drawer(page)).toBeVisible()
  await expect(page.locator('.drawer-close')).toBeFocused()
}

test('(1) member: reflow at 320 and 390 over every visible nav route', async ({ page }) => {
  await signIn(page, 'member')
  await reflowOverRoutes(page, await routeList(page))
})

test('(1) council admin: reflow at 320 and 390 over every visible nav route and /messages/manage', async ({ page }) => {
  await signIn(page, 'admin')
  await reflowOverRoutes(page, await routeList(page, ADMIN_EXTRA_ROUTES))
})

test('(2) member, keyboard only at 390: trap, Escape returns focus, a route link lands on the skip link', async ({ page }) => {
  await signIn(page, 'member')
  const routes = await routeList(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(hamburger(page)).not.toHaveAttribute('aria-controls')
  await expect(hamburger(page)).not.toHaveAttribute('aria-haspopup')
  await openDrawer(page)
  await expect(drawer(page)).toHaveAttribute('aria-modal', 'true')
  const controls = await hamburger(page).getAttribute('aria-controls')
  expect(controls).toBe(await drawer(page).getAttribute('id'))
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(key)
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `${key} #${i + 1}`).toBe(true)
    }
  }
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(hamburger(page)).toBeFocused()
  expect(await page.locator('[inert]').count()).toBe(0)

  // A link for another route: the new route renders, focus does not return to
  // the hamburger, and the next Tab reaches the skip link.
  const other = routes.find((r) => r !== '/')!
  await openDrawer(page)
  const link = drawer(page).locator(`a[href="${other}"]`)
  await link.focus()
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => u.pathname === other)
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.locator('[aria-current="page"]')).toHaveAttribute('href', other)
  await expect(hamburger(page)).not.toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toBeFocused()
})

test('(3) member: the stored choice survives a reload and the width at DOMContentLoaded is the final width', async ({ page }) => {
  await signIn(page, 'member')
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const col = document.querySelector('.nav-col')
      ;(window as unknown as { __navWidthAtDCL: number }).__navWidthAtDCL = col ? col.getBoundingClientRect().width : -1
    })
  })
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.goto('/')
  expect(await page.evaluate((k) => localStorage.getItem(k), NAV_KEY)).toBeNull()
  const toggle = page.getByRole('button', { name: 'Seitenleiste', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveAccessibleDescription('Wird auf diesem Gerät gespeichert')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await page.evaluate((k) => localStorage.getItem(k), NAV_KEY)).toBe('expanded')

  await page.reload()
  await expect(page.locator('.app-shell[data-nav-ready]')).toBeAttached()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(400) // past the 220 ms motion
  const finalWidth = await page.locator('.nav-col').evaluate((c) => c.getBoundingClientRect().width)
  const atDCL = await page.evaluate(() => (window as unknown as { __navWidthAtDCL: number }).__navWidthAtDCL)
  expect(atDCL).toBe(finalWidth)
  expect(finalWidth).toBeGreaterThan(100)
})

test('(3)(11) member: nothing stored after load at any width; 100dvh shell; content box >= 390 at >= 768', async ({ page }) => {
  await signIn(page, 'member')
  for (const [w, h] of [[390, 844], [767, 800], [768, 800], [1279, 800], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto('/')
    await expect(page.locator('.app-shell[data-nav-ready]')).toBeAttached()
    expect(await page.evaluate((k) => localStorage.getItem(k), NAV_KEY), `${w}px`).toBeNull()
    const m = await page.evaluate(() => {
      const root = document.querySelector('.app-shell')!
      const main = document.getElementById('main-content')!
      const cs = getComputedStyle(main)
      return {
        height: parseFloat(getComputedStyle(root).height),
        inner: window.innerHeight,
        box: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      }
    })
    expect(m.height, `${w}px shell height`).toBe(m.inner)
    if (w >= 768) expect(m.box, `${w}px content box`).toBeGreaterThanOrEqual(390)
  }
})

test('(4) council admin: rotating 390x844 to 844x390 with the drawer open closes it and focuses the rail', async ({ page }) => {
  await signIn(page, 'admin')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await openDrawer(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(drawer(page)).toHaveCount(0)
  expect(await page.locator('[inert]').count()).toBe(0)
  expect(await page.evaluate(() => !!document.activeElement?.closest('.nav-col'))).toBe(true)
})

test('(6) council admin: exactly one aria-current link on every route in drawer, rail and expanded', async ({ page }) => {
  await signIn(page, 'admin')
  const routes = await routeList(page, ADMIN_EXTRA_ROUTES)
  const failures: string[] = []
  for (const [state, w] of [['drawer', 390], ['rail', 1024], ['expanded', 1440]] as const) {
    await page.setViewportSize({ width: w, height: 900 })
    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('.app-shell[data-nav-ready]')).toBeAttached()
      if (state === 'drawer') await openDrawer(page)
      const n = await page.locator('[aria-current="page"]').count()
      if (n !== 1) failures.push(`${state} ${route}: ${n} current links`)
      if (state === 'drawer') await page.keyboard.press('Escape')
    }
  }
  expect(failures).toEqual([])
})
