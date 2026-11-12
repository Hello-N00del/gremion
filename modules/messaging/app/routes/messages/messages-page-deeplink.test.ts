// src/routes/messages/messages-page-deeplink.test.ts
//
// /messages?room=<room id>: the link "Verlauf lesen" of the room administration names one room.
// The page used to ignore its query and open its first active room, so the history that came up
// belonged to a different room. Also here: the selection after a room is gone from the list, and
// the confirmation of a rename in the settings panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, within, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { Role } from '$lib/auth/types'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'

const h = vi.hoisted(() => ({
  // $app/state: where the page reads its own URL from. Each test sets the query before it renders.
  statePage: { url: new URL('http://localhost/messages'), data: { brand: null } },
  roles: [] as string[],
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('$app/stores', () => ({
  page: {
    // read at subscription time, so each test renders with its own session
    subscribe(run: (value: unknown) => void) {
      run({ data: { session: { user: { id: 'admin-1', roles: h.roles } }, brand: null } })
      return () => {}
    },
  },
}))
vi.mock('$app/state', () => ({ page: h.statePage }))
vi.mock('$app/navigation', () => ({ invalidate: () => Promise.resolve() }))
vi.mock('svelte-sonner', () => ({ toast: h.toast }))

class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  addEventListener() {}
  close() {}
}

import Page from './+page.svelte'

const FIRST = { roomId: '!vorstand:matrix.test', name: 'Vorstand', unreadCount: 0, lastMessageTs: 0, archived: false }
const SECOND = { roomId: '!plenum:matrix.test', name: 'Plenum', unreadCount: 0, lastMessageTs: 0, archived: false }
const ARCHIVED = { roomId: '!altbau:matrix.test', name: 'Altbau-Initiative', unreadCount: 2, lastMessageTs: 0, archived: true }
const ROOMS = [FIRST, SECOND, ARCHIVED]

function renderWith(search: string, rooms: Array<typeof FIRST> = ROOMS, role: Role = Role.CouncilAdmin) {
  h.statePage.url = new URL(`http://localhost/messages${search}`)
  h.roles = [role]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url === '/api/messages/rooms') {
      return { ok: true, json: async () => ({ success: true, data: rooms }) }
    }
    if (method === 'GET' && url.endsWith('/unit')) {
      return { ok: true, json: async () => ({ success: true, data: { orgUnitId: 'ou-1' } }) }
    }
    return { ok: true, json: async () => ({ success: true }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  return { ...render(Page), fetchMock }
}

const openRoomName = (container: HTMLElement) => container.querySelector('.chat-head-name')?.textContent ?? null
const room = (roomId: string) => `?room=${encodeURIComponent(roomId)}`

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
  h.statePage.url = new URL('http://localhost/messages')
})

describe('/messages?room= opens the room the link names', () => {
  it('opens the archived room of the link, not the first active room', async () => {
    const { container, findByText } = renderWith(room(ARCHIVED.roomId))
    await findByText('Dieser Raum ist archiviert und schreibgeschützt.')
    expect(openRoomName(container)).toBe('Altbau-Initiative')
    expect(get(selectedRoomId)).toBe(ARCHIVED.roomId)
  })

  it('opens an active room of the link that is not the first one, and marks it read', async () => {
    const rooms = [FIRST, { ...SECOND, unreadCount: 3 }, ARCHIVED]
    const { container, fetchMock } = renderWith(room(SECOND.roomId), rooms)
    await waitFor(() => expect(openRoomName(container)).toBe('Plenum'))
    expect(fetchMock.mock.calls.some((c) => c[0] === `/api/messages/rooms/${encodeURIComponent(SECOND.roomId)}/read`)).toBe(true)
  })

  it('the room of the link wins over a room that was open before', async () => {
    selectedRoomId.set(FIRST.roomId)
    const { container } = renderWith(room(ARCHIVED.roomId))
    await waitFor(() => expect(openRoomName(container)).toBe('Altbau-Initiative'))
  })

  it('a missing room of the link does not leave the room open that was open before', async () => {
    selectedRoomId.set(FIRST.roomId)
    const { container, findByText } = renderWith(room('!fremd:matrix.test'))
    await findByText(/Den Verlauf können nur Mitglieder des Raums lesen/)
    expect(openRoomName(container)).toBeNull()
  })

  it('a room of the link that is not in the list opens NO other room and says why', async () => {
    const { container, findByText } = renderWith(room('!fremd:matrix.test'))
    await findByText(/Den Verlauf können nur Mitglieder des Raums lesen/)
    expect(openRoomName(container)).toBeNull()
    expect(get(selectedRoomId)).toBeNull()
    // also as a toast: on a phone the list is the first screen and the pane is not rendered
    expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('Den Verlauf können nur Mitglieder des Raums lesen'))
    // the list is still there to pick another room from
    expect(within(container).getByText('Vorstand')).toBeTruthy()
  })

  it('the notice goes away once a room is picked from the list', async () => {
    const { container, findByText, queryByText } = renderWith(room('!fremd:matrix.test'))
    await findByText(/Den Verlauf können nur Mitglieder des Raums lesen/)
    await fireEvent.click(within(container).getByText('Plenum'))
    await waitFor(() => expect(openRoomName(container)).toBe('Plenum'))
    expect(queryByText(/Den Verlauf können nur Mitglieder des Raums lesen/)).toBeNull()
  })

  it('without the parameter the first active room opens, as before', async () => {
    const { container } = renderWith('')
    await waitFor(() => expect(openRoomName(container)).toBe('Vorstand'))
  })
})

describe('/messages — a room that is gone from the list is not kept as the open room', () => {
  // A room deleted in the room administration: the id of the open room outlives the page (it is a
  // store), and the reloaded list no longer has it. The pane stayed empty with nothing selected.
  it('falls back to the first active room when the room that was open no longer exists', async () => {
    selectedRoomId.set('!geloescht:matrix.test')
    const { container } = renderWith('')
    await waitFor(() => expect(openRoomName(container)).toBe('Vorstand'))
    expect(get(selectedRoomId)).toBe(FIRST.roomId)
  })
})

describe('/messages — the settings panel confirms a rename', () => {
  it('shows the confirmation with the new name after a successful rename', async () => {
    const { getByText, findByTitle } = renderWith('', [FIRST])
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    const nameInput = await within(document.body).findByDisplayValue('Vorstand')
    await fireEvent.input(nameInput, { target: { value: 'Vorstand intern' } })
    await fireEvent.click(getByText('Speichern'))

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum in „Vorstand intern“ umbenannt'))
    expect(h.toast.error).not.toHaveBeenCalled()
  })
})
