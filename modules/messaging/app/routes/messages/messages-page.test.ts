// src/routes/messages/messages-page.test.ts
//
// TASK-009 lane B (row 15, FLOW-MSG-001): component coverage for the
// /messages page's admin surface — the create-room dialog, the
// Einstellungen panel's rename/archive/delete calls, the ITAdmin-only
// delete gate (R23-4), and the read-only Archiv section (R23-5). Round-2
// item C of the fix-round-2 task: none of this had a component test before.
//
// The page reads `page` via BOTH `$app/stores` (its own $page.data.session
// / $page.data.brand) and `$app/state` (PageTitle's tab-title brand lookup)
// — both are stubbed so the render is hermetic. `$app/navigation`'s
// `invalidate` is a no-op (the unread-badge revalidation is not this
// test's concern). `EventSource` is not implemented in jsdom, so a minimal
// fake stands in for the SSE connection the page opens on mount; this test
// exercises the admin surface, not the live-sync stream.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { tick } from 'svelte'
import { Role } from '$lib/auth/types'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'

let sessionUser: { id: string; roles: Role[] } | undefined

vi.mock('$app/stores', () => ({
  page: readable({ data: { get session() { return sessionUser ? { user: sessionUser } : null }, brand: null } }),
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

const ACTIVE_ROOM = {
  roomId: '!vorstand:matrix.test',
  name: 'Vorstand',
  unreadCount: 0,
  lastMessageTs: 0,
  archived: false,
}
const ARCHIVED_ROOM = {
  roomId: '!altbau:matrix.test',
  name: 'Altbau-Initiative',
  unreadCount: 0,
  lastMessageTs: 0,
  archived: true,
}

/** Routes a mocked fetch by method + URL substring, matching the
 *  {ok, json} shape the page's own fetch call sites read (never a real
 *  Response — same pattern as vault-page.test.ts / lists-page.test.ts). */
function makeFetchMock(rooms: Array<typeof ACTIVE_ROOM | typeof ARCHIVED_ROOM>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url === '/api/messages/rooms') {
      return { ok: true, json: async () => ({ success: true, data: rooms }) }
    }
    if (method === 'GET' && url === '/api/governance/committees') {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: [{ id: 'ou-9', name: 'AK Finanzen', wants_matrix_room: false }],
        }),
      }
    }
    if (method === 'GET' && /\/unit$/.test(url)) {
      return { ok: true, json: async () => ({ success: true, data: { orgUnitId: 'ou-1' } }) }
    }
    if (method === 'POST' && url === '/api/messages/rooms') {
      return { ok: true, json: async () => ({ success: true, data: { roomId: '!new:matrix.test' } }) }
    }
    if (method === 'PATCH') {
      return { ok: true, json: async () => ({ success: true }) }
    }
    if (method === 'POST' && /\/archive$/.test(url)) {
      return { ok: true, json: async () => ({ success: true, data: '!vorstand:matrix.test' }) }
    }
    if (method === 'DELETE') {
      return { ok: true, json: async () => ({ success: true }) }
    }
    // /read (openRoom) and anything else — best-effort no-op ack.
    return { ok: true, json: async () => ({ success: true }) }
  })
}

function renderAs(role: Role, rooms: Array<typeof ACTIVE_ROOM | typeof ARCHIVED_ROOM>) {
  sessionUser = { id: 'admin-1', roles: [role] }
  const fetchMock = makeFetchMock(rooms)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  const utils = render(Page)
  return { ...utils, fetchMock }
}

/** Round-2 (fu1) item 2: same render, but the caller supplies its own fetch
 *  mock outright, so a test can control the `/unit` lookup's timing/outcome
 *  precisely (a pending promise, or a failure) instead of the fixed
 *  always-succeeds-immediately shape makeFetchMock gives every call. */
function renderWithFetch(
  role: Role, fetchMock: ReturnType<typeof vi.fn>
) {
  sessionUser = { id: 'admin-1', roles: [role] }
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  const utils = render(Page)
  return { ...utils, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
  sessionUser = undefined
})

describe('/messages — create-room dialog (row 15)', () => {
  it('submits POST /api/messages/rooms with the selected org unit', async () => {
    const { getByText, fetchMock } = renderAs(Role.CouncilAdmin, [])
    await fireEvent.click(await within(document.body).findByText('Raum erstellen'))
    const select = (await within(document.body).findByLabelText('Gremium oder Initiative')) as HTMLSelectElement
    await fireEvent.change(select, { target: { value: 'ou-9' } })
    await fireEvent.click(getByText('Erstellen'))

    const createCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/messages/rooms' && (c[1] as RequestInit)?.method === 'POST'
    )
    expect(createCall).toBeTruthy()
    const body = JSON.parse((createCall![1] as RequestInit).body as string)
    expect(body.orgUnitId).toBe('ou-9')
  })
})

