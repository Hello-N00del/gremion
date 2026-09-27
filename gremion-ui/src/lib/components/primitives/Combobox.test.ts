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

  // Round-3 regressions (house HIGH, verifier STALE-1/STALE-2): the input text
  // must be a function of `value`, never a one-shot copy taken at mount.
  const hidden = () => document.querySelector('input[name="referat"]') as HTMLInputElement | null

  test('STALE-1: clicking the selected option deselects it and clears the input text with the posted value', async () => {
    const user = userEvent.setup()
    render(Combobox, { props: { ...props, name: 'referat' } })
    await user.click(input())
    await user.keyboard('finanz')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Finanzreferat' })).toBeTruthy())
    await user.click(screen.getByRole('option', { name: 'Finanzreferat' }))
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('Finanzreferat')
    expect(hidden()?.value).toBe('fin')
    await user.click(screen.getByRole('button', { name: 'Vorschläge anzeigen' }))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Finanzreferat' })).toBeTruthy())
    await user.click(screen.getByRole('option', { name: 'Finanzreferat' }))
    await waitFor(() => expect(hidden()?.value).toBe(''))
    expect((input() as HTMLInputElement).value).toBe('')
  })

  test('STALE-2: a value set by the parent after mount shows its label in the input', async () => {
    const { rerender } = render(Combobox, { props: { ...props, name: 'referat' } })
    expect((input() as HTMLInputElement).value).toBe('')
    await rerender({ ...props, name: 'referat', value: 'hopo' })
    await waitFor(() => expect((input() as HTMLInputElement).value).toBe('Hochschulpolitik'))
    expect(hidden()?.value).toBe('hopo')
    await rerender({ ...props, name: 'referat', value: '' })
    await waitFor(() => expect((input() as HTMLInputElement).value).toBe(''))
  })

  test('options that arrive after mount label the already-set value', async () => {
    const { rerender } = render(Combobox, { props: { ...props, options: [], value: 'kultur' } })
    expect((input() as HTMLInputElement).value).toBe('')
    await rerender({ ...props, options, value: 'kultur' })
    await waitFor(() => expect((input() as HTMLInputElement).value).toBe('Kulturreferat'))
  })

  test('closing without a new selection restores the selected label over the typed text', async () => {
    const user = userEvent.setup()
    render(Combobox, { props: { ...props, value: 'fin' } })
    expect((input() as HTMLInputElement).value).toBe('Finanzreferat')
    await user.clear(input())
    await user.keyboard('hoch')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('Finanzreferat')
  })
})
