import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'

// F1-FIX-10-K / K2#13: Systemstatus rendered canned per-state snapshots as live
// health ("Alle Dienste dieser Instanz laufen", six green "Bereit" pills) for a
// tenant that has no provisioning-ledger row at all, and its "Erneut versuchen"
// button had no handler. A service without a real signal is "unbekannt"; a
// button without a handler does not exist.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/systemstatus'), data: { brand: null } } }))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }))

import Page from './+page.svelte'

function data(instance: { state: string; realStatuses: Record<string, string> }) {
  return { instance, modules: {}, realm: 'default' } as never
}

const ALL_OK = { db: 'ok', keycloak: 'ok', nextcloud: 'ok', matrix: 'ok' }

describe('systemstatus page (K2#13)', () => {
  it('shows "Unbekannt" for silo services without a ledger signal, never a green Bereit for them', () => {
    const { container } = render(Page, { props: { data: data({ state: 'ready', realStatuses: {} }) } })
    const rows = Array.from(container.querySelectorAll('.sys-svc'))
    const silo = rows.filter((r) => /PostgreSQL|Keycloak|Nextcloud|Matrix/.test(r.textContent ?? ''))
    expect(silo).toHaveLength(4)
    for (const r of silo) {
      expect(r.textContent).toMatch(/Unbekannt/)
      expect(r.textContent).not.toMatch(/Bereit/)
    }
    expect(container.textContent).not.toMatch(/Alle Dienste dieser Instanz laufen/)
  })

  it('shows Bereit and the converged headline only when every silo service has a real ok signal', () => {
    const { container } = render(Page, { props: { data: data({ state: 'ready', realStatuses: ALL_OK }) } })
    expect(container.textContent).toMatch(/Alle Dienste dieser Instanz laufen/)
    expect(container.textContent).not.toMatch(/Unbekannt/)
  })

  it('shows a real failure as failed and offers no retry button without a handler', () => {
    const { container } = render(Page, {
      props: { data: data({ state: 'failed', realStatuses: { ...ALL_OK, keycloak: 'failed' } }) },
    })
    expect(container.textContent).toMatch(/Fehler/)
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull()
  })
})
