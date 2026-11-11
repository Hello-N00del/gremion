import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Card from './Card.svelte'
import type { CardView } from './types'

afterEach(() => cleanup())

const CARD: CardView = {
  id: 'c1',
  stack_id: 's1',
  title: 'Plakate drucken',
  description: 'DIN A2',
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

describe('a task card', () => {
  it('opens its editor when the card is clicked', async () => {
    const onopen = vi.fn()
    render(Card, { card: CARD, onopen })
    await fireEvent.click(screen.getByText('Plakate drucken'))
    expect(onopen).toHaveBeenCalledTimes(1)
    expect(onopen).toHaveBeenCalledWith(CARD)
  })

  it('has a labelled edit button, so the card can be opened without a pointer', async () => {
    const onopen = vi.fn()
    render(Card, { card: CARD, onopen })
    const btn = screen.getByRole('button', { name: 'Karte bearbeiten: Plakate drucken' })
    await fireEvent.click(btn)
    // the button's click and the card's click are one open, not two
    expect(onopen).toHaveBeenCalledTimes(1)
  })

  it('still renders as before when no one listens (no edit button, no error)', () => {
    render(Card, { card: CARD })
    expect(screen.getByText('Plakate drucken')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
