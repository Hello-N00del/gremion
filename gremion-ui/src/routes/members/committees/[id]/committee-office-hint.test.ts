// committee-office-hint.test.ts -- IT-admin finding 2: on a committee page an IT admin saw only
// "Entfernen" on the member rows and no way to assign an office, with no word about why.
// The permission is not the cause (it-admin contains council-admin in the role ladder, so the page's
// isAdmin and the assign endpoint both let an IT admin through). The cause is that "Amt zuweisen"
// exists only on a vacant office row: a committee with no offices, or with every office taken, gave
// an admin no assign path and no explanation. The page now says which of the two it is.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/svelte'

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }))
vi.mock('$app/navigation', () => nav)

import Page from './+page.svelte'

const COMMITTEE = { id: 'ou-1', name: 'Fachschaftsrat', description: null }
const member = (id: string, displayName: string) => ({
  id: `m-${id}`, org_unit_id: 'ou-1', user_keycloak_id: id, membership_type: 'unelected',
  term_start: null, term_end: null, voting: true, joined_at: '2026-01-01T00:00:00.000Z', displayName,
})
const role = (id: string, name: string, holder: { id: string; displayName: string } | null = null) => ({
  id, org_unit_id: 'ou-1', name, election_method: 'manual', is_elected: true, grace_period_days: 14,
  currentAssignment: holder
    ? { id: `a-${id}`, role_id: id, user_keycloak_id: holder.id, start_date: '2026-01-01', end_date: '2027-01-01', status: 'active', displayName: holder.displayName }
    : null,
})

function pageData(over: Record<string, unknown> = {}) {
  return {
    committee: COMMITTEE,
    members: [member('u-anna', 'Anna Berger'), member('u-ben', 'Ben Hoffmann')],
    roles: [],
    history: [],
    resources: [],
    user: { id: 'admin', roles: ['it-admin'] },
    isAdmin: true,
    ...over,
  }
}
const mount = (over: Record<string, unknown> = {}) => render(Page, { props: { data: pageData(over) as never } })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('committee page: an admin is told when there is no office to assign', () => {
  it('a committee without any office says so, instead of leaving only "Entfernen" on the rows', () => {
    mount()
    expect(screen.queryByRole('button', { name: /Amt zuweisen/ })).toBeNull()
    const hint = screen.getByTestId('office-assign-hint')
    expect(hint.textContent).toContain('keine Ämter angelegt')
    expect(hint.textContent).toContain('lassen sich hier keine Ämter anlegen')
  })

  it('a committee whose offices are all taken says how one becomes free', () => {
    mount({
      roles: [
        role('r-vors', 'Vorsitz', { id: 'u-anna', displayName: 'Anna Berger' }),
        role('r-fin', 'Finanzvorstand', { id: 'u-ben', displayName: 'Ben Hoffmann' }),
      ],
    })
    expect(screen.queryByRole('button', { name: /Amt zuweisen/ })).toBeNull()
    const hint = screen.getByTestId('office-assign-hint')
    expect(hint.textContent).toContain('Alle Ämter sind besetzt')
    expect(hint.textContent).toContain('Abberufen')
  })

  it('a vacant office keeps its "Amt zuweisen" button and no hint is shown', () => {
    mount({ roles: [role('r-vors', 'Vorsitz')] })
    const row = screen.getByText('Vorsitz').closest('tr')!
    expect(within(row).getByRole('button', { name: /Amt zuweisen/ })).toBeTruthy()
    expect(screen.queryByTestId('office-assign-hint')).toBeNull()
  })

  it('a non-admin gets no hint: it would point at actions they do not have', () => {
    mount({ isAdmin: false })
    expect(screen.queryByTestId('office-assign-hint')).toBeNull()
  })
})
