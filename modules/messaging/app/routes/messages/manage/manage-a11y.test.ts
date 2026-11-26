// src/routes/messages/manage/manage-a11y.test.ts
//
// "Verwaltung -> Räume": every row repeats the same few actions, so a screen reader user who
// moves from button to button hears only "Umbenennen", "Archivieren", "Löschen" unless the name
// carries the room too. The visible word stays first in the name.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/svelte'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/messages/manage'), data: {} as Record<string, unknown> },
}))
vi.mock('$app/state', () => ({ page: h.page }))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(() => Promise.resolve()) }))
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import Page from './+page.svelte'

const data = {
  matrix: 'reachable',
  units: [
    { unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv', roomId: '!a:matrix.test' },
    { unitId: 'ou-2', unitName: 'Fachschaftsrat', state: 'aktiv', roomId: '!b:matrix.test', roomName: 'FSR Allgemein' },
    { unitId: 'ou-3', unitName: 'Haushalt', state: 'leer' },
    { unitId: 'ou-4', unitName: 'Kasse', state: 'fehler' },
    { unitId: 'ou-5', unitName: 'Plenum', state: 'archiviert', roomId: '!c:matrix.test' },
  ],
  archivedRooms: [
    { roomId: '!c:matrix.test', unitId: 'ou-5', unitName: 'Plenum', archivedAt: '2026-09-01T12:00:00Z', restorable: true },
    { roomId: '!d:matrix.test', unitId: 'ou-5', unitName: 'Plenum', roomName: 'Altes Plenum', restorable: true },
  ],
}

beforeEach(() => {
  h.page.data = { session: { user: { id: 'admin-1', roles: [Role.ITAdmin] } } }
})

const names = (role: 'button' | 'link', pattern: RegExp) =>
  screen.getAllByRole(role).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '').filter((n) => pattern.test(n))

describe('Räume verwalten - accessible names', () => {
  it('Umbenennen, Archivieren and Löschen name the room they act on', () => {
    render(Page, { props: { data: data as never } })
    expect(screen.getByRole('button', { name: 'Umbenennen: Vorstand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Umbenennen: FSR Allgemein' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archivieren: Vorstand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archivieren: FSR Allgemein' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Löschen: Vorstand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Löschen: FSR Allgemein' })).toBeTruthy()
  })

  it('no two buttons of the active list carry the same name', () => {
    render(Page, { props: { data: data as never } })
    const all = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '')
    expect(new Set(all).size).toBe(all.length)
  })

  it('Raum anlegen and Erneut versuchen name the unit', () => {
    render(Page, { props: { data: data as never } })
    expect(screen.getByRole('button', { name: 'Raum anlegen: Haushalt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Erneut versuchen: Kasse' })).toBeTruthy()
  })

  it('the archive rows name their room, including the history link', () => {
    render(Page, { props: { data: data as never } })
    expect(screen.getByRole('button', { name: 'Wiederherstellen: Plenum' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Wiederherstellen: Altes Plenum' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Verlauf lesen: Plenum' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Verlauf lesen: Altes Plenum' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Löschen: Altes Plenum' })).toBeTruthy()
    expect(names('button', /^Löschen/).length).toBe(4)
  })

  it('the confirmation and the rename controls name the room too', async () => {
    render(Page, { props: { data: data as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Archivieren: Vorstand' }))
    expect(screen.getByRole('button', { name: 'Bestätigen: Vorstand archivieren' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Abbrechen: Vorstand' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen: FSR Allgemein' }))
    const input = screen.getByRole('textbox', { name: 'Neuer Raumname' })
    const row = input.closest('.room-row') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Speichern: FSR Allgemein' })).toBeTruthy()
  })
})
