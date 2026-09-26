// primitives/Select: WAI-ARIA APG collapsible listbox (button + listbox) on Bits UI.
// TASK-082 brief section 6 item 5: arrows, Enter/Space, Escape, typeahead.
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'

import Select from './Select.svelte'
import { installDomShims } from './__tests__/dom-shims'

installDomShims()

const options = [
  { value: 'ordentlich', label: 'Ordentliche Sitzung' },
  { value: 'ausserordentlich', label: 'Außerordentliche Sitzung' },
  { value: 'konstituierend', label: 'Konstituierende Sitzung' },
]
const props = { label: 'Sitzungsart', placeholder: 'Bitte wählen', options }

beforeEach(() => {
  document.body.style.pointerEvents = ''
})

const combobox = () => screen.getByRole('button', { name: /^Sitzungsart/ })
const highlighted = () => document.querySelector('[role="option"][data-highlighted]')

describe('primitives/Select', () => {
  test('the trigger is a collapsed listbox button named by the label and the current value', () => {
    render(Select, { props })
    const cb = combobox()
    expect(cb).toHaveAttribute('aria-haspopup', 'listbox')
    expect(cb).toHaveAttribute('aria-expanded', 'false')
    expect(cb).toHaveAccessibleName('Sitzungsart Bitte wählen')
    expect(cb).toHaveTextContent('Bitte wählen')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('Enter opens the listbox; ArrowDown/ArrowUp move the highlight; Enter selects, closes and refocuses the trigger', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(Select, { props: { ...props, onValueChange } })
    combobox().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(combobox()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await waitFor(() => expect(highlighted()).not.toBeNull())
    const first = highlighted()?.textContent
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(highlighted()?.textContent).not.toBe(first))
    expect(highlighted()?.textContent).toContain('Außerordentliche Sitzung')
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(highlighted()?.textContent).toContain('Ordentliche Sitzung'))
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onValueChange).toHaveBeenLastCalledWith('ausserordentlich')
    expect(combobox()).toHaveAccessibleName('Sitzungsart Außerordentliche Sitzung')
    await waitFor(() => expect(document.activeElement).toBe(combobox()))
  })

  test('Space opens it too, and Escape closes without changing the value', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(Select, { props: { ...props, value: 'ordentlich', onValueChange } })
    combobox().focus()
    await user.keyboard(' ')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onValueChange).not.toHaveBeenCalled()
    expect(combobox()).toHaveTextContent('Ordentliche Sitzung')
    await waitFor(() => expect(document.activeElement).toBe(combobox()))
  })

  test('typeahead: typing a label prefix while open highlights the matching option', async () => {
    const user = userEvent.setup()
    render(Select, { props })
    combobox().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    await user.keyboard('k')
    await waitFor(() => expect(highlighted()?.textContent).toContain('Konstituierende Sitzung'))
  })

  test('the selected option is marked aria-selected', async () => {
    const user = userEvent.setup()
    render(Select, { props: { ...props, value: 'konstituierend' } })
    combobox().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const opt = screen.getByRole('option', { name: 'Konstituierende Sitzung' })
    expect(opt).toHaveAttribute('aria-selected', 'true')
  })
})
