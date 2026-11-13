/**
 * The files list on a phone, in real Chromium (Vitest browser mode, the harness of shell.browser.test.ts).
 *
 * Operator feedback from the pilot host: the list was tiny and crammed on a phone. Required below 640 px:
 * readable text, touch targets of at least 44 CSS px, the name takes the width, date and size sit under the
 * name, the row actions stay reachable, and the page never scrolls sideways. At 1280 px the five-column table
 * stays as it was (the positive control).
 */
import '$lib/../app.css'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'

vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/messages/de.json')).default as Record<string, string>
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

import FileBrowser from './FileBrowser.svelte'

const FILES = [
  { path: 'Protokolle/Sitzung der Fachschaftenkonferenz vom 14. Oktober mit allen Anlagen und Beschluessen.odt', name: 'Sitzung der Fachschaftenkonferenz vom 14. Oktober mit allen Anlagen und Beschluessen.odt', is_dir: false, etag: 'a', size: 2048, last_modified: '2026-11-01T10:00:00Z' },
  { path: 'Protokolle/Foto.png', name: 'Foto.png', is_dir: false, etag: 'b', size: 4096000, last_modified: '2026-11-02T10:00:00Z' },
  { path: 'Protokolle/Archiv', name: 'Archiv', is_dir: true, etag: 'c', size: 0, last_modified: '2026-11-03T10:00:00Z' }
]

let asserted = 0
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

async function mount(width: number) {
  await vpage.viewport(width, 800)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ success: true, files: FILES })
    }))
  )
  document.body.style.margin = '0'
  // A phone page keeps a gutter around the content; the shell does that in the app.
  const host = document.createElement('div')
  host.style.padding = '0 12px'
  document.body.appendChild(host)
  const r = render(FileBrowser, { target: host, props: { rootPath: 'Protokolle', readonly: false } })
  for (let i = 0; i < 50 && host.querySelectorAll('.fb-row').length < FILES.length; i++) await nextFrame()
  await nextFrame()
  return { ...r, host }
}

const rect = (el: Element) => el.getBoundingClientRect()
const visible = (el: Element) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0

beforeEach(() => {
  document.documentElement.lang = 'de'
  window.scrollTo(0, 0)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.style.removeProperty('margin')
  document.body.replaceChildren()
})
afterAll(() => {
  // A guard that asserted nothing passes vacuously.
  if (asserted === 0) throw new Error('FileBrowser narrow layout suite asserted nothing')
})

