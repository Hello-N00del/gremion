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

  it('on a phone folds them into ONE row: a select to choose the body and a button to create', () => {
    stubViewport(true)
    render(BoardCreate, { units: UNITS, busy: false, oncreate: vi.fn() })
    expect(createButtons()).toHaveLength(0)
    const control = screen.getByRole('combobox', { name: 'Gremium für das neue Board' })
    expect([...(control as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual([
      'Gremium wählen …',
      'StuRa',
      'Vorstand',
      'Fachschaftsrat Informatik',
    ])
    // not one button per body
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('choosing a body in the phone select creates nothing (arrowing through the list is not a decision)', async () => {
    stubViewport(true)
    const oncreate = vi.fn()
    render(BoardCreate, { units: UNITS, busy: false, oncreate })
    const control = screen.getByRole('combobox', { name: 'Gremium für das neue Board' }) as HTMLSelectElement
    await fireEvent.change(control, { target: { value: 'ou-2' } })
    expect(oncreate).not.toHaveBeenCalled()
  })

  it('the phone button stays disabled until a body is chosen', async () => {
    stubViewport(true)
    render(BoardCreate, { units: UNITS, busy: false, oncreate: vi.fn() })
    expect(screen.getByRole('button', { name: 'Board anlegen' })).toBeDisabled()
    await fireEvent.change(screen.getByRole('combobox', { name: 'Gremium für das neue Board' }), { target: { value: 'ou-1' } })
    expect(screen.getByRole('button', { name: 'Board anlegen' })).toBeEnabled()
  })

  it('creates the board of the chosen body when the phone button is pressed, then resets the select', async () => {
    stubViewport(true)
    const oncreate = vi.fn()
    render(BoardCreate, { units: UNITS, busy: false, oncreate })
    const control = screen.getByRole('combobox', { name: 'Gremium für das neue Board' }) as HTMLSelectElement
    await fireEvent.change(control, { target: { value: 'ou-2' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Board anlegen' }))
    expect(oncreate).toHaveBeenCalledTimes(1)
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
    expect(screen.getByRole('combobox', { name: 'Gremium für das neue Board' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Board anlegen' })).toBeDisabled()
  })
})
