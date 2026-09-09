import { describe, test, expect, vi, beforeEach } from 'vitest'
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
  test('renders nothing while closed and the dialog once open', () => {
    const { queryByRole, rerender, getByRole } = render(CommandPalette, {
      props: { open: false, nav }
    })
    expect(queryByRole('dialog')).toBeNull()
    rerender({ open: true, nav })
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
    const input = getByLabelText('Suche … Antrag, Datei, Person') as HTMLInputElement
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

  test('shows the stubbed Personen section (people search not wired yet)', () => {
    const { getByText } = render(CommandPalette, { props: { open: true, nav } })
    expect(getByText('Personen — folgt')).toBeTruthy()
  })
})
