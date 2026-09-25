import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import { FIXTURE_NAV, reflow, nextFrame } from './fixtures/shell-harness'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

async function mount(opts: { width: number; height: number; wideMain?: number; path?: string }) {
  await vpage.viewport(opts.width, opts.height)
  pageState.url = new URL('http://localhost' + (opts.path ?? '/members'))
  render(ShellFixture, { props: { nav: FIXTURE_NAV, activeHref: opts.path ?? '/members', wideMain: opts.wideMain ?? 0 } })
  await nextFrame()
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* private mode */ }
  document.documentElement.className = ''
})
afterEach(() => cleanup())

describe('(1) reflow at 320x640 and 390x844', () => {
  test.each([[320, 640], [390, 844]])('%ix%i: no sidebar width, no horizontal scroll, nothing past the viewport', async (w, h) => {
    await mount({ width: w, height: h })
    const r = reflow()
    expect.soft(r.sidebarWidth, 'sidebar layout width').toBe(0)
    expect.soft(r.documentOverflow, 'document horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.mainOverflow, '#main-content horizontal overflow').toBeLessThanOrEqual(0)
    expect.soft(r.offenders, 'elements past documentElement.clientWidth').toEqual([])
  })
})
