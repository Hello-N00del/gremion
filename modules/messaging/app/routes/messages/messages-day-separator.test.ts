// src/routes/messages/messages-day-separator.test.ts
//
// The conversation's day separators. Each run of messages sent on the same calendar day gets one
// separator that names THAT day; "Heute" and "Gestern" appear only on the groups they are true for.
//
// The fixture sits on midnight boundaries in Europe/Berlin (UTC+1 in November). Two messages that
// share a UTC date but fall on different Berlin days must land under different separators, so a
// grouping by UTC date, or one label for the whole list, fails here. The zone is pinned for this
// file and checked before the first render: a runner in another zone must not pass by accident.
//
// Only `Date` is faked by default, so the page's own timers stay real; the one case about a page
// left open over midnight also fakes the interval that re-reads the clock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { tick } from 'svelte'
import { Role } from '$lib/auth/types'
import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'
import type { MatrixMessage } from '$lib/stores/matrix'

vi.mock('$app/stores', () => ({
  page: readable({ data: { session: { user: { id: 'member-1', roles: [Role.Member] } }, brand: null } }),
}))
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/messages'), data: { brand: null } },
}))
vi.mock('$app/navigation', () => ({ invalidate: () => Promise.resolve() }))

/** Stands in for the SSE stream; the test pushes sync snapshots through `emit`. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  constructor() {
    FakeEventSource.last = this
  }
  addEventListener() {}
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

import Page from './+page.svelte'

const ROOM_ID = '!vorstand:matrix.test'
const ROOM = { roomId: ROOM_ID, name: 'Vorstand', unreadCount: 0, lastMessageTs: 0, archived: false }

function msg(eventId: string, iso: string, body: string): MatrixMessage {
  return {
    eventId,
    sender: '@erika.musterfrau:matrix.test',
    senderDisplayName: 'Erika Musterfrau',
    type: 'm.text',
    body,
    ts: Date.parse(iso),
  }
}

// "Now" is Thursday 12.11.2026, 09:00 in Berlin.
const NOW = '2026-11-12T08:00:00Z'
const HISTORY: MatrixMessage[] = [
  msg('$a', '2026-11-09T10:00:00Z', 'Montagmittag'), //            09.11. 11:00 Berlin
  msg('$b', '2026-11-10T22:30:00Z', 'Dienstag kurz vor Mitternacht'), // 10.11. 23:30 Berlin
  msg('$c', '2026-11-10T23:30:00Z', 'Mittwoch kurz nach Mitternacht'), // 11.11. 00:30 Berlin, UTC date still 10.11.
  msg('$d', '2026-11-11T22:59:00Z', 'Mittwoch 23:59'), //          11.11. 23:59 Berlin
  msg('$e', '2026-11-11T23:01:00Z', 'Donnerstag 00:01'), //        12.11. 00:01 Berlin, UTC date still 11.11.
]

/** The conversation as the reader sees it, top to bottom: separators and message texts. */
function timeline(container: HTMLElement): string[] {
  const rows = container.querySelectorAll('.chat-body .divider-label, .chat-body .mtext')
  return Array.from(rows, (el) =>
    el.classList.contains('divider-label') ? `--- ${el.textContent?.trim()}` : (el.textContent?.trim() ?? ''),
  )
}

async function renderConversation(messages: MatrixMessage[]) {
  roomStore.set({ [ROOM_ID]: { ...ROOM, messages } })
  selectedRoomId.set(ROOM_ID)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [ROOM] }) })),
  )
  vi.stubGlobal('EventSource', FakeEventSource)
  const utils = render(Page)
  // The stream is opened once the room list has loaded. setTimeout is never faked here.
  for (let i = 0; i < 50 && FakeEventSource.last === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(FakeEventSource.last).not.toBeNull()
  await tick()
  return utils
}

const previousTz = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeEventSource.last = null
  roomStore.set({})
  selectedRoomId.set(null)
  syncStatus.set('connecting')
})

