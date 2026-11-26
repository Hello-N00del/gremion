import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'

// E2E pass 2026-11-26 (findings 9 and 10): "+ Aufgabe hinzufügen" immediately
// POSTed and stored an EMPTY task; a task saved from the form showed no title in
// the draft view, and its due date was not stored (the form sent `due_date`, the
// route reads `dueDate`). The button now only opens an entry form: a task is
// stored when it is saved with its title, and cancelling leaves nothing behind.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: readable({
      url: new URL('http://localhost/members/committees/c1/protokolle/p1'),
      data: { user: { roles: ['council-admin'] } },
    }),
  }
})
vi.mock('$app/state', () => ({ page: { data: {} } }))

import Page from './+page.svelte'

const DATA = {
  committee: { id: 'c1', name: 'Finanzausschuss' },
  protocol: {
    id: 'p1', committee_id: 'c1', title: 'Sitzung', meeting_date: '2026-11-01',
    location: null, status: 'draft', guest_edit_enabled: false, body_html: null,
    hasDraftDocument: false, draftDocumentMissing: false,
  },
  attendance: [
    { user_id: 'u-1', status: 'present', displayName: 'Erika Beispiel' },
    { user_id: 'u-2', status: 'absent', displayName: 'Max Muster' },
  ],
  advisoryAttendance: [{ user_id: 'u-3', status: 'present', displayName: 'Berta Beratung' }],
  resolutions: [],
  actionItems: [],
  pendingApprovals: [],
  wopiToken: null,
  quorum: { eligibleVotingCount: 2, presentVotingCount: 1, quorate: false },
}

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'a1', protocol_id: 'p1', assignee_keycloak_id: null, text: 'Kasse prüfen',
  due_date: '2026-12-10T00:00:00.000Z', completed: false, created_at: '2026-11-01T10:00:00Z', ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}')
    return new Response(
      JSON.stringify({
        actionItem: stored({
          text: body.text, due_date: body.dueDate ? `${body.dueDate}T00:00:00.000Z` : null,
          assignee_keycloak_id: body.assigneeKeycloakId ?? null,
        }),
      }),
      { status: init?.method === 'POST' ? 201 : 200 },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const calls = (method: string) =>
  fetchMock.mock.calls.filter(([url, init]) =>
    String(url).includes('/action-items') && (init as RequestInit | undefined)?.method === method)
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string)

