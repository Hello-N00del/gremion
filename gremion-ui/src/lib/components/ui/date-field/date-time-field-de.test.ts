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

describe('DateTimeFieldDe, values that bypass the typing', () => {
  it('can be typed on a phone keyboard: the text input does not ask for the digits-only keypad', () => {
    render(Harness, { props: { initial: '', dateOnly: true } })
    // inputmode="numeric" has no '.', ' ' or ':' key on iOS
    expect(text().getAttribute('inputmode')).toBe('text')
  })

  it('limits the native picker to the years the field accepts', () => {
    const { unmount } = render(Harness, { props: { initial: '', dateOnly: true } })
    expect(picker('date').min).toBe('1000-01-01')
    expect(picker('date').max).toBe('9999-12-31')
    unmount()
    render(Harness, { props: { initial: '', dateOnly: false } })
    expect(picker('datetime-local').min).toBe('1000-01-01T00:00')
    expect(picker('datetime-local').max).toBe('9999-12-31T23:59')
  })

  it('treats a picked day below the year 1000 like a typed one: empty value and the format hint', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    const native = picker('date')
    native.value = '0999-01-01'
    await fireEvent.change(native)
    expect(bound()).toBe('')
    expect(text().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('status').textContent?.trim()).toBe('Bitte im Format TT.MM.JJJJ eingeben.')
  })

  it('treats a picked date and time below the year 1000 like a typed one', async () => {
    render(Harness, { props: { initial: '2026-11-05T09:30', dateOnly: false } })
    const native = picker('datetime-local')
    native.value = '0999-01-01T10:00'
    await fireEvent.change(native)
    expect(bound()).toBe('')
    expect(text().getAttribute('aria-invalid')).toBe('true')
  })

  it('still takes a valid picked date and time', async () => {
    render(Harness, { props: { initial: '', dateOnly: false } })
    const native = picker('datetime-local')
    native.value = '2028-02-29T18:45'
    await fireEvent.change(native)
    expect(text().value).toBe('29.02.2028 18:45')
    expect(bound()).toBe('2028-02-29T18:45')
  })

  it('does not hold a value set from outside that the field would refuse to type', async () => {
    render(Harness, { props: { initial: '2026-11-05', dateOnly: true } })
    await fireEvent.click(screen.getByRole('button', { name: 'ungültig von außen setzen' }))
    await tick()
    expect(bound()).toBe('')
    // shown, not blank: the person sees what is wrong
    expect(text().value).toBe('0999-01-01')
    expect(text().getAttribute('aria-invalid')).toBe('true')
  })

  it('does not hold a value that merely looks empty (a day without time in a date-and-time field)', async () => {
    render(Harness, { props: { initial: '2026-11-05T09:30', dateOnly: false } })
    await fireEvent.click(screen.getByRole('button', { name: 'von außen setzen' }))
    await tick()
    expect(text().value).not.toBe('')
    expect(bound()).toBe('')
    expect(text().getAttribute('aria-invalid')).toBe('true')
  })

  it('does not start with an initial value the field would refuse to type', () => {
    render(Harness, { props: { initial: '0999-01-01', dateOnly: true } })
    expect(bound()).toBe('')
    expect(text().value).toBe('0999-01-01')
    expect(text().getAttribute('aria-invalid')).toBe('true')
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
