import '../../../app.css'
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { tick } from 'svelte'
import { page as vpage } from 'vitest/browser'

/**
 * The create-event dialog (E2E findings 13 and 14):
 *  - the dates read in German order (the browser's own date input showed
 *    11/11/2026), while what is sent to the server stays ISO;
 *  - the dialog never grows past the window: the title and the action buttons
 *    stay in view and only the form body scrolls.
 */
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('svelte-sonner', () => ({ toast }))

import CreateEventDialog from './CreateEventDialog.svelte'

interface Posted {
  startAt: string
  endAt: string
  allDay: boolean
  title: string
}
let posted: Posted | null = null

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  posted = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/calendar/events' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body)) as Posted
        return jsonResponse({ id: 'e1' })
      }
      if (url === '/api/calendar/event-types') {
        return jsonResponse([
          { id: 't1', name: 'Sitzung', color: '#3366cc' },
          { id: 't2', name: 'Veranstaltung', color: '#cc6633' },
        ])
      }
      if (url === '/api/governance/committees') {
        return jsonResponse(
          Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `Gremium ${i + 1}` })),
        )
      }
      return jsonResponse([])
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// 11 Nov 2026, 09:30 local time: the prefill the calendar passes in when a day is clicked.
const PREFILL = new Date(2026, 10, 11, 9, 30)

