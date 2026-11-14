// The /votes detail panel loads a poll's options on click. A failed load must end in an error with a
// retry, never in a note that says "Optionen werden geladen…" for ever, and must not hammer the endpoint.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'

vi.mock('$env/dynamic/public', () => ({ env: {} }))
vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('http://localhost/votes') } }))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }))

const { default: Page } = await import('./+page.svelte')

const pollItem = {
  id: 'poll:7',
  kind: 'poll',
  lifecycle: 'open',
  title: 'Sommerfest',
  description: '',
  turnout: 0,
  quorum: 0,
  voterCount: 0,
  castVotes: 0,
  opens: '',
  closes: '2026-11-11T22:59:59.000Z',
  degraded: false,
}

function data(over: Record<string, unknown> = {}) {
  return { votes: [pollItem], pollErrors: null, heliosStatus: null, electionsEnabled: false, isManager: false, retainedRecords: [], ...over } as never
}

const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) })

describe('/votes poll options', () => {
  const mockFetch = vi.fn()
  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })
  afterEach(() => vi.unstubAllGlobals())

  test('a failed options request shows an error with a retry, and asks only once', async () => {
    // A pending answer from the 4th call on, so a retry storm fails the count below instead of spinning the runner.
    mockFetch.mockImplementation(() => (mockFetch.mock.calls.length > 3 ? new Promise(() => {}) : Promise.resolve(answer(502, { message: 'down' }))))
    const { findByTestId, container } = render(Page, { props: { data: data() } })
    expect(await findByTestId('poll-options-error')).toBeTruthy()
    expect(container.textContent).not.toContain('Optionen werden geladen')
    expect(container.textContent).toContain('konnten nicht geladen werden')
    // The failure must settle: no second request without a click on the retry.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('a thrown network error ends in the same error state', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const { findByTestId } = render(Page, { props: { data: data() } })
    expect(await findByTestId('poll-options-error')).toBeTruthy()
  })

  test('the retry asks again and shows the options when the second request succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(answer(502, {}))
      .mockResolvedValueOnce(answer(200, { options: [{ label: 'Ja', votes: 3 }, { label: 'Nein', votes: 1 }] }))
    const { findByTestId, container, queryByTestId } = render(Page, { props: { data: data() } })
    await fireEvent.click(await findByTestId('poll-options-retry'))
    await waitFor(() => expect(container.textContent).toContain('Ja'))
    expect(container.textContent).toContain('Nein')
    expect(queryByTestId('poll-options-error')).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test('a successful first request shows the options without any error', async () => {
    mockFetch.mockResolvedValue(answer(200, { options: [{ label: 'Ja', votes: 3 }] }))
    const { container, queryByTestId } = render(Page, { props: { data: data() } })
    await waitFor(() => expect(container.textContent).toContain('Ja'))
    expect(queryByTestId('poll-options-error')).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
