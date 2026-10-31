import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte'
import type { ModuleOverview, ModuleOverviewItem } from '$lib/modules/switch-preview'
import TabModules from './TabModules.svelte'

// Karenz phase 1, Task 12: the settings section "Module". A council admin switches a module ON; the
// switch OFF is rendered inert until phase 2. Every server answer is a double here: the page shows
// what the server said and never claims a switch before the request is applied.
afterEach(() => {
  vi.unstubAllGlobals()
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
  ...over,
})
const overview = (modules: ModuleOverviewItem[], over: Partial<ModuleOverview> = {}): ModuleOverview => ({
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

  it('a denied module is listed with its reason and offers no switch', async () => {
    fetchDouble([ok(overview([item({ moduleId: 'board', label: 'Gremium', denied: 'it is not tenant-isolated yet' })]))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/not tenant-isolated yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Einschalten' })).toBeNull()
  })

  it('a history problem is shown as a note while the list stays', async () => {
    fetchDouble([ok(overview([item()], { problem: 'Der Verlauf der Modulanfragen konnte nicht geladen werden.' }))])
    render(TabModules, { props: { pollMs: 10_000 } })
    expect(await screen.findByText(/Verlauf der Modulanfragen/)).toBeTruthy()
    expect(screen.getByText('Abstimmungen')).toBeTruthy()
  })
})
