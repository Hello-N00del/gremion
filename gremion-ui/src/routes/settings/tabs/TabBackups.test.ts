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

function statusBody(opts: { available?: boolean; reason?: string; run?: RunRec | null; last?: string | null }) {
  return {
    success: true,
    data: [],
    trigger: { available: opts.available ?? true, reason: opts.reason },
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

const startButton = () => screen.getByRole('button', { name: /Backup jetzt erstellen|Starte Backup|Backup läuft/ })

describe('TabBackups.svelte: real backup outcome', () => {
  it('disables the button and shows the reason when hostd cannot take the trigger', async () => {
    const reason = 'Der Host-Dienst (hostd) ist nicht erreichbar: sein Socket fehlt.'
    const fetchMock = vi.fn(async () => json(statusBody({ available: false, reason })))
    vi.stubGlobal('fetch', fetchMock)

    render(TabBackups, { props: { backups: BACKUPS, pollMs: 5 } })

    expect(await screen.findByText(reason)).toBeTruthy()
    expect((startButton() as HTMLButtonElement).disabled).toBe(true)
    // no POST was ever sent
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true)
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
