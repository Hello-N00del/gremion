// committee-roster-reload.test.ts -- the roster really refreshes from the server.
//
// committee-roster.test.ts proves the rows change at once through the page's own
// state, with invalidateAll as a no-op. This file proves the other half: after a
// successful add, remove or assign the page asks for a reload, the REAL load
// function (+page.server.ts) runs again, and the page then shows the server's
// copy and no longer its own placeholder.
//
// invalidateAll does here what SvelteKit does: it re-runs the load and hands the
// page its new `data`. The load reads a small in-memory server (the db and
// directory modules are faked over it) that the faked API calls change, so every
// row asserted after the reload can only have come through the load.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { Role } from '$lib/auth/types'

type MemberRow = {
  id: string; org_unit_id: string; user_keycloak_id: string; membership_type: string
  term_start: null; term_end: null; voting: boolean; joined_at: string
}
type Assignment = { id: string; role_id: string; user_keycloak_id: string; start_date: string; end_date: string; status: string }
type HistoryRow = { id: string; role_id: string; user_keycloak_id: string; start_date: string; end_date: string; ended_reason: string; created_at: string }

const h = vi.hoisted(() => ({
  invalidateAll: vi.fn(async () => {}),
  goto: vi.fn(async () => {}),
  server: {
    members: [] as unknown[],
    roles: [] as unknown[],
    assignments: {} as Record<string, unknown>,
    history: [] as unknown[],
    directory: {} as Record<string, { firstName: string; lastName: string; username: string }>,
  },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: h.invalidateAll, goto: h.goto }))
vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnitMembers: vi.fn(async () => [...h.server.members]),
  isMemberOf: vi.fn(async () => false),
}))
vi.mock('$lib/server/governance/governance-db', () => ({
  listRoles: vi.fn(async () => [...h.server.roles]),
  listHistory: vi.fn(async () => [...h.server.history]),
  getActiveAssignment: vi.fn(async (roleId: string) => h.server.assignments[roleId] ?? null),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResources: vi.fn(async () => []) }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({
    getUser: async (id: string) => {
      const user = h.server.directory[id]
      if (!user) throw new Error('unknown user')
      return user
    },
  }),
}))

import Page from './+page.svelte'
import { load } from './+page.server'

const server = h.server as {
  members: MemberRow[]
  roles: Array<{ id: string; org_unit_id: string; name: string; election_method: string; is_elected: boolean; grace_period_days: number }>
  assignments: Record<string, Assignment | null>
  history: HistoryRow[]
  directory: Record<string, { firstName: string; lastName: string; username: string }>
}

const COMMITTEE = { id: 'ou-1', name: 'Vorstand', description: null }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'admin@example.org', name: 'Admin' }

const memberRow = (userId: string): MemberRow => ({
  id: `srv-${userId}`, org_unit_id: 'ou-1', user_keycloak_id: userId, membership_type: 'unelected',
  term_start: null, term_end: null, voting: true, joined_at: '2026-01-01T00:00:00.000Z',
})
const assignment = (roleId: string, userId: string): Assignment => ({
  id: `a-${roleId}`, role_id: roleId, user_keycloak_id: userId, start_date: '2026-11-12', end_date: '2027-11-12', status: 'active',
})

function resetServer() {
  server.directory = {
    'u-anna': { firstName: 'Anna', lastName: 'Berger', username: 'anna' },
    'u-ben': { firstName: 'Ben', lastName: 'Hoffmann', username: 'ben' },
    'u-mia': { firstName: 'Mia', lastName: 'Neu', username: 'mia' },
    'u-cem': { firstName: 'Cem', lastName: 'Kaya', username: 'cem' },
  }
  server.members = [memberRow('u-anna'), memberRow('u-ben')]
  server.roles = [
    { id: 'r-vors', org_unit_id: 'ou-1', name: 'Vorsitz', election_method: 'manual', is_elected: true, grace_period_days: 14 },
    { id: 'r-fin', org_unit_id: 'ou-1', name: 'Finanzvorstand', election_method: 'manual', is_elected: true, grace_period_days: 14 },
  ]
  server.assignments = { 'r-fin': assignment('r-fin', 'u-anna') }
  server.history = []
}

let loadRuns = 0
/** Run the page's real load function against the in-memory server. */
async function runLoad() {
  loadRuns++
  return load({
    params: { id: 'ou-1' },
    locals: { auth: async () => ({ user: ADMIN }), tenant: {} },
    parent: async () => ({ committee: COMMITTEE }),
  } as never)
}

type Call = { url: string; method: string; body: Record<string, unknown> | null }
/** The API as the page calls it. `api` decides the answer and may change the server. */
let api: (c: Call) => { status: number; body: unknown }
let calls: Call[] = []

async function mount() {
  const view = render(Page, { props: { data: (await runLoad()) as never } })
  // SvelteKit's invalidateAll: re-run the load, then give the page its new data.
  h.invalidateAll.mockImplementation(async () => {
    await view.rerender({ data: (await runLoad()) as never })
  })
  return view
}

const rows = () => Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim() ?? '')
const roster = () => rows().join(' | ')
const rowOf = (text: string) => screen.getByText(text).closest('tr')!

