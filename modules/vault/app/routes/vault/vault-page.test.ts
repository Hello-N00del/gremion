import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

// The page reads `page` only through PageTitle (brand for the tab title) and
// navigates only via invalidateAll — stub both so the render is hermetic.
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/vault'), data: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import Page from './+page.svelte'

afterEach(() => {
  vi.unstubAllGlobals()
})

// #405 (design v11) page-data fixture — the shape +page.server.ts ships.
const baseData = {
  units: [{ id: 'ou-1', name: 'Referat Finanzen', kind: 'referat', hue: 210, abbr: 'RF' }],
  items: [
    {
      id: 'v1',
      org_unit_id: 'ou-1',
      name: 'Sparkasse Online-Banking',
      username: 'stura.finanzen',
      url: null,
      created: '12.03.2026',
      createdByName: 'Ben Hoffmann',
    },
  ],
  handoverRefs: { v1: ['Finanzen'] } as Record<string, string[]>,
  log: [{ id: 'a1', ts: '14.07.2026 · 11:03', actor: 'Emma Fischer', itemName: 'Canva-Team' }],
  isIT: false,
  stepUpEnforced: true,
  stepUpOk: true,
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderPage = (data: Partial<typeof baseData> = {}) =>
  render(Page, { props: { data: { ...baseData, ...data } } as any })

describe('Tresor page — unlocked (fresh LoA 2)', () => {
  it('renders the Fach with item metadata only (no secret up front) and offers Anzeigen', () => {
    const { getByText, queryByText } = renderPage()
    expect(getByText('Referat Finanzen')).toBeTruthy()
    expect(getByText('Sparkasse Online-Banking')).toBeTruthy()
    // username + created + creator in the mono meta line
    expect(getByText(/stura\.finanzen · angelegt 12\.03\.2026 · Ben Hoffmann/)).toBeTruthy()
    expect(getByText('Anzeigen')).toBeTruthy()
    expect(queryByText('geheim-123')).toBeNull()
    // unlocked → no lock card
    expect(queryByText('Tresor gesperrt')).toBeNull()
  })

  it('renders the handover cross-link chip as a link to /handover', () => {
    const { getByText } = renderPage()
    const chip = getByText(/Übergabe · Finanzen/).closest('a')
    expect(chip?.getAttribute('href')).toBe('/handover')
  })

  it('shows the empty-compartment state for a Fach without items', () => {
    const { getByText } = renderPage({ items: [], handoverRefs: {} })
    expect(getByText('Noch keine Einträge — dieses Fach ist leer.')).toBeTruthy()
  })

  it('shows the no-Fach empty state when no unit is in scope', () => {
    const { getByText } = renderPage({ units: [], items: [], handoverRefs: {} })
    expect(getByText('Kein Fach für dich sichtbar')).toBeTruthy()
  })
})

describe('Tresor page — lock state (honest #164 mapping)', () => {
  it('renders locked when step-up is enforced and the session LoA 2 is not fresh', () => {
    const { container, getByText, queryByText } = renderPage({ stepUpOk: false })
    expect(getByText('Tresor gesperrt')).toBeTruthy()
    // the ONE real unlock action → the existing step-up flow with returnTo
    const unlock = getByText(/Mit 2FA entsperren/).closest('a')
    expect(unlock?.getAttribute('href')).toBe('/auth/step-up?returnTo=%2Fvault')
    // compartments hidden while locked; no fake passkey/passphrase controls
    expect(queryByText('Sparkasse Online-Banking')).toBeNull()
    expect(queryByText('Mit Passkey entsperren')).toBeNull()
    expect(queryByText('Anzeigen')).toBeNull()
    // A6c (v11 sign-off): the lock card sits in the MAIN grid column, so the
    // Zugriffsprotokoll side card top-aligns with it instead of floating
    // detached beside an empty column.
    expect(container.querySelector('.vt-main .vt-lock')).toBeTruthy()
  })

  it('renders unlocked when enforcement is off (no fake lock)', () => {
    const { queryByText, getByText } = renderPage({ stepUpEnforced: false, stepUpOk: false })
    expect(queryByText('Tresor gesperrt')).toBeNull()
    expect(getByText('Sparkasse Online-Banking')).toBeTruthy()
  })

  it('Sperren re-locks client-side and clears the view', async () => {
    const { getByText, queryByText } = renderPage()
    await fireEvent.click(getByText('Sperren'))
    expect(getByText('Tresor gesperrt')).toBeTruthy()
    expect(queryByText('Sparkasse Online-Banking')).toBeNull()
  })
})

describe('Tresor page — reveal flow', () => {
  it('reveals a secret via GET /api/vault/[id]/secret with the Protokolliert pill', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { secret: 'geheim-123' } }) })
    vi.stubGlobal('fetch', fetchSpy)
    const { getByText, findByText } = renderPage()
    await fireEvent.click(getByText('Anzeigen'))
    expect(await findByText('geheim-123')).toBeTruthy()
    expect(await findByText('Protokolliert')).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledWith('/api/vault/v1/secret')
  })

  it('flips to the locked state on 401 STEP_UP_REQUIRED (stale step-up)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 }),
      }),
    )
    const { getByText, findByText, queryByText } = renderPage()
    await fireEvent.click(getByText('Anzeigen'))
    expect(await findByText('Tresor gesperrt')).toBeTruthy()
    expect(queryByText('geheim-123')).toBeNull()
  })

  it('surfaces an error when the reveal fails for another reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }))
    const { getByText, findByText } = renderPage()
    await fireEvent.click(getByText('Anzeigen'))
    expect(await findByText('Geheimnis konnte nicht angezeigt werden.')).toBeTruthy()
  })
})

