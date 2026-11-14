import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/svelte'
import type { KarenzView, ModuleOverview, ModuleOverviewItem } from '$lib/modules/switch-preview'
import TabModules from './TabModules.svelte'

// Karenz phase 1, Task 12: the settings section "Module". A council admin switches a module ON; the
// switch OFF is rendered inert until phase 2. Every server answer is a double here: the page shows
// what the server said and never claims a switch before the request is applied.
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

const item = (over: Partial<ModuleOverviewItem> = {}): ModuleOverviewItem => ({
  moduleId: 'votes',
  label: 'Abstimmungen',
  enabled: false,
  managed: true,
  dpiaRecorded: true,
  denied: null,
  pending: [],
  lastFailure: null,
  karenz: null,
  ...over,
})
const karenzView = (over: Partial<KarenzView> = {}): KarenzView => ({
  karenzId: '55555555-5555-4555-8555-555555555555',
  state: 'open',
  switchedOffAt: '2026-11-05T09:00:00.000Z',
  finalAt: '2026-12-05T09:00:00.000Z',
  daysLeft: 25,
  canRestore: true,
  mail: null,
  mailFailed: false,
  problems: [],
  retained: [],
  backupHref: '/settings/sicherungen',
  ...over,
})
const overview =(modules: ModuleOverviewItem[], over: Partial<ModuleOverview> = {}): ModuleOverview => ({
  modules,
  disableAvailable: false,
  problem: null,
  ...over,
})
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

/** Routes a fetch double by method; GET answers come from `gets` in order (the last one repeats). */
function fetchDouble(gets: Array<Response | (() => Response)>, post?: (body: Record<string, unknown>) => Response) {
  let n = 0
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ url, method, body })
    if (method === 'POST') return post ? post(body ?? {}) : reply(201, { success: true, requestId: 'r1' })
    const g = gets[Math.min(n++, gets.length - 1)]!
    return typeof g === 'function' ? g() : g.clone()
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}
const getCount = (calls: { method: string }[]) => calls.filter((c) => c.method === 'GET').length

