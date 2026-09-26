/**
 * Responsive navigation shell — component suite in real Chromium (TASK-208,
 * UX-071a AC-1..AC-11, AC-13(a)(b)). Items (1)..(12) of the acceptance, in
 * order. Item (8)'s 200 % zoom case (device scale factor 2) is in
 * shell.dsf2.browser.test.ts, which runs in its own browser project.
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage, userEvent, cdp } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import {
  FIXTURE_NAV,
  FIXTURE_ROUTES,
  reflow,
  nextFrame,
  columnWidth,
  mainContentBox,
  navColumn,
  shellRoot
} from './fixtures/shell-harness'
import { TOPBAR_SLOT_BELOW_RAIL } from './topbar-slot'
import { NAV_CONTROL_SIZE, NAV_SIDEBAR_WIDTH, NAV_RAIL_WIDTH, NAV_STORAGE_KEY, NAV_MAIN_MIN_CONTENT } from './nav-constants'
import { fontSizePx } from '$lib/stores/font-size'
import de from '$lib/i18n/messages/de.json'
import en from '$lib/i18n/messages/en.json'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

const COUNTS = { approvals: 3, liveVotes: 0, unread: 5 }
const LABELS = FIXTURE_NAV.flatMap((n) => (n.kind === 'section' ? n.children : [n])).map((i) => ('label' in i ? i.label : ''))

interface MountOpts {
  width: number
  height: number
  wideMain?: number
  path?: string
  withModules?: boolean
}

async function mount(opts: MountOpts) {
  await vpage.viewport(opts.width, opts.height)
  const path = opts.path ?? '/members'
  pageState.url = new URL('http://localhost' + path)
  const r = render(ShellFixture, {
    props: { nav: FIXTURE_NAV, activeHref: path, counts: COUNTS, wideMain: opts.wideMain ?? 0, withModules: opts.withModules ?? false }
  })
  await nextFrame()
  return r
}

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)]
const hamburger = () => $<HTMLButtonElement>('.nav-hamburger')!
const dialog = () => $<HTMLElement>('[role="dialog"]')
const toggle = () => $<HTMLButtonElement>('.nav-toggle')!
const visible = (el: Element) => {
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0
}
const size = (el: Element) => el.getBoundingClientRect()

async function openDrawerByKeyboard() {
  hamburger().focus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(document.activeElement?.closest('[role="dialog"]')).toBeTruthy())
  // Past the slide-in (NAV_MOTION_MS): measure the settled drawer.
  await vi.waitFor(() => expect(dialog()!.getBoundingClientRect().left).toBeGreaterThanOrEqual(0))
}

// Links never navigate the test page; SvelteKit's router does that in the app.
const stopNavigation = (e: MouseEvent) => {
  if (e.target instanceof Element && e.target.closest('a[href]')) e.preventDefault()
}
const extraStyles: HTMLStyleElement[] = []
function addStyle(css: string) {
  const s = document.createElement('style')
  s.textContent = css
  document.head.append(s)
  extraStyles.push(s)
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* private mode */
  }
  document.documentElement.className = ''
  document.documentElement.style.removeProperty('--base-font-size')
  pageState.data = {}
  document.addEventListener('click', stopNavigation, true)
})
afterEach(async () => {
  cleanup()
  document.removeEventListener('click', stopNavigation, true)
  for (const s of extraStyles.splice(0)) s.remove()
  await cdp().send('Emulation.setEmulatedMedia', { features: [] })
})

