import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'

// IT-admin pass 2026-11-13: "+ Beschluss hinzufügen" immediately POSTed and
// stored an EMPTY decision. The button must only open an entry form (an unsaved
// draft row); a decision is stored when the admin saves it with its text, and
// cancelling leaves nothing behind.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: readable({
      url: new URL('http://localhost/members/committees/c1/protokolle/p1'),
      data: { user: { roles: ['council-admin'] } },
    }),
  }
})

import Page from './+page.svelte'

const DATA = {
  protocol: {
    id: 'p1', committee_id: 'c1', title: 'Sitzung', meeting_date: '2026-11-01',
    location: null, status: 'draft', guest_edit_enabled: false, body_html: null,
    hasDraftDocument: false,
  },
  attendance: [],
  advisoryAttendance: [],
  resolutions: [],
  actionItems: [],
  pendingApprovals: [],
  wopiToken: null,
  quorum: { eligibleVotingCount: 3, presentVotingCount: 0, quorate: false },
}

const createdRow = {
  id: 'r1', sequence_nr: 1, global_nr: null, text: 'Antrag A',
  votes_yes: 0, votes_no: 0, votes_abstain: 0, result: 'rejected', required_majority: 'simple',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ resolution: createdRow }), { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const resolutionPosts = () =>
  fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith('/resolutions') && (init as RequestInit | undefined)?.method === 'POST')

describe('minutes editor — adding a decision', () => {
  it('"+ Beschluss hinzufügen" opens an entry form and stores nothing yet', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))

    expect(screen.getByPlaceholderText('Beschlusstext')).toBeTruthy()
    expect(resolutionPosts()).toHaveLength(0)
  })

  it('add then cancel stores nothing and leaves no row behind', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.click(screen.getByText('Abbrechen'))

    expect(screen.queryByPlaceholderText('Beschlusstext')).toBeNull()
    expect(resolutionPosts()).toHaveLength(0)
    expect(screen.getByText('+ Beschluss hinzufügen')).toBeTruthy()
  })

  it('saving without text is refused on the client and stores nothing', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.click(screen.getByText('Speichern'))

    expect(resolutionPosts()).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toMatch(/Beschlusstext/)
  })

  it('add then save stores exactly one decision, with its text', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(screen.getByText('Speichern'))

    await waitFor(() => expect(resolutionPosts()).toHaveLength(1))
    const body = JSON.parse((resolutionPosts()[0][1] as RequestInit).body as string)
    expect(body.text).toBe('Antrag A')
    expect(body.requiredMajority).toBe('simple')
    // The saved row is listed, the entry form is gone.
    await waitFor(() => expect(screen.queryByPlaceholderText('Beschlusstext')).toBeNull())
    expect(screen.getByText('Antrag A')).toBeTruthy()
  })

  it('a refused save keeps the form and the typed text, and shows the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Der Beschlusstext darf nicht leer sein.' }), { status: 400 }),
    )
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(screen.getByText('Speichern'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/nicht leer/))
    expect((screen.getByPlaceholderText('Beschlusstext') as HTMLInputElement).value).toBe('Antrag A')
  })
})

// A save that is still on its way must not be repeatable or cancellable: two
// clicks stored two identical decisions, and Abbrechen during the request closed
// the form while the decision was stored anyway.
describe('minutes editor — a save in flight', () => {
  function pendingCreate() {
    let settle!: (res: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve }))
    return { finish: () => settle(new Response(JSON.stringify({ resolution: createdRow }), { status: 201 })) }
  }

  async function fillAndSave() {
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(screen.getByText('Speichern'))
  }

  it('a double click on Speichern sends exactly one POST', async () => {
    const pending = pendingCreate()
    render(Page, { props: { data: DATA } as never })
    await fillAndSave()
    await fireEvent.click(screen.getByText('Speichern'))
    await fireEvent.click(screen.getByText('Speichern'))

    expect(resolutionPosts()).toHaveLength(1)
    pending.finish()
    await waitFor(() => expect(screen.queryByPlaceholderText('Beschlusstext')).toBeNull())
    expect(resolutionPosts()).toHaveLength(1)
    expect(screen.getAllByText('Antrag A')).toHaveLength(1)
  })

  it('Abbrechen while the save is pending does not pretend to cancel', async () => {
    const pending = pendingCreate()
    render(Page, { props: { data: DATA } as never })
    await fillAndSave()
    await fireEvent.click(screen.getByText('Abbrechen'))

    // The form is still there: the request is on its way and cannot be recalled.
    expect(screen.getByPlaceholderText('Beschlusstext')).toBeTruthy()
    pending.finish()
    await waitFor(() => expect(screen.queryByPlaceholderText('Beschlusstext')).toBeNull())
    expect(screen.getAllByText('Antrag A')).toHaveLength(1)
  })

  it('a network failure keeps the form and says so', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(Page, { props: { data: DATA } as never })
    await fillAndSave()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/nicht hinzugefügt/))
    expect((screen.getByPlaceholderText('Beschlusstext') as HTMLInputElement).value).toBe('Antrag A')
    // And the form can be saved again afterwards.
    await fireEvent.click(screen.getByText('Speichern'))
    await waitFor(() => expect(resolutionPosts()).toHaveLength(2))
  })
})

describe('minutes editor — a cleared vote count', () => {
  it('is refused instead of being stored as a counted 0', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Beschluss hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.input(screen.getByLabelText('Ja'), { target: { value: '' } })
    await fireEvent.click(screen.getByText('Speichern'))

    expect(resolutionPosts()).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toMatch(/Stimmzahlen/)
  })
})

describe('minutes editor — a refused edit shows the server message', () => {
  it('names why the edit of a decision was refused', async () => {
    const alertMock = vi.fn()
    vi.stubGlobal('alert', alertMock)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Der Beschlusstext darf nicht leer sein.' }), { status: 400 }),
    )
    const stored = { ...createdRow, text: 'Alt' }
    render(Page, { props: { data: { ...DATA, resolutions: [stored] } } as never })
    await fireEvent.click(screen.getByText('Bearbeiten'))
    await fireEvent.click(screen.getByText('Zurückziehen'))

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1))
    expect(alertMock.mock.calls[0][0]).toMatch(/Beschlusstext darf nicht leer/)
  })
})
