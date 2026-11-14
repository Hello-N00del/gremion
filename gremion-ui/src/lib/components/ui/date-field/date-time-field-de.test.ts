// The German date field: the text is German order, the bound value stays ISO.
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import Harness from './fixtures/DateFieldFixture.svelte'

const text = () => screen.getByLabelText('Stichtag') as HTMLInputElement
const bound = () => screen.getByTestId('bound').textContent
const picker = (type: string) => document.querySelector<HTMLInputElement>(`input[type="${type}"]`)!

describe('DateTimeFieldDe, a day without a time', () => {
  it('shows the ISO value in German order in a text field', () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    expect(text().type).toBe('text')
    expect(text().value).toBe('05.11.2026')
    expect(text().placeholder).toBe('TT.MM.JJJJ')
    expect(bound()).toBe('2026-11-05')
  })

  it('binds the ISO date for a typed German date and tidies the text on leaving the field', async () => {
    render(Harness, { props: { initial: '', dateOnly: true } })
    await fireEvent.input(text(), { target: { value: '5.1.2030' } })
    expect(bound()).toBe('2030-01-05')
    expect(text().getAttribute('aria-invalid')).toBeNull()
    await fireEvent.blur(text())
    expect(text().value).toBe('05.01.2030')
  })

  it('binds an empty value and explains the format while the text is not a German date', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    await fireEvent.input(text(), { target: { value: '11/05/2026' } })
    expect(bound()).toBe('')
    expect(text().getAttribute('aria-invalid')).toBe('true')
    const hint = screen.getByRole('status')
    expect(hint.textContent?.trim()).toBe('Bitte im Format TT.MM.JJJJ eingeben.')
    expect(text().getAttribute('aria-describedby')).toBe(hint.id)
    // the typed text stays for correction
    await fireEvent.blur(text())
    expect(text().value).toBe('11/05/2026')
  })

  it('shows no hint for an empty field', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    await fireEvent.input(text(), { target: { value: '' } })
    expect(bound()).toBe('')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('takes a day chosen in the native picker, which stays out of the tab order and the accessibility tree', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    const native = picker('date')
    expect(native.getAttribute('aria-hidden')).toBe('true')
    expect(native.tabIndex).toBe(-1)
    expect(screen.getByRole('button', { name: 'Stichtag im Kalender wählen' })).toBeTruthy()
    native.value = '2028-02-29'
    await fireEvent.change(native)
    expect(text().value).toBe('29.02.2028')
    expect(bound()).toBe('2028-02-29')
  })

  it('shows a value that was set from outside', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    await fireEvent.click(screen.getByRole('button', { name: 'von außen setzen' }))
    await tick()
    expect(text().value).toBe('24.12.2031')
    expect(bound()).toBe('2031-12-24')
  })
})

describe('DateTimeFieldDe, a day with a time', () => {
  it('shows and binds date and time', async () => {
    render(Harness, { props: { initial: '2026-11-05T09:30', dateOnly: false } })
    expect(text().value).toBe('05.11.2026 09:30')
    expect(text().placeholder).toBe('TT.MM.JJJJ HH:MM')
    expect(picker('datetime-local')).toBeTruthy()
    await fireEvent.input(text(), { target: { value: '24.12.2031 18:45' } })
    expect(bound()).toBe('2031-12-24T18:45')
    await fireEvent.input(text(), { target: { value: '24.12.2031' } })
    expect(bound()).toBe('')
    expect(screen.getByRole('status').textContent?.trim()).toBe('Bitte im Format TT.MM.JJJJ HH:MM eingeben.')
  })
})
