// The /messages page at phone width and the sender labels in the timeline.
//
// At 375 px the room list (264 px) and the conversation sat side by side and the message text
// broke into one letter per line. Below the breakpoint the page now shows the room list OR the
// conversation, never both; selecting a room opens the conversation with a back control.
// jsdom has no layout, so the breakpoint is driven through a matchMedia stub.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, within, waitFor } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'

vi.mock('$app/stores', () => ({
  page: readable({ data: { session: { user: { id: 'member-1', roles: ['member'] } }, brand: null } }),
}))
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/messages'), data: { brand: null } },
}))
vi.mock('$app/navigation', () => ({ invalidate: () => Promise.resolve() }))

class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  addEventListener() {}
  close() {}
}

import Page from './+page.svelte'

const NARROW = '(max-width: 767px)'

const ROOM_A = { roomId: '!vorstand:matrix.test', name: 'Vorstand', unreadCount: 0, lastMessageTs: 0, archived: false }
const ROOM_B = { roomId: '!finanzen:matrix.test', name: 'AK Finanzen', unreadCount: 0, lastMessageTs: 0, archived: false }
const RAW_SENDER = '@max.mustermann_40example.org:matrix.test'

function stubWidth(narrow: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  let matches = narrow
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === NARROW ? matches : false },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { if (query === NARROW) listeners.add(fn) },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { listeners.delete(fn) },
  }))
  return {
    resize(toNarrow: boolean) {
      matches = toNarrow
      for (const fn of listeners) fn({ matches })
    },
  }
}

function renderPage(narrow: boolean, rooms = [ROOM_A, ROOM_B]) {
  const width = stubWidth(narrow)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/messages/rooms') return { ok: true, json: async () => ({ success: true, data: rooms }) }
    return { ok: true, json: async () => ({ success: true }) }
  }))
  const utils = render(Page)
  return { ...utils, width }
}

const roomButton = (name: string) => within(document.body).findByRole('button', { name: new RegExp(name) })
const hasList = () => document.querySelector('.room-list') !== null
const hasConversation = () => document.querySelector('.chat-main') !== null

afterEach(() => {
  vi.unstubAllGlobals()
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
})

describe('/messages at phone width', () => {
  it('shows the room list alone, not the conversation', async () => {
    renderPage(true)
    await roomButton('AK Finanzen')
    expect(hasList()).toBe(true)
    expect(hasConversation()).toBe(false)
    expect(within(document.body).queryByLabelText('Zurück zur Raumliste')).toBeNull()
  })

  it('does not open a conversation by itself when the rooms load', async () => {
    renderPage(true)
    await roomButton('Vorstand')
    expect(hasConversation()).toBe(false)
  })

  it('selecting a room shows the conversation alone, with a back control', async () => {
    renderPage(true)
    await fireEvent.click(await roomButton('AK Finanzen'))
    await waitFor(() => expect(hasConversation()).toBe(true))
    expect(hasList()).toBe(false)
    expect(within(document.body).getByText('AK Finanzen')).toBeTruthy()
    expect(within(document.body).getByLabelText('Zurück zur Raumliste')).toBeTruthy()
  })

  it('the back control returns to the room list', async () => {
    renderPage(true)
    await fireEvent.click(await roomButton('AK Finanzen'))
    await fireEvent.click(await within(document.body).findByLabelText('Zurück zur Raumliste'))
    await waitFor(() => expect(hasList()).toBe(true))
    expect(hasConversation()).toBe(false)
  })

  it('opening a room again after going back works', async () => {
    renderPage(true)
    await fireEvent.click(await roomButton('Vorstand'))
    await fireEvent.click(await within(document.body).findByLabelText('Zurück zur Raumliste'))
    await fireEvent.click(await roomButton('AK Finanzen'))
    await waitFor(() => expect(hasConversation()).toBe(true))
    expect(hasList()).toBe(false)
  })

  it('falls back to the list when the open room disappears', async () => {
    renderPage(true)
    await fireEvent.click(await roomButton('AK Finanzen'))
    await waitFor(() => expect(hasConversation()).toBe(true))
    roomStore.set({})
    await waitFor(() => expect(hasList()).toBe(true))
    expect(hasConversation()).toBe(false)
  })

  it('keeps both panes at desktop width, without a back control', async () => {
    renderPage(false)
    await roomButton('Vorstand')
    await waitFor(() => expect(hasConversation()).toBe(true))
    expect(hasList()).toBe(true)
    expect(within(document.body).queryByLabelText('Zurück zur Raumliste')).toBeNull()
  })

  it('follows a resize from desktop to phone width and back', async () => {
    const { width } = renderPage(false)
    await roomButton('Vorstand')
    await waitFor(() => expect(hasConversation()).toBe(true))
    width.resize(true)
    await waitFor(() => expect(hasConversation()).toBe(false))
    expect(hasList()).toBe(true)
    width.resize(false)
    await waitFor(() => expect(hasConversation()).toBe(true))
    expect(hasList()).toBe(true)
  })
})

describe('/messages sender labels', () => {
  async function openWith(messages: Array<{ sender: string; senderDisplayName: string }>) {
    renderPage(false, [ROOM_A])
    await roomButton('Vorstand')
    roomStore.update((s) => ({
      ...s,
      [ROOM_A.roomId]: {
        ...s[ROOM_A.roomId]!,
        messages: messages.map((m, i) => ({ eventId: `$${i}`, type: 'm.text', body: `Text ${i}`, ts: 1, ...m })),
      },
    }))
    await waitFor(() => expect(document.querySelectorAll('.mname').length).toBe(messages.length))
    return [...document.querySelectorAll('.mname')].map((n) => n.textContent?.trim())
  }

  it('shows the display name of a known member', async () => {
    const labels = await openWith([{ sender: RAW_SENDER, senderDisplayName: 'Max Mustermann' }])
    expect(labels).toEqual(['Max Mustermann'])
  })

  it('shows a readable fallback, not the Matrix id, for an unknown sender', async () => {
    const labels = await openWith([{ sender: RAW_SENDER, senderDisplayName: RAW_SENDER }])
    expect(labels).toEqual(['Max Mustermann'])
  })

  it('shows a readable fallback when the display name is missing', async () => {
    const labels = await openWith([{ sender: RAW_SENDER, senderDisplayName: '' }])
    expect(labels).toEqual(['Max Mustermann'])
  })

  it('never shows an e-mail address or a Matrix id in a sender label or avatar', async () => {
    await openWith([
      { sender: RAW_SENDER, senderDisplayName: RAW_SENDER },
      { sender: RAW_SENDER, senderDisplayName: 'max.mustermann@example.org' },
      { sender: '@erika_40example.org:matrix.test', senderDisplayName: '' },
    ])
    const shown = [...document.querySelectorAll('.mname, .mav')].map((n) => n.textContent ?? '')
    for (const t of shown) {
      expect(t).not.toMatch(/[@:]/)
      expect(t).not.toMatch(/example\.org/)
    }
    expect([...document.querySelectorAll('.mav')].map((n) => n.textContent)).toEqual(['MM', 'MM', 'ER'])
  })
})
