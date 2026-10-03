import { describe, it, expect, vi, afterEach } from 'vitest'

// createHeliosVoterSession short-circuits to a no-op stub when `browser` is
// false (SSR safety). Force browser mode so the iframe + listener path runs.
vi.mock('$app/environment', () => ({ browser: true }))

describe('HeliosVoterSession', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.querySelectorAll('iframe[data-helios-auth]').forEach((el) => el.remove())
    vi.resetModules()
  })

  it('starts in checking state', async () => {
    const { createHeliosVoterSession } = await import('./helios-voter-session.svelte')
    const session = createHeliosVoterSession({
      heliosBase: 'http://helios:8000',
      callbackPath: '/elections/abc/helios-cb',
      electionUuid: 'abc',
      gremionUiOrigin: 'http://localhost:3001',
    })
    expect(session.state).toBe('checking')
  })

  it('transitions to ready on a helios_auth postMessage from the GremionUI origin', async () => {
    const { createHeliosVoterSession } = await import('./helios-voter-session.svelte')
    const session = createHeliosVoterSession({
      heliosBase: 'http://helios:8000',
      callbackPath: '/elections/abc/helios-cb',
      electionUuid: 'abc',
      gremionUiOrigin: 'http://localhost:3001',
    })

    // The helios-cb callback page runs inside the iframe on the GremionUI
    // origin (return_url points back to GremionUI), so the postMessage that
    // signals success carries the GremionUI origin, not the Helios origin.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3001',
        data: { type: 'helios_auth', status: 'ok' },
      }),
    )

    expect(session.state).toBe('ready')
  })

  it('ignores postMessages from untrusted origins', async () => {
    const { createHeliosVoterSession } = await import('./helios-voter-session.svelte')
    const session = createHeliosVoterSession({
      heliosBase: 'http://helios:8000',
      callbackPath: '/elections/abc/helios-cb',
      electionUuid: 'abc',
      gremionUiOrigin: 'http://localhost:3001',
    })

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://evil.example.com',
        data: { type: 'helios_auth', status: 'ok' },
      }),
    )

    expect(session.state).toBe('checking')
  })

  it('transitions to needed after 3s timeout with no message', async () => {
    vi.useFakeTimers()
    const { createHeliosVoterSession } = await import('./helios-voter-session.svelte')
    const session = createHeliosVoterSession({
      heliosBase: 'http://helios:8000',
      callbackPath: '/elections/abc/helios-cb',
      electionUuid: 'abc',
      gremionUiOrigin: 'http://localhost:3001',
    })

    vi.advanceTimersByTime(3001)

    expect(session.state).toBe('needed')
    vi.useRealTimers()
  })
})
