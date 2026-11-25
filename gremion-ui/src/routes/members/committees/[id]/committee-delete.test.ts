// committee-delete.test.ts -- "Gremium löschen" shows the server's refusal.
// A body that still has minutes is answered with 409 and a German text naming what
// hangs on it; the page must put that text in front of the admin and stay put.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }))
vi.mock('$app/navigation', () => nav)

import Page from './+page.svelte'

const REFUSAL = 'Das Gremium kann nicht gelöscht werden, solange noch Daten daran hängen: 2 Protokolle.'

function mount() {
  const data = {
    committee: { id: 'ou-1', name: 'Vorstand', description: null },
    members: [], roles: [], history: [], resources: [],
    user: { id: 'admin', roles: [] }, isAdmin: true,
  }
  return render(Page, { props: { data: data as never } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  nav.goto.mockClear()
})

describe('Gremium löschen', () => {
  it('shows the 409 text and does not leave the page', async () => {
    vi.stubGlobal('confirm', () => true)
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: REFUSAL }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Gremium löschen' }))
    expect(await screen.findByText(REFUSAL)).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledWith('/api/governance/committees/ou-1', { method: 'DELETE' })
    expect(nav.goto).not.toHaveBeenCalled()
  })

  it('says on the button what a delete needs, not only "no members"', () => {
    mount()
    const hint = screen.getByRole('button', { name: 'Gremium löschen' }).getAttribute('title') ?? ''
    for (const word of ['Mitglieder', 'Protokolle', 'Beschlüsse', 'Boards', 'Termine']) expect(hint).toContain(word)
  })

  it('shows the 503 text when a module could not be asked, and does not leave the page', async () => {
    vi.stubGlobal('confirm', () => true)
    const text = 'Das Gremium wurde nicht gelöscht: Boards konnten nicht geprüft werden, weil das zuständige Modul gerade nicht antwortet. Bitte später erneut versuchen.'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: text }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Gremium löschen' }))
    expect(await screen.findByText(text)).toBeTruthy()
    expect(nav.goto).not.toHaveBeenCalled()
  })

  it('goes back to the overview after a clean delete', async () => {
    vi.stubGlobal('confirm', () => true)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Gremium löschen' }))
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/members'))
  })
})