async function mountDialog() {
  const r = render(CreateEventDialog, { props: { open: true, prefillDate: PREFILL } })
  // the committees and event types arrive after a fetch
  await vi.waitFor(() => expect(document.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(8))
  await tick()
  return r
}

function field(id: string): HTMLInputElement {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`)
  return el
}

async function typeInto(el: HTMLInputElement, text: string) {
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}

async function save(title: string) {
  await typeInto(field('ce-title'), title)
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Speichern')
  if (!button) throw new Error('no Speichern button')
  button.click()
  await vi.waitFor(() => expect(posted).not.toBeNull())
}

describe('create-event dialog: German dates, ISO on the wire', () => {
  test('the start and end show day.month.year with a 24-hour time', async () => {
    await mountDialog()
    expect(field('ce-start').value).toBe('11.11.2026 09:30')
    expect(field('ce-end').value).toBe('11.11.2026 10:30')
  })

  test('the untouched dialog still sends the ISO instants of the prefill', async () => {
    await mountDialog()
    await save('Sitzung')
    expect(posted?.startAt).toBe(new Date(2026, 10, 11, 9, 30).toISOString())
    expect(posted?.endAt).toBe(new Date(2026, 10, 11, 10, 30).toISOString())
  })

  test('a date typed in German order is sent as the ISO instant', async () => {
    await mountDialog()
    await typeInto(field('ce-start'), '24.12.2026 18:45')
    await typeInto(field('ce-end'), '24.12.2026 20:00')
    await save('Weihnachtsfeier')
    expect(posted?.startAt).toBe(new Date(2026, 11, 24, 18, 45).toISOString())
    expect(posted?.endAt).toBe(new Date(2026, 11, 24, 20, 0).toISOString())
  })

  test('a date the German reader refuses blocks saving and is marked invalid', async () => {
    await mountDialog()
    await typeInto(field('ce-title'), 'Sitzung')
    await typeInto(field('ce-start'), '11/24/2026 6:45 PM')
    expect(field('ce-start').getAttribute('aria-invalid')).toBe('true')
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Speichern')
    expect(button?.disabled).toBe(true)
  })

  describe('recurrence end date', () => {
    async function chooseUntil() {
      await typeInto(field('ce-title'), 'Sitzung')
      const select = document.getElementById('ce-recur') as HTMLSelectElement
      select.value = 'weekly'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
      const until = Array.from(document.querySelectorAll('input[type="radio"]')).find(
        (r) => (r as HTMLInputElement).value === 'until',
      ) as HTMLInputElement
      until.click()
      await tick()
    }
    const saveButton = () =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Speichern')

    test.each(['31.11.2026', '30.11.26', '12/31/2027', 'bald'])(
      'invalid end text %s blocks saving and nothing is sent',
      async (text) => {
        await mountDialog()
        await chooseUntil()
        await typeInto(field('ce-until'), text)
        expect(field('ce-until').getAttribute('aria-invalid')).toBe('true')
        expect(saveButton()?.disabled).toBe(true)
        saveButton()?.click()
        await tick()
        expect(posted).toBeNull()
      },
    )

    test('an empty end date in the until mode also blocks saving', async () => {
      await mountDialog()
      await chooseUntil()
      expect(saveButton()?.disabled).toBe(true)
    })

    test('a valid end date is sent as the ISO instant', async () => {
      await mountDialog()
      await chooseUntil()
      await typeInto(field('ce-until'), '30.11.2026')
      expect(saveButton()?.disabled).toBe(false)
      await save('Sitzung')
      const rec = (posted as unknown as { recurrence: { until: string | null } }).recurrence
      expect(rec.until).toBe(new Date('2026-11-30').toISOString())
    })

    test('the end text field has an accessible name and the format hint is linked to it', async () => {
      await mountDialog()
      await chooseUntil()
      expect(field('ce-until').getAttribute('aria-label')).toBe('Wiederholung endet am')
      await typeInto(field('ce-until'), 'bald')
      const hintId = field('ce-until').getAttribute('aria-describedby')
      expect(hintId).toBeTruthy()
      expect(document.getElementById(hintId as string)?.textContent).toContain('TT.MM.JJJJ')
    })
  })

  test('an all-day event shows the date only, in German order, and still sends ISO', async () => {
    await mountDialog()
    const allDay = field('ce-allday')
    allDay.click()
    await tick()
    expect(field('ce-start').value).toBe('11.11.2026')
    expect(field('ce-end').value).toBe('11.11.2026')
    await save('Tag der offenen Tür')
    expect(posted?.allDay).toBe(true)
    expect(posted?.startAt).toBe(new Date('2026-11-11').toISOString())
    expect(posted?.endAt).toBe(new Date('2026-11-11').toISOString())
  })

  test('no field of the dialog is a browser date input that follows the browser language', async () => {
    await mountDialog()
    const native = Array.from(document.querySelectorAll('[role="dialog"] input')).filter((el) => {
      const type = (el as HTMLInputElement).type
      return type === 'date' || type === 'datetime-local'
    })
    // the hidden pickers are opened by a button and never show their own format
    for (const el of native) {
      expect(getComputedStyle(el).opacity).toBe('0')
      expect(el.getAttribute('aria-hidden')).toBe('true')
    }
  })
})

describe('create-event dialog: fits the window', () => {
  test.each([
    [1280, 713],
    [1280, 480],
    [375, 600],
    [375, 420],
  ])('%i x %i px: dialog, title and buttons are inside the window and the body scrolls', async (w, h) => {
    await vpage.viewport(w, h)
    await mountDialog()
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const rect = dialog.getBoundingClientRect()
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight)

    const title = dialog.querySelector('h2') as HTMLElement
    const tr = title.getBoundingClientRect()
    expect(tr.top).toBeGreaterThanOrEqual(0)
    expect(tr.bottom).toBeLessThanOrEqual(window.innerHeight)

    const buttons = Array.from(dialog.querySelectorAll('button')).filter((b) =>
      ['Abbrechen', 'Speichern'].includes(b.textContent?.trim() ?? ''),
    )
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      const br = b.getBoundingClientRect()
      expect(br.top).toBeGreaterThanOrEqual(0)
      expect(br.bottom).toBeLessThanOrEqual(window.innerHeight)
    }

    const body = dialog.querySelector('[data-dialog-body]') as HTMLElement
    expect(body).not.toBeNull()
    expect(['auto', 'scroll']).toContain(getComputedStyle(body).overflowY)
    // the form is longer than the room it gets, so the body is what scrolls
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)
  })

  test.each([500, 900])('at %i px height the dialog has a max height that follows the viewport', async (h) => {
    await vpage.viewport(1280, h)
    await mountDialog()
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const cap = parseFloat(getComputedStyle(dialog).maxHeight)
    expect(Number.isFinite(cap)).toBe(true)
    // relative to the window (a small margin), not a fixed number
    expect(cap).toBeLessThanOrEqual(window.innerHeight)
    expect(cap).toBeGreaterThanOrEqual(window.innerHeight - 64)
  })
})
