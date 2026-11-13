import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import TabGeneral from './TabGeneral.svelte'

const ORG = { name: 'Studierendenrat', domain: 'x.example.org', logo_path: null }

let fetchMock: ReturnType<typeof vi.fn>
const sent = () => JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body)) as Record<string, unknown>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const winter = () => screen.getByLabelText('Wintersemester beginnt im') as HTMLSelectElement
const summer = () => screen.getByLabelText('Sommersemester beginnt im') as HTMLSelectElement
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

describe('TabGeneral — semester start months', () => {
  it('shows the stored months, and a save sends them with the name (the months are not dropped)', async () => {
    render(TabGeneral, { props: { org: ORG, termMonths: { winter: 10, summer: 4 } } })
    expect(winter().value).toBe('10')
    expect(summer().value).toBe('4')
    await save()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sent().brand).toEqual({ term_months: { winter: 10, summer: 4 } })
    expect((sent().org as { name: string }).name).toBe('Studierendenrat')
  })

  it('a customer without months starts unset: a save sends no brand key, so it cannot invent months', async () => {
    render(TabGeneral, { props: { org: ORG, termMonths: null } })
    expect(winter().value).toBe('')
    expect(summer().value).toBe('')
    await save()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect('brand' in sent()).toBe(false)
  })

  it('choosing both months sends them', async () => {
    render(TabGeneral, { props: { org: ORG, termMonths: null } })
    await fireEvent.change(winter(), { target: { value: '9' } })
    await fireEvent.change(summer(), { target: { value: '3' } })
    await save()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sent().brand).toEqual({ term_months: { winter: 9, summer: 3 } })
  })

  it('equal months, or only one of the two, is refused on the form and nothing is sent', async () => {
    render(TabGeneral, { props: { org: ORG, termMonths: { winter: 10, summer: 4 } } })
    await fireEvent.change(summer(), { target: { value: '10' } })
    await save()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Semester/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('one month chosen without the other is refused', async () => {
    render(TabGeneral, { props: { org: ORG, termMonths: null } })
    await fireEvent.change(winter(), { target: { value: '10' } })
    await save()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Semester/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