describe('files list below 640 px', () => {
  for (const width of [320, 360, 414, 480, 640]) {
    test(`${width} px: no sideways scroll, readable text, 44 px targets, the name takes the width`, async () => {
      const { host } = await mount(width)
      const rows = [...host.querySelectorAll('.fb-row')]
      expect(rows).toHaveLength(FILES.length)

      // No horizontal page scroll, and nothing pokes out of the viewport.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
      for (const el of host.querySelectorAll('.fb-row *')) {
        if (!visible(el)) continue
        expect(rect(el).right, `${(el as HTMLElement).className} pokes out of the ${width} px viewport`).toBeLessThanOrEqual(window.innerWidth + 0.5)
      }

      for (const row of rows) {
        const name = row.querySelector('.fb-name') as HTMLElement
        expect(parseFloat(getComputedStyle(name).fontSize), 'name font size').toBeGreaterThanOrEqual(16)
        expect(rect(name).height, 'name touch target').toBeGreaterThanOrEqual(44)
        // The name takes the width: at least 40 % of the viewport, even with two 44 px actions beside it.
        expect(rect(name).width, 'name width').toBeGreaterThanOrEqual(window.innerWidth * 0.4)

        // Date and size move under the name (same left edge, lower down), still readable.
        for (const meta of row.querySelectorAll('.fb-mod, .fb-size')) {
          expect(visible(meta)).toBe(true)
          expect(rect(meta).top, 'meta sits under the name').toBeGreaterThanOrEqual(rect(name).bottom - 1)
          expect(rect(meta).left, 'meta is not left of the name').toBeGreaterThanOrEqual(rect(name).left - 1)
          expect(parseFloat(getComputedStyle(meta).fontSize), 'meta font size').toBeGreaterThanOrEqual(12)
        }

        // The row actions stay reachable: each at least 44 x 44 and inside the viewport.
        const actions = [...row.querySelectorAll('.fb-actions a, .fb-actions button')]
        expect(actions.length).toBeGreaterThan(0)
        for (const a of actions) {
          expect(rect(a).width, `${a.getAttribute('aria-label')} width`).toBeGreaterThanOrEqual(44)
          expect(rect(a).height, `${a.getAttribute('aria-label')} height`).toBeGreaterThanOrEqual(44)
          expect(rect(a).left).toBeGreaterThanOrEqual(0)
          expect(rect(a).right).toBeLessThanOrEqual(window.innerWidth + 0.5)
        }
        asserted++
      }

      // The column titles of the desktop table have no place on a phone.
      expect(visible(host.querySelector('.fb-head')!)).toBe(false)

      // Toolbar and breadcrumb are touch targets too.
      for (const c of host.querySelectorAll('.fb-toolbar .btn, .fb-crumb')) {
        expect(rect(c).height, `${c.textContent?.trim()} height`).toBeGreaterThanOrEqual(44)
      }
      asserted++
    })
  }

  test('an editable file still shows its Öffnen label where there is room, and always keeps the accessible name', async () => {
    const { host } = await mount(640)
    const open = host.querySelector('.fb-row .fb-actions a[aria-label="Öffnen"]') as HTMLElement
    expect(open).toBeTruthy()
    expect(visible(open.querySelector('.fb-open-label')!)).toBe(true)
    cleanup()
    document.body.replaceChildren()
    const narrow = await mount(360)
    const openNarrow = narrow.host.querySelector('.fb-row .fb-actions a[aria-label="Öffnen"]') as HTMLElement
    expect(openNarrow).toBeTruthy()
    expect(visible(openNarrow)).toBe(true)
    // Below ~420 px the label gives way to the icon, so the name keeps its width.
    expect(visible(openNarrow.querySelector('.fb-open-label')!)).toBe(false)
    asserted++
  })
})

describe('renaming a file on a phone', () => {
  for (const width of [320, 360, 640]) {
    test(`${width} px: the rename field is a 44 px touch target and stays inside the viewport`, async () => {
      const { host } = await mount(width)
      const name = host.querySelector('.fb-row a.fb-name') as HTMLElement
      name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await nextFrame()
      const input = host.querySelector('.fb-row input') as HTMLInputElement
      expect(input, 'rename field').toBeTruthy()
      expect(rect(input).height, 'rename field height').toBeGreaterThanOrEqual(44)
      expect(rect(input).right).toBeLessThanOrEqual(window.innerWidth + 0.5)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
      asserted++
    })
  }
})

describe('rename field follows the component breakpoint, not a Tailwind variant', () => {
  // The phone block ends at 640 px inclusive; one pixel wider the table is back and the field is the compact one.
  // A Tailwind sm: variant is inclusive at 640 px too, so the field and the layout disagreed exactly there.
  for (const width of [641, 1280]) {
    test(`${width} px: the rename field is the compact desktop field`, async () => {
      const { host } = await mount(width)
      const name = host.querySelector('.fb-row a.fb-name') as HTMLElement
      name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await nextFrame()
      const input = host.querySelector('.fb-row input') as HTMLInputElement
      expect(input, 'rename field').toBeTruthy()
      expect(rect(input).height, 'rename field height').toBeLessThanOrEqual(32)
      expect(rect(input).width, 'rename field width').toBeLessThanOrEqual(12 * 16 + 1)
      expect(input.className, 'no viewport variant on the field').not.toMatch(/(^|\s)sm:/)
      asserted++
    })
  }
})

describe('files list at 1280 px (positive control)', () => {
  test('keeps the five-column table: titles shown, date and size beside the name', async () => {
    const { host } = await mount(1280)
    const head = host.querySelector('.fb-head') as HTMLElement
    expect(visible(head)).toBe(true)
    const row = host.querySelector('.fb-row') as HTMLElement
    const name = row.querySelector('.fb-name') as HTMLElement
    const mod = row.querySelector('.fb-mod') as HTMLElement
    expect(rect(mod).left).toBeGreaterThan(rect(name).right)
    expect(Math.abs(rect(mod).top - rect(name).top)).toBeLessThan(rect(row).height)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    asserted++
  })
})
