// The protocol page and the server's "every counted resolution needs a vote"
// refusal: the admin reads the server's sentence inline, on submit and on
// publish, and is not sent to the attendance list for a missing vote.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'

vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: readable({
      url: new URL('http://localhost/members/committees/c1/protokolle/p1'),
      data: { user: { id: 'admin', roles: ['council-admin'] } },
    }),
  }
})

import Page from './+page.svelte'
import { untalliedResolutionsMessage, UNTALLIED_RESOLUTION_CODE } from '$lib/governance/resolution-vote-state'

const untallied = {
  id: 'r1', sequence_nr: 1, global_nr: null, text: 'Antrag ohne Stimmen', adoption_mode: 'tally',
  votes_yes: 0, votes_no: 0, votes_abstain: 0, result: 'rejected', required_majority: 'simple',
}
const consent = { ...untallied, id: 'r2', sequence_nr: 2, text: 'Konsensantrag', required_majority: 'consent', result: 'passed' }

const pageData = (status: 'draft' | 'submitted') => ({
  protocol: {
    id: 'p1', committee_id: 'c1', title: 'Sitzung', meeting_date: '2026-06-21', location: null, status,
    guest_edit_enabled: false, body_html: '<p>Text</p>', hasDraftDocument: false,
  },
  attendance: [],
  advisoryAttendance: [],
  quorum: { eligibleVotingCount: 3, presentVotingCount: 2, quorate: true },
  resolutions: [untallied, consent],
  actionItems: [],
  wopiToken: null,
  pendingApprovals: [],
  committeeId: 'c1',
})

let answer: { status: number; body: unknown }
let requested: string[] = []
const alertSpy = vi.fn()

beforeEach(() => {
  requested = []
  alertSpy.mockReset()
  vi.stubGlobal('alert', alertSpy)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requested.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const message = untalliedResolutionsMessage([untallied, consent])!

describe('protocol page: a resolution nobody voted on', () => {
  it('lists it as "noch keine Abstimmung" and a consent resolution with an empty tally as adopted', () => {
    render(Page, { props: { data: pageData('draft') as never } })
    const row = (text: string) => screen.getByText(text).parentElement!.textContent ?? ''
    expect(row('Antrag ohne Stimmen')).toMatch(/noch keine Abstimmung/)
    expect(row('Antrag ohne Stimmen')).not.toMatch(/Abgelehnt/)
    expect(row('Konsensantrag')).toMatch(/Angenommen/)
    expect(row('Konsensantrag')).not.toMatch(/noch keine Abstimmung/)
  })

  it('shows the server\'s refusal of a submit inline, as a sentence and not as raw JSON', async () => {
    answer = { status: 422, body: { error: message } }
    render(Page, { props: { data: pageData('draft') as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Zur Abstimmung einreichen' }))

    const alert = await screen.findByRole('alert')
    expect(requested).toEqual(['POST /api/protocols/p1/submit'])
    expect(alert.textContent).toContain('Einreichung nicht möglich')
    expect(alert.textContent).toContain('Beschluss 1 hat noch keine Abstimmung')
    expect(alert.textContent).not.toContain('{')
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('shows the refusal of a publish without the attendance shortcut', async () => {
    answer = { status: 422, body: { message, code: UNTALLIED_RESOLUTION_CODE } }
    render(Page, { props: { data: pageData('submitted') as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Veröffentlichen' }))

    const alert = await screen.findByRole('alert')
    expect(requested).toEqual(['POST /api/protocols/p1/publish'])
    expect(alert.textContent).toContain('Veröffentlichung blockiert')
    expect(alert.textContent).toContain('Beschluss 1 hat noch keine Abstimmung')
    expect(screen.queryByRole('button', { name: 'Anwesenheit erfassen' })).toBeNull()
  })

  it('keeps the attendance shortcut for a missing quorum', async () => {
    answer = { status: 422, body: { message: 'Nicht beschlussfähig: 1/3 stimmberechtigte Mitglieder anwesend' } }
    render(Page, { props: { data: pageData('submitted') as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Veröffentlichen' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Nicht beschlussfähig'))
    expect(screen.getByRole('button', { name: 'Anwesenheit erfassen' })).toBeTruthy()
  })
})

// A protocol that reached "Eingereicht" with a resolution nobody voted on cannot
// be published, and the refusal tells the admin to enter the count, withdraw or
// delete. The page must then offer exactly that for exactly those rows; every
// other row stays locked once the protocol is submitted.
describe('protocol page: a submitted protocol with a resolution nobody voted on', () => {
  const rowOf = (text: string) => screen.getByText(text).parentElement!.parentElement!
  const editButton = (text: string) =>
    Array.from(rowOf(text).querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Bearbeiten') ?? null

  it('lets the admin edit the resolution without a vote, and only that one', () => {
    render(Page, { props: { data: pageData('submitted') as never } })
    expect(editButton('Antrag ohne Stimmen')).not.toBeNull()
    expect(editButton('Konsensantrag')).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Beschluss hinzufügen' })).toBeNull()
  })

  it('locks the row again once the count is saved', async () => {
    answer = { status: 200, body: { resolution: { ...untallied, votes_yes: 2, votes_no: 1, result: 'passed' } } }
    render(Page, { props: { data: pageData('submitted') as never } })
    await fireEvent.click(editButton('Antrag ohne Stimmen')!)
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    await waitFor(() => expect(rowOf('Antrag ohne Stimmen').textContent).toMatch(/Angenommen/))
    expect(requested).toEqual(['PATCH /api/protocols/p1/resolutions/r1'])
    expect(editButton('Antrag ohne Stimmen')).toBeNull()
  })

  it('offers no editing once the protocol is published', () => {
    render(Page, { props: { data: { ...pageData('submitted'), protocol: { ...pageData('submitted').protocol, status: 'published' } } as never } })
    expect(editButton('Antrag ohne Stimmen')).toBeNull()
  })
})