describe('minutes editor — adding a task', () => {
  it('"+ Aufgabe hinzufügen" opens an entry form and stores nothing yet', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))

    expect(screen.getByPlaceholderText('Aufgabe')).toBeTruthy()
    expect(calls('POST')).toHaveLength(0)
  })

  it('add then cancel stores nothing and leaves no row behind', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.click(screen.getByText('Abbrechen'))

    expect(screen.queryByPlaceholderText('Aufgabe')).toBeNull()
    expect(calls('POST')).toHaveLength(0)
    expect(screen.getByText('+ Aufgabe hinzufügen')).toBeTruthy()
  })

  it('saving without a title is refused on the client and stores nothing', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.click(screen.getByText('Speichern'))

    expect(calls('POST')).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toMatch(/Titel/)
  })

  it('a title of blanks is not a title', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Aufgabe'), { target: { value: '   ' } })
    await fireEvent.click(screen.getByText('Speichern'))

    expect(calls('POST')).toHaveLength(0)
  })

  it('add then save stores one task with title, due date and assignee, and the draft view shows all three', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Aufgabe'), { target: { value: 'Kasse prüfen' } })
    await fireEvent.input(screen.getByLabelText('Fällig bis'), { target: { value: '2026-12-10' } })
    await fireEvent.change(screen.getByLabelText('Zuständig'), { target: { value: 'u-1' } })
    await fireEvent.click(screen.getByText('Speichern'))

    await waitFor(() => expect(calls('POST')).toHaveLength(1))
    expect(bodyOf(calls('POST')[0])).toEqual({ text: 'Kasse prüfen', dueDate: '2026-12-10', assigneeKeycloakId: 'u-1' })
    await waitFor(() => expect(screen.queryByPlaceholderText('Aufgabe')).toBeNull())
    expect(screen.getByText('Kasse prüfen')).toBeTruthy()
    expect(screen.getByText(/10\.12\.2026/)).toBeTruthy()
    // (the attendance list above also names her: look inside the task section)
    const tasks = screen.getByText('Aufgaben').closest('section') as HTMLElement
    expect(within(tasks).getByText('Erika Beispiel')).toBeTruthy()
  })

  it('offers every member of the body, voting or advisory, as assignee', async () => {
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    const select = screen.getByLabelText('Zuständig')
    const names = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Niemand', 'Erika Beispiel', 'Max Muster', 'Berta Beratung'])
  })

  it('a refused save keeps the form and the typed title, and shows the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Ungültiges Fälligkeitsdatum.' }), { status: 400 }),
    )
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Aufgabe'), { target: { value: 'Kasse prüfen' } })
    await fireEvent.click(screen.getByText('Speichern'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Fälligkeitsdatum/))
    expect((screen.getByPlaceholderText('Aufgabe') as HTMLInputElement).value).toBe('Kasse prüfen')
    expect(calls('POST')).toHaveLength(1)
  })

  it('a double click on Speichern sends exactly one POST', async () => {
    let settle!: (res: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve }))
    render(Page, { props: { data: DATA } as never })
    await fireEvent.click(screen.getByText('+ Aufgabe hinzufügen'))
    await fireEvent.input(screen.getByPlaceholderText('Aufgabe'), { target: { value: 'Kasse prüfen' } })
    await fireEvent.click(screen.getByText('Speichern'))
    await fireEvent.click(screen.getByText('Speichern'))

    expect(calls('POST')).toHaveLength(1)
    settle(new Response(JSON.stringify({ actionItem: stored() }), { status: 201 }))
    await waitFor(() => expect(screen.queryByPlaceholderText('Aufgabe')).toBeNull())
    expect(screen.getAllByText('Kasse prüfen')).toHaveLength(1)
  })
})

describe('minutes editor — editing a task', () => {
  it('sends the due date under the name the route reads, and the draft view shows the saved title', async () => {
    const empty = stored({ text: '', due_date: null })
    render(Page, { props: { data: { ...DATA, actionItems: [empty] } } as never })
    await fireEvent.click(screen.getByText('✎'))
    await fireEvent.input(screen.getByPlaceholderText('Aufgabe'), { target: { value: 'Protokoll versenden' } })
    await fireEvent.input(screen.getByLabelText('Fällig bis'), { target: { value: '2026-12-10' } })
    await fireEvent.click(screen.getByText('Speichern'))

    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(bodyOf(calls('PATCH')[0])).toMatchObject({ text: 'Protokoll versenden', dueDate: '2026-12-10' })
    await waitFor(() => expect(screen.getByText('Protokoll versenden')).toBeTruthy())
    expect(screen.getByText(/10\.12\.2026/)).toBeTruthy()
  })

  it('opens a stored task with its date in the date field', async () => {
    render(Page, { props: { data: { ...DATA, actionItems: [stored()] } } as never })
    await fireEvent.click(screen.getByText('✎'))
    expect((screen.getByLabelText('Fällig bis') as HTMLInputElement).value).toBe('2026-12-10')
  })
})

describe('minutes editor — the Nextcloud draft', () => {
  it('says so when the draft document could not be created', () => {
    render(Page, {
      props: { data: { ...DATA, protocol: { ...DATA.protocol, draftDocumentMissing: true } } } as never,
    })
    expect(screen.getByText(/Entwurfsdokument/)).toBeTruthy()
  })

  it('stays quiet when there is nothing to report', () => {
    render(Page, { props: { data: DATA } as never })
    expect(screen.queryByText(/Entwurfsdokument/)).toBeNull()
  })
})