// ── (1) ──────────────────────────────────────────────────────────────────────
describe('(1) reflow at 320x640 and 390x844', () => {
  test.each([[320, 640], [390, 844]])('%ix%i: no sidebar width, no horizontal scroll, nothing past the viewport', async (w, h) => {
    await mount({ width: w, height: h, withModules: true })
    const r = reflow()
    expect.soft(r.sidebarWidth, 'sidebar layout width').toBe(0)
    expect.soft(r.documentOverflow, 'document horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.mainOverflow, '#main-content horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.offenders, 'elements past documentElement.clientWidth').toEqual([])
  })

  test.each([320, 390])('%i px with every TopBar slot filled and a degraded instance badge', async (w) => {
    pageState.data = { instanceState: 'degraded' }
    await mount({ width: w, height: 700, withModules: true, path: '/protokolle/2026/sitzung' })
    const r = reflow()
    expect.soft(r.documentOverflow).toBeLessThanOrEqual(0)
    expect.soft(r.mainOverflow).toBeLessThanOrEqual(0)
    expect.soft(r.offenders).toEqual([])
    for (const id of ['fixture-live', 'fixture-bell', 'fixture-body']) expect.soft(visible($(`[data-testid="${id}"]`)!), id).toBe(true)
  })

  test('the #main-content clause goes RED alone on a 391 px element in #main-content', async () => {
    await mount({ width: 390, height: 844, wideMain: 391 })
    const r = reflow()
    expect(r.mainOverflow).toBeGreaterThan(0)
    expect(r.documentOverflow).toBeLessThanOrEqual(0)
    expect(r.offenders).toEqual([])
  })

  test('the box clause goes RED alone on a 500 px nowrap TopBar child', async () => {
    await mount({ width: 390, height: 844 })
    const child = document.createElement('span')
    child.style.cssText = 'white-space: nowrap; width: 500px; display: inline-block; flex-shrink: 0;'
    $('.topbar')!.append(child)
    await nextFrame()
    const r = reflow()
    expect(r.offenders.length).toBeGreaterThan(0)
    expect(r.mainOverflow).toBeLessThanOrEqual(0)
  })

  test('the width clause goes RED alone on a 232 px sidebar', async () => {
    await mount({ width: 390, height: 844 })
    addStyle('.nav-col { display: flex !important; width: 232px !important; }')
    await nextFrame()
    expect(reflow().sidebarWidth).toBe(232)
  })
})

// ── (2) ──────────────────────────────────────────────────────────────────────
describe('(2) keyboard-only drawer at 390 px', () => {
  test('the hamburger has no aria-controls while closed and no aria-haspopup', async () => {
    await mount({ width: 390, height: 844 })
    expect(hamburger().hasAttribute('aria-controls')).toBe(false)
    expect(hamburger().hasAttribute('aria-haspopup')).toBe(false)
    expect(dialog()).toBeNull()
  })

  test('Enter opens a modal dialog that aria-controls then names, focus on its close button', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    const d = dialog()!
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(hamburger().getAttribute('aria-controls')).toBe(d.id)
    expect(document.getElementById(hamburger().getAttribute('aria-controls')!)).toBe(d)
    expect(document.activeElement).toBe($('.drawer-close'))
    await expect.element(vpage.getByRole('dialog', { name: de['nav.drawer'] })).toBeVisible()
  })

  test('every focusable element outside the dialog has an inert ancestor (skip link included, live region excepted)', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    const d = dialog()!
    const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'
    const outside = $$(FOCUSABLE).filter((el) => !d.contains(el))
    expect(outside.length).toBeGreaterThan(5)
    const lacking = outside.filter((el) => !el.closest('[inert]')).map((el) => el.outerHTML.slice(0, 80))
    expect(lacking).toEqual([])
    expect($('[data-testid="skip-link"]')!.closest('[inert]')).toBeTruthy()
    expect($('[data-shell-status]')!.closest('[inert]'), 'the app status region stays live').toBeNull()
    // A page's own live region (with a button in it) is inerted like the rest.
    expect($('[data-testid="page-status"]')!.closest('[inert]')).toBeTruthy()
    expect($('#main-content')!.closest('[inert]')).toBeTruthy()
  })

  test('the drawer itself scrolls: wheel and touchmove on it are not cancelled by the scroll lock', async () => {
    await mount({ width: 320, height: 420 })
    await openDrawerByKeyboard()
    const d = dialog()!
    expect(d.scrollHeight).toBeGreaterThan(d.clientHeight)
    const link = $('[role="dialog"] a[href="/members"]')!
    const wheel = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })
    link.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    const touch = new Event('touchmove', { bubbles: true, cancelable: true })
    link.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(false)
    // …while the page behind stays locked.
    const behind = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })
    $('.nav-scrim')!.dispatchEvent(behind)
    expect(behind.defaultPrevented).toBe(true)
  })

  test('Ctrl+K does not open the (inert) command palette behind an open drawer', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    await userEvent.keyboard('{Control>}k{/Control}')
    await nextFrame()
    expect($$('[role="dialog"]').length).toBe(1)
    expect(dialog()!.contains(document.activeElement)).toBe(true)
  })

  test('a route change from outside the drawer (browser back, goto) closes it', async () => {
    const r = await mount({ width: 390, height: 844, path: '/members' })
    await openDrawerByKeyboard()
    await r.rerender({ nav: FIXTURE_NAV, activeHref: '/committees', counts: COUNTS, wideMain: 0, withModules: false })
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect($$('[inert]')).toEqual([])
  })

  test('a modified click (new tab) on a drawer link keeps the drawer open', async () => {
    await mount({ width: 390, height: 844, path: '/members' })
    await openDrawerByKeyboard()
    await userEvent.click($('[role="dialog"] a[href="/committees"]')!, { modifiers: ['ControlOrMeta'] })
    await nextFrame()
    expect(dialog()).not.toBeNull()
  })

  test('30 Tab and 30 Shift+Tab presses never leave the dialog', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    const d = dialog()!
    for (let i = 0; i < 30; i++) {
      await userEvent.tab()
      expect(d.contains(document.activeElement), `Tab #${i + 1}`).toBe(true)
    }
    for (let i = 0; i < 30; i++) {
      await userEvent.tab({ shift: true })
      expect(d.contains(document.activeElement), `Shift+Tab #${i + 1}`).toBe(true)
    }
  })

  test.each(['escape', 'scrim', 'close'] as const)('%s closes it and returns focus to the hamburger, nothing left inert', async (how) => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    if (how === 'escape') await userEvent.keyboard('{Escape}')
    if (how === 'scrim') await userEvent.click($('.nav-scrim')!, { position: { x: 370, y: 400 } })
    if (how === 'close') await userEvent.keyboard('{Enter}') // focus starts on the close button
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(hamburger()))
    expect($$('[inert]')).toEqual([])
    expect(hamburger().hasAttribute('aria-controls')).toBe(false)
  })

  // The skip-link landing after the route change is SvelteKit's focus reset;
  // the signed-in spec (tests/e2e/shell-responsive.spec.ts) asserts it.
  test('activating a link for another route closes it without returning focus to the hamburger', async () => {
    await mount({ width: 390, height: 844, path: '/members' })
    await openDrawerByKeyboard()
    const target = $<HTMLAnchorElement>('[role="dialog"] a[href="/committees"]')!
    let hamburgerFocused = false
    hamburger().addEventListener('focus', () => (hamburgerFocused = true), { once: true })
    target.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await nextFrame()
    expect(hamburgerFocused).toBe(false)
    expect(document.activeElement).not.toBe(hamburger())
    expect($$('[inert]')).toEqual([])
  })
})

