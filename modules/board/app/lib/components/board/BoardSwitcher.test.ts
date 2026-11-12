import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import BoardSwitcher from './BoardSwitcher.svelte'

const OU_A = '11111111-1111-4111-8111-111111111111'
const OU_B = '22222222-2222-4222-8222-222222222222'
const OU_C = '33333333-3333-4333-8333-333333333333'
const BOARDS = [
  { id: 'b1', org_unit_id: OU_A, name: 'Aufgaben', org_unit_name: 'Vorstand' },
  { id: 'b2', org_unit_id: OU_B, name: 'Aufgaben', org_unit_name: 'Finanzausschuss' },
  { id: 'b3', org_unit_id: OU_C, name: 'Sommerfest', org_unit_name: 'Kulturreferat' },
]

afterEach(cleanup)

describe('the board switcher', () => {
  it('tells two boards with the same title apart by their committee', () => {
    render(BoardSwitcher, { boards: BOARDS, selectedId: 'b1', onselect: vi.fn() })
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual([
      'Aufgaben · Vorstand',
      'Aufgaben · Finanzausschuss',
      'Sommerfest',
    ])
    // no two chips read the same
    expect(screen.queryByRole('button', { name: 'Aufgaben' })).toBeNull()
  })

  it('marks the open board and opens another one on click', async () => {
    const onselect = vi.fn()
    render(BoardSwitcher, { boards: BOARDS, selectedId: 'b1', onselect })
    expect(screen.getByRole('button', { name: 'Aufgaben · Vorstand' })).toHaveClass('on')
    const other = screen.getByRole('button', { name: 'Aufgaben · Finanzausschuss' })
    expect(other).not.toHaveClass('on')
    await fireEvent.click(other)
    expect(onselect).toHaveBeenCalledExactlyOnceWith('b2')
  })

  it('shows a single board by its title alone', () => {
    render(BoardSwitcher, { boards: [BOARDS[0]], selectedId: 'b1', onselect: vi.fn() })
    expect(screen.getByRole('button', { name: 'Aufgaben' })).toBeInTheDocument()
  })
})