describe('/messages — Einstellungen panel (row 15)', () => {
  it('rename (Speichern) PATCHes the resolved orgUnitId + new name', async () => {
    const { getByText, findByTitle, fetchMock } = renderAs(Role.CouncilAdmin, [ACTIVE_ROOM])
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    const nameInput = await within(document.body).findByDisplayValue('Vorstand')
    await fireEvent.input(nameInput, { target: { value: 'Vorstand (neu)' } })
    await fireEvent.click(getByText('Speichern'))

    const patchCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH')
    expect(patchCall?.[0]).toBe(`/api/messages/rooms/${encodeURIComponent(ACTIVE_ROOM.roomId)}`)
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body).toEqual({ orgUnitId: 'ou-1', name: 'Vorstand (neu)' })
  })

  it('archive (Archivieren -> Bestätigen) POSTs to the archive endpoint', async () => {
    const { getByText, findByTitle, fetchMock } = renderAs(Role.CouncilAdmin, [ACTIVE_ROOM])
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    await fireEvent.click(getByText('Archivieren'))
    await fireEvent.click(getByText('Bestätigen'))

    const archiveCall = fetchMock.mock.calls.find((c) => /\/archive$/.test(c[0] as string))
    expect(archiveCall?.[0]).toBe(`/api/messages/rooms/${encodeURIComponent(ACTIVE_ROOM.roomId)}/archive`)
    const body = JSON.parse((archiveCall![1] as RequestInit).body as string)
    expect(body).toEqual({ orgUnitId: 'ou-1' })
  })

  it('delete is absent for a CouncilAdmin who is not also ITAdmin', async () => {
    const { getByText, findByTitle, queryByText } = renderAs(Role.CouncilAdmin, [ACTIVE_ROOM])
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    expect(queryByText('Löschen')).toBeNull()
  })

  it('delete (Löschen -> Bestätigen) DELETEs with orgUnitId as a query param, for an ITAdmin', async () => {
    const { getByText, findByTitle, fetchMock } = renderAs(Role.ITAdmin, [ACTIVE_ROOM])
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    await fireEvent.click(getByText('Löschen'))
    await fireEvent.click(getByText('Bestätigen'))

    const deleteCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe(
      `/api/messages/rooms/${encodeURIComponent(ACTIVE_ROOM.roomId)}?orgUnitId=ou-1`
    )
  })

  // TASK-009 fu1 DEFECT 2 (live e2e, UX race): openSettings() resolves the
  // owning org unit asynchronously (GET .../unit, O(units) sequential ledger
  // reads on the server). Before this fix, Speichern/Archivieren/Löschen
  // were enabled the instant the panel opened; a click before the lookup
  // resolved hit the "Raum-Zuordnung nicht gefunden" toast-and-noop path,
  // and a 404 from the lookup was indistinguishable from "still loading".
  it('DEFECT 2 RED->GREEN: Speichern/Archivieren/Löschen are disabled with a loading hint while the unit lookup is pending', async () => {
    let resolveUnit: (v: unknown) => void = () => {}
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === '/api/messages/rooms') {
        return { ok: true, json: async () => ({ success: true, data: [ACTIVE_ROOM] }) }
      }
      if (method === 'GET' && /\/unit$/.test(url)) {
        return new Promise((resolve) => { resolveUnit = resolve })
      }
      return { ok: true, json: async () => ({ success: true }) }
    })
    const { getByText, findByTitle } = renderWithFetch(Role.ITAdmin, fetchMock)
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))
    await within(document.body).findByDisplayValue('Vorstand')

    expect((getByText('Speichern') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Archivieren') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Löschen') as HTMLButtonElement).disabled).toBe(true)
    expect(within(document.body).getByText(/Raum-Zuordnung wird geladen/)).toBeTruthy()

    resolveUnit({ ok: true, json: async () => ({ success: true, data: { orgUnitId: 'ou-1' } }) })
    // Flush the chained microtask awaits inside openSettings (the fetch
    // promise itself, then res.json(), then the finally block), then let
    // Svelte re-render.
    await new Promise((r) => setTimeout(r, 0))
    await tick()

    expect((getByText('Speichern') as HTMLButtonElement).disabled).toBe(false)
    expect((getByText('Archivieren') as HTMLButtonElement).disabled).toBe(false)
  })

  it('DEFECT 2 RED->GREEN: a failed unit lookup (non-2xx) shows an explicit inline error and keeps actions disabled, not enabled', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === '/api/messages/rooms') {
        return { ok: true, json: async () => ({ success: true, data: [ACTIVE_ROOM] }) }
      }
      if (method === 'GET' && /\/unit$/.test(url)) {
        return { ok: false, status: 404, json: async () => ({ success: false }) }
      }
      return { ok: true, json: async () => ({ success: true }) }
    })
    const { getByText, findByTitle } = renderWithFetch(Role.ITAdmin, fetchMock)
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))

    await within(document.body).findByText('Raum-Zuordnung konnte nicht geladen werden')
    expect((getByText('Speichern') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Archivieren') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Löschen') as HTMLButtonElement).disabled).toBe(true)
  })

  it('DEFECT 2 RED->GREEN: a thrown unit lookup (network error) shows the same inline error, not silence', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === '/api/messages/rooms') {
        return { ok: true, json: async () => ({ success: true, data: [ACTIVE_ROOM] }) }
      }
      if (method === 'GET' && /\/unit$/.test(url)) {
        throw new Error('network down')
      }
      return { ok: true, json: async () => ({ success: true }) }
    })
    const { getByText, findByTitle } = renderWithFetch(Role.ITAdmin, fetchMock)
    await findByTitle('Einstellungen')
    await fireEvent.click(getByText('Einstellungen'))

    await within(document.body).findByText('Raum-Zuordnung konnte nicht geladen werden')
    expect((getByText('Speichern') as HTMLButtonElement).disabled).toBe(true)
  })

  // LOW (TASK-009 fu1 round 2 verifier, downgraded from the house review's
  // HIGH #1): the OLD stale-response guard compared only roomId, so a rapid
  // close/reopen of the SAME room — open A, close, reopen A while the first
  // /unit lookup is still in flight, then the first lookup fails and the
  // second succeeds — left settingsLoadError stuck at true forever even
  // though the SECOND, MORE RECENT call already resolved a good
  // settingsOrgUnitId. A per-call request token (bumped on every
  // openSettings(), not the room id) fixes this: only the most recent call's
  // outcome is ever applied.
  it('RED->GREEN: reopening the same room while a first (later-failing) lookup is in flight is not left stuck on the error state', async () => {
    const unitResolvers: Array<(v: unknown) => void> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === '/api/messages/rooms') {
        return { ok: true, json: async () => ({ success: true, data: [ACTIVE_ROOM] }) }
      }
      if (method === 'GET' && /\/unit$/.test(url)) {
        return new Promise((resolve) => { unitResolvers.push(resolve) })
      }
      return { ok: true, json: async () => ({ success: true }) }
    })
    const { getByText, getByLabelText, findByTitle } = renderWithFetch(Role.ITAdmin, fetchMock)
    await findByTitle('Einstellungen')

    // Open A (call #1 starts, still pending), close, reopen A (call #2 starts).
    await fireEvent.click(getByText('Einstellungen'))
    await fireEvent.click(getByLabelText('Schließen'))
    await fireEvent.click(getByText('Einstellungen'))
    await within(document.body).findByDisplayValue('Vorstand')
    expect(unitResolvers.length).toBe(2)

    // Call #1 (the stale one) fails AFTER call #2 (the current one) already
    // started — this ordering is the whole point of the race.
    unitResolvers[0]({ ok: false, status: 404, json: async () => ({ success: false }) })
    await new Promise((r) => setTimeout(r, 0))
    await tick()
    // Call #2 (current) succeeds.
    unitResolvers[1]({ ok: true, json: async () => ({ success: true, data: { orgUnitId: 'ou-1' } }) })
    await new Promise((r) => setTimeout(r, 0))
    await tick()

    expect(within(document.body).queryByText('Raum-Zuordnung konnte nicht geladen werden')).toBeNull()
    expect((getByText('Speichern') as HTMLButtonElement).disabled).toBe(false)
    expect((getByText('Archivieren') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('/messages — Archiv section (R23-5: read-only, no Einstellungen)', () => {
  it('lists an archived room separately and renders it read-only when opened', async () => {
    const { getByText, findByText } = renderAs(Role.CouncilAdmin, [ACTIVE_ROOM, ARCHIVED_ROOM])
    await findByText('Archiv')
    expect(getByText('Altbau-Initiative')).toBeTruthy()

    await fireEvent.click(getByText('Altbau-Initiative'))
    expect(await findByText('Dieser Raum ist archiviert und schreibgeschützt.')).toBeTruthy()
    // No Einstellungen for an archived room (create/rename/archive/delete
    // all operate on the active room only — R23-5 says archived rooms stay
    // read-only, members kept, no further mutation surface).
    expect(document.querySelector('button[title="Einstellungen"]')).toBeNull()
  })
})
