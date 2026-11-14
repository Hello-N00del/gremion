// src/routes/messages/manage/manage-page.test.ts
//
// The "Verwaltung -> Räume" page: the inline rename (an in-app input, never window.prompt), the
// archive section (one row per archived ROOM, restore, the history link, delete) and the visible
// confirmation of every action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, within, waitFor } from '@testing-library/svelte'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/messages/manage'), data: {} as Record<string, unknown> },
  invalidateAll: vi.fn(() => Promise.resolve()),
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('$app/state', () => ({ page: h.page }))
vi.mock('$app/navigation', () => ({ invalidateAll: h.invalidateAll }))
vi.mock('svelte-sonner', () => ({ toast: h.toast }))

import Page from './+page.svelte'

interface UnitRow { unitId: string; unitName: string; state: string; roomId?: string; roomName?: string }
interface ArchivedRow { roomId: string; unitId: string; unitName: string; roomName?: string; archivedAt?: string; restorable: boolean; restoreBlockedBy?: 'other_room' | 'unreadable' | 'being_created' }
interface Data { matrix: 'reachable' | 'unreachable'; units: UnitRow[]; archivedRooms: ArchivedRow[] }

const VORSTAND = '!vorstand:matrix.test'
const baseData: Data = {
  matrix: 'reachable',
  units: [{ unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: VORSTAND }],
  archivedRooms: [],
}

const NEWER = '!plenum-neu:matrix.test'
const OLDER = '!plenum-alt:matrix.test'
const OF_ACTIVE_UNIT = '!vorstand-alt:matrix.test'
const archiveData: Data = {
  matrix: 'reachable',
  units: [
    { unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: VORSTAND },
    { unitId: 'ou-2', unitName: 'Plenum', state: 'archiviert', roomId: NEWER },
  ],
  archivedRooms: [
    { roomId: NEWER, unitId: 'ou-2', unitName: 'Plenum', archivedAt: '2026-09-01T12:00:00Z', restorable: true },
    { roomId: OLDER, unitId: 'ou-2', unitName: 'Plenum', roomName: 'Altes Plenum', archivedAt: '2026-01-01T12:00:00Z', restorable: true },
    { roomId: OF_ACTIVE_UNIT, unitId: 'ou-1', unitName: 'Vorstand', archivedAt: '2025-06-01T12:00:00Z', restorable: false, restoreBlockedBy: 'other_room' },
  ],
}

