/**
 * The brand line (organisation short name and semester) in real Chromium. The
 * sidebar column leaves about 110 px for it, so "Muster-HS" and "WiSe 26/27" do
 * not fit side by side: the semester drops to a second line, whole, and the
 * short name keeps its full text. Only a short name wider than the line (the
 * 20-character maximum) is cut with an ellipsis. Nothing may leave the column
 * and the semester is never clipped. Sidebar (232 px) and drawer (390 px viewport).
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
    org: line.querySelector<HTMLElement>('.bl-org')!,
    term: line.querySelector<HTMLElement>('.bl-term')!,
  }
}

/** Left edge of the semester's TEXT (its box starts one separator-width further left, clipped by the line). */
function textLeft(el: HTMLElement): number {
  const r = document.createRange()
  r.selectNodeContents(el)
  return r.getBoundingClientRect().left
}
const textBox = (el: HTMLElement) => {
  const r = document.createRange()
  r.selectNodeContents(el)
  return r.getBoundingClientRect()
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

function expectInside(root: HTMLElement, line: HTMLElement, term: HTMLElement) {
  const lineBox = line.getBoundingClientRect()
  const t = textBox(term)
  expect(t.left, 'semester text starts inside the line').toBeGreaterThanOrEqual(lineBox.left - 0.5)
  expect(t.right, 'semester text ends inside the line').toBeLessThanOrEqual(lineBox.right + 0.5)
  expect(t.right, 'semester inside the column').toBeLessThanOrEqual(root.getBoundingClientRect().right)
  expect(term.scrollWidth, 'semester not clipped by its own box').toBeLessThanOrEqual(term.clientWidth)
}

describe('brand line in the sidebar (expanded, 232 px)', () => {
  test('a 20-character short name is cut with an ellipsis on its own line, the semester whole on the next', async () => {
    await mount(1280, LONG_ORG)
    const col = document.querySelector<HTMLElement>('.nav-col.sidebar')!
    const { line, org, term } = parts(col)
    expect(getComputedStyle(col.querySelector('.sb-brand-txt')!).display).not.toBe('none')
    expect(term.textContent).toBe(TERM)
    expectInside(col, line, term)
    expect(org.scrollWidth, 'short name is cut').toBeGreaterThan(org.clientWidth)
    expect(getComputedStyle(org).textOverflow).toBe('ellipsis')
    expect(term.getBoundingClientRect().top, 'semester on the second line').toBeGreaterThan(org.getBoundingClientRect().bottom - 1)
    expect(line.getBoundingClientRect().height, 'two lines').toBeLessThan(30)
  })

  test('an ordinary short name (9 characters) is shown in full, never reduced to a stub', async () => {
    await mount(1280, 'Muster-HS')
    const col = document.querySelector<HTMLElement>('.nav-col.sidebar')!
    const { line, org, term } = parts(col)
    expect(org.scrollWidth, 'short name not cut').toBeLessThanOrEqual(org.clientWidth)
    expectInside(col, line, term)
  })

  test('a very short name and the semester share one line', async () => {
    await mount(1280, 'MS')
    const col = document.querySelector<HTMLElement>('.nav-col.sidebar')!
    const { line, org, term } = parts(col)
    expect(org.scrollWidth).toBeLessThanOrEqual(org.clientWidth)
    expectInside(col, line, term)
    expect(Math.abs(term.getBoundingClientRect().top - org.getBoundingClientRect().top), 'same line').toBeLessThan(2)
    expect(line.getBoundingClientRect().height, 'one line').toBeLessThan(16)
  })
})

describe('brand line in the drawer (390 px viewport)', () => {
  test('a 20-character short name next to the semester stays inside the drawer, semester whole', async () => {
    await mount(390, LONG_ORG)
    const hamburger = document.querySelector<HTMLButtonElement>('.nav-hamburger')!
    hamburger.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] .brand-line')).toBeTruthy())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await vi.waitFor(() => expect(dialog.getBoundingClientRect().left).toBeGreaterThanOrEqual(0))
    const { line, org, term } = parts(dialog)
    expectInside(dialog, line, term)
    // whichever of the two gives way, the short name keeps its full text in the title
    expect(org.getAttribute('title')).toBe(LONG_ORG)
  })
})
