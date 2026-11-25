// The protocol page and the plausibility of a decision: the entry form says in
// German why a decision is not stored (more votes than members present, or a
// meeting that is not beschlussfähig), from the attendance the page itself shows,
// including a roster edited a moment ago without a reload. The server repeats the
// checks; what it answers is shown as it is.
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

// The committee comes from the parent layout's load; <PageTitle> reads the brand from $app/state.
vi.mock('$app/state', () => ({ page: { data: {} } }))

import Page from './+page.svelte'

type Status = 'present' | 'absent' | 'excused'

// A body of two voting members; `status` is what the page load saw.
const pageData = (
  status: Status,
  over: { protocolStatus?: string; resolutions?: unknown[] } = {},
) => {
  const attendance = [
    { user_id: 'u1', status, displayName: 'Anna Beispiel' },
    { user_id: 'u2', status, displayName: 'Ben Muster' },
  ]
  const present = status === 'present' ? 2 : 0
  return {
    protocol: {
      id: 'p1', committee_id: 'c1', title: 'Sitzung', meeting_date: '2026-11-01', location: null,
      status: over.protocolStatus ?? 'draft', guest_edit_enabled: false, body_html: '<p>Text</p>', hasDraftDocument: false,
    },
    attendance,
    advisoryAttendance: [],
    quorum: { eligibleVotingCount: 2, presentVotingCount: present, quorate: present * 2 > 2 },
    resolutions: over.resolutions ?? [],
    actionItems: [],
    wopiToken: null,
    pendingApprovals: [],
    committee: { id: 'c1', name: 'Finanzausschuss' },
    committeeId: 'c1',
  }
}

const createdRow = {
  id: 'r1', sequence_nr: 1, global_nr: null, text: 'Antrag A', adoption_mode: 'tally',
  votes_yes: 2, votes_no: 0, votes_abstain: 0, result: 'passed', required_majority: 'simple',
}

let fetchMock: ReturnType<typeof vi.fn>
let resolutionAnswer: Response | null
let resolutionPatchAnswer: Response | null

beforeEach(() => {
  resolutionAnswer = null
  resolutionPatchAnswer = null
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/resolutions') && init?.method === 'POST') {
      return resolutionAnswer ?? new Response(JSON.stringify({ resolution: createdRow }), { status: 201 })
    }
    if (init?.method === 'PATCH' && String(url).includes('/resolutions/')) {
      return resolutionPatchAnswer ?? new Response(JSON.stringify({ resolution: createdRow }), { status: 200 })
    }
    // attendance chip save
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const resolutionPatches = () =>
  fetchMock.mock.calls.filter(([url, init]) =>
    String(url).includes('/resolutions/') && (init as RequestInit | undefined)?.method === 'PATCH')

const resolutionPosts = () =>
  fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith('/resolutions') && (init as RequestInit | undefined)?.method === 'POST')

