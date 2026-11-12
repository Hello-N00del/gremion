import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'

// F1-FIX-10-K / H04 (D-4 = WIRE IT): the Backups tab must show the REAL outcome
// of a run (started -> finished/failed with time), never "erfolgreich gestartet"
// for a request nothing consumed, and must disable the button with the reason
// when the host cannot take the trigger.
import TabBackups from './TabBackups.svelte'

const BACKUPS = { retention_days: 30, last_backup_at: null as string | null, encryption_key_path: '' }

interface RunRec {
  id: string
  state: 'started' | 'finished' | 'failed'
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  error?: string
}

type TriggerState = 'available' | 'not_configured' | 'unreachable'

function statusBody(opts: { available?: boolean; state?: TriggerState; reason?: string; run?: RunRec | null; last?: string | null }) {
  const state: TriggerState = opts.state ?? ((opts.available ?? true) ? 'available' : 'unreachable')
  return {
    success: true,
    data: [],
    trigger: { available: state === 'available', state, reason: opts.reason },
    run: opts.run ?? null,
    runs_state: opts.run ? [opts.run] : [],
    last_backup_at: opts.last ?? null,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const START_NAME = /Backup jetzt erstellen|Starte Backup|Backup läuft/
const CHECK_NAME = /Integritätsprüfung anfragen|Anfrage läuft/
const startButton = () => screen.getByRole('button', { name: START_NAME })
const checkButton = () => screen.getByRole('button', { name: CHECK_NAME })

describe('TabBackups.svelte: real backup outcome', () => {
  it('configured but unreachable: an error is shown and neither action can be started', async () => {
    const reason = 'Der Host-Dienst (hostd) ist nicht erreichbar. Aus der App kann derzeit kein Backup ausgelöst werden.'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(statusBody({ state: 'unreachable', reason })))
    vi.stubGlobal('fetch', fetchMock)

    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(reason)
    expect((startButton() as HTMLButtonElement).disabled).toBe(true)
    expect((checkButton() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('backup-not-managed')).toBeNull()
    // no POST was ever sent
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true)
  })

  it('an answer without a state field is read from `available` (older server shape)', async () => {
    const reason = 'Der Host-Dienst (hostd) antwortet nicht.'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ success: true, data: [], trigger: { available: false, reason }, run: null, runs_state: [], last_backup_at: null })),
    )
    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    expect((await screen.findByRole('alert')).textContent).toContain(reason)
    expect((startButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows started, then finished with the time, and never "erfolgreich gestartet"', async () => {
    const running: RunRec = { id: 'r1', state: 'started', startedAt: '2026-10-01T10:00:00.000Z' }
    const done: RunRec = { ...running, state: 'finished', finishedAt: '2026-10-01T10:05:00.000Z', exitCode: 0 }
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return json({ success: true, data: { started: true, state: 'started', run_id: 'r1', timestamp: running.startedAt } }, 202)
        }
        polls += 1
        // 1: initial load (idle). 2: first poll after POST (running). 3+: finished.
        if (polls === 1) return json(statusBody({}))
        if (polls === 2) return json(statusBody({ run: running }))
        return json(statusBody({ run: done, last: done.finishedAt }))
      }),
    )

    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    await fireEvent.click(startButton())

    expect(await screen.findByTestId('backup-run-state')).toBeTruthy()
    expect(screen.queryByText(/erfolgreich gestartet/)).toBeNull()
    await vi.waitFor(() => expect(screen.getByTestId('backup-run-state').textContent).toMatch(/abgeschlossen/))
    expect(screen.queryByText(/erfolgreich gestartet/)).toBeNull()
    // the shown time comes from the finished run
    expect(screen.getByTestId('backup-last-at').textContent).toMatch(/2026|01\.10\./)
  })

  it('shows a failed run as failed and keeps "letztes Backup" empty', async () => {
    const failed: RunRec = {
      id: 'r2',
      state: 'failed',
      startedAt: '2026-10-01T10:00:00.000Z',
      finishedAt: '2026-10-01T10:01:00.000Z',
      exitCode: 1,
      error: 'Backup fehlgeschlagen (Exit 1).',
    }
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ success: true, data: { started: true, state: 'started', run_id: 'r2', timestamp: failed.startedAt } }, 202)
        polls += 1
        return json(polls === 1 ? statusBody({}) : statusBody({ run: failed }))
      }),
    )

    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    await fireEvent.click(startButton())

    await vi.waitFor(() => expect(screen.getByTestId('backup-run-state').textContent).toMatch(/fehlgeschlagen/))
    expect(screen.getByTestId('backup-last-at').textContent).toMatch(/Noch kein erfolgreiches Backup/)
  })

  it('shows the server refusal (503) instead of a success message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ success: false, error: 'Der Host-Dienst (hostd) antwortet nicht.', code: 'unavailable' }, 503)
        return json(statusBody({}))
      }),
    )

    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    await fireEvent.click(startButton())

    expect(await screen.findByText(/Host-Dienst \(hostd\) antwortet nicht/)).toBeTruthy()
    expect(screen.queryByTestId('backup-run-state')).toBeNull()
  })

  it('resumes polling when the page loads while a run is already in flight', async () => {
    const running: RunRec = { id: 'r3', state: 'started', startedAt: '2026-10-01T10:00:00.000Z' }
    const done: RunRec = { ...running, state: 'finished', finishedAt: '2026-10-01T10:05:00.000Z', exitCode: 0 }
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        polls += 1
        return json(polls === 1 ? statusBody({ run: running }) : statusBody({ run: done, last: done.finishedAt }))
      }),
    )
    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await vi.waitFor(() => expect(screen.getByTestId('backup-run-state').textContent).toMatch(/abgeschlossen/))
  })
})

