/**
 * The navigation scrollbars in real Chromium: the sidebar list and the drawer
 * panel use the thin, theme-token scrollbar in light and dark, the scrollbar is
 * not hidden (the list still scrolls) and the scroll area keeps its width.
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage, userEvent } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import { FIXTURE_NAV, nextFrame } from './fixtures/shell-harness'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

async function mount(width: number, height: number) {
  await vpage.viewport(width, height)
  document.documentElement.lang = 'de'
  const r = render(ShellFixture, { props: { nav: FIXTURE_NAV, activeHref: '/members' } })
  await nextFrame()
  return r
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

const thumbOf = (el: HTMLElement) => getComputedStyle(el).scrollbarColor

describe('sidebar navigation scrollbar', () => {
  test('is thin and takes its thumb colour from the theme, in light and dark', async () => {
    await mount(1280, 300)
    const nav = document.querySelector<HTMLElement>('.nav-col.sidebar .sb-nav')!
    const cs = getComputedStyle(nav)
    expect(cs.scrollbarWidth).toBe('thin')
    expect(nav.scrollHeight, 'the list overflows, so it really scrolls').toBeGreaterThan(nav.clientHeight)
    const light = thumbOf(nav)
    expect(light).not.toBe('auto')
    document.documentElement.classList.add('dark')
    await nextFrame()
    const dark = thumbOf(nav)
    expect(dark, 'dark theme picks another thumb colour').not.toBe(light)
  })

  test('scrolls by keyboard and the scroll area keeps its width', async () => {
    await mount(1280, 300)
    const nav = document.querySelector<HTMLElement>('.nav-col.sidebar .sb-nav')!
    const link = nav.querySelector<HTMLElement>('a')!
    link.focus()
    for (let i = 0; i < 40; i++) await userEvent.keyboard('{Tab}')
    await vi.waitFor(() => expect(nav.scrollTop).toBeGreaterThan(0))
    expect(nav.getBoundingClientRect().width).toBeGreaterThan(200)
    expect(nav.scrollWidth, 'no horizontal overflow from the thin bar').toBeLessThanOrEqual(nav.clientWidth)
  })
})

describe('drawer scrollbar', () => {
  test('is thin and themed', async () => {
    await mount(390, 400)
    document.querySelector<HTMLButtonElement>('.nav-hamburger')!.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(document.querySelector('.nav-drawer')).toBeTruthy())
    const drawer = document.querySelector<HTMLElement>('.nav-drawer')!
    expect(getComputedStyle(drawer).scrollbarWidth).toBe('thin')
    expect(thumbOf(drawer)).not.toBe('auto')
  })
})