async function enterDecision(yes: number, no = 0, abstain = 0) {
  await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
  await fireEvent.input(screen.getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
  await fireEvent.input(screen.getByLabelText('Ja'), { target: { value: String(yes) } })
  await fireEvent.input(screen.getByLabelText('Nein'), { target: { value: String(no) } })
  await fireEvent.input(screen.getByLabelText('Enthaltung'), { target: { value: String(abstain) } })
  await fireEvent.click(screen.getByText('Speichern'))
}

describe('protocol page: a decision that does not fit the meeting', () => {
  it('the live case: 999 yes in a body of 2, both absent, is refused with the reason and not sent', async () => {
    render(Page, { props: { data: pageData('absent') as never } })
    expect(screen.getByText('Nicht beschlussfähig')).toBeTruthy()
    await enterDecision(999)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/nicht beschlussfähig/i)
    expect(alert.textContent).toMatch(/Anwesenheit/)
    expect(resolutionPosts()).toHaveLength(0)
    // The form stays open with what was typed.
    expect((screen.getByPlaceholderText('Beschlusstext') as HTMLInputElement).value).toBe('Antrag A')
  })

  it('the refused form shows no computed verdict next to the refusal (it would read as Angenommen)', async () => {
    render(Page, { props: { data: pageData('absent') as never } })
    await enterDecision(999)

    await screen.findByRole('alert')
    expect(screen.queryAllByText(/Angenommen/)).toEqual([])
    expect(screen.queryAllByText(/berechnet/)).toEqual([])
  })

  it('more votes than members present in a beschlussfähig meeting is refused, naming both numbers', async () => {
    render(Page, { props: { data: pageData('present') as never } })
    await enterDecision(3)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/3/)
    expect(alert.textContent).toMatch(/2/)
    expect(alert.textContent).toMatch(/anwesend/)
    expect(resolutionPosts()).toHaveLength(0)
  })

  it('a count that fits the attendance is sent', async () => {
    render(Page, { props: { data: pageData('present') as never } })
    await enterDecision(2)

    await waitFor(() => expect(resolutionPosts()).toHaveLength(1))
    const body = JSON.parse((resolutionPosts()[0][1] as RequestInit).body as string)
    expect(body.votesYes).toBe(2)
  })

  it('attendance marked a moment ago counts: mark both present, then save, without a reload', async () => {
    render(Page, { props: { data: pageData('absent') as never } })
    // absent -> entschuldigt -> anwesend, for both members
    for (const name of ['Anna Beispiel', 'Ben Muster']) {
      await fireEvent.click(screen.getByRole('button', { name: `${name}: abwesend` }))
      await waitFor(() => screen.getByRole('button', { name: `${name}: entschuldigt` }))
      await fireEvent.click(screen.getByRole('button', { name: `${name}: entschuldigt` }))
      await waitFor(() => screen.getByRole('button', { name: `${name}: anwesend` }))
    }
    expect(screen.getByText('Beschlussfähig 2/2')).toBeTruthy()

    await enterDecision(2)
    await waitFor(() => expect(resolutionPosts()).toHaveLength(1))
  })

  it('and the other way round: attendance lowered a moment ago is refused without a reload', async () => {
    render(Page, { props: { data: pageData('present') as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => screen.getByRole('button', { name: 'Anna Beispiel: abwesend' }))

    await enterDecision(2)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/nicht beschlussfähig/i)
    expect(resolutionPosts()).toHaveLength(0)
  })

  it('shows the server refusal as it is when the server judges differently', async () => {
    resolutionAnswer = new Response(
      JSON.stringify({ message: 'Die Stimmen (2) übersteigen die Zahl der anwesenden stimmberechtigten Mitglieder (1).' }),
      { status: 400 },
    )
    render(Page, { props: { data: pageData('present') as never } })
    await enterDecision(2)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/übersteigen/))
    expect(resolutionPosts()).toHaveLength(1)
  })

  it('a decision nobody has voted on yet can still be added in a meeting that is not beschlussfähig', async () => {
    render(Page, { props: { data: pageData('absent') as never } })
    await enterDecision(0)
    await waitFor(() => expect(resolutionPosts()).toHaveLength(1))
  })
})

// Once a protocol is submitted the attendance is frozen and a counted row is not editable, so
// a stored decision that no longer fits the meeting (a protocol submitted before the rule, or
// an attendance lowered after the decision) would leave publish refused with no way out. Such a
// row is therefore opened for withdrawal; a row that fits stays locked.
describe('protocol page: a submitted protocol with a decision that does not fit', () => {
  const counted = (over: Record<string, unknown> = {}) => ({
    ...createdRow, votes_yes: 2, votes_no: 0, votes_abstain: 0, ...over,
  })

  it('a stored count above the members present can be edited (withdrawn) in the submitted state', async () => {
    render(Page, {
      props: { data: pageData('present', { protocolStatus: 'submitted', resolutions: [counted({ votes_yes: 999 })] }) as never },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Zurückziehen' }))

    await waitFor(() => expect(resolutionPatches()).toHaveLength(1))
    expect(JSON.parse((resolutionPatches()[0][1] as RequestInit).body as string).result).toBe('withdrawn')
  })

  it('a decision of a meeting that is not beschlussfähig can be edited in the submitted state', async () => {
    render(Page, {
      props: { data: pageData('absent', { protocolStatus: 'submitted', resolutions: [counted({ votes_yes: 1 })] }) as never },
    })
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeTruthy()
  })

  it('a decision that fits stays locked in the submitted state', () => {
    render(Page, {
      props: { data: pageData('present', { protocolStatus: 'submitted', resolutions: [counted()] }) as never },
    })
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).toBeNull()
  })
})

// An acclamation row carries no count unless the chair gives an informational one; clearing the
// fields must not be read as an implausible count.
describe('protocol page: an acclamation row without counts', () => {
  it('is saved with blank count fields in a beschlussfähig meeting', async () => {
    const acclamation = {
      id: 'r9', sequence_nr: 1, global_nr: null, text: 'Antrag per Akklamation', adoption_mode: 'acclamation',
      votes_yes: null, votes_no: null, votes_abstain: null, result: 'passed', required_majority: 'simple',
    }
    render(Page, { props: { data: pageData('present', { resolutions: [acclamation] }) as never } })
    await fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }))
    await fireEvent.input(screen.getByLabelText('Ja'), { target: { value: '3' } })
    await fireEvent.input(screen.getByLabelText('Ja'), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    await waitFor(() => expect(resolutionPatches()).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
