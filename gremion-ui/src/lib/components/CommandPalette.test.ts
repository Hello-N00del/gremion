import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import type { NavItem } from '$lib/components/layout/nav-schema'

// goto is the navigation side-effect we assert on. Mock before importing the
// component so the module picks up the stub.
const gotoMock = vi.fn((_url: string) => Promise.resolve())
vi.mock('$app/navigation', () => ({
  goto: (url: string) => gotoMock(url)
}))

// The theme store touches localStorage at import time; jsdom's localStorage is
// not wired in this config, so stub the store (same pattern as
// topbar-call-chip.test.ts). The "Theme wechseln" action isn't under test here.
vi.mock('$lib/stores/theme', async () => {
  const { writable } = await import('svelte/store')
  return { themeMode: writable('light') }
})

import CommandPalette from './CommandPalette.svelte'

const nav: NavItem[] = [
  {
    kind: 'section',
    label: 'Arbeitsbereich',
    children: [
      { kind: 'item', href: '/', label: 'Übersicht', icon: 'home' },
      { kind: 'item', href: '/calendar', label: 'Kalender', icon: 'calendar' },
      { kind: 'item', href: '/messages', label: 'Matrix · Chat', icon: 'chat' }
    ]
  },
  { kind: 'item', href: '/finance', label: 'Finanzen', icon: 'euro' }
]

beforeEach(() => {
  gotoMock.mockClear()
})

describe('CommandPalette', () => {
  test('renders nothing while closed and the dialog once open', async () => {
    const { queryByRole, rerender, getByRole } = render(CommandPalette, {
      props: { open: false, nav }
    })
    expect(queryByRole('dialog')).toBeNull()
    // rerender() is async (awaits Svelte.tick() internally) — awaiting it
    // here (typescript(no-floating-promises)) also guards against reading
    // the DOM before the update has actually flushed.
    await rerender({ open: true, nav })
    expect(getByRole('dialog')).toBeTruthy()
  })

  test('lists the role-filtered pages under the Seiten section', () => {
    const { getByText } = render(CommandPalette, { props: { open: true, nav } })
    expect(getByText('Seiten')).toBeTruthy()
    expect(getByText('Übersicht')).toBeTruthy()
    expect(getByText('Matrix · Chat')).toBeTruthy()
    expect(getByText('Finanzen')).toBeTruthy()
  })

  test('renders the German quick-action labels under Aktionen', () => {
    // Carve note: the feature-module quick actions (Finanzantrag / Neue
    // Abstimmung / Neue Umfrage) rode out with their modules; the governance-only
    // kernel ships just the theme toggle.
    const { getByText, queryByText } = render(CommandPalette, { props: { open: true, nav } })
    expect(getByText('Aktionen')).toBeTruthy()
    expect(getByText('Theme wechseln')).toBeTruthy()
    expect(queryByText('Finanzantrag stellen')).toBeNull()
    expect(queryByText('Neue Abstimmung')).toBeNull()
  })

  test('fuzzy-filters pages as the user types', async () => {
    const { getByLabelText, queryByText, getByText } = render(CommandPalette, {
      props: { open: true, nav }
    })
    const input = getByLabelText('Suche … Protokoll, Termin, Person') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'kal' } })
    expect(getByText('Kalender')).toBeTruthy()
    // Non-matching page drops out.
    expect(queryByText('Übersicht')).toBeNull()
  })

  test('Enter navigates to the highlighted page (first result by default)', async () => {
    const { getByRole } = render(CommandPalette, { props: { open: true, nav } })
    const dialog = getByRole('dialog')
    await fireEvent.keyDown(dialog, { key: 'Enter' })
    // First page in the flat list is "/" (Übersicht).
    expect(gotoMock).toHaveBeenCalledWith('/')
  })

  test('ArrowDown then Enter navigates to the next page', async () => {
    const { getByRole } = render(CommandPalette, { props: { open: true, nav } })
    const dialog = getByRole('dialog')
    await fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    await fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(gotoMock).toHaveBeenCalledWith('/calendar')
  })

  test('Escape closes the palette (open becomes false → dialog unmounts)', async () => {
    const { getByRole, queryByRole } = render(CommandPalette, {
      props: { open: true, nav }
    })
    const dialog = getByRole('dialog')
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(queryByRole('dialog')).toBeNull()
  })

  test('shows no "folgt" placeholder: people are searched now', () => {
    const { queryByText, container } = render(CommandPalette, { props: { open: true, nav } })
    expect(queryByText(/folgt/)).toBeNull()
    expect(container.textContent).not.toContain('Personen')
  })
})