// ── (3) ──────────────────────────────────────────────────────────────────────
describe('(3) state per width, the toggle, the stored choice', () => {
  test.each([
    [767, 'drawer', 0],
    [768, 'rail', NAV_RAIL_WIDTH.normal],
    [1279, 'rail', NAV_RAIL_WIDTH.normal],
    [1280, 'expanded', NAV_SIDEBAR_WIDTH.normal]
  ] as const)('with nothing stored, %i px is %s (%i px column) and nothing is written', async (w, mode, colW) => {
    await mount({ width: w, height: 800 })
    expect(columnWidth()).toBe(colW)
    if (mode === 'drawer') expect(visible(hamburger())).toBe(true)
    else {
      expect(visible(hamburger())).toBe(false)
      await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe(String(mode === 'expanded')))
    }
    expect(localStorage.getItem(NAV_STORAGE_KEY)).toBeNull()
  })

  test.each([768, 1024, 1280])('at %i px the toggle switches rail and expanded, keeps its name, and alone writes gremion.nav', async (w) => {
    await mount({ width: w, height: 800 })
    const start = w >= 1280 ? 'true' : 'false'
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe(start))
    expect(localStorage.getItem(NAV_STORAGE_KEY)).toBeNull()
    await userEvent.click(toggle())
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe(start === 'true' ? 'false' : 'true'))
    // The column animates its width (NAV_MOTION_MS); wait for the end state.
    await vi.waitFor(() => expect(columnWidth()).toBe(start === 'true' ? NAV_RAIL_WIDTH.normal : NAV_SIDEBAR_WIDTH.normal))
    expect(localStorage.getItem(NAV_STORAGE_KEY)).toBe(start === 'true' ? 'rail' : 'expanded')
    await expect.element(vpage.getByRole('button', { name: 'Seitenleiste', exact: true })).toBeInTheDocument()
    await userEvent.click(toggle())
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe(start))
    expect(toggle().getAttribute('aria-label')).toBe('Seitenleiste')
  })

  test('gremion.nav stays unwritten after load at every width and across resizes', async () => {
    for (const w of [320, 767, 768, 1024, 1279, 1280, 1440, 1920]) {
      await mount({ width: w, height: 800 })
      await vi.waitFor(() => expect(shellRoot().hasAttribute('data-nav-ready')).toBe(true))
      expect(localStorage.getItem(NAV_STORAGE_KEY), `${w}px`).toBeNull()
      cleanup()
    }
    await mount({ width: 390, height: 844 })
    for (const w of [768, 1280, 1920, 1024, 390]) {
      await vpage.viewport(w, 800)
      await nextFrame()
    }
    expect(localStorage.getItem(NAV_STORAGE_KEY)).toBeNull()
  })

  test("the toggle's description says the choice is saved on this device (de and en)", async () => {
    await mount({ width: 1024, height: 800 })
    await expect.element(vpage.getByRole('button', { name: 'Seitenleiste' })).toHaveAccessibleDescription('Wird auf diesem Gerät gespeichert')
    expect(en['nav.sidebar.saved']).toBe('Saved on this device')
    expect(de['nav.sidebar']).toBe('Seitenleiste')
  })

  test('a stored choice (as the pre-paint class) is honoured at 768 px and above, never below', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, 'expanded')
    document.documentElement.classList.add('nav-expanded')
    await mount({ width: 768, height: 800 })
    expect(columnWidth()).toBe(NAV_SIDEBAR_WIDTH.normal)
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('true'))
    cleanup()
    await mount({ width: 767, height: 800 })
    expect(columnWidth()).toBe(0)
  })

  test("#main-content's content box is at least 390 px at every width of 768 px or more, in both states and densities", async () => {
    const results: string[] = []
    for (const density of ['', 'density-gross']) {
      for (const cls of ['nav-rail', 'nav-expanded']) {
        for (const w of [768, 800, 1024, 1279, 1280, 1440, 1920]) {
          document.documentElement.className = [density, cls].filter(Boolean).join(' ')
          await mount({ width: w, height: 800 })
          const box = mainContentBox()
          if (box < NAV_MAIN_MIN_CONTENT) results.push(`${density || 'normal'} ${cls} ${w}px: ${box}`)
          cleanup()
        }
      }
    }
    expect(results).toEqual([])
  })
})

