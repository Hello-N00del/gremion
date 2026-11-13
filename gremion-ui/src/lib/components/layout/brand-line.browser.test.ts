/**
 * The brand line (organisation short name and semester) in real Chromium: a
 * 20-character short name next to "WiSe 26/27" must neither overflow the
 * navigation column nor wrap, and the semester must stay whole while the short
 * name gives way with an ellipsis. Sidebar (232 px) and drawer (390 px viewport).
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage, userEvent } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import { FIXTURE_NAV, nextFrame } from './fixtures/shell-harness'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

const LONG_ORG = 'Hochschulvertretung1' // 20 characters
const TERM = 'WiSe 26/27'

async function mount(width: number, orgShort: string) {
  await vpage.viewport(width, 800)
  document.documentElement.lang = 'de'
  const r = render(ShellFixture, {
    props: { nav: FIXTURE_NAV, activeHref: '/members', brand: { product: 'Ratsportal', orgShort, term: TERM } }
  })
  await nextFrame()
  return r
}

function parts(root: ParentNode) {
  const line = root.querySelector<HTMLElement>('.brand-line')!
  return {
    line,
    org: line.querySelector<HTMLElement>('.org')!,
    term: line.querySelector<HTMLElement>('.term')!,
  }
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* private mode */
  }
  document.documentElement.className = ''
  pageState.data = {}
})
afterEach(() => cleanup())

describe('brand line in the sidebar (expanded, 232 px)', () => {
  test('a 20-character short name is cut with an ellipsis, the semester stays whole, one line, nothing past the column', async () => {
    await mount(1280, LONG_ORG)
    const col = document.querySelector<HTMLElement>('.nav-col.sidebar')!
    const { line, org, term } = parts(col)
    expect(getComputedStyle(col.querySelector('.sb-brand-txt')!).display).not.toBe('none')
    const colBox = col.getBoundingClientRect()
    const termBox = term.getBoundingClientRect()
    expect(term.textContent).toBe(TERM)
    expect(termBox.right, 'semester inside the column').toBeLessThanOrEqual(colBox.right)
    expect(term.scrollWidth, 'semester not clipped').toBeLessThanOrEqual(term.clientWidth)
    expect(line.scrollWidth, 'brand line does not overflow itself').toBeLessThanOrEqual(line.clientWidth)
    expect(org.scrollWidth, 'short name is cut').toBeGreaterThan(org.clientWidth)
    expect(getComputedStyle(org).textOverflow).toBe('ellipsis')
    expect(line.getBoundingClientRect().height, 'one line').toBeLessThan(16)
  })

  test('a short name and the semester both show in full', async () => {
    await mount(1280, 'MS')
    const col = document.querySelector<HTMLElement>('.nav-col.sidebar')!
    const { org, term } = parts(col)
    expect(org.scrollWidth).toBeLessThanOrEqual(org.clientWidth)
    expect(term.scrollWidth).toBeLessThanOrEqual(term.clientWidth)
  })
})

describe('brand line in the drawer (390 px viewport)', () => {
  test('a 20-character short name next to the semester does not overflow or wrap', async () => {
    await mount(390, LONG_ORG)
    const hamburger = document.querySelector<HTMLButtonElement>('.nav-hamburger')!
    hamburger.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] .brand-line')).toBeTruthy())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await vi.waitFor(() => expect(dialog.getBoundingClientRect().left).toBeGreaterThanOrEqual(0))
    const { line, org, term } = parts(dialog)
    expect(term.getBoundingClientRect().right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right)
    expect(term.scrollWidth).toBeLessThanOrEqual(term.clientWidth)
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth)
    expect(line.getBoundingClientRect().height, 'one line').toBeLessThan(16)
    // whichever of the two gives way, the short name keeps its full text in the title
    expect(org.getAttribute('title')).toBe(LONG_ORG)
  })
})
