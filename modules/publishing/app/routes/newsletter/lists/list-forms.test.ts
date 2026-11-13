import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import ListsPage from './+page.svelte'
import MembersPage from './[id]/+page.svelte'

// Newsletter distribution lists: Enter in the new-list and add-member fields behaves like the
// button; German grammar for the member count; German wording for the source of an address.

afterEach(() => vi.unstubAllGlobals())

function okFetch() {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

type Source = 'manual' | 'csv'
const member = (n: number, source: Source = 'manual') => ({
  id: n,
  email: `person${n}@example.org`,
  name: null,
  source,
})

function renderMembers(members: ReturnType<typeof member>[]) {
  return render(MembersPage, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: { data: { list: { id: 3, name: 'Verteiler' }, members } } as any,
  })
}

describe('Verteilerlisten (newsletter) — new list name', () => {
  it('sits in a form, so Enter submits and creates the list', async () => {
    const fetchMock = okFetch()
    const { getByPlaceholderText } = render(ListsPage, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { lists: [] } } as any,
    })
    const input = getByPlaceholderText('Name der neuen Liste') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'Fachschaften' } })
    expect(input.form).not.toBeNull()
    await fireEvent.submit(input.form!)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/newsletter/lists')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Fachschaften' })
  })
})

describe('Verteilerliste (newsletter) — members', () => {
  it('reads "1 Mitglied" for one, "2 Mitglieder" for two', () => {
    const one = renderMembers([member(1)])
    expect(one.getByRole('heading', { name: /^\d+ Mitglied/ }).textContent?.trim()).toBe('1 Mitglied')
    one.unmount()
    const two = renderMembers([member(1), member(2)])
    expect(two.getByRole('heading', { name: /^\d+ Mitglied/ }).textContent?.trim()).toBe('2 Mitglieder')
  })

  it('shows "(manuell)" for a hand-entered address and "(CSV)" for an imported one', () => {
    const { getByText } = renderMembers([member(1, 'manual'), member(2, 'csv')])
    expect(getByText('(manuell)')).toBeTruthy()
    expect(getByText('(CSV)')).toBeTruthy()
  })

  it('sits the manual add fields in a form, so Enter adds the member', async () => {
    const fetchMock = okFetch()
    const { getByPlaceholderText } = renderMembers([])
    const input = getByPlaceholderText('E-Mail') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'a@example.org' } })
    expect(input.form).not.toBeNull()
    await fireEvent.submit(input.form!)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/newsletter/lists/3/members')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.org' })
  })
})
