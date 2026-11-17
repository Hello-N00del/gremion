/**
 * The /messages room header in a narrow column, in real Chromium (Vitest browser mode, the harness of
 * shell.browser.test.ts).
 *
 * Pilot finding: in a narrow desktop window the room header was squashed. Avatar, title block and the two
 * action buttons shared one row, the buttons kept their width and the title block was squeezed down to a
 * few pixels. Required: title, message count and actions never overlap or clip, at a phone viewport (375 px)
 * and in a narrow column of a desktop window (viewport 1024 px, page column 520 px). A wide column is the
 * positive control: everything stays on one row.
 */
import '$lib/../app.css'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'
import { readable } from 'svelte/store'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'

vi.mock('$app/stores', () => ({
  page: readable({ data: { session: { user: { id: 'admin-1', roles: ['council-admin'] } }, brand: null } }),
}))
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/messages'), data: { brand: null } },
}))
vi.mock('$app/navigation', () => ({
  invalidate: () => Promise.resolve(),
  invalidateAll: () => Promise.resolve(),
  goto: () => Promise.resolve(),
  replaceState: () => {},
  pushState: () => {},
  beforeNavigate: () => {},
  afterNavigate: () => {},
  onNavigate: () => {},
}))

class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  addEventListener() {}
  close() {}
}

import Page from './+page.svelte'

const ROOM = {
  roomId: '!vorstand:matrix.test',
  name: 'Fachschaftenkonferenz Vorstand und Gremien',
  unreadCount: 0,
  lastMessageTs: 0,
  archived: false,
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const rect = (el: Element) => el.getBoundingClientRect()
const overlap = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5

async function mount(viewport: number, columnWidth: number | null) {
  await vpage.viewport(viewport, 800)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/messages/rooms') return { ok: true, json: async () => ({ success: true, data: [ROOM] }) }
      return { ok: true, json: async () => ({ success: true }) }
    }),
  )
  document.body.style.margin = '0'
  // The app shell hands the page a column narrower than the window (sidebar next to it).
  const host = document.createElement('div')
  host.style.height = '600px'
  host.style.display = 'flex'
  host.style.flexDirection = 'column'
  if (columnWidth !== null) host.style.width = `${columnWidth}px`
  document.body.appendChild(host)
  render(Page, { target: host })
  let head: HTMLElement | null = null
  for (let i = 0; i < 80 && !head; i++) {
    await nextFrame()
    head = host.querySelector<HTMLElement>('.chat-head')
    // a wide viewport selects the first room by itself; the phone shows the list first
    const open = [...host.querySelectorAll<HTMLElement>('.room-list button')].find((b) => b.textContent?.includes(ROOM.name))
    if (!head && open && viewport < 768) open.click()
  }
  if (!head) throw new Error('room header never rendered')
  await nextFrame()
  return { host, head }
}

function headParts(head: HTMLElement) {
  const text = head.querySelector<HTMLElement>('.chat-head-text')!
  const name = head.querySelector<HTMLElement>('.chat-head-name')!
  const sub = head.querySelector<HTMLElement>('.chat-head-sub')!
  const buttons = [...head.querySelectorAll<HTMLElement>('button.btn')].filter((b) => !b.classList.contains('chat-back'))
  return { text, name, sub, buttons }
}

function expectHeaderIntact(head: HTMLElement) {
  const { text, name, sub, buttons } = headParts(head)
  expect(buttons.length).toBe(2) // "Einstellungen" and "Element Call"
  const h = rect(head)
  // the title block keeps a readable width: the name is not squeezed to an ellipsis
  expect(rect(name).width).toBeGreaterThanOrEqual(120)
  // the message count line is not clipped
  expect(sub.scrollWidth).toBeLessThanOrEqual(sub.clientWidth + 1)
  // nothing sticks out of the header sideways
  expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth + 1)
  for (const el of [text, ...buttons]) {
    expect(rect(el).left).toBeGreaterThanOrEqual(h.left - 0.5)
    expect(rect(el).right).toBeLessThanOrEqual(h.right + 0.5)
  }
  // title block and actions never overlap, and neither do the actions among themselves
  for (const b of buttons) expect(overlap(rect(text), rect(b))).toBe(false)
  expect(overlap(rect(buttons[0]), rect(buttons[1]))).toBe(false)
}

beforeEach(() => {
  document.documentElement.lang = 'de'
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
})

describe('/messages room header', () => {
  test('is intact at a 375 px phone viewport', async () => {
    const { head } = await mount(375, null)
    expectHeaderIntact(head)
  })

  test('is intact in a 520 px column of a 1024 px desktop window', async () => {
    const { head } = await mount(1024, 520)
    expectHeaderIntact(head)
  })

  test('is intact in a 460 px column of a 1024 px desktop window', async () => {
    const { head } = await mount(1024, 460)
    expectHeaderIntact(head)
  })

  test('keeps title and actions on one row when the column is wide (positive control)', async () => {
    const { head } = await mount(1440, 1100)
    const { text, buttons } = headParts(head)
    expectHeaderIntact(head)
    for (const b of buttons) {
      expect(Math.abs(rect(b).top + rect(b).height / 2 - (rect(text).top + rect(text).height / 2))).toBeLessThan(rect(head).height / 2)
    }
    expect(rect(head).height).toBeLessThan(80)
  })
})
