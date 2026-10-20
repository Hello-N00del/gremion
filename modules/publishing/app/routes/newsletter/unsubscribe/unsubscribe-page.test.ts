// The mailed newsletter link opens this page. Mail-security scanners and prefetchers GET every link in a message, so
// opening the page must not touch the single-use token: GET renders a confirm button and makes no request to the API;
// only the recipient's click POSTs the token (in a JSON body, not in the URL) to /api/newsletter/unsubscribe.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'

const mockPage = vi.hoisted(() => ({ url: new URL('http://localhost/newsletter/unsubscribe?token=tok-123') }))

vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable(mockPage) }
})

import Page from './+page.svelte'

const fetchMock = vi.fn()

function respond(status: number, body: unknown = { ok: status === 200 }) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  mockPage.url = new URL('http://localhost/newsletter/unsubscribe?token=tok-123')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /newsletter/unsubscribe (the page)', () => {
  it('renders the confirm button and makes no request on load: the token is not touched', async () => {
    render(Page)
    await tick()
    expect(screen.getByRole('button', { name: /Abmeldung bestätigen/ })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not claim success before the click', async () => {
    render(Page)
    await tick()
    expect(screen.queryByText(/Erfolgreich abgemeldet/)).toBeNull()
  })

  it('without a token in the link: an error, no confirm button, no request', async () => {
    mockPage.url = new URL('http://localhost/newsletter/unsubscribe')
    render(Page)
    await tick()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/Kein gültiger Token/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('confirming', () => {
  it('POSTs the token in a JSON body to the API, never in the URL, then shows the success state', async () => {
    fetchMock.mockReturnValue(respond(200))
    render(Page)
    await fireEvent.click(screen.getByRole('button', { name: /Abmeldung bestätigen/ }))
    await waitFor(() => expect(screen.getByText(/Erfolgreich abgemeldet/)).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/newsletter/unsubscribe')
    expect(url).not.toContain('tok-123')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-123' })
  })

  it('a second click while the request is in flight does not send a second POST', async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)))
    render(Page)
    const button = screen.getByRole('button', { name: /Abmeldung bestätigen/ })
    await fireEvent.click(button)
    await fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release(new Response('{"ok":true}', { status: 200 }))
    await waitFor(() => expect(screen.getByText(/Erfolgreich abgemeldet/)).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [410, /abgelaufen/],
    [404, /Ungültiger|bereits verwendet/],
    [429, /Zu viele/],
    [503, /nicht verfügbar/],
  ])('a %i answer shows its own message and no success', async (status, message) => {
    fetchMock.mockReturnValue(respond(status, { ok: false }))
    render(Page)
    await fireEvent.click(screen.getByRole('button', { name: /Abmeldung bestätigen/ }))
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy())
    expect(screen.queryByText(/Erfolgreich abgemeldet/)).toBeNull()
  })

  it('a network failure shows an error', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    render(Page)
    await fireEvent.click(screen.getByRole('button', { name: /Abmeldung bestätigen/ }))
    await waitFor(() => expect(screen.getByText(/Netzwerkfehler/)).toBeTruthy())
  })
})