describe('Tresor page — Löschen (confirm dialog, not browser confirm)', () => {
  it('opens the confirm dialog and only DELETEs after the dialog confirm', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchSpy)
    const { getByText, getAllByText, findByText } = renderPage()
    await fireEvent.click(getByText('Löschen'))
    // dialog is open, nothing deleted yet
    expect(await findByText('Eintrag löschen')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
    // second 'Löschen' is the dialog confirm
    const buttons = getAllByText('Löschen')
    await fireEvent.click(buttons[buttons.length - 1]!)
    expect(fetchSpy).toHaveBeenCalledWith('/api/vault/v1', { method: 'DELETE' })
  })

  it('surfaces an error when the delete fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const { getByText, getAllByText, findByText } = renderPage()
    await fireEvent.click(getByText('Löschen'))
    const buttons = getAllByText('Löschen')
    await fireEvent.click(buttons[buttons.length - 1]!)
    expect(await findByText('Eintrag konnte nicht gelöscht werden.')).toBeTruthy()
  })
})

describe('Tresor page — Bearbeiten (PUT, prefilled dialog)', () => {
  it('offers Bearbeiten per item only in the unlocked state', () => {
    const { getByText, unmount } = renderPage()
    expect(getByText('Bearbeiten')).toBeTruthy()
    unmount()
    const { queryByText } = renderPage({ stepUpOk: false })
    expect(queryByText('Bearbeiten')).toBeNull()
  })

  it('opens the dialog prefilled with metadata (never the secret) and PUTs without `secret` when the field stays empty', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchSpy)
    const { getByText, findByText, getByLabelText } = renderPage()
    await fireEvent.click(getByText('Bearbeiten'))
    // dialog is open, nothing saved yet
    expect(await findByText('Eintrag bearbeiten')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((getByLabelText('Name') as HTMLInputElement).value).toBe('Sparkasse Online-Banking')
    expect((getByLabelText(/Benutzername/) as HTMLInputElement).value).toBe('stura.finanzen')
    // the stored secret is never prefilled — empty field = keep it
    expect((getByLabelText(/Neues Geheimnis/) as HTMLInputElement).value).toBe('')
    await fireEvent.click(getByText('Speichern'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/vault/v1', expect.objectContaining({ method: 'PUT' }))
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body)
    expect(body).toEqual({
      orgUnitId: 'ou-1',
      name: 'Sparkasse Online-Banking',
      username: 'stura.finanzen',
    })
  })

  it('includes `secret` only when the Neues-Geheimnis field is filled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchSpy)
    const { getByText, findByText, getByLabelText } = renderPage()
    await fireEvent.click(getByText('Bearbeiten'))
    await findByText('Eintrag bearbeiten')
    await fireEvent.input(getByLabelText(/Neues Geheimnis/), { target: { value: 'neu-geheim' } })
    await fireEvent.click(getByText('Speichern'))
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body)
    expect(body.secret).toBe('neu-geheim')
  })

  it('surfaces the server message when the PUT fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Kein Zugriff auf diese Gliederung' }),
      }),
    )
    const { getByText, findByText } = renderPage()
    await fireEvent.click(getByText('Bearbeiten'))
    await findByText('Eintrag bearbeiten')
    await fireEvent.click(getByText('Speichern'))
    expect(await findByText('Kein Zugriff auf diese Gliederung')).toBeTruthy()
  })
})

describe('Tresor page — Zugriffsprotokoll card', () => {
  it('renders log rows as ts · actor → item with the append-only footnote', () => {
    const { getByText } = renderPage()
    expect(getByText('14.07.2026 · 11:03')).toBeTruthy()
    expect(getByText('Emma Fischer')).toBeTruthy()
    expect(getByText(/Ein Abruf ohne Akteur wird abgelehnt/)).toBeTruthy()
  })

  it('mentions the all-units view only for it-admin', () => {
    const { queryByText, unmount } = renderPage()
    expect(queryByText(/siehst du alle Einheiten/)).toBeNull()
    unmount()
    const { getByText } = renderPage({ isIT: true })
    expect(getByText(/Als IT-Administration siehst du alle Einheiten/)).toBeTruthy()
  })

  it('paginates: newest 8 visible, Mehr anzeigen reveals the rest', async () => {
    const log = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      ts: `01.07.2026 · 08:${String(i).padStart(2, '0')}`,
      actor: `actor-${i}`,
      itemName: 'X',
    }))
    const { getByText, queryByText } = renderPage({ log })
    expect(getByText('actor-7')).toBeTruthy()
    expect(queryByText('actor-8')).toBeNull()
    await fireEvent.click(getByText('Mehr anzeigen'))
    expect(getByText('actor-11')).toBeTruthy()
  })
})

describe('Tresor page — honest trust banner', () => {
  it('labels E2E as Zielbild and today as server-side AES-256-GCM', () => {
    const { getByText } = renderPage()
    expect(getByText('E2E-Zielbild (#405) · heute: serverseitig AES-256-GCM — Design-ahead')).toBeTruthy()
    expect(getByText(/Serverseitig verschlüsselt, jede Anzeige protokolliert/)).toBeTruthy()
  })
})