// ── (4) ──────────────────────────────────────────────────────────────────────
describe('(4) rotation', () => {
  test('390x844 -> 844x390 with the drawer open closes it, leaves nothing inert, puts focus in the rail', async () => {
    await mount({ width: 390, height: 844, path: '/committees' })
    await openDrawerByKeyboard()
    await vpage.viewport(844, 390)
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(navColumn().contains(document.activeElement)).toBe(true))
    expect($$('[inert]')).toEqual([])
    expect(columnWidth()).toBe(NAV_RAIL_WIDTH.normal)
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page')
  })
})

// ── (5) ──────────────────────────────────────────────────────────────────────
describe('(5) the icon rail', () => {
  test("every nav link's accessible name is its label plus its badge count", async () => {
    await mount({ width: 1024, height: 900 })
    const col = vpage.elementLocator(navColumn())
    await expect.element(col.getByRole('link', { name: 'Nachrichten 5', exact: true })).toBeInTheDocument()
    await expect.element(col.getByRole('link', { name: 'Protokolle & Beschlüsse 3', exact: true })).toBeInTheDocument()
    for (const l of LABELS.filter((l) => l !== 'Nachrichten' && l !== 'Protokolle & Beschlüsse')) {
      await expect.element(col.getByRole('link', { name: l, exact: true })).toBeInTheDocument()
    }
    // Rail labels are visually hidden, not removed.
    const label = $('.nav-col .sb-label')!
    expect(size(label).width).toBeLessThanOrEqual(1)
  })

  test('each section is a list labelled by its heading', async () => {
    await mount({ width: 1024, height: 900 })
    const col = vpage.elementLocator(navColumn())
    for (const s of ['Arbeitsbereich', 'Gremien', 'Verwaltung']) {
      await expect.element(col.getByRole('list', { name: s, exact: true })).toBeInTheDocument()
    }
  })

  test('keyboard focus shows the label as a tooltip; Escape hides it without moving focus', async () => {
    await mount({ width: 1024, height: 900 })
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
    const link = $<HTMLAnchorElement>('.nav-col a[href="/committees"]')!
    link.focus()
    await vi.waitFor(() => expect($('.rail-tip')?.textContent?.trim()).toBe('Gremien & Referate'))
    const tip = $('.rail-tip')!
    expect(tip.getAttribute('aria-hidden')).toBe('true')
    expect(size(tip).left).toBeGreaterThanOrEqual(size(link).right)
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect($('.rail-tip')).toBeNull())
    expect(document.activeElement).toBe(link)
  })

  test('the expanded sidebar shows no tooltip (labels are visible)', async () => {
    await mount({ width: 1440, height: 900 })
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('true'))
    $<HTMLAnchorElement>('.nav-col a[href="/committees"]')!.focus()
    await nextFrame()
    expect($('.rail-tip')).toBeNull()
  })

  test('the tooltip is announced once: it is aria-hidden and nothing points at it', async () => {
    await mount({ width: 1024, height: 900 })
    await vi.waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
    $<HTMLAnchorElement>('.nav-col a[href="/members"]')!.focus()
    await vi.waitFor(() => expect($('.rail-tip')).toBeTruthy())
    expect($('.rail-tip')!.id).toBe('')
    expect($$('[aria-describedby]').map((e) => e.getAttribute('aria-describedby'))).toEqual(['nav-toggle-desc'])
  })

  test('no two rail items share a glyph', async () => {
    await mount({ width: 1024, height: 900 })
    const glyphs = $$('.nav-col .sb-item svg').map((s) => s.innerHTML)
    expect(glyphs.length).toBe(LABELS.length)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  test('ids are unique while the column and the drawer are both in the DOM', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    const ids = $$('[id]').map((e) => e.id)
    expect(ids.length).toBeGreaterThan(5)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})

// ── (6) ──────────────────────────────────────────────────────────────────────
describe('(6) exactly one aria-current link on every nav route in every state', () => {
  const states = [
    ['drawer', 390],
    ['rail', 1024],
    ['expanded', 1440]
  ] as const
  for (const [state, w] of states) {
    test.each(FIXTURE_ROUTES)(`${state}: %s`, async (route) => {
      await mount({ width: w, height: 900, path: route })
      if (state === 'drawer') await openDrawerByKeyboard()
      const current = $$('[aria-current="page"]')
      expect(current.length).toBe(1)
      expect(current[0].getAttribute('href')).toBe(route)
      expect(visible(current[0])).toBe(true)
    })
  }
})

// ── (7) ──────────────────────────────────────────────────────────────────────
describe('(7) target sizes', () => {
  const min = NAV_CONTROL_SIZE.normal
  test('hamburger, toggle and close button measure at least 44x44', async () => {
    await mount({ width: 390, height: 844 })
    expect(size(hamburger()).width).toBeGreaterThanOrEqual(min)
    expect(size(hamburger()).height).toBeGreaterThanOrEqual(min)
    await openDrawerByKeyboard()
    const close = $('.drawer-close')!
    expect(size(close).width).toBeGreaterThanOrEqual(min)
    expect(size(close).height).toBeGreaterThanOrEqual(min)
    cleanup()
    for (const w of [1024, 1440]) {
      await mount({ width: w, height: 900 })
      expect(size(toggle()).width).toBeGreaterThanOrEqual(min)
      expect(size(toggle()).height).toBeGreaterThanOrEqual(min)
      cleanup()
    }
  })

  test('with html.density-gross the controls measure at least 56x56', async () => {
    document.documentElement.className = 'density-gross'
    await mount({ width: 390, height: 844 })
    const g = NAV_CONTROL_SIZE.gross
    expect(size(hamburger()).width).toBeGreaterThanOrEqual(g)
    await openDrawerByKeyboard()
    expect(size($('.drawer-close')!).height).toBeGreaterThanOrEqual(g)
    cleanup()
    await mount({ width: 1024, height: 900 })
    expect(size(toggle()).width).toBeGreaterThanOrEqual(g)
    expect(size(toggle()).height).toBeGreaterThanOrEqual(g)
  })

  test.each([
    ['drawer', 390],
    ['rail', 1024],
    ['expanded', 1440]
  ] as const)('no visible nav target measures under 24x24 (%s)', async (state, w) => {
    await mount({ width: w, height: 900 })
    if (state === 'drawer') await openDrawerByKeyboard()
    const scope = state === 'drawer' ? dialog()! : navColumn()
    if (state === 'rail') {
      await userEvent.click($('.nav-col .legal-btn')!)
      await vi.waitFor(() => expect(visible($('.nav-col .legal-list a')!)).toBe(true))
    }
    const targets = $$('a[href], button', scope).filter(visible)
    expect(targets.length).toBeGreaterThan(LABELS.length)
    const small = targets
      .map((t) => ({ t, r: size(t) }))
      .filter(({ r }) => r.width < 24 || r.height < 24)
      .map(({ t, r }) => `${t.textContent?.trim() || t.getAttribute('aria-label')}: ${r.width.toFixed(1)}x${r.height.toFixed(1)}`)
    expect(small).toEqual([])
  })
})

// ── (8) ──────────────────────────────────────────────────────────────────────
describe('(8) zoom, text size, density and text spacing', () => {
  test('html.density-gross + gremion.font-size=xlarge at 768 px with expanded stored: 290 px sidebar, >= 390 px content, no label clipped', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, 'expanded')
    localStorage.setItem('gremion.font-size', 'xlarge')
    document.documentElement.className = 'density-gross nav-expanded'
    document.documentElement.style.setProperty('--base-font-size', fontSizePx('xlarge'))
    await mount({ width: 768, height: 900 })
    expect(columnWidth()).toBe(NAV_SIDEBAR_WIDTH.gross)
    expect(mainContentBox()).toBeGreaterThanOrEqual(NAV_MAIN_MIN_CONTENT)
    const clipped = $$('.nav-col .sb-label').filter((l) => l.scrollWidth > l.clientWidth || l.scrollHeight > l.clientHeight)
    expect(clipped.map((l) => l.textContent)).toEqual([])
    expect(size(toggle()).width).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.gross)
  })

  const TEXT_SPACING = `
    * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
    p { margin-bottom: 2em !important; }`

  // Visually hidden rail labels (1 px clip) are not shown text; the rail's
  // visible label is the tooltip, checked separately.
  const shown = (e: HTMLElement) => visible(e) && size(e).width > 1

  function overflowing(els: HTMLElement[]): string[] {
    return els
      .filter(shown)
      .filter((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight)
      .map((e) => `${e.className}: ${e.textContent?.trim()} (${e.scrollWidth}/${e.clientWidth}, ${e.scrollHeight}/${e.clientHeight})`)
  }

  test.each([
    ['drawer', 320, ''],
    ['rail', 768, 'nav-rail'],
    ['expanded', 768, 'nav-expanded'],
    ['default', 1280, '']
  ] as const)('with the four SC 1.4.12 overrides (%s, %i px) no nav label, drawer row or TopBar name overflows', async (state, w, cls) => {
    document.documentElement.className = cls
    addStyle(TEXT_SPACING)
    await mount({ width: w, height: 900, path: '/protokolle' })
    if (state === 'drawer') await openDrawerByKeyboard()
    const els = [
      ...$$('.sb-label'),
      ...$$('.sb-section'),
      ...$$('[role="dialog"] .sb-item, [role="dialog"] .drawer-action'),
      ...$$('.crumbs'),
      ...$$('.crumbs > *')
    ]
    expect(els.filter(shown).length).toBeGreaterThan(2)
    expect(overflowing(els)).toEqual([])
    if (state === 'rail') {
      $<HTMLAnchorElement>('.nav-col a[href="/protokolle"]')!.focus()
      await vi.waitFor(() => expect($('.rail-tip')).toBeTruthy())
      expect(overflowing([$('.rail-tip')!])).toEqual([])
    }
    expect(reflow().offenders).toEqual([])
  })
})