describe('TabModules.svelte', () => {
  it('lists the modules with their state, the DPIA state and a denied reason', async () => {
    fetchDouble([
      ok(overview([item({ enabled: true, dpiaRecorded: true }), item({ moduleId: 'calendar', label: 'Kalender', dpiaRecorded: false, managed: false, enabled: true })])),
    ])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(screen.getByText('Kalender')).toBeTruthy()
    expect(screen.getAllByText('Eingeschaltet')).toHaveLength(2)
    expect(screen.getByText('DPIA-Entscheidung hinterlegt')).toBeTruthy()
    expect(screen.getByText('DPIA-Entscheidung fehlt noch')).toBeTruthy()
  })

  it('shows "nicht konfiguriert" for a 503 NOT_CONFIGURED, never an empty list', async () => {
    fetchDouble([reply(503, { success: false, code: 'NOT_CONFIGURED', error: 'Modulschalter nicht konfiguriert.' })])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect((await screen.findByRole('alert')).textContent).toContain('Modulschalter nicht konfiguriert')
    expect(screen.queryByRole('button', { name: 'Einschalten' })).toBeNull()
  })

  it('enabling a module with a recorded DPIA decision posts {moduleId, action:"enable"} without DPIA fields', async () => {
    const { calls } = fetchDouble([ok(overview([item({ enabled: false, dpiaRecorded: true })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/settings/modules')
    expect(post.body).toEqual({ moduleId: 'votes', action: 'enable' })
  })

  it('without a recorded decision the enable form asks for the DPIA answer and the document reference, then posts them', async () => {
    const { calls } = fetchDouble([ok(overview([item({ enabled: false, dpiaRecorded: false })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    // nothing is posted yet: the form opened
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    const submit = screen.getByRole('button', { name: /Einschalten und Entscheidung festhalten/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await fireEvent.change(screen.getByLabelText(/DPIA erforderlich/), { target: { value: 'no' } })
    await fireEvent.input(screen.getByLabelText(/Dokumentverweis/), { target: { value: 'TOM 4.2' } })
    expect(submit.disabled).toBe(false)
    await fireEvent.click(submit)
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      moduleId: 'votes',
      action: 'enable',
      dpia: { requiresDpia: false, documentRef: 'TOM 4.2' },
    })
  })

  it('a 422 DPIA_REQUIRED opens the DPIA fields instead of an error toast', async () => {
    fetchDouble(
      [ok(overview([item({ enabled: false, dpiaRecorded: true })]))],
      () => reply(422, { success: false, code: 'DPIA_REQUIRED', error: 'Für dieses Modul liegt noch keine DPIA-Entscheidung vor.' }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    expect(await screen.findByLabelText(/Dokumentverweis/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a 401 STEP_UP_REQUIRED sends the user to /auth/step-up with returnTo, without queuing anything', async () => {
    const navigate = vi.fn()
    fetchDouble([ok(overview([item({ dpiaRecorded: true })]))], () => reply(401, { error: 'STEP_UP_REQUIRED', requiredLoa: 2 }))
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/step-up?returnTo=/settings/module'))
  })

  it('a refusal (409 / 422) shows the server text in role=alert', async () => {
    fetchDouble(
      [ok(overview([item({ dpiaRecorded: true })]))],
      () => reply(409, { success: false, code: 'IN_FLIGHT', error: 'Für diesen Mandanten läuft bereits eine Anfrage.' }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    expect((await screen.findByRole('alert')).textContent).toContain('läuft bereits eine Anfrage')
  })

  it('pending requests show the notice in queued state and polling stops after applied', async () => {
    const pending = ok(overview([item({ pending: [{ requestId: 'r1', action: 'enable', state: 'queued' }] })]))
    const done = ok(overview([item({ enabled: true, pending: [] })]))
    const { calls } = fetchDouble([pending, pending, done])
    render(TabModules, { props: { pollMs: 15 } })
    expect(await screen.findByText('Anfrage wird ausgeführt')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Eingeschaltet')).toBeTruthy())
    expect(screen.queryByText('Anfrage wird ausgeführt')).toBeNull()
    const settled = getCount(calls)
    await new Promise((r) => setTimeout(r, 120))
    expect(getCount(calls)).toBe(settled)
  })

  it('while a request is pending the module offers no second switch', async () => {
    fetchDouble([ok(overview([item({ pending: [{ requestId: 'r1', action: 'enable', state: 'applying' }] })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    await screen.findByText('Anfrage wird ausgeführt')
    expect((screen.getByRole('button', { name: 'Einschalten' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed request shows its outcome in role=alert and nothing reads as switched', async () => {
    fetchDouble([ok(overview([item({ enabled: false, lastFailure: 'DPIA gate refused: NO_DPIA_DECISION' })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('DPIA gate refused: NO_DPIA_DECISION')
    expect(alert.textContent).toContain('nicht ausgeführt')
    expect(screen.queryByText('Eingeschaltet')).toBeNull()
  })

  it('with disableAvailable false the disable control is inert and shows the explanatory text', async () => {
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })], { disableAvailable: false }))])
    render(TabModules, { props: { pollMs: 10_000 } })
    const btn = (await screen.findByRole('button', { name: /Ausschalten folgt mit der 30-Tage-Frist/ })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    await fireEvent.click(btn)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(calls.some((c) => c.url.includes('preview='))).toBe(false)
  })

  it('with disableAvailable true the disable control loads the preview and opens the warning', async () => {
    const preview = {
      moduleId: 'votes',
      moduleLabel: 'Abstimmungen',
      confirmPhrase: 'Abstimmungen',
      deletes: [{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }],
      retained: [],
      graceDays: 30,
      finalDeletionAt: null,
      recoverable: true,
    }
    const { calls } = fetchDouble([
      ok(overview([item({ enabled: true })], { disableAvailable: true })),
      ok(preview),
      ok(overview([item({ enabled: true })], { disableAvailable: true })),
    ])
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Ausschalten' }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(calls.some((c) => c.url === '/api/settings/modules?preview=votes')).toBe(true)
    await fireEvent.input(screen.getByLabelText(/Namen des Moduls/), { target: { value: 'Abstimmungen' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Modul ausschalten' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' })
  })

  it('an applying request that carries a config error shows that error, not only the running notice', async () => {
    fetchDouble([
      ok(
        overview([
          item({ pending: [{ requestId: 'r1', action: 'enable', state: 'applying' }], lastFailure: 'config.json not writable' }),
        ]),
      ),
    ])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Anfrage wird ausgeführt')).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('config.json not writable')
  })

  it('a failed refresh after the first load says the list may be out of date, and clears on the next good one', async () => {
    const good = ok(overview([item({ pending: [{ requestId: 'r1', action: 'enable', state: 'queued' }] })]))
    const { calls } = fetchDouble([good, () => reply(500, { success: false }), good])
    render(TabModules, { props: { pollMs: 15 } })
    expect(await screen.findByText('Anfrage wird ausgeführt')).toBeTruthy()
    expect(await screen.findByText(/nicht aktualisiert werden/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/nicht aktualisiert werden/)).toBeNull())
    expect(getCount(calls)).toBeGreaterThanOrEqual(3)
  })

  it('cancelling the switch-off warning while the disable request is in flight does not crash the tab when it fails', async () => {
    const preview = {
      moduleId: 'votes',
      moduleLabel: 'Abstimmungen',
      confirmPhrase: 'Abstimmungen',
      deletes: [{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }],
      retained: [],
      graceDays: 30,
      finalDeletionAt: null,
      recoverable: true,
    }
    let release: (r: Response) => void = () => {}
    const slowPost = new Promise<Response>((r) => (release = r))
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return slowPost
        return n++ === 0 ? ok(overview([item({ enabled: true })], { disableAvailable: true })) : n === 2 ? ok(preview) : ok(overview([item({ enabled: true })], { disableAvailable: true }))
      }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Ausschalten' }))
    await screen.findByRole('alertdialog')
    await fireEvent.input(screen.getByLabelText(/Namen des Moduls/), { target: { value: 'Abstimmungen' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Modul ausschalten' }))
    // while the request is out the dialog cannot be closed from under it
    const cancel = screen.getByRole('button', { name: 'Abbrechen' }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    // jsdom still runs the handler of a disabled button on a synthetic click: this is the race itself
    // (the dialog closed while the request is out), so the late refusal must not rebuild a closed dialog
    await fireEvent.click(cancel)
    release(reply(409, { success: false, code: 'IN_FLIGHT', error: 'Für diesen Mandanten läuft bereits eine Anfrage.' }))
    await new Promise((r) => setTimeout(r, 50))
    // the tab is still alive and renders the list
    expect(screen.getByTestId('tab-modules')).toBeTruthy()
    expect(screen.getByText('Abstimmungen')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a denied module is listed with its reason and offers no switch', async () => {
    fetchDouble([ok(overview([item({ moduleId: 'board', label: 'Gremium', denied: 'it is not tenant-isolated yet' })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/not tenant-isolated yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Einschalten' })).toBeNull()
  })

  it('a module in Karenz shows days left and a restore button that posts enable (no DPIA fields, no second Einschalten)', async () => {
    const { calls } = fetchDouble([ok(overview([item({ enabled: false, dpiaRecorded: false, karenz: karenzView() })], { disableAvailable: true }))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/Noch 25 Tage/)).toBeTruthy()
    // the plain enable button gives way to the restore button of the status block
    expect(screen.queryByRole('button', { name: 'Einschalten' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Modul wieder einschalten' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ moduleId: 'votes', action: 'enable' })
    expect(screen.queryByLabelText(/Dokumentverweis/)).toBeNull()
  })

  it('a refused restore shows the server text in role=alert', async () => {
    fetchDouble(
      [ok(overview([item({ enabled: false, karenz: karenzView() })], { disableAvailable: true }))],
      () => reply(409, { success: false, code: 'KARENZ_FINALIZING', error: 'Die endgültige Löschung läuft gerade.' }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Modul wieder einschalten' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Die endgültige Löschung läuft gerade.')
  })

  it('a finalizing Karenz offers no switch at all (neither Einschalten nor restore)', async () => {
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ state: 'finalizing', canRestore: false }) })], { disableAvailable: true }))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/endgültige Löschung läuft/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Einschalten' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Modul wieder einschalten' })).toBeNull()
  })

  it('problems of the Karenz render in role=alert', async () => {
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ problems: ['Schritt participant:votes:switchoff fehlgeschlagen: KarenzPartialError (1 item(s))'] }) })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('participant:votes:switchoff')
  })

  it('the mail line appears only after the notice step succeeded', async () => {
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ mail: null }) })]))])
    const before = render(TabModules, { props: { pollMs: 10_000 } })
    await screen.findByText(/Noch 25 Tage/)
    expect(before.container.textContent).not.toContain('Info-Mail')
    before.unmount()

    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ mail: { recipients: 2, failed: 0, skippedHolders: 0 } }) })]))])
    const after = render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Eine Info-Mail ging an 2 Empfänger.')).toBeTruthy()
    after.unmount()

    // a done step with nobody reached (N = 0) claims nothing
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ mail: { recipients: 0, failed: 0, skippedHolders: 2 } }) })]))])
    const none = render(TabModules, { props: { pollMs: 10_000 } })
    await screen.findByText(/Noch 25 Tage/)
    expect(none.container.textContent).not.toContain('Eine Info-Mail ging an')
  })

  it('a failed info mail is an alert, not a mail line', async () => {
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView({ mail: null, mailFailed: true }) })]))])
    const { container } = render(TabModules, { props: { pollMs: 10_000 } })
    await screen.findByText(/Noch 25 Tage/)
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('Info-Mail')
    expect(container.textContent).not.toContain('Eine Info-Mail ging an')
  })

  it('retained downloads link to /api/settings/modules/retained?id=', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    fetchDouble([
      ok(overview([item({ enabled: false, karenz: karenzView({ retained: [{ id, label: 'Wahlergebnisse', lineCount: 3, href: `/api/settings/modules/retained?id=${id}` }] }) })])),
    ])
    render(TabModules, { props: { pollMs: 10_000 } })
    const link = await screen.findByRole('link', { name: /Wahlergebnisse/ })
    expect(link.getAttribute('href')).toBe(`/api/settings/modules/retained?id=${id}`)
  })

  it('a history problem is shown as a note while the list stays', async () => {
    fetchDouble([ok(overview([item()], { problem: 'Der Verlauf der Modulanfragen konnte nicht geladen werden.' }))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/Verlauf der Modulanfragen/)).toBeTruthy()
    expect(screen.getByText('Abstimmungen')).toBeTruthy()
  })

  // Einstellungen > Module listed only what the council may switch; content, files, messaging and publishing
  // were missing although the customer had them on. They are listed now, honestly marked, without a control.
  describe('modules the operator manages', () => {
    const operator = [
      { moduleId: 'messaging', label: 'Chat' },
      { moduleId: 'files', label: 'Dokumente' },
      { moduleId: 'content', label: 'Inhalte' },
      { moduleId: 'publishing', label: 'Newsletter' },
    ]

    it('lists every one of them with its state and "Vom Betreiber verwaltet", next to the switchable ones', async () => {
      fetchDouble([
        ok({
          ...overview([item({ enabled: true }), item({ moduleId: 'calendar', label: 'Kalender', enabled: true })]),
          operatorModules: operator,
        }),
      ])
      render(TabModules, { props: { pollMs: 10_000 } })
      expect(await screen.findByText('Abstimmungen')).toBeTruthy()
      expect(screen.getByText('Kalender')).toBeTruthy()
      for (const m of operator) {
        const li = document.querySelector(`[data-module="${m.moduleId}"]`) as HTMLElement
        expect(li, m.moduleId).not.toBeNull()
        expect(within(li).getByText(m.label)).toBeTruthy()
        expect(within(li).getByText('Eingeschaltet')).toBeTruthy()
        expect(within(li).getByText('Vom Betreiber verwaltet')).toBeTruthy()
      }
      expect(screen.getByRole('list', { name: 'Vom Betreiber verwaltete Module' })).toBeTruthy()
    })

    it('an operator row has no control at all: no switch, no DPIA line, no dead button', async () => {
      fetchDouble([ok({ ...overview([item({ enabled: true })], { disableAvailable: true }), operatorModules: operator })])
      render(TabModules, { props: { pollMs: 10_000 } })
      await screen.findByText('Abstimmungen')
      for (const m of operator) {
        const li = document.querySelector(`[data-module="${m.moduleId}"]`) as HTMLElement
        expect(within(li).queryAllByRole('button')).toHaveLength(0)
        expect(within(li).queryByText(/DPIA/)).toBeNull()
      }
      // the switchable row keeps its switch as before
      const votes = document.querySelector('[data-module="votes"]') as HTMLElement
      expect(within(votes).getByRole('button', { name: 'Ausschalten' })).toBeTruthy()
    })

    it('a switchable row does not read as operator-managed', async () => {
      fetchDouble([ok({ ...overview([item({ enabled: true })]), operatorModules: operator })])
      render(TabModules, { props: { pollMs: 10_000 } })
      await screen.findByText('Abstimmungen')
      const votes = document.querySelector('[data-module="votes"]') as HTMLElement
      expect(within(votes).queryByText('Vom Betreiber verwaltet')).toBeNull()
    })

    it('without any operator module (or an answer that predates the field) the list is the switchable one and no empty second list shows', async () => {
      fetchDouble([ok(overview([item({ enabled: true })])), ok({ ...overview([item({ enabled: true })]), operatorModules: [] })])
      const { unmount } = render(TabModules, { props: { pollMs: 10_000 } })
      expect(await screen.findByText('Abstimmungen')).toBeTruthy()
      expect(screen.queryByRole('list', { name: 'Vom Betreiber verwaltete Module' })).toBeNull()
      unmount()
      render(TabModules, { props: { pollMs: 10_000 } })
      expect(await screen.findByText('Abstimmungen')).toBeTruthy()
      expect(screen.queryByRole('list', { name: 'Vom Betreiber verwaltete Module' })).toBeNull()
    })

    it('only operator modules: they show although the switchable list is empty', async () => {
      fetchDouble([ok({ ...overview([]), operatorModules: operator })])
      render(TabModules, { props: { pollMs: 10_000 } })
      expect(await screen.findByText('Dokumente')).toBeTruthy()
    })
  })
})

