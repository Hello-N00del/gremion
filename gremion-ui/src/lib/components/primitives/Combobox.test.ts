// primitives/Combobox: WAI-ARIA APG combobox with a listbox popup (list
// autocomplete) on Bits UI. TASK-082 brief section 6 item 5.
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'

import Combobox from './Combobox.svelte'
import { installDomShims } from './__tests__/dom-shims'

installDomShims()

const options = [
  { value: 'fin', label: 'Finanzreferat' },
  { value: 'hopo', label: 'Hochschulpolitik' },
  { value: 'kultur', label: 'Kulturreferat' },
  { value: 'soz', label: 'Sozialreferat' },
]
const props = {
  label: 'Referat',
  placeholder: 'Referat suchen',
  toggleLabel: 'Vorschläge anzeigen',
  emptyText: 'Keine Treffer',
  options,
}

beforeEach(() => {
  document.body.style.pointerEvents = ''
})

const input = () => screen.getByRole('combobox', { name: 'Referat' })
const highlighted = () => document.querySelector('[role="option"][data-highlighted]')

describe('primitives/Combobox', () => {
  test('the input is a collapsed combobox named by its visible label', () => {
    render(Combobox, { props })
    const cb = input()
    expect(cb.tagName).toBe('INPUT')
    expect(cb).toHaveAttribute('aria-expanded', 'false')
    expect(cb).toHaveAttribute('placeholder', 'Referat suchen')
    expect(screen.getByRole('button', { name: 'Vorschläge anzeigen' })).toBeTruthy()
  })

  test('typing opens the listbox and filters the options (list autocomplete)', async () => {
    const user = userEvent.setup()
    render(Combobox, { props })
    await user.click(input())
    await user.keyboard('ref')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    const names = screen.getAllByRole('option').map((o) => o.textContent?.trim())
    expect(names).toEqual(['Finanzreferat', 'Kulturreferat', 'Sozialreferat'])
  })

  test('ArrowDown/ArrowUp move the highlight while focus stays in the input; Enter selects', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(Combobox, { props: { ...props, onValueChange } })
    await user.click(input())
    await user.keyboard('referat')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(highlighted()).not.toBeNull())
    const first = highlighted()?.textContent
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(highlighted()?.textContent).not.toBe(first))
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(highlighted()?.textContent).toBe(first))
    expect(document.activeElement).toBe(input())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(options.map((o) => o.value)).toContain(onValueChange.mock.calls[0][0])
    expect((input() as HTMLInputElement).value).toBe(first?.trim())
  })

  test('Escape closes the listbox and keeps focus in the input', async () => {
    const user = userEvent.setup()
    render(Combobox, { props })
    await user.click(input())
    await user.keyboard('hoch')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(input())
  })

  test('no match shows the emptyText prop instead of an empty listbox', async () => {
    const user = userEvent.setup()
    render(Combobox, { props })
    await user.click(input())
    await user.keyboard('zzz')
    await waitFor(() => expect(screen.getByText('Keine Treffer')).toBeTruthy())
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
