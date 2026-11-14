// office-assign-dates.test.ts -- the term fields of the "Amt zuweisen" dialog.
// The browser's own date input follows the browser language, so the two term fields are typed and
// shown in German order (TT.MM.JJJJ) while the assign call keeps sending ISO dates. The default term
// (today until the same day one year later) is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }))
vi.mock('$app/navigation', () => nav)

import Page from './+page.svelte'

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []

const member = (id: string, displayName: string) => ({
  id: `m-${id}`, org_unit_id: 'ou-1', user_keycloak_id: id, membership_type: 'unelected',
  term_start: null, term_end: null, voting: true, joined_at: '2026-01-01T00:00:00.000Z', displayName,
})

const pageData = {
  committee: { id: 'ou-1', name: 'Vorstand', description: null },
  members: [member('u-anna', 'Anna Berger'), member('u-ben', 'Ben Hoffmann')],
  roles: [{ id: 'r-vors', org_unit_id: 'ou-1', name: 'Vorsitz', election_method: 'manual', is_elected: true, grace_period_days: 14, currentAssignment: null }],
  history: [],
  resources: [],
  user: { id: 'admin', roles: [] },
  isAdmin: true,
}

async function openDialog(): Promise<HTMLElement> {
  render(Page, { props: { data: pageData as never } })
  await fireEvent.click(screen.getByRole('button', { name: /Amt zuweisen/ }))
  return screen.getByRole('dialog')
}

const field = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(label) as HTMLInputElement

async function type(input: HTMLInputElement, text: string) {
  await fireEvent.input(input, { target: { value: text } })
}

beforeEach(() => {
  // Only the clock is faked: the default term is derived from "now".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'))
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null })
      return new Response(
        JSON.stringify({ success: true, groupsReconciled: true, data: { id: 'a-new', role_id: 'r-vors', user_keycloak_id: 'u-ben', start_date: '2026-12-01', end_date: '2027-11-30', status: 'active' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Amt zuweisen: the term is entered and shown in German order', () => {
  it('shows the default term as TT.MM.JJJJ in text fields: today until one year later', async () => {
    const dialog = await openDialog()
    const start = field(dialog, 'Amtszeit von')
    const end = field(dialog, 'Amtszeit bis')
    expect(start.type).toBe('text')
    expect(end.type).toBe('text')
    expect(start.value).toBe('12.11.2026')
    expect(end.value).toBe('12.11.2027')
    expect(start.placeholder).toBe('TT.MM.JJJJ')
  })

  it('offers no browser-format date field to the keyboard or to assistive technology', async () => {
    const dialog = await openDialog()
    const native = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="date"], input[type="datetime-local"]'))
    for (const input of native) {
      expect(input.getAttribute('aria-hidden')).toBe('true')
      expect(input.tabIndex).toBe(-1)
    }
    expect(within(dialog).getByRole('button', { name: 'Beginn der Amtszeit im Kalender wählen' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Ende der Amtszeit im Kalender wählen' })).toBeTruthy()
  })

  it('sends the default term as ISO dates', async () => {
    const dialog = await openDialog()
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ userKeycloakId: 'u-ben', startDate: '2026-11-12', endDate: '2027-11-12' })
  })

  it('sends a typed German term as ISO dates', async () => {
    const dialog = await openDialog()
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await type(field(dialog, 'Amtszeit von'), '1.12.2026')
    await type(field(dialog, 'Amtszeit bis'), '30.11.2027')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/governance/committees/ou-1/roles/r-vors/assign')
    expect(post.body).toEqual({ userKeycloakId: 'u-ben', startDate: '2026-12-01', endDate: '2027-11-30' })
  })

  it('takes a day chosen in the calendar and shows it in German order', async () => {
    const dialog = await openDialog()
    const picker = dialog.querySelectorAll<HTMLInputElement>('input[type="date"]')[1]
    expect(picker).toBeTruthy()
    picker.value = '2028-02-29'
    await fireEvent.change(picker)
    expect(field(dialog, 'Amtszeit bis').value).toBe('29.02.2028')
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Zuweisen' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect((calls.find((c) => c.method === 'POST')!.body as { endDate: string }).endDate).toBe('2028-02-29')
  })

  it('refuses a date that is not in German order: a hint shows and nothing is sent', async () => {
    const dialog = await openDialog()
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    const start = field(dialog, 'Amtszeit von')
    await type(start, '12/01/2026')
    expect(start.getAttribute('aria-invalid')).toBe('true')
    expect(within(dialog).getByText('Bitte im Format TT.MM.JJJJ eingeben.')).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: 'Zuweisen' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await fireEvent.click(confirm)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('refuses an end year below 1000: a hint shows, the text stays and nothing is sent', async () => {
    const dialog = await openDialog()
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    const end = field(dialog, 'Amtszeit bis')
    await type(end, '01.01.0999')
    await fireEvent.blur(end)
    expect(end.value).toBe('01.01.0999')
    expect(end.getAttribute('aria-invalid')).toBe('true')
    const confirm = within(dialog).getByRole('button', { name: 'Zuweisen' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await fireEvent.click(confirm)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('keeps the term order rule: an end on or before the start cannot be sent', async () => {
    const dialog = await openDialog()
    await fireEvent.change(within(dialog).getByLabelText('Mitglied'), { target: { value: 'u-ben' } })
    await type(field(dialog, 'Amtszeit bis'), '12.11.2026')
    expect((within(dialog).getByRole('button', { name: 'Zuweisen' }) as HTMLButtonElement).disabled).toBe(true)
    await type(field(dialog, 'Amtszeit bis'), '13.11.2026')
    expect((within(dialog).getByRole('button', { name: 'Zuweisen' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('opens with the default term again after the dialog was closed with other dates typed', async () => {
    const dialog = await openDialog()
    await type(field(dialog, 'Amtszeit von'), '01.01.2030')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await fireEvent.click(screen.getByRole('button', { name: /Amt zuweisen/ }))
    expect(field(screen.getByRole('dialog'), 'Amtszeit von').value).toBe('12.11.2026')
  })
})
