import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { CardView } from './types'

vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import BoardColumn from './BoardColumn.svelte'

afterEach(() => cleanup())

const CARD: CardView = {
  id: 'c1',
  stack_id: 's3',
  title: 'Plakate drucken',
  description: null,
  due_date: null,
  label: null,
  sort_order: 0,
  protocol_action_item_id: null,
  created_by: null,
  created_at: new Date('2026-11-01T10:00:00Z'),
  assignee_name: null,
  assignee_id: null,
  is_mine: false,
}

describe('a board column', () => {
  it.each(['Offen', 'In Arbeit', 'Erledigt', 'Veröffentlicht'])('%s: every card has its edit button and opens', async (name) => {
    const onopen = vi.fn()
    render(BoardColumn, { boardId: 'b1', stack: { id: 's3', name }, cards: [CARD], onopen })
    await fireEvent.click(await screen.findByRole('button', { name: 'Karte bearbeiten: Plakate drucken' }))
    expect(onopen).toHaveBeenCalledTimes(1)
    expect(onopen).toHaveBeenCalledWith(CARD)
  })
})
