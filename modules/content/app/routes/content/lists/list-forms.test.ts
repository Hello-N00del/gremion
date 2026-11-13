import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import ListsPage from './+page.svelte'
import MembersPage from './[id]/+page.svelte'

// Typing into a field and pressing Enter must do what the button does. A browser turns Enter in a
// text input into a submit of the enclosing form, so the inputs and the button must sit in a form
// whose submit handler creates the list / adds the member.

afterEach(() => vi.unstubAllGlobals())

function okFetch() {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Verteilerlisten (content) — new list name', () => {
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
    expect(url).toBe('/api/content/lists')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Fachschaften' })
  })
})

describe('Verteilerliste (content) — add member', () => {
  it('sits in a form, so Enter in the address field adds the member', async () => {
    const fetchMock = okFetch()
    const { getByPlaceholderText } = render(MembersPage, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { list: { id: 'l1', name: 'V' }, members: [] } } as any,
    })
    const input = getByPlaceholderText('E-Mail') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'a@example.org' } })
    expect(input.form).not.toBeNull()
    await fireEvent.submit(input.form!)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('/api/content/lists/l1/members')
  })
})
