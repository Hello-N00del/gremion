// German count labels on the /messages page: the room-list subline and the chat header must read
// the singular for exactly one ("1 Raum", "1 Nachricht"), never "1 Räume" / "1 Nachrichten".
// Same hermetic harness as messages-page.test.ts (stores and EventSource stubbed); the rooms come
// from the roomStore, the fetch mock only answers the page's own initial room load.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { Role } from '$lib/auth/types'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'

vi.mock('$app/stores', () => ({
  page: readable({ data: { session: { user: { id: 'u-1', roles: [Role.Member] } }, brand: null } }),
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

function room(id: string, messageCount: number) {
  return {
    roomId: id,
    name: `Raum ${id}`,
    unreadCount: 0,
    lastMessageTs: 0,
    archived: false,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      eventId: `$${id}-${i}`,
      sender: '@a:matrix.test',
      senderDisplayName: 'A',
      type: 'm.text',
      body: `Text ${i}`,
      ts: i,
    })),
  }
}

function renderWith(rooms: ReturnType<typeof room>[], selected: string | null) {
  roomStore.set(Object.fromEntries(rooms.map((r) => [r.roomId, r])))
  selectedRoomId.set(selected)
  const rows = rooms.map(({ messages: _m, ...r }) => r)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ success: true, data: url === '/api/messages/rooms' ? rows : [] }),
    })),
  )
  return render(Page)
}

afterEach(() => {
  vi.unstubAllGlobals()
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
})

describe('/messages — German count labels', () => {
  it('reads "1 Raum" for a single room and "2 Räume" for two', async () => {
    const one = renderWith([room('a', 0)], null)
    expect(one.container.querySelector('.room-list-sub')?.textContent).toMatch(/^1 Raum · /)
    one.unmount()
    const two = renderWith([room('a', 0), room('b', 0)], null)
    expect(two.container.querySelector('.room-list-sub')?.textContent).toMatch(/^2 Räume · /)
  })

  it('reads "1 Nachricht" for a single message and "3 Nachrichten" for three', async () => {
    const one = renderWith([room('a', 1)], 'a')
    expect(one.container.querySelector('.chat-head-sub')?.textContent).toMatch(/1 Nachricht ·/)
    one.unmount()
    const three = renderWith([room('a', 3)], 'a')
    expect(three.container.querySelector('.chat-head-sub')?.textContent).toMatch(/3 Nachrichten ·/)
  })

  it('reads "0 Nachrichten" for an empty room', async () => {
    const r = renderWith([room('a', 0)], 'a')
    expect(r.container.querySelector('.chat-head-sub')?.textContent).toMatch(/0 Nachrichten ·/)
  })
})
