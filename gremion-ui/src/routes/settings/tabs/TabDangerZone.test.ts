import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'

// F1-FIX-10-K / K2#9: the reset button PATCHed a hard-coded finance/elections
// module set (modules the kernel no longer ships) and only merged; the "Alle
// Daten löschen" dialog collected an admin password for an endpoint that always
// answers 501. Reset is a server action now; the dead wipe dialog is gone.
import TabDangerZone from './TabDangerZone.svelte'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TabDangerZone.svelte (K2#9)', () => {
  it('has no wipe button or password field for an action that is not implemented', () => {
    const { container } = render(TabDangerZone)
    expect(screen.queryByRole('button', { name: /Alle Daten löschen/ })).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    // the explanation of the real path stays
    expect(container.textContent).toMatch(/Server-CLI/)
  })

  it('resets through the server action, with no module ids in the client request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(TabDangerZone)

    await fireEvent.click(screen.getByRole('button', { name: 'Konfiguration zurücksetzen' }))
    await fireEvent.input(screen.getByLabelText(/Bestätigung/), { target: { value: 'ZURÜCKSETZEN' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/reset')
    expect(init.method).toBe('POST')
    const sent = typeof init.body === 'string' ? init.body : ''
    expect(sent).not.toMatch(/finance|elections/)
    expect(JSON.parse(sent)).toEqual({ confirm: 'ZURÜCKSETZEN' })
    expect(await screen.findByText('Konfiguration zurückgesetzt.')).toBeTruthy()
  })

  it('shows the server error instead of a success message when the reset fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'Zurücksetzen fehlgeschlagen.' }), { status: 500 })),
    )
    render(TabDangerZone)
    await fireEvent.click(screen.getByRole('button', { name: 'Konfiguration zurücksetzen' }))
    await fireEvent.input(screen.getByLabelText(/Bestätigung/), { target: { value: 'ZURÜCKSETZEN' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }))
    expect(await screen.findByText('Zurücksetzen fehlgeschlagen.')).toBeTruthy()
    expect(screen.queryByText('Konfiguration zurückgesetzt.')).toBeNull()
  })
})