// ── (9) ──────────────────────────────────────────────────────────────────────
describe('(9) reduced motion', () => {
  test('without the preference the drawer slides (sanity: the check is not vacuous)', async () => {
    await mount({ width: 390, height: 844 })
    await openDrawerByKeyboard()
    expect(getComputedStyle(dialog()!).transitionProperty).toContain('transform')
  })

  test('with prefers-reduced-motion emulated the drawer opens without a transform transition', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await mount({ width: 390, height: 844 })
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
    await openDrawerByKeyboard()
    const cs = getComputedStyle(dialog()!)
    expect(cs.transitionProperty).not.toMatch(/transform|all/)
    expect(cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true)
  })
})

// ── (10) ─────────────────────────────────────────────────────────────────────
describe('(10) below 768 px the command palette entry and a degraded instance badge stay named', () => {
  test.each([320, 390, 767])('%i px', async (w) => {
    pageState.data = { instanceState: 'degraded' }
    await mount({ width: w, height: 800 })
    const search = vpage.getByRole('button', { name: /Befehlspalette öffnen/ })
    await expect.element(search).toBeVisible()
    const badge = vpage.getByRole('link', { name: /INSTANZ/ })
    await expect.element(badge).toBeVisible()
    for (const el of [search.element(), badge.element()]) {
      expect(size(el).width).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
      expect(size(el).height).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
    }
    expect(reflow().offenders).toEqual([])
  })
})

