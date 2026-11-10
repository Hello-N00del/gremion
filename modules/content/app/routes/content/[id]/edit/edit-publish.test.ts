import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/svelte'

import Page from './+page.svelte'

// The editor's publish and schedule buttons must act on what the author sees:
// the ticked recipients and the text on screen, not the previously saved copy.

interface Call {
  url: string
  method: string
  body: unknown
}

interface Opts {
  lists?: { id: string; name: string }[]
  groups?: { id: string; name: string; path: string }[]
  stored?: { mailing_list_id: string | null; keycloak_group_id: string | null }[]
  getStatus?: number
  putStatus?: number
  putBody?: unknown
  patchStatus?: number
  publishStatus?: number
  publishBody?: unknown
  /** Hold the first body PATCH until hold.release() is called. */
  hold?: { release?: () => void }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(opts: Opts = {}): Call[] {
  const calls: Call[] = []
  let held = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.includes('/preview/') || url.includes('/carousel/')) return reply(500, {})
      if (url.endsWith('/recipients')) {
        if (method === 'PUT') return reply(opts.putStatus ?? 200, opts.putBody ?? { ok: true })
        const status = opts.getStatus ?? 200
        if (status !== 200) return reply(status, {})
        return reply(200, {
          recipients: opts.stored ?? [],
          lists: (opts.lists ?? [{ id: 'l1', name: 'Liste A' }]).map((l) => ({ ...l, created_at: 'x' })),
          groups: opts.groups ?? [],
        })
      }
      if (url.includes('/publish/')) {
        return reply(opts.publishStatus ?? 200, opts.publishBody ?? { status: 'sent', warnings: [], recipientCount: 1 })
      }
      if (method === 'PATCH') {
        const b = init?.body ? (JSON.parse(String(init.body)) as object) : {}
        if (opts.hold && !held && 'body_html' in b) {
          held = true
          await new Promise<void>((resolve) => {
            opts.hold!.release = resolve
          })
        }
        return reply(opts.patchStatus ?? 200, { ok: true })
      }
      return reply(404, {})
    }),
  )
  return calls
}

function renderPage() {
  return render(Page, {
    props: {
      data: {
        post: { id: 'p1', title: 'Titel', body_html: '<p>Text</p>' },
        channelEnabled: { email: true, portal: true, instagram: false },
        channelState: {
          email: { status: 'draft', scheduled_at: null },
          portal: { status: 'draft', scheduled_at: null },
          instagram: { status: 'draft', scheduled_at: null },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
}

const idx = (calls: Call[], pred: (c: Call) => boolean) => calls.findIndex(pred)
const isPut = (c: Call) => c.method === 'PUT' && c.url.endsWith('/recipients')
const isPublish = (c: Call) => c.method === 'POST' && c.url.includes('/publish/email')
const isSchedulePatch = (c: Call) =>
  c.method === 'PATCH' && !!c.body && typeof c.body === 'object' && 'scheduled_at' in (c.body as object)
const isBodyPatch = (c: Call) =>
  c.method === 'PATCH' && !!c.body && typeof c.body === 'object' && 'body_html' in (c.body as object)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('publish uses the audience that is ticked on screen', () => {
  it('saves the ticked list first, then publishes', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByRole } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    await waitFor(() => expect(calls.some(isPublish)).toBe(true))
    const put = idx(calls, isPut)
    expect(put).toBeGreaterThan(-1)
    expect(calls[put].body).toEqual({ recipients: [{ mailing_list_id: 'l1' }] })
    expect(put).toBeLessThan(idx(calls, isPublish))
  })

  it('refuses to publish when nothing is ticked, and sends nothing', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByRole, findByText } = renderPage()
    await findByLabelText('Liste A')
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(await findByText('Bitte mindestens einen Empfänger auswählen.')).toBeTruthy()
    expect(calls.some(isPut)).toBe(false)
    expect(calls.some(isPublish)).toBe(false)
  })

  it('does not overwrite the saved audience when the recipients never loaded', async () => {
    const calls = stubFetch({ getStatus: 500 })
    const { getAllByRole, findByText } = renderPage()
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/recipients'))).toBe(true))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(await findByText('Empfänger sind nicht geladen. Bitte Seite neu laden.')).toBeTruthy()
    expect(calls.some(isPut)).toBe(false)
    expect(calls.some(isPublish)).toBe(false)
  })

  it('aborts the publish and shows the server message when the audience cannot be saved', async () => {
    const calls = stubFetch({ putStatus: 400, putBody: { message: 'Gruppe nicht gefunden: gx' } })
    const { findByLabelText, getAllByRole, findByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(await findByText('Gruppe nicht gefunden: gx')).toBeTruthy()
    expect(calls.some(isPublish)).toBe(false)
  })

  it('does not touch the recipients when publishing the portal channel', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByRole } = renderPage()
    await findByLabelText('Liste A')
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[1])
    await waitFor(() => expect(calls.some((c) => c.url.includes('/publish/portal'))).toBe(true))
    expect(calls.some(isPut)).toBe(false)
  })

  it('saves the ticked audience before it schedules the send', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByLabelText, getAllByRole } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getAllByLabelText('Geplante Zeit')[0], { target: { value: '2030-01-01T10:00' } })
    await fireEvent.click(getAllByRole('button', { name: 'Planen' })[0])
    await waitFor(() => expect(calls.some(isSchedulePatch)).toBe(true))
    const put = idx(calls, isPut)
    expect(put).toBeGreaterThan(-1)
    expect(put).toBeLessThan(idx(calls, isSchedulePatch))
  })

  it('does not schedule with nothing ticked', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByLabelText, getAllByRole, findByText } = renderPage()
    await findByLabelText('Liste A')
    await fireEvent.input(getAllByLabelText('Geplante Zeit')[0], { target: { value: '2030-01-01T10:00' } })
    await fireEvent.click(getAllByRole('button', { name: 'Planen' })[0])
    expect(await findByText('Bitte mindestens einen Empfänger auswählen.')).toBeTruthy()
    expect(calls.some(isSchedulePatch)).toBe(false)
  })
})

