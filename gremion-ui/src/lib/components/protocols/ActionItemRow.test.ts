import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import ActionItemRow from './ActionItemRow.svelte'

// E2E finding 17: the checkbox on a minutes action item had no name of its own
// (the task text sits beside it, not in a label) and was announced as "on".

afterEach(cleanup)

const item = { id: 'a1', text: 'Kassenprüfung terminieren', completed: false }

describe('ActionItemRow accessible name', () => {
  it('names the checkbox after the task it completes', () => {
    render(ActionItemRow, { props: { item, isAdmin: false, onSave: () => {}, onToggle: () => {} } })
    expect(screen.getByRole('checkbox', { name: 'Erledigt: Kassenprüfung terminieren' })).toBeTruthy()
  })

  it('reports the toggle for the task it is named after', async () => {
    const onToggle = vi.fn()
    render(ActionItemRow, { props: { item, isAdmin: false, onSave: () => {}, onToggle } })
    await fireEvent.click(screen.getByRole('checkbox', { name: /Kassenprüfung/ }))
    expect(onToggle).toHaveBeenCalledWith('a1', true)
  })
})