// ── (11) ─────────────────────────────────────────────────────────────────────
describe('(11) 100dvh shell', () => {
  test('the shell root is 100dvh with a 100vh fallback: computed height equals innerHeight at 390x844', async () => {
    await mount({ width: 390, height: 844 })
    const root = shellRoot()
    expect(root.classList.contains('app-shell')).toBe(true)
    expect(parseFloat(getComputedStyle(root).height)).toBe(window.innerHeight)
    const css = $('#__nav-shell')?.textContent ?? ''
    expect(css).toMatch(/\.app-shell\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh;/)
  })

  test('static check: no h-screen, and no 100vh without a following dvh, in layout/**', () => {
    const sources = import.meta.glob(['./**/*.svelte', './**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    const bad: string[] = []
    // Comments are stripped first: a 'dvh' in a comment must not excuse a 100vh.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const [file, raw] of Object.entries(sources)) {
      const src = code(raw)
      if (/\bh-screen\b/.test(src)) bad.push(`${file}: h-screen`)
      for (const m of src.matchAll(/100vh/g)) {
        const after = src.slice(m.index! + 5, m.index! + 80)
        if (!/dvh/.test(after)) bad.push(`${file}@${m.index}: 100vh without dvh`)
      }
    }
    expect(bad).toEqual([])
  })

  test('AppShell sets data-nav-ready once hydrated', async () => {
    await mount({ width: 390, height: 844 })
    await vi.waitFor(() => expect(shellRoot().hasAttribute('data-nav-ready')).toBe(true))
  })
})

// ── (12) ─────────────────────────────────────────────────────────────────────
describe('(12) topbarModuleSlot: chips, live-call indicator, bell', () => {
  test('below 768 px the fixture chip is hidden and the bell stays, named, at control size', async () => {
    expect(TOPBAR_SLOT_BELOW_RAIL).toEqual({ chips: 'hidden', liveCall: 'kept', bell: 'kept' })
    await mount({ width: 390, height: 844, withModules: true })
    expect(visible($('[data-testid="fixture-chip"]')!)).toBe(false)
    expect(visible($('[data-testid="fixture-live"]')!)).toBe(true)
    const bell = vpage.getByRole('button', { name: /Benachrichtigungen/ })
    await expect.element(bell).toBeVisible()
    expect(size(bell.element()).width).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
    expect(size(bell.element()).height).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
    expect(reflow().offenders).toEqual([])
  })

  test('at 768 px and above chip and bell both show', async () => {
    await mount({ width: 1024, height: 800, withModules: true })
    expect(visible($('[data-testid="fixture-chip"]')!)).toBe(true)
    expect(visible($('[data-testid="fixture-bell"]')!)).toBe(true)
  })

  test('theme toggle and logout move from the TopBar into the drawer below 768 px', async () => {
    await mount({ width: 1024, height: 800 })
    expect($$('.topbar .icon-btn').filter(visible).length).toBe(2)
    cleanup()
    await mount({ width: 390, height: 844 })
    expect($$('.topbar .icon-btn').filter(visible)).toEqual([])
    await openDrawerByKeyboard()
    await expect.element(vpage.getByRole('dialog').getByRole('button', { name: de['topbar.logout'] })).toBeVisible()
    await expect.element(vpage.getByRole('dialog').getByRole('button', { name: de['theme.dark'] })).toBeVisible()
  })
})
