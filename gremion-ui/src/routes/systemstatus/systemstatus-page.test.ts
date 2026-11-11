import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'

// E3 (finding 4): the page showed "Konvergiert noch", "Wartet auf Datenbank" and
// "Wartet auf Realm", and named Caddy and federation, on a customer whose services
// were all running: it rendered a provisioning record that a hand-wired tenant
// never updates. The page now renders live probe results only. A service the app
// cannot check is not listed; a claim without a signal does not exist.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/systemstatus'), data: { brand: null } } }))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }))

import Page from './+page.svelte'

type Status = 'ok' | 'unreachable' | 'off'
type Row = { key: 'db' | 'keycloak' | 'nextcloud' | 'matrix'; status: Status }

const ALL_OK: Row[] = [
  { key: 'db', status: 'ok' },
  { key: 'keycloak', status: 'ok' },
  { key: 'nextcloud', status: 'ok' },
  { key: 'matrix', status: 'ok' },
]

function data(services: Row[], over: Record<string, unknown> = {}) {
  return { services, modules: {}, realm: 'example-realm', tenantActive: true, ...over } as never
}

describe('systemstatus page (E3)', () => {
  it('an active tenant with reachable services shows no convergence or waiting claim', () => {
    const { container } = render(Page, { props: { data: data(ALL_OK) } })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/Konvergiert/)
    expect(text).not.toMatch(/Konvergenz/)
    expect(text).not.toMatch(/Wartet auf/)
    expect(text).not.toMatch(/wird bereitgestellt/i)
    expect(text).toMatch(/Alle geprüften Dienste sind erreichbar/)
    expect(text).toMatch(/4 \/ 4/)
  })

  it('names no component that does not exist in this deployment', () => {
    const { container } = render(Page, { props: { data: data(ALL_OK) } })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/Caddy/i)
    expect(text).not.toMatch(/Föderation|Foederation|federation/i)
  })

  it('an unreachable service is rendered as not reachable, and only that one', () => {
    const rows = ALL_OK.map((r) => (r.key === 'nextcloud' ? { ...r, status: 'unreachable' as const } : r))
    const { container } = render(Page, { props: { data: data(rows) } })
    const svc = Array.from(container.querySelectorAll('.sys-svc'))
    const nc = svc.find((r) => /Nextcloud/.test(r.textContent ?? ''))
    const kc = svc.find((r) => /Keycloak/.test(r.textContent ?? ''))
    expect(nc?.textContent).toMatch(/Nicht erreichbar/)
    expect(kc?.textContent).not.toMatch(/Nicht erreichbar/)
    expect(container.textContent).not.toMatch(/Alle geprüften Dienste sind erreichbar/)
    expect(container.textContent).toMatch(/3 \/ 4/)
  })

  it('an unreachable database or login service is flagged as a core outage', () => {
    const rows = ALL_OK.map((r) => (r.key === 'keycloak' ? { ...r, status: 'unreachable' as const } : r))
    const { container } = render(Page, { props: { data: data(rows) } })
    expect(container.querySelector('.sys-head.danger')).not.toBeNull()
  })

  it('a switched-off module service is shown as off and does not count as a fault', () => {
    const rows = ALL_OK.map((r) => (r.key === 'matrix' ? { ...r, status: 'off' as const } : r))
    const { container } = render(Page, { props: { data: data(rows) } })
    const mx = Array.from(container.querySelectorAll('.sys-svc')).find((r) => /Matrix/.test(r.textContent ?? ''))
    expect(mx?.textContent).toMatch(/Aus/)
    expect(mx?.textContent).not.toMatch(/Nicht erreichbar/)
    expect(container.textContent).toMatch(/Alle geprüften Dienste sind erreichbar/)
    expect(container.textContent).toMatch(/3 \/ 3/)
  })

  it('lists no service the deployment does not run', () => {
    const { container } = render(Page, {
      props: { data: data([{ key: 'db', status: 'ok' }, { key: 'keycloak', status: 'ok' }]) },
    })
    expect(container.textContent).not.toMatch(/Nextcloud/)
    expect(container.textContent).not.toMatch(/Matrix/)
  })

  it('offers no retry button without a handler', () => {
    render(Page, { props: { data: data(ALL_OK) } })
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull()
  })

  it('has no tenant: says so, never claims a healthy picture', () => {
    const { container } = render(Page, { props: { data: data([], { tenantActive: false, realm: null }) } })
    expect(container.textContent).not.toMatch(/Alle geprüften Dienste sind erreichbar/)
    expect(container.textContent).toMatch(/Kein Mandant/)
  })
})