describe('/messages — day separators', () => {
  it('runs in Europe/Berlin (winter time, UTC+1), so the fixture really straddles local midnight', () => {
    expect(new Date(NOW).getTimezoneOffset()).toBe(-60)
    expect(new Date('2026-11-10T23:30:00Z').getDate()).toBe(11)
  })

  it('labels every group with the local day of its own messages, one separator per day', async () => {
    const { container } = await renderConversation(HISTORY)

    expect(timeline(container)).toEqual([
      '--- 09.11.2026',
      'Montagmittag',
      '--- 10.11.2026',
      'Dienstag kurz vor Mitternacht',
      '--- Gestern · 11.11.2026',
      'Mittwoch kurz nach Mitternacht',
      'Mittwoch 23:59',
      '--- Heute · 12.11.2026',
      'Donnerstag 00:01',
    ])
  })

  it('says "Heute" only above messages of today, never above an older conversation', async () => {
    const { container } = await renderConversation(HISTORY.slice(0, 4))

    const labels = timeline(container).filter((row) => row.startsWith('---'))
    expect(labels).toEqual(['--- 09.11.2026', '--- 10.11.2026', '--- Gestern · 11.11.2026'])
    expect(container.querySelector('.chat-body')?.textContent).not.toContain('Heute')
  })

  it('puts a message that arrives today under its own "Heute" separator, not under yesterday', async () => {
    const { container } = await renderConversation(HISTORY.slice(0, 4))

    FakeEventSource.last!.emit({
      nextBatch: 's2',
      rooms: [
        { roomId: ROOM_ID, unreadCount: 0, events: [msg('$f', '2026-11-12T07:30:00Z', 'Guten Morgen')] },
      ],
    })
    await tick()

    expect(timeline(container).slice(-4)).toEqual([
      'Mittwoch kurz nach Mitternacht',
      'Mittwoch 23:59',
      '--- Heute · 12.11.2026',
      'Guten Morgen',
    ])
  })

  it('keeps a second message of today under the one existing "Heute" separator', async () => {
    const { container } = await renderConversation(HISTORY)

    FakeEventSource.last!.emit({
      nextBatch: 's2',
      rooms: [
        { roomId: ROOM_ID, unreadCount: 0, events: [msg('$f', '2026-11-12T07:30:00Z', 'Guten Morgen')] },
      ],
    })
    await tick()

    const rows = timeline(container)
    expect(rows.filter((row) => row.startsWith('--- Heute'))).toHaveLength(1)
    expect(rows.slice(-3)).toEqual(['--- Heute · 12.11.2026', 'Donnerstag 00:01', 'Guten Morgen'])
  })

  it('opens no separator for a message without a timestamp', async () => {
    const { container } = await renderConversation([
      HISTORY[3],
      { ...msg('$z', NOW, 'ohne Zeitstempel'), ts: 0 },
    ])

    expect(timeline(container)).toEqual(['--- Gestern · 11.11.2026', 'Mittwoch 23:59', 'ohne Zeitstempel'])
  })

  it('stops saying "Heute" once the day is over, on a page that stayed open', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-11-12T22:59:30Z')) // 12.11. 23:59:30 Berlin
    const { container } = await renderConversation([msg('$n', '2026-11-12T20:00:00Z', 'Abendnachricht')])
    expect(timeline(container)).toEqual(['--- Heute · 12.11.2026', 'Abendnachricht'])

    vi.advanceTimersByTime(60_000) // 13.11. 00:00:30 Berlin, and the page re-reads the clock
    await tick()

    expect(timeline(container)).toEqual(['--- Gestern · 12.11.2026', 'Abendnachricht'])
  })

  it('shows no separator in an empty room', async () => {
    const { container, getByText } = await renderConversation([])

    expect(getByText('Noch keine Nachrichten in diesem Raum.')).toBeTruthy()
    expect(container.querySelector('.chat-body .divider-label')).toBeNull()
  })
})
