/**
 * R29-MD-B (defect B3): the sign-in legal footer must never cover the card's
 * control. Real Chromium (Vitest browser mode), the same harness as
 * shell.browser.test.ts.
 *
 * Grounds: WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum), SC 1.4.10 Reflow;
 * DDG section 5 "unmittelbar erreichbar" (the 1280x800 positive control).
 *
 * The bug this guards: `.signin-legal` was `position: fixed; bottom: 0`, so on a
 * short viewport (400 % zoom, phone landscape, "Sehr gross") a wrapped footer
 * sat on top of the forbidden/loggedOut card's only control and scrolling could
 * not uncover it.
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'
import Page from './+page.svelte'
import { fontSizePx } from '$lib/stores/font-size'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/auth/login'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))
// The default branch's onMount calls signIn() unconditionally; a no-op spy keeps
// the test page from navigating. The two branches asserted here never call it
// on mount, but the button's onclick does.
vi.mock('@auth/sveltekit/client', () => ({ signIn: vi.fn() }))

type Font = 'normal' | 'xlarge'
interface Cell {
  w: number
  h: number
  font: Font
  /** true: expected RED before the fix (the footer wraps to two rows). */
  redBefore: boolean
}
const CELLS: Cell[] = [
  { w: 320, h: 256, font: 'normal', redBefore: true }, // 400 % of 1280x1024
  { w: 320, h: 256, font: 'xlarge', redBefore: true },
  { w: 568, h: 320, font: 'xlarge', redBefore: false }, // phone landscape
  { w: 360, h: 520, font: 'normal', redBefore: false },
  { w: 360, h: 520, font: 'xlarge', redBefore: false },
  { w: 1280, h: 560, font: 'normal', redBefore: false },
  { w: 1280, h: 560, font: 'xlarge', redBefore: false }
]
const BRANCHES = [
  { name: 'forbidden', query: '?error=forbidden', control: 'main a[href="/"]' },
  { name: 'loggedOut', query: '?loggedOut=1', control: 'main button' }
]

let asserted = 0

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const label = (c: Cell) => `${c.w}x${c.h} ${c.font === 'xlarge' ? 'Sehr gross' : 'Normal'}`

async function mount(query: string, w: number, h: number, font: Font) {
  await vpage.viewport(w, h)
  pageState.url = new URL('http://localhost/auth/login' + query)
  document.documentElement.style.setProperty('--base-font-size', fontSizePx(font))
  // No host padding or margin: the measurement is the page's own.
  document.body.style.margin = '0'
  document.body.style.padding = '0'
  const r = render(Page)
  await nextFrame()
  return r
}

beforeEach(() => {
  document.documentElement.className = ''
  // $t follows <html lang>; the app's German-first default is de.
  document.documentElement.lang = 'de'
  document.documentElement.style.removeProperty('--base-font-size')
  window.scrollTo(0, 0)
})
afterEach(() => {
  cleanup()
  document.body.style.removeProperty('margin')
  document.body.style.removeProperty('padding')
})
afterAll(() => {
  // A guard that asserted nothing passes vacuously.
  expect(asserted, 'cells asserted').toBeGreaterThan(0)
})

const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

describe('sign-in legal footer never covers the card control', () => {
  for (const branch of BRANCHES) {
    test.each(CELLS)(`?${branch.name}: $w x $h (font $font)`, async (cell) => {
      await mount(branch.query, cell.w, cell.h, cell.font)
      const control = document.querySelector<HTMLElement>(branch.control)
      const footer = document.querySelector<HTMLElement>('footer.signin-legal')
      expect(control, `${branch.name} control`).not.toBeNull()
      expect(footer, 'legal footer').not.toBeNull()

      // The focus scroll SC 2.4.11 is about: from the top, focus, then bring the
      // control into view the way the browser does.
      window.scrollTo(0, 0)
      control!.focus()
      control!.scrollIntoView({ block: 'nearest' })
      await nextFrame()

      const cr = control!.getBoundingClientRect()
      const fr = footer!.getBoundingClientRect()
      const cx = cr.left + cr.width / 2
      const cy = cr.top + cr.height / 2
      const hit = document.elementFromPoint(cx, cy)

      asserted++
      expect.soft(intersects(cr, fr), `[${label(cell)}] control rect ${JSON.stringify(cr)} intersects footer rect ${JSON.stringify(fr)}`).toBe(false)
      expect.soft(
        hit !== null && (hit === control || control!.contains(hit)),
        `[${label(cell)}] elementFromPoint(${cx},${cy}) is ${hit?.tagName}.${hit?.className}, not the control`
      ).toBe(true)
      expect.soft(document.documentElement.scrollWidth, `[${label(cell)}] horizontal overflow (SC 1.4.10)`).toBeLessThanOrEqual(window.innerWidth)
    })
  }

  test('positive control 1280x800: the legal links are visible without scrolling', async () => {
    for (const branch of BRANCHES) {
      await mount(branch.query, 1280, 800, 'normal')
      window.scrollTo(0, 0)
      const fr = document.querySelector<HTMLElement>('footer.signin-legal')!.getBoundingClientRect()
      asserted++
      expect.soft(fr.top, `?${branch.name} footer top`).toBeGreaterThanOrEqual(0)
      expect.soft(fr.bottom, `?${branch.name} footer bottom ${fr.bottom} vs innerHeight ${window.innerHeight}`).toBeLessThanOrEqual(window.innerHeight)
      cleanup()
    }
  })
})
