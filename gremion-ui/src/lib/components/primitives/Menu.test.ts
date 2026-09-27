// primitives/Menu: WAI-ARIA APG menu button pattern on Bits UI.
// TASK-082 brief section 6 item 5: arrows, Enter/Space, Escape, typeahead.
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'

import Menu from './Menu.svelte'
import { installDomShims } from './__tests__/dom-shims'

installDomShims()

const make = () => {
  const calls: string[] = []
  const items = [
    { id: 'edit', label: 'Bearbeiten', onSelect: vi.fn(() => calls.push('edit')) },
    { id: 'copy', label: 'Duplizieren', onSelect: vi.fn(() => calls.push('copy')) },
    { id: 'cancel', label: 'Absagen', onSelect: vi.fn(() => calls.push('cancel')) },
  ]
  return { calls, items }
}

beforeEach(() => {
  document.body.style.pointerEvents = ''
})

const button = () => screen.getByRole('button', { name: 'Aktionen' })
const focusedItem = () => (document.activeElement?.getAttribute('role') === 'menuitem' ? document.activeElement : null)

describe('primitives/Menu', () => {
  test('the trigger is a collapsed menu button', () => {
    const { items } = make()
    render(Menu, { props: { triggerLabel: 'Aktionen', items } })
    expect(button()).toHaveAttribute('aria-haspopup', 'menu')
    expect(button()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('Enter opens the menu with focus on the first item; ArrowDown/ArrowUp move focus between items', async () => {
    const user = userEvent.setup()
    const { items } = make()
    render(Menu, { props: { triggerLabel: 'Aktionen', items } })
    button().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(button()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual(['Bearbeiten', 'Duplizieren', 'Absagen'])
    await waitFor(() => expect(focusedItem()?.textContent?.trim()).toBe('Bearbeiten'))
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(focusedItem()?.textContent?.trim()).toBe('Duplizieren'))
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(focusedItem()?.textContent?.trim()).toBe('Bearbeiten'))
  })

  test('Enter on an item runs its onSelect, closes the menu and returns focus to the button', async () => {
    const user = userEvent.setup()
    const { items, calls } = make()
    render(Menu, { props: { triggerLabel: 'Aktionen', items } })
    button().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(focusedItem()).not.toBeNull())
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(focusedItem()?.textContent?.trim()).toBe('Duplizieren'))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(calls).toEqual(['copy'])
    await waitFor(() => expect(document.activeElement).toBe(button()))
  })

  test('Space opens it too; Escape closes without selecting and returns focus to the button', async () => {
    const user = userEvent.setup()
    const { items, calls } = make()
    render(Menu, { props: { triggerLabel: 'Aktionen', items } })
    button().focus()
    await user.keyboard(' ')
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(calls).toEqual([])
    await waitFor(() => expect(document.activeElement).toBe(button()))
  })

  test('typeahead: typing a letter moves focus to the next item starting with it', async () => {
    const user = userEvent.setup()
    const { items } = make()
    render(Menu, { props: { triggerLabel: 'Aktionen', items } })
    button().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(focusedItem()).not.toBeNull())
    await user.keyboard('a')
    await waitFor(() => expect(focusedItem()?.textContent?.trim()).toBe('Absagen'))
  })
})