// A switch needs a fresh second factor, and the way there is a full round trip through the sign-in service:
// the page comes back as a new page that holds nothing. The server keeps the confirmed switch for that trip
// (modules.test.ts); the page leaves a mark in the tab and, once it is back, asks the server ONCE to carry
// the kept switch out. The mark carries no content, and every decision is the server's.
describe('TabModules.svelte: the switch confirmed before the second factor is carried out after it', () => {
  const MARK = 'gremion.module-switch.resume'
  const STEP_UP = '/auth/step-up?returnTo=/settings/module'
  /** The mark the page left when it went to the second factor, `agoMs` ago. */
  const leaveMark = (agoMs = 40_000) => sessionStorage.setItem(MARK, (Date.now() - agoMs).toString())
  const isResume = (c: { method: string; body: Record<string, unknown> | null }) => c.method === 'POST' && c.body?.resume === true
  const needsSecondFactor = () => reply(401, { error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
  const resumed = () => reply(201, { success: true, resumed: true, requestId: 'r1', moduleId: 'votes', action: 'disable' })
  const preview = {
    moduleId: 'votes',
    moduleLabel: 'Abstimmungen',
    confirmPhrase: 'Abstimmungen',
    deletes: [{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }],
    retained: [],
    graceDays: 30,
    finalDeletionAt: null,
    recoverable: true,
  }

  it('switch-on: the 401 leaves the mark in the tab before the browser goes to the second factor', async () => {
    let markWhenLeaving: string | null = null
    const navigate = vi.fn(() => {
      markWhenLeaving = sessionStorage.getItem(MARK)
    })
    fetchDouble([ok(overview([item({ dpiaRecorded: true })]))], needsSecondFactor)
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Einschalten' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(STEP_UP))
    expect(markWhenLeaving).not.toBeNull()
  })

  it('switch-off: the 401 after the typed name leaves the mark too', async () => {
    const navigate = vi.fn()
    fetchDouble([ok(overview([item({ enabled: true })], { disableAvailable: true })), ok(preview)], needsSecondFactor)
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Ausschalten' }))
    await fireEvent.input(await screen.findByLabelText(/Namen des Moduls/), { target: { value: 'Abstimmungen' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Modul ausschalten' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(STEP_UP))
    expect(sessionStorage.getItem(MARK)).not.toBeNull()
  })

  it('the restore button leaves the mark as well', async () => {
    const navigate = vi.fn()
    fetchDouble([ok(overview([item({ enabled: false, karenz: karenzView() })], { disableAvailable: true }))], needsSecondFactor)
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Modul wieder einschalten' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(STEP_UP))
    expect(sessionStorage.getItem(MARK)).not.toBeNull()
  })

  it('back from the second factor: one { resume: true } goes out before the list is loaded, and the list shows the switch as running', async () => {
    leaveMark()
    const navigate = vi.fn()
    const { calls } = fetchDouble(
      [ok(overview([item({ enabled: true, pending: [{ requestId: 'r1', action: 'disable', state: 'queued' }] })], { disableAvailable: true }))],
      resumed,
    )
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    expect(await screen.findByText('Anfrage wird ausgeführt')).toBeTruthy()
    expect(calls.filter(isResume)).toHaveLength(1)
    // the resume carries nothing but the word: the kept input is the server's
    expect(calls.find(isResume)).toMatchObject({ url: '/api/settings/modules', body: { resume: true } })
    expect(calls.findIndex(isResume)).toBeLessThan(calls.findIndex((c) => c.method === 'GET'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(MARK)).toBeNull()
  })

  it('exactly once: the mark is spent by the first page, a reload does not resume again', async () => {
    leaveMark()
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })]))], resumed)
    const first = render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    first.unmount()
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(getCount(calls)).toBe(2)
    expect(calls.filter(isResume)).toHaveLength(1)
  })

  it('without the mark nothing is resumed: an ordinary visit only loads the list', async () => {
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it.each([
    ['left long ago (the round trip was given up)', () => leaveMark(16 * 60_000)],
    ['from the future', () => leaveMark(-60_000)],
    ['not a time at all', () => sessionStorage.setItem(MARK, 'votes:disable')],
  ])('a mark %s is dropped without asking the server', async (_name, leave) => {
    leave()
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(sessionStorage.getItem(MARK)).toBeNull()
  })

  it('a refused resume shows the reason at its module and never leads to a second round trip', async () => {
    leaveMark()
    const navigate = vi.fn()
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })], { disableAvailable: true }))], () =>
      reply(409, { success: false, code: 'RESUME_UNCONFIRMED', error: 'Die Zwei-Faktor-Prüfung wurde nicht abgeschlossen.', moduleId: 'votes', action: 'disable' }),
    )
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    expect((await screen.findByRole('alert')).textContent).toContain('Zwei-Faktor-Prüfung wurde nicht abgeschlossen')
    expect(screen.getByText('Abstimmungen')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(MARK)).toBeNull()
    expect(calls.filter(isResume)).toHaveLength(1)
  })

  it('a refusal that names no module is shown above the list', async () => {
    leaveMark()
    const navigate = vi.fn()
    fetchDouble([ok(overview([item({ enabled: true })]))], () => reply(409, { success: false, code: 'RESUME_GONE', error: 'Die bestätigte Aktion liegt nicht mehr vor.' }))
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    expect((await screen.findByTestId('module-resume-error')).textContent).toContain('liegt nicht mehr vor')
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('even a 401 answer to the resume is only shown: the page never starts the second factor by itself', async () => {
    leaveMark()
    const navigate = vi.fn()
    const { calls } = fetchDouble([ok(overview([item({ enabled: true })]))], needsSecondFactor)
    render(TabModules, { props: { pollMs: 10_000, navigate } })
    expect((await screen.findByTestId('module-resume-error')).textContent).toContain('Die Anfrage konnte nicht gestellt werden.')
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(MARK)).toBeNull()
    expect(calls.filter(isResume)).toHaveLength(1)
  })

  it('a resumed switch-on that still needs the DPIA decision opens the DPIA fields of that module', async () => {
    leaveMark()
    fetchDouble([ok(overview([item({ enabled: false, dpiaRecorded: false })]))], () =>
      reply(422, { success: false, code: 'DPIA_REQUIRED', error: 'Für dieses Modul liegt noch keine DPIA-Entscheidung vor.', moduleId: 'votes', action: 'enable' }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByLabelText(/Dokumentverweis/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('when the server cannot be reached the list is still loaded and the failure is said', async () => {
    leaveMark()
    let posted = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          posted += 1
          throw new TypeError('network')
        }
        return ok(overview([item({ enabled: true })]))
      }),
    )
    render(TabModules, { props: { pollMs: 10_000 } })
    expect((await screen.findByTestId('module-resume-error')).textContent).toContain('Keine Verbindung zum Server.')
    expect(await screen.findByText('Abstimmungen')).toBeTruthy()
    expect(posted).toBe(1)
  })
})