function renderPage(data: Data = baseData, opts: { role?: Role; status?: number } = {}) {
  h.page.data = { session: { user: { id: 'admin-1', roles: [opts.role ?? Role.CouncilAdmin] } } }
  const status = opts.status ?? 200
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400, status, json: async () => ({ success: status < 400, data: { aliasRestored: true } }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const utils = render(Page, { props: { data: data as never } })
  return { ...utils, fetchMock }
}

const archiveRow = (container: HTMLElement, roomId: string) => {
  const row = container.querySelector<HTMLElement>(`[data-archived-room="${roomId}"]`)
  if (!row) throw new Error(`no archive row for ${roomId}`)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  h.page.data = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/messages/manage — rename (MEDIUM fix: in-app affordance, not window.prompt)', () => {
  it('never calls window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt')
    renderPage()
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })

  it('Umbenennen opens an inline input (no native prompt) and Speichern PATCHes the new name', async () => {
    const { getByText, getByLabelText, fetchMock } = renderPage()
    await fireEvent.click(getByText('Umbenennen'))
    const input = getByLabelText('Neuer Raumname') as HTMLInputElement
    expect(input.value).toBe('Vorstand')
    await fireEvent.input(input, { target: { value: 'Vorstand (neu)' } })
    await fireEvent.click(getByText('Speichern'))

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/messages/rooms/${encodeURIComponent('!vorstand:matrix.test')}`,
      expect.objectContaining({ method: 'PATCH' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body).toEqual({ orgUnitId: 'ou-1', name: 'Vorstand (neu)' })
  })

  it('Abbrechen discards the edit without calling fetch', async () => {
    const { getByText, queryByLabelText, fetchMock } = renderPage()
    await fireEvent.click(getByText('Umbenennen'))
    await fireEvent.click(getByText('Abbrechen'))
    expect(queryByLabelText('Neuer Raumname')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// A rename changes the name of the ROOM, not of the unit. The page showed the unit name only and
// said nothing after the save, so a successful rename looked like a click that did nothing.
describe('/messages/manage — a rename is confirmed and visible', () => {
  it('confirms a successful rename with the new name and reloads the overview', async () => {
    const { getByText, getByLabelText } = renderPage()
    await fireEvent.click(getByText('Umbenennen'))
    await fireEvent.input(getByLabelText('Neuer Raumname'), { target: { value: 'Vorstand intern' } })
    await fireEvent.click(getByText('Speichern'))

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum in „Vorstand intern“ umbenannt'))
    expect(h.invalidateAll).toHaveBeenCalledTimes(1)
    expect(h.toast.error).not.toHaveBeenCalled()
  })

  it('a refused rename shows the error and no confirmation', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getByText, getByLabelText } = renderPage(baseData, { status: 502 })
    await fireEvent.click(getByText('Umbenennen'))
    await fireEvent.input(getByLabelText('Neuer Raumname'), { target: { value: 'Vorstand intern' } })
    await fireEvent.click(getByText('Speichern'))

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Raum konnte nicht umbenannt werden'))
    expect(h.toast.success).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('shows the own name of a room next to its unit, and starts the rename from it', async () => {
    const data: Data = {
      ...baseData,
      units: [{ unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: VORSTAND, roomName: 'Vorstand intern' }],
    }
    const { getByText, getByLabelText, container } = renderPage(data)
    expect(container.querySelector('.room-name')?.textContent).toContain('Vorstand intern')

    await fireEvent.click(getByText('Umbenennen'))
    expect((getByLabelText('Neuer Raumname') as HTMLInputElement).value).toBe('Vorstand intern')
  })

  it('renaming a room back to the name of its unit is sent, not dropped as unchanged', async () => {
    const data: Data = {
      ...baseData,
      units: [{ unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: VORSTAND, roomName: 'Vorstand intern' }],
    }
    const { getByText, getByLabelText, fetchMock } = renderPage(data)
    await fireEvent.click(getByText('Umbenennen'))
    await fireEvent.input(getByLabelText('Neuer Raumname'), { target: { value: 'Vorstand' } })
    await fireEvent.click(getByText('Speichern'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ orgUnitId: 'ou-1', name: 'Vorstand' })
  })

  it('does not repeat the name of a room that is called like its unit', () => {
    const data: Data = {
      ...baseData,
      units: [{ unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: VORSTAND, roomName: 'Vorstand' }],
    }
    const { container } = renderPage(data)
    expect(container.querySelector('.room-name')).toBeNull()
  })
})

describe('/messages/manage — archive', () => {
  it('lists every archived room, also two of one unit and one of a unit that has a room again', () => {
    const { container } = renderPage(archiveData)
    const rows = [...container.querySelectorAll<HTMLElement>('[data-archived-room]')]
    expect(rows.map((r) => r.dataset.archivedRoom)).toEqual([NEWER, OLDER, OF_ACTIVE_UNIT])
    expect(within(archiveRow(container, OLDER)).getByText('Plenum')).toBeTruthy()
    expect(archiveRow(container, OLDER).textContent).toContain('Altes Plenum')
    expect(archiveRow(container, NEWER).textContent).toContain('01.09.2026')
  })

  it('has no archive section without an archived room', () => {
    const { queryByText } = renderPage()
    expect(queryByText('Archiv')).toBeNull()
  })

  // The link carried the unit (?ou=), which the chat page never read: it opened its first room.
  it('"Verlauf lesen" links to the archived room itself', () => {
    const { container } = renderPage(archiveData)
    for (const roomId of [NEWER, OLDER, OF_ACTIVE_UNIT]) {
      const link = within(archiveRow(container, roomId)).getByText('Verlauf lesen') as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe(`/messages?room=${encodeURIComponent(roomId)}`)
    }
  })

  it('restores an archived room: POST to its restore route for its unit, confirmation, reload', async () => {
    const { container, fetchMock } = renderPage(archiveData)
    await fireEvent.click(within(archiveRow(container, OLDER)).getByText('Wiederherstellen'))

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum wiederhergestellt'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/messages/rooms/${encodeURIComponent(OLDER)}/unarchive`)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ orgUnitId: 'ou-2' })
    expect(h.invalidateAll).toHaveBeenCalledTimes(1)
  })

  it('offers no restore for a room whose unit has a room again, and says why', () => {
    const { container } = renderPage(archiveData)
    const row = archiveRow(container, OF_ACTIVE_UNIT)
    expect(within(row).queryByText('Wiederherstellen')).toBeNull()
    expect(row.textContent).toContain('„Vorstand“ hat bereits einen neuen Raum')
    // the rooms that can be restored carry no such note
    expect(archiveRow(container, NEWER).textContent).not.toContain('hat bereits einen neuen Raum')
    expect(within(archiveRow(container, NEWER)).getByText('Wiederherstellen')).toBeTruthy()
  })

  // The overview could not read the unit's ledger: that says nothing about another room, so the page
  // must not claim one.
  it('says the room status could not be read, not that a new room exists, when the ledger read failed', () => {
    const data: Data = { ...archiveData, archivedRooms: [{ roomId: OLDER, unitId: 'ou-2', unitName: 'Plenum', restorable: false, restoreBlockedBy: 'unreadable' }] }
    const { container } = renderPage(data)
    const row = archiveRow(container, OLDER)
    expect(within(row).queryByText('Wiederherstellen')).toBeNull()
    expect(row.textContent).toContain('Der Raumstatus von „Plenum“ konnte nicht gelesen werden')
    expect(row.textContent).not.toContain('hat bereits einen neuen Raum')
  })

  it('says the unit is getting a new room, not that it has one, while that room is still being created', () => {
    const data: Data = { ...archiveData, archivedRooms: [{ roomId: OLDER, unitId: 'ou-2', unitName: 'Plenum', restorable: false, restoreBlockedBy: 'being_created' }] }
    const { container } = renderPage(data)
    const row = archiveRow(container, OLDER)
    expect(within(row).queryByText('Wiederherstellen')).toBeNull()
    expect(row.textContent).toContain('„Plenum“ bekommt gerade einen neuen Raum')
    expect(row.textContent).not.toContain('hat bereits einen neuen Raum')
  })

  it('tells before the click that only members can read the history of an archived room', () => {
    const { container } = renderPage(archiveData)
    expect(container.textContent).toContain('Den Verlauf eines archivierten Raums können nur dessen Mitglieder lesen.')
  })

  it('says so when the restore could not take the unit address back', async () => {
    h.page.data = { session: { user: { id: 'admin-1', roles: [Role.CouncilAdmin] } } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: { aliasRestored: false } }) }))
    const { container } = render(Page, { props: { data: archiveData as never } })
    await fireEvent.click(within(archiveRow(container, OLDER)).getByText('Wiederherstellen'))

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('Adresse')))
    expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('Raum wiederhergestellt'))
  })

  it('a refused restore shows the error, no confirmation, and reloads the overview', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = renderPage(archiveData, { status: 409 })
    await fireEvent.click(within(archiveRow(container, NEWER)).getByText('Wiederherstellen'))

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Raum konnte nicht wiederhergestellt werden'))
    expect(h.toast.success).not.toHaveBeenCalled()
    // a conflict means the overview on screen is out of date
    expect(h.invalidateAll).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it('delete is ITAdmin-only in the archive', () => {
    const { container } = renderPage(archiveData, { role: Role.CouncilAdmin })
    expect(within(archiveRow(container, NEWER)).queryByText('Löschen')).toBeNull()
  })

  it('deletes exactly the archived room of the clicked row, confirms it and reloads the overview', async () => {
    const { container, fetchMock, rerender } = renderPage(archiveData, { role: Role.ITAdmin })
    await fireEvent.click(within(archiveRow(container, NEWER)).getByText('Löschen'))
    // the confirm step belongs to this row only, not to the other archived room of the same unit
    expect(within(archiveRow(container, OLDER)).queryByText('Bestätigen')).toBeNull()
    await fireEvent.click(within(archiveRow(container, NEWER)).getByText('Bestätigen'))

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum gelöscht'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/messages/rooms/${encodeURIComponent(NEWER)}?orgUnitId=ou-2`)
    expect(fetchMock.mock.calls[0]![1]).toEqual({ method: 'DELETE' })
    expect(h.invalidateAll).toHaveBeenCalledTimes(1)

    // the reloaded overview no longer carries the room: its row is gone, the older room keeps its own
    await rerender({ data: { ...archiveData, archivedRooms: archiveData.archivedRooms.filter((r) => r.roomId !== NEWER) } as never })
    expect(container.querySelector(`[data-archived-room="${NEWER}"]`)).toBeNull()
    expect(archiveRow(container, OLDER)).toBeTruthy()
  })

  it('tells before archiving that the room becomes read-only and can be restored', async () => {
    const { getByText, container } = renderPage()
    await fireEvent.click(getByText('Archivieren'))
    expect(container.textContent).toContain('schreibgeschützt')
    expect(container.textContent).toContain('wiederhergestellt')
  })

  it('confirms an archive and a delete of an active room', async () => {
    const { getByText, queryByText } = renderPage(baseData, { role: Role.ITAdmin })
    await fireEvent.click(getByText('Archivieren'))
    await fireEvent.click(getByText('Bestätigen'))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum archiviert'))
    // the row is busy until the overview is reloaded
    await waitFor(() => expect(queryByText('Bestätigen')).toBeNull())

    await fireEvent.click(getByText('Löschen'))
    await fireEvent.click(getByText('Bestätigen'))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Raum gelöscht'))
    expect(h.invalidateAll).toHaveBeenCalledTimes(2)
  })
})
