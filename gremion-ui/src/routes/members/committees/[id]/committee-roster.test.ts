// committee-roster.test.ts -- E2E finding 6 (committee members).
//  (a) the roster shows a new member right after "Hinzufuegen" and drops a removed one right after
//      "Entfernen", WITHOUT waiting for a reload: invalidateAll is a no-op in these tests, so the rows
//      can only change through the page's own state.
//  (b) an admin assigns a member to a vacant office and the office shows in the table; a failed save
//      leaves the office vacant and shows the error. Clearing an office (the recall dialog) empties it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }))
vi.mock('$app/navigation', () => nav)

import Page from './+page.svelte'

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []
let responder: (c: Call) => { status: number; body: unknown }

function stubFetch() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : null,
      }
      calls.push(call)
      const r = responder(call)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

const COMMITTEE = { id: 'ou-1', name: 'Vorstand', description: null }
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
    roles: [role('r-vors', 'Vorsitz'), role('r-fin', 'Finanzvorstand', { id: 'u-anna', displayName: 'Anna Berger' })],
    history: [],
    resources: [],
    user: { id: 'admin', roles: [] },
    isAdmin: true,
    ...over,
  }
}

const mount = (over: Record<string, unknown> = {}) => render(Page, { props: { data: pageData(over) as never } })
const rows = () => Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim() ?? '')

async function searchAndAdd(name: string) {
  await fireEvent.click(screen.getByRole('button', { name: /Mitglied hinzufügen/ }))
  await fireEvent.input(screen.getByPlaceholderText(/Name oder E-Mail/), { target: { value: name } })
  await fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
  const add = await screen.findByRole('button', { name: /^\+ Hinzufügen$/ })
  await fireEvent.click(add)
}

