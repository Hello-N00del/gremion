/**
 * Item (8), first clause (TASK-208, UX-071a AC-8): 1280 px at 200 % zoom is a
 * 640 CSS px viewport at device scale factor 2. Runs in the browser-dsf2
 * project (contextOptions.deviceScaleFactor = 2). The drawer state applies and
 * item (1)'s reflow holds, also with html.density-gross.
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import { FIXTURE_NAV, reflow, nextFrame } from './fixtures/shell-harness'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

beforeEach(() => {
  document.documentElement.className = ''
})
afterEach(() => cleanup())

describe('(8) 640 CSS px at device scale factor 2', () => {
  test.each(['', 'density-gross'])('drawer state and reflow hold (html class: %j)', async (cls) => {
    document.documentElement.className = cls
    await vpage.viewport(640, 800)
    render(ShellFixture, { props: { nav: FIXTURE_NAV, activeHref: '/members', withModules: true } })
    await nextFrame()
    expect(window.devicePixelRatio).toBe(2)
    expect(document.documentElement.clientWidth).toBe(640)
    const hamburger = document.querySelector<HTMLElement>('.nav-hamburger')!
    expect(getComputedStyle(hamburger).display).not.toBe('none')
    const r = reflow()
    expect.soft(r.sidebarWidth, 'sidebar layout width').toBe(0)
    expect.soft(r.documentOverflow, 'document horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.mainOverflow, '#main-content horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.offenders, 'elements past documentElement.clientWidth').toEqual([])
  })
})
