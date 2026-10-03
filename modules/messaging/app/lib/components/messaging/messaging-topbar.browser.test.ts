/**
 * The messaging module's TopBar parts in real Chromium (TASK-205b, UX-071a.6; TASK-208's slot contract).
 *
 * The real slot components (Matrix chip, live-call indicator, notification bell) are mounted through
 * AppShell's topbarModules, the way routes/+layout.svelte composes them. Asserted, in order:
 *   - at desktop width all three parts render in their wrappers; the live-call indicator only while a call runs;
 *   - below 768 px the chips are hidden (they live in the drawer) while the live-call indicator and the bell
 *     are kept, the bell's target at least the shell control size (44 CSS px);
 *   - the bell opens a popover whose width is min(348px, 100vw - 32px): 348 px on a desktop, never past a
 *     320 px viewport; opening it marks nothing read (no request is made); Escape closes it and returns focus.
 */
import '$lib/../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage, userEvent } from 'vitest/browser'
import Fixture from './fixtures/MessagingShellFixture.svelte'
import { FIXTURE_NAV, nextFrame } from '$lib/components/layout/fixtures/shell-harness'
import { NAV_CONTROL_SIZE } from '$lib/components/layout/nav-constants'
import { TOPBAR_SLOT_BELOW_RAIL } from '$lib/components/layout/topbar-slot'
import { callStore } from '$lib/stores/call-store.svelte'
import slot from '$lib/modules/slots/messaging.slot'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))
// the slot also imports the call picture-in-picture, a byte-equal copy that still reads `$env/dynamic/public`
// at module load (K3 conversion deferred to TASK-032, R29-I5); this suite never renders it, so the component is
// stubbed rather than mocking `$env/dynamic/*` in new code (kit-3 rule K3)
vi.mock('$lib/components/VideoCallPip.svelte', () => ({ default: function VideoCallPipStub() {} }))

const COUNTS = { approvals: 0, liveVotes: 0, unread: 3 }

async function mount(width: number, unread = 3) {
  await vpage.viewport(width, 800)
  pageState.data = { counts: { ...COUNTS, unread } }
  const r = render(Fixture, { props: { nav: FIXTURE_NAV, activeHref: '/members', counts: { ...COUNTS, unread } } })
  await nextFrame()
  return r
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const visible = (el: Element | null) => {
  if (!el) return false
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0
}

beforeEach(() => {
  document.documentElement.lang = 'de'
  callStore.status = 'idle'
  document.addEventListener('click', stopNavigation, true)
})
afterEach(() => {
  cleanup()
  callStore.status = 'idle'
  document.removeEventListener('click', stopNavigation, true)
})
// Links never navigate the test page.
const stopNavigation = (e: MouseEvent) => {
  if (e.target instanceof Element && e.target.closest('a[href]')) e.preventDefault()
}

describe('the slot declares the three TopBar parts and the overlay', () => {
  test('chips, liveCall, bell and the call picture-in-picture are all provided', () => {
    expect(slot.chips).toBeTypeOf('function')
    expect(slot.liveCall).toBeTypeOf('function')
    expect(slot.bell).toBeTypeOf('function')
    expect(slot.overlay).toBeTypeOf('function')
    // the contract the TopBar enforces below the rail breakpoint
    expect(TOPBAR_SLOT_BELOW_RAIL).toEqual({ chips: 'hidden', liveCall: 'kept', bell: 'kept' })
  })
})

describe('desktop (1280 px)', () => {
  test('the Matrix chip and the bell render; the live-call indicator only while a call runs', async () => {
    await mount(1280)
    expect(visible($('[data-topbar-slot="chips"]'))).toBe(true)
    expect($('[data-topbar-slot="chips"]')!.textContent).toContain('Matrix')
    expect(visible($('[data-topbar-slot="bell"] button'))).toBe(true)
    expect($('[data-topbar-slot="liveCall"]')?.textContent ?? '').not.toContain('CALL')
    callStore.status = 'active'
    await vi.waitFor(() => expect($('[data-topbar-slot="liveCall"]')!.textContent).toContain('CALL · LIVE'))
  })

  test('the bell names itself and shows its dot only while something is unread', async () => {
    await mount(1280, 3)
    const bell = $<HTMLButtonElement>('[data-topbar-slot="bell"] button')!
    expect(bell.getAttribute('aria-label')).toBe('Benachrichtigungen, Ungelesenes vorhanden')
    expect(bell.querySelector('.dot')).not.toBeNull()
    cleanup()
    await mount(1280, 0)
    const quiet = $<HTMLButtonElement>('[data-topbar-slot="bell"] button')!
    expect(quiet.getAttribute('aria-label')).toBe('Benachrichtigungen')
    expect(quiet.querySelector('.dot')).toBeNull()
  })
})

describe('below the rail breakpoint (600 px)', () => {
  test('the chips are hidden, the live-call indicator and the bell are kept, the bell target is at least 44 px', async () => {
    await mount(600)
    callStore.status = 'active'
    await vi.waitFor(() => expect($('[data-topbar-slot="liveCall"]')!.textContent).toContain('CALL · LIVE'))
    expect(visible($('[data-topbar-slot="chips"]'))).toBe(false)
    expect(visible($('[data-topbar-slot="liveCall"]'))).toBe(true)
    const bell = $<HTMLButtonElement>('[data-topbar-slot="bell"] button')!
    expect(visible(bell)).toBe(true)
    const box = bell.getBoundingClientRect()
    expect(box.width).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
    expect(box.height).toBeGreaterThanOrEqual(NAV_CONTROL_SIZE.normal)
  })
})

describe('the bell popover', () => {
  test('is 348 px wide on a desktop and never wider than the viewport minus 32 px on a 320 px phone', async () => {
    await mount(1280)
    await userEvent.click($('[data-topbar-slot="bell"] button')!)
    const pop = await vi.waitFor(() => {
      const el = $('[role="dialog"][aria-label="Benachrichtigungen"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(Math.round(pop.getBoundingClientRect().width)).toBe(348)
    cleanup()

    await mount(320)
    await userEvent.click($('[data-topbar-slot="bell"] button')!)
    const small = await vi.waitFor(() => {
      const el = $('[role="dialog"][aria-label="Benachrichtigungen"]')
      expect(el).not.toBeNull()
      return el!
    })
    const r = small.getBoundingClientRect()
    expect(r.width).toBeLessThanOrEqual(320 - 32 + 0.5)
    expect(r.left).toBeGreaterThanOrEqual(0)
    expect(r.right).toBeLessThanOrEqual(320 + 0.5)
  })

  test('opening it marks nothing read (no request), shows the unread chat row, and Escape closes it and returns focus', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await mount(1280, 3)
    const bell = $<HTMLButtonElement>('[data-topbar-slot="bell"] button')!
    await userEvent.click(bell)
    await vi.waitFor(() => expect($('[role="dialog"][aria-label="Benachrichtigungen"]')).not.toBeNull())
    expect($('.ntf-row')!.textContent).toContain('3 ungelesene Nachrichten')
    expect($<HTMLAnchorElement>('.ntf-row')!.getAttribute('href')).toBe('/messages')
    expect(fetchSpy).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect($('[role="dialog"][aria-label="Benachrichtigungen"]')).toBeNull())
    expect(document.activeElement).toBe(bell)
    fetchSpy.mockRestore()
  })
})