// The server-side search: minutes, events, units and people next to the pages.
describe('CommandPalette search results', () => {
  const MINUTES = { id: 'p1', label: 'Haushaltsplan 2026', hint: '12.05.2026 · Finanzen', href: '/members/committees/u1/protokolle/p1' }
  const EVENT = { id: 'e1', label: 'Plenum Juni', hint: '20.06.2026', href: '/calendar?date=2026-06-20' }
  const UNIT = { id: 'u1', label: 'Finanzen', hint: null, href: '/members/committees/u1' }
  const PERSON = { id: 'mira', label: 'Mira Kowalski', hint: 'Finanzen', href: '/members?member=mira' }
  const none = { minutes: [], events: [], units: [], people: [] }

  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function answer(data: Record<string, unknown>) {
    return Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }))
  }

  async function type(input: HTMLElement, value: string) {
    await fireEvent.input(input, { target: { value } })
    await vi.advanceTimersByTimeAsync(300)
  }

  test('asks nothing for fewer than two characters', async () => {
    const { getByLabelText } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'h')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('asks the search endpoint once after the typing pauses, with the typed text', async () => {
    fetchMock.mockImplementation(() => answer(none))
    const { getByLabelText } = render(CommandPalette, { props: { open: true, nav } })
    const input = getByLabelText('Suche … Protokoll, Termin, Person')
    await fireEvent.input(input, { target: { value: 'ha' } })
    await fireEvent.input(input, { target: { value: 'haus' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=haus')
  })

  test('lists minutes, events, units and people under their own headings, with hints', async () => {
    fetchMock.mockImplementation(() => answer({ minutes: [MINUTES], events: [EVENT], units: [UNIT], people: [PERSON] }))
    const { getByLabelText, getByText } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'plan')
    for (const heading of ['Protokolle', 'Termine', 'Gremien', 'Personen']) expect(getByText(heading)).toBeTruthy()
    for (const text of ['Haushaltsplan 2026', '12.05.2026 · Finanzen', 'Plenum Juni', '20.06.2026', 'Mira Kowalski']) {
      expect(getByText(text)).toBeTruthy()
    }
  })

  test('two results that share a link and an id kind do not collide (no duplicate keys)', async () => {
    const a = { id: 'e1', label: 'Plenum A', hint: '20.06.2026', href: '/calendar?date=2026-06-20' }
    const b = { id: 'e2', label: 'Plenum B', hint: '20.06.2026', href: '/calendar?date=2026-06-20' }
    fetchMock.mockImplementation(() => answer({ ...none, events: [a, b] }))
    const { getByLabelText, getByText } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'plenum')
    expect(getByText('Plenum A')).toBeTruthy()
    expect(getByText('Plenum B')).toBeTruthy()
  })

  test('a found item joins the keyboard list: Enter opens it when no page or action matches', async () => {
    fetchMock.mockImplementation(() => answer({ ...none, people: [PERSON] }))
    const { getByLabelText, getByRole } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'mira')
    const dialog = getByRole('dialog')
    // Nothing of nav or actions matches "mira": the person is the only (first) row.
    await fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(gotoMock).toHaveBeenCalledWith('/members?member=mira')
  })

  test('clicking a found item opens it', async () => {
    fetchMock.mockImplementation(() => answer({ ...none, minutes: [MINUTES] }))
    const { getByLabelText, getByText } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'haushalt')
    await fireEvent.click(getByText('Haushaltsplan 2026'))
    expect(gotoMock).toHaveBeenCalledWith('/members/committees/u1/protokolle/p1')
  })

  test('a failed search keeps the page matches and shows no error text', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 })))
    const { getByLabelText, getByText, queryByText } = render(CommandPalette, { props: { open: true, nav } })
    await type(getByLabelText('Suche … Protokoll, Termin, Person'), 'kal')
    expect(getByText('Kalender')).toBeTruthy()
    expect(queryByText(/boom/)).toBeNull()
  })

  test('a slower answer to an older query never replaces the newer one', async () => {
    let releaseOld!: (r: Response) => void
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((res) => (releaseOld = res)))
      .mockImplementationOnce(() => answer({ ...none, people: [PERSON] }))
    const { getByLabelText, queryByText, getByText } = render(CommandPalette, { props: { open: true, nav } })
    const input = getByLabelText('Suche … Protokoll, Termin, Person')
    await type(input, 'ha')
    await type(input, 'mira')
    expect(getByText('Mira Kowalski')).toBeTruthy()
    releaseOld(new Response(JSON.stringify({ success: true, data: { ...none, minutes: [MINUTES] } }), { status: 200 }))
    await vi.advanceTimersByTimeAsync(10)
    expect(queryByText('Haushaltsplan 2026')).toBeNull()
    expect(getByText('Mira Kowalski')).toBeTruthy()
  })

  test('clearing the query drops the found items', async () => {
    fetchMock.mockImplementation(() => answer({ ...none, people: [PERSON] }))
    const { getByLabelText, queryByText } = render(CommandPalette, { props: { open: true, nav } })
    const input = getByLabelText('Suche … Protokoll, Termin, Person')
    await type(input, 'mira')
    expect(queryByText('Mira Kowalski')).toBeTruthy()
    await type(input, '')
    expect(queryByText('Mira Kowalski')).toBeNull()
  })
})