describe('publish sends the text that is on screen', () => {
  it('flushes the pending autosave before it publishes, and the timer does not fire again', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByRole, getByLabelText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getByLabelText('Titel'), { target: { value: 'Neuer Titel' } })
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    await waitFor(() => expect(calls.some(isPublish)).toBe(true))
    const patch = idx(calls, isBodyPatch)
    expect(patch).toBeGreaterThan(-1)
    expect(calls[patch].body).toMatchObject({ title: 'Neuer Titel' })
    expect(patch).toBeLessThan(idx(calls, isPublish))
    // the debounce timer was cleared: no second save 800 ms later
    await new Promise((r) => setTimeout(r, 1000))
    expect(calls.filter(isBodyPatch)).toHaveLength(1)
  })

  it('refreshes the previews after it saved a pending edit, so they show the text that is sent', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByRole, getByLabelText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getByLabelText('Titel'), { target: { value: 'Neuer Titel' } })
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    await waitFor(() => expect(calls.some(isPublish)).toBe(true))
    const patch = idx(calls, isBodyPatch)
    await waitFor(() =>
      expect(calls.slice(patch + 1).some((c) => c.method === 'GET' && c.url.includes('/preview/'))).toBe(true),
    )
  })

  it('waits for an autosave that is already in flight, so the older text cannot land last', async () => {
    const hold: { release?: () => void } = {}
    const calls = stubFetch({ hold })
    const { findByLabelText, getAllByRole, getByLabelText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getByLabelText('Titel'), { target: { value: 'A' } })
    await waitFor(() => expect(calls.filter(isBodyPatch)).toHaveLength(1), { timeout: 3000 })
    await fireEvent.input(getByLabelText('Titel'), { target: { value: 'B' } })
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    await new Promise((r) => setTimeout(r, 100))
    // the second save has not been sent while the first one is still open
    expect(calls.filter(isBodyPatch)).toHaveLength(1)
    hold.release?.()
    await waitFor(() => expect(calls.some(isPublish)).toBe(true))
    const patches = calls.filter(isBodyPatch)
    expect(patches).toHaveLength(2)
    expect(patches[1].body).toMatchObject({ title: 'B' })
  })

  it('aborts the publish when the text cannot be saved', async () => {
    const calls = stubFetch({ patchStatus: 500 })
    const { findByLabelText, getAllByRole, findByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(await findByText(/Der Text konnte nicht gespeichert werden/)).toBeTruthy()
    expect(calls.some(isPublish)).toBe(false)
  })

  it('saves the text on screen before it schedules, and arms nothing when that fails', async () => {
    const calls = stubFetch()
    const { findByLabelText, getAllByLabelText, getAllByRole, getByLabelText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getByLabelText('Titel'), { target: { value: 'Neuer Titel' } })
    await fireEvent.input(getAllByLabelText('Geplante Zeit')[0], { target: { value: '2030-01-01T10:00' } })
    await fireEvent.click(getAllByRole('button', { name: 'Planen' })[0])
    await waitFor(() => expect(calls.some(isSchedulePatch)).toBe(true))
    const patch = idx(calls, isBodyPatch)
    expect(patch).toBeGreaterThan(-1)
    expect(patch).toBeLessThan(idx(calls, isSchedulePatch))
  })

  it('does not schedule when the text cannot be saved', async () => {
    const calls = stubFetch({ patchStatus: 500 })
    const { findByLabelText, getAllByLabelText, getAllByRole, findByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.input(getAllByLabelText('Geplante Zeit')[0], { target: { value: '2030-01-01T10:00' } })
    await fireEvent.click(getAllByRole('button', { name: 'Planen' })[0])
    expect(await findByText(/Der Text konnte nicht gespeichert werden/)).toBeTruthy()
    expect(calls.some(isSchedulePatch)).toBe(false)
  })
})

