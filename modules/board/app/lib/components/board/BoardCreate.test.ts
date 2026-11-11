import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import BoardCreate from './BoardCreate.svelte'

const UNITS = [
  { id: 'ou-1', name: 'StuRa' },
  { id: 'ou-2', name: 'Vorstand' },
  { id: 'ou-3', name: 'Fachschaftsrat Informatik' },
]

// jsdom has no matchMedia; the component asks for the shell's phone breakpoint (the drawer layout).
function stubViewport(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: narrow && query.includes('not all and'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  )
}

beforeEach(() => stubViewport(false))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const createButtons = () => screen.queryAllByRole('button', { name: /^Board für .* anlegen$/ })

describe('creating a board', () => {
  it('on a wide screen keeps one button per body', () => {
    render(BoardCreate, { units: UNITS, busy: false, oncreate: vi.fn() })
    expect(createButtons().map((b) => b.textContent?.trim())).toEqual([
      'Board für StuRa anlegen',
      'Board für Vorstand anlegen',
      'Board für Fachschaftsrat Informatik anlegen',
    ])
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('on a phone folds them into ONE control named "Board anlegen"', () => {
    stubViewport(true)
    render(BoardCreate, { units: UNITS, busy: false, oncreate: vi.fn() })
    expect(createButtons()).toHaveLength(0)
    const control = screen.getByRole('combobox', { name: 'Board anlegen' })
    expect([...(control as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual([
      'Board anlegen …',
      'Board für StuRa',
      'Board für Vorstand',
      'Board für Fachschaftsrat Informatik',
    ])
    // one control in total, not one per body
    expect(screen.getAllByRole('combobox').length + screen.queryAllByRole('button').length).toBe(1)
  })

  it('creates the board of the body picked in the phone control, then resets it', async () => {
    stubViewport(true)
    const oncreate = vi.fn()
    render(BoardCreate, { units: UNITS, busy: false, oncreate })
    const control = screen.getByRole('combobox', { name: 'Board anlegen' }) as HTMLSelectElement
    await fireEvent.change(control, { target: { value: 'ou-2' } })
    expect(oncreate).toHaveBeenCalledWith('ou-2')
    expect(control.value).toBe('')
  })

  it('on a phone with a single body shows that one button, which is still a single control', () => {
    stubViewport(true)
    render(BoardCreate, { units: [UNITS[0]], busy: false, oncreate: vi.fn() })
    expect(createButtons()).toHaveLength(1)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('a wide button creates that body\'s board', async () => {
    const oncreate = vi.fn()
    render(BoardCreate, { units: UNITS, busy: false, oncreate })
    await fireEvent.click(screen.getByRole('button', { name: 'Board für Vorstand anlegen' }))
    expect(oncreate).toHaveBeenCalledWith('ou-2')
  })

  it('disables every control while a create is running', () => {
    stubViewport(true)
    render(BoardCreate, { units: UNITS, busy: true, oncreate: vi.fn() })
    expect(screen.getByRole('combobox', { name: 'Board anlegen' })).toBeDisabled()
  })
})