// The host daemon is optional. Where an installation has none configured, the
// operator runs backups outside the app, and the tab has to say exactly that:
// no daemon or socket wording, no action that cannot do anything, and no line
// claiming that no backup exists.
describe('TabBackups.svelte: backups not managed from the app', () => {
  const RAW = 'Der Host-Dienst (hostd) ist nicht erreichbar: sein Socket fehlt.'

  it('says who runs backups and offers neither action', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(statusBody({ state: 'not_configured', reason: RAW })))
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })

    const notice = await screen.findByTestId('backup-not-managed')
    expect(notice.textContent).toMatch(/nicht aus der App gesteuert/)
    expect(notice.textContent).toMatch(/Betreiber/)
    expect(notice.textContent).toMatch(/außerhalb der App/)
    // why the actions are missing
    expect(notice.textContent).toMatch(/weder ein Backup noch eine Integritätsprüfung/)

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/hostd/i)
    expect(text).not.toMatch(/socket/i)
    expect(text).not.toMatch(/nächsten Backup-Lauf/)
    expect(text).not.toMatch(/Noch kein erfolgreiches Backup/)
    expect(text).not.toMatch(/Keine Backups vorhanden/)
    expect(screen.queryByRole('alert')).toBeNull()

    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull()
    expect(screen.queryByRole('button', { name: CHECK_NAME })).toBeNull()
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true)
  })

  it('still shows a recorded last successful backup, without claiming there is none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(statusBody({ state: 'not_configured', last: '2026-10-01T10:05:00.000Z' }))),
    )
    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByTestId('backup-not-managed')
    expect(screen.getByTestId('backup-last-at').textContent).toMatch(/Letztes erfolgreiches Backup/)
  })

  it('a refusal with code not_configured switches to the notice instead of showing an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ success: false, error: RAW, code: 'not_configured' }, 503)
        return json(statusBody({}))
      }),
    )
    const { container } = render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    await fireEvent.click(startButton())

    expect(await screen.findByTestId('backup-not-managed')).toBeTruthy()
    expect(container.textContent ?? '').not.toMatch(/hostd|socket/i)
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull()
  })
})

describe('TabBackups.svelte: integrity check', () => {
  it('is offered while the host daemon is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(statusBody({}))))
    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    expect((checkButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('a refusal with code not_configured is not shown as a pending check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ success: false, error: 'x', code: 'not_configured' }, 503)
        return json(statusBody({}))
      }),
    )
    const { container } = render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })
    await screen.findByText('Keine Backups vorhanden.')
    await fireEvent.click(checkButton())

    expect(await screen.findByTestId('backup-not-managed')).toBeTruthy()
    expect(container.textContent ?? '').not.toMatch(/nächsten Backup-Lauf/)
  })
})