beforeEach(() => {
  resetServer()
  loadRuns = 0
  calls = []
  h.invalidateAll.mockReset()
  api = () => ({ status: 200, body: {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : null,
      }
      calls.push(call)
      const r = api(call)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('committee roster: the page data is reloaded from the server', () => {
  it('first shows the roster the load returns', async () => {
    await mount()
    expect(loadRuns).toBe(1)
    expect(roster()).toContain('Anna Berger')
    expect(roster()).toContain('Ben Hoffmann')
    expect(rowOf('Vorsitz').textContent).toContain('Unbesetzt')
  })

  it('add: the placeholder row is replaced by the row the reloaded server data holds', async () => {
    // The slim search result carries no name, so the page's own row can only show
    // the e-mail. The name comes from the directory, which only the load reads.
    api = (c) => {
      if (c.url.startsWith('/api/users')) return { status: 200, body: { data: [{ id: 'u-mia', email: 'mia@example.org' }] } }
      if (c.method === 'POST' && c.url === '/api/governance/committees/ou-1/members') {
        server.members = [...server.members, memberRow(String(c.body?.userKeycloakId))]
        return { status: 201, body: { success: true, data: { report: { overall: 'ok' } } } }
      }
      return { status: 404, body: {} }
    }
    await mount()
    await fireEvent.click(screen.getByRole('button', { name: /Mitglied hinzufügen/ }))
    await fireEvent.input(screen.getByPlaceholderText(/Name oder E-Mail/), { target: { value: 'mia' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
    await fireEvent.click(await screen.findByRole('button', { name: /^\+ Hinzufügen$/ }))

    await waitFor(() => expect(roster()).toContain('Mia Neu'))
    expect(loadRuns).toBe(2) // the initial load and exactly one reload
    expect(roster()).not.toContain('mia@example.org')
    expect(rows().filter((r) => r.includes('Mia Neu'))).toHaveLength(1)
  })

  it('remove: after the reload the roster is the server\'s, including a change made elsewhere', async () => {
    api = (c) => {
      if (c.method === 'DELETE' && c.url === '/api/governance/committees/ou-1/members/u-ben') {
        server.members = server.members.filter((m) => m.user_keycloak_id !== 'u-ben')
        // Another admin added a member in the meantime: only a reload can show it.
        server.members = [...server.members, memberRow('u-cem')]
        return { status: 200, body: { success: true } }
      }
      return { status: 404, body: {} }
    }
    await mount()
    expect(roster()).not.toContain('Cem Kaya')
    await fireEvent.click(within(rowOf('Ben Hoffmann')).getByRole('button', { name: 'Entfernen' }))

    await waitFor(() => expect(roster()).toContain('Cem Kaya'))
    expect(loadRuns).toBe(2)
    expect(roster()).not.toContain('Ben Hoffmann')
    expect(roster()).toContain('Anna Berger')
  })

  it('assign: after the reload the offices are the server\'s, including a recall made elsewhere', async () => {
    api = (c) => {
      if (c.method === 'POST' && c.url === '/api/governance/committees/ou-1/roles/r-vors/assign') {
        const created = assignment('r-vors', String(c.body?.userKeycloakId))
        server.assignments = { ...server.assignments, 'r-vors': created }
        // Meanwhile another admin recalled the Finanzvorstand: the office is vacant
        // on the server and the ended term is in the history.
        server.assignments = { ...server.assignments, 'r-fin': null }
        server.history = [{
          id: 'h-1', role_id: 'r-fin', user_keycloak_id: 'u-anna', start_date: '2026-01-01', end_date: '2026-11-12',
          ended_reason: 'recalled', created_at: '2026-11-12T09:00:00.000Z',
        }]
        return { status: 201, body: { success: true, groupsReconciled: true, data: created } }
      }
      return { status: 404, body: {} }
    }
    await mount()
    expect(rowOf('Finanzvorstand').textContent).toContain('Anna Berger')
    await fireEvent.click(within(rowOf('Vorsitz')).getByRole('button', { name: /Amt zuweisen/ }))
    const dialog = screen.getByRole('dialog')
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))

    await waitFor(() => expect(rowOf('Finanzvorstand').textContent).toContain('Unbesetzt'))
    expect(loadRuns).toBe(2)
    expect(rowOf('Vorsitz').textContent).toContain('Ben Hoffmann')
    expect(rowOf('Vorsitz').textContent).not.toContain('Unbesetzt')
    // The history section is rendered from the loaded data only.
    expect(document.body.textContent).toContain('recalled')
  })

  it('a refused action reloads nothing and leaves the roster as it was', async () => {
    api = () => ({ status: 500, body: { success: false, error: 'Fehlgeschlagen' } })
    await mount()
    await fireEvent.click(within(rowOf('Ben Hoffmann')).getByRole('button', { name: 'Entfernen' }))
    await waitFor(() => expect(document.body.textContent).toContain('Fehlgeschlagen'))
    expect(loadRuns).toBe(1)
    expect(roster()).toContain('Ben Hoffmann')
  })
})