describe('an invalid group id cannot break a send', () => {
  it('shows a stored group that the list does not know, so it can be unticked', async () => {
    stubFetch({ stored: [{ mailing_list_id: null, keycloak_group_id: 'gx' }] })
    const { findByLabelText } = renderPage()
    const box = (await findByLabelText('gx (nicht in der Liste)')) as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it('does not duplicate a stored group that the list knows', async () => {
    stubFetch({
      groups: [{ id: 'g1', name: 'Vorstand', path: '/Stura/Vorstand' }],
      stored: [{ mailing_list_id: null, keycloak_group_id: 'g1' }],
    })
    const { findByLabelText, queryByLabelText } = renderPage()
    const box = (await findByLabelText('/Stura/Vorstand')) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(queryByLabelText('g1 (nicht in der Liste)')).toBeNull()
  })

  it('shows the message of the server when saving the recipients fails', async () => {
    stubFetch({ putStatus: 400, putBody: { message: 'Gruppe nicht gefunden: gx' } })
    const { findByLabelText, getByRole, findByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getByRole('button', { name: 'Empfänger speichern' }))
    expect(await findByText('Gruppe nicht gefunden: gx')).toBeTruthy()
  })

  it('shows a German text, not the generic English server text, when saving the recipients fails unexpectedly', async () => {
    stubFetch({ putStatus: 500, putBody: { message: 'Internal Error' } })
    const { findByLabelText, getByRole, findByText, queryByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getByRole('button', { name: 'Empfänger speichern' }))
    expect(await findByText('Empfänger konnten nicht gespeichert werden.')).toBeTruthy()
    expect(queryByText('Internal Error')).toBeNull()
  })

  it('shows a German text, not the generic English one, when the publish fails on the server', async () => {
    stubFetch({ publishStatus: 500, publishBody: { message: 'Internal Error' } })
    const { findByLabelText, getAllByRole, findByText, queryByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(
      await findByText('Veröffentlichung fehlgeschlagen. Bitte Empfänger prüfen und erneut versuchen.'),
    ).toBeTruthy()
    expect(queryByText('Internal Error')).toBeNull()
  })

  it('keeps the German message of the server for a 502 (a deployment fault the author cannot fix by retrying)', async () => {
    stubFetch({ publishStatus: 502, publishBody: { message: 'Mandantenkennung stimmt nicht. Bitte vom Betrieb prüfen lassen.' } })
    const { findByLabelText, getAllByRole, findByText, queryByText } = renderPage()
    await fireEvent.click(await findByLabelText('Liste A'))
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[0])
    expect(await findByText('Mandantenkennung stimmt nicht. Bitte vom Betrieb prüfen lassen.')).toBeTruthy()
    expect(queryByText(/Bitte Empfänger prüfen/)).toBeNull()
  })

  it('does not tell the author to check recipients when the portal channel fails', async () => {
    stubFetch({ publishStatus: 500, publishBody: { message: 'Internal Error' } })
    const { getAllByRole, findByText, queryByText } = renderPage()
    await fireEvent.click(getAllByRole('button', { name: 'Jetzt veröffentlichen' })[1])
    expect(await findByText('Veröffentlichung fehlgeschlagen. Bitte erneut versuchen.')).toBeTruthy()
    expect(queryByText(/Empfänger prüfen/)).toBeNull()
  })
})

describe('the group picker', () => {
  it('labels a body by its path and says that direct members are addressed', async () => {
    stubFetch({ groups: [{ id: 'g2', name: 'Vorstand', path: '/Stura/Vorstand' }] })
    const { findByLabelText, getByText } = renderPage()
    await findByLabelText('/Stura/Vorstand')
    expect(getByText(/nur die direkten Mitglieder/)).toBeTruthy()
  })
})

describe('the portal channel', () => {
  it('says that the post is stored internally and is not on a website yet', async () => {
    stubFetch()
    const { getByText } = renderPage()
    expect(getByText('Portal (intern abgelegt, noch nicht auf einer Website)')).toBeTruthy()
  })
})