beforeEach(() => {
  nav.invalidateAll.mockClear()
  stubFetch()
  responder = () => ({ status: 200, body: {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('committee roster: add and remove show without a reload', () => {
  it('shows the new member in the table after a successful add', async () => {
    responder = (c) => {
      if (c.url.startsWith('/api/users')) return { status: 200, body: { data: [{ id: 'u-mia', firstName: 'Mia', lastName: 'Neu', email: 'mia@example.org' }] } }
      return { status: 201, body: { success: true, data: { report: { overall: 'ok' } } } }
    }
    mount()
    expect(rows().join('|')).not.toContain('Mia Neu')
    await searchAndAdd('mia')
    await waitFor(() => expect(rows().join('|')).toContain('Mia Neu'))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/governance/committees/ou-1/members')
    expect((post.body as { userKeycloakId: string }).userKeycloakId).toBe('u-mia')
  })

  it('still lists the member when the add came back 207 (row exists, provisioning failed) and shows the error', async () => {
    responder = (c) => {
      if (c.url.startsWith('/api/users')) return { status: 200, body: { data: [{ id: 'u-mia', firstName: 'Mia', lastName: 'Neu', email: 'mia@example.org' }] } }
      return { status: 207, body: { success: false, error: 'Bereitstellung nicht vollständig.' } }
    }
    mount()
    await searchAndAdd('mia')
    await waitFor(() => expect(rows().join('|')).toContain('Mia Neu'))
    expect(document.body.textContent).toContain('Bereitstellung nicht vollständig.')
  })

  it('does not list the member and shows the error when the add fails', async () => {
    responder = (c) => {
      if (c.url.startsWith('/api/users')) return { status: 200, body: { data: [{ id: 'u-mia', firstName: 'Mia', lastName: 'Neu', email: 'mia@example.org' }] } }
      return { status: 500, body: { success: false, error: 'Interner Fehler' } }
    }
    mount()
    await searchAndAdd('mia')
    await waitFor(() => expect(document.body.textContent).toContain('Interner Fehler'))
    expect(rows().join('|')).not.toContain('Mia Neu')
  })

  it('drops a removed member from the table after a successful remove', async () => {
    responder = () => ({ status: 200, body: { success: true } })
    mount()
    const benRow = screen.getByText('Ben Hoffmann').closest('tr')!
    await fireEvent.click(within(benRow).getByRole('button', { name: 'Entfernen' }))
    await waitFor(() => expect(rows().join('|')).not.toContain('Ben Hoffmann'))
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/governance/committees/ou-1/members/u-ben')
  })

  it('keeps the member in the table when the remove fails', async () => {
    responder = () => ({ status: 500, body: { success: false, error: 'Fehlgeschlagen' } })
    mount()
    const benRow = screen.getByText('Ben Hoffmann').closest('tr')!
    await fireEvent.click(within(benRow).getByRole('button', { name: 'Entfernen' }))
    await waitFor(() => expect(document.body.textContent).toContain('Fehlgeschlagen'))
    expect(rows().join('|')).toContain('Ben Hoffmann')
  })
})

describe('committee roster: assign and clear an office', () => {
  const vorsitzRow = () => screen.getByText('Vorsitz').closest('tr')!

  it('shows an office as vacant, with an assign control only for an admin', () => {
    mount()
    expect(vorsitzRow().textContent).toContain('Unbesetzt')
    expect(within(vorsitzRow()).getByRole('button', { name: /Amt zuweisen/ })).toBeTruthy()
    const finRow = screen.getByText('Finanzvorstand').closest('tr')!
    expect(finRow.textContent).not.toContain('Unbesetzt')
    expect(finRow.textContent).toContain('Anna Berger')
  })

  it('offers no assign control to a non-admin', () => {
    mount({ isAdmin: false })
    expect(screen.queryByRole('button', { name: /Amt zuweisen/ })).toBeNull()
    expect(vorsitzRow().textContent).toContain('Unbesetzt')
  })

  it('assigns a member to the office: the API gets the member and the term, the row shows the holder', async () => {
    responder = () => ({
      status: 201,
      body: { success: true, groupsReconciled: true, data: { id: 'a-new', role_id: 'r-vors', user_keycloak_id: 'u-ben', start_date: '2026-11-11', end_date: '2027-11-11', status: 'active' } },
    })
    mount()
    await fireEvent.click(within(vorsitzRow()).getByRole('button', { name: /Amt zuweisen/ }))
    const dialog = screen.getByRole('dialog')
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))
    await waitFor(() => expect(vorsitzRow().textContent).toContain('Ben Hoffmann'))
    expect(vorsitzRow().textContent).not.toContain('Unbesetzt')
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/governance/committees/ou-1/roles/r-vors/assign')
    const body = post.body as { userKeycloakId: string; startDate: string; endDate: string }
    expect(body.userKeycloakId).toBe('u-ben')
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.endDate > body.startDate).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the office vacant and shows the error when the assign is refused', async () => {
    responder = () => ({ status: 403, body: { success: false, error: 'Forbidden' } })
    mount()
    await fireEvent.click(within(vorsitzRow()).getByRole('button', { name: /Amt zuweisen/ }))
    const dialog = screen.getByRole('dialog')
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('Forbidden'))
    expect(vorsitzRow().textContent).toContain('Unbesetzt')
    expect(vorsitzRow().textContent).not.toContain('Ben Hoffmann')
  })

  it('clears an office through the recall dialog: the seat is vacant again', async () => {
    responder = () => ({ status: 200, body: { success: true, groupsReconciled: true } })
    mount()
    const finRow = () => screen.getByText('Finanzvorstand').closest('tr')!
    await fireEvent.click(within(finRow()).getByRole('button', { name: 'Abberufen' }))
    const dialog = screen.getByRole('dialog')
    await fireEvent.input(within(dialog).getByLabelText(/Grund/), { target: { value: 'Rücktritt' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Abberufen' }))
    await waitFor(() => expect(finRow().textContent).toContain('Unbesetzt'))
  })
})

// The add-member panel says something about a search only once that search has run, and tells
// "nobody matches" apart from "everyone who matches is already a member" and from "nothing was typed".
describe('committee roster: what the add-member search reports', () => {
  const NONE = 'Keine passenden Nutzer gefunden.'
  const ALL_MEMBERS = 'Alle Treffer sind bereits Mitglied dieses Gremiums.'
  const TYPE_SOMETHING = 'Bitte einen Namen oder eine E-Mail-Adresse eingeben.'
  const REFINE = 'Es gibt möglicherweise weitere Treffer. Bitte die Suche eingrenzen.'
  const text = () => document.body.textContent ?? ''
  const hit = (id: string, firstName: string, lastName: string) => ({ id, firstName, lastName, email: `${id}@example.test`, username: id })
  const userSearches = () => calls.filter((c) => c.url.startsWith('/api/users'))

  async function openPanel() {
    await fireEvent.click(screen.getByRole('button', { name: /Mitglied hinzufügen/ }))
    return screen.getByPlaceholderText(/Name oder E-Mail/)
  }
  async function search(term: string) {
    const input = await openPanel()
    await fireEvent.input(input, { target: { value: term } })
    await fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
    await screen.findByRole('button', { name: 'Suchen' })
    return input
  }

  it('a single typed letter is sent as it is: the search starts at one character', async () => {
    responder = () => ({ status: 200, body: { data: [hit('u-mia', 'Mia', 'Neu')] } })
    mount()
    await search('e')
    await screen.findByText('Mia Neu')
    expect(userSearches().map((c) => c.url)).toEqual(['/api/users?search=e&slim=true&max=10'])
  })

  it('typing a term without searching reports nothing: no "none found" before a search ran', async () => {
    mount()
    const input = await openPanel()
    await fireEvent.input(input, { target: { value: 'mia' } })
    expect(text()).not.toContain(NONE)
    expect(userSearches()).toEqual([])
  })

  it('an empty search asks for a term instead of looking like an empty user list, and sends no request', async () => {
    mount()
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
    await waitFor(() => expect(text()).toContain(TYPE_SOMETHING))
    expect(text()).not.toContain(NONE)
    expect(userSearches()).toEqual([])
  })

  it('a search nobody matches says so', async () => {
    responder = () => ({ status: 200, body: { data: [] } })
    mount()
    await search('zzz')
    await waitFor(() => expect(text()).toContain(NONE))
    expect(text()).not.toContain(ALL_MEMBERS)
  })

  it('a search whose hits are all members already says that, not "none found"', async () => {
    responder = () => ({ status: 200, body: { data: [hit('u-anna', 'Anna', 'Berger'), hit('u-ben', 'Ben', 'Hoffmann')] } })
    mount()
    await search('e')
    await waitFor(() => expect(text()).toContain(ALL_MEMBERS))
    expect(text()).not.toContain(NONE)
    expect(screen.queryByRole('button', { name: /^\+ Hinzufügen$/ })).toBeNull()
  })

  it('a full page of hits says that there may be more and asks to narrow the search', async () => {
    const page = Array.from({ length: 10 }, (_, i) => hit(`u-x${i}`, 'Person', `Nr${i}`))
    responder = () => ({ status: 200, body: { data: page } })
    mount()
    await search('e')
    await waitFor(() => expect(text()).toMatch(REFINE))
    expect(screen.getAllByRole('button', { name: /^\+ Hinzufügen$/ })).toHaveLength(10)
  })

  it('fewer hits than a full page carry no such note', async () => {
    responder = () => ({ status: 200, body: { data: [hit('u-mia', 'Mia', 'Neu')] } })
    mount()
    await search('mia')
    await screen.findByText('Mia Neu')
    expect(text()).not.toMatch(REFINE)
  })

  it('changing the term after a search takes the old verdict away until the next search', async () => {
    responder = () => ({ status: 200, body: { data: [] } })
    mount()
    const input = await search('zzz')
    await waitFor(() => expect(text()).toContain(NONE))
    await fireEvent.input(input, { target: { value: 'mia' } })
    await waitFor(() => expect(text()).not.toContain(NONE))
  })

  it('a failed search shows the failure and no verdict about users', async () => {
    responder = () => ({ status: 502, body: { success: false, error: 'Mitgliedersuche fehlgeschlagen' } })
    mount()
    await search('mia')
    await waitFor(() => expect(text()).toContain('Suche fehlgeschlagen (502)'))
    expect(text()).not.toContain(NONE)
  })
})
