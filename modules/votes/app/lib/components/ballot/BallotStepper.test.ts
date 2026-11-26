/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://b.example.org/elections/e1" }
 *
 * The ballot stepper on a secondary customer host. One gremion-ui serves every host and its process env
 * (PUBLIC_BASE_URL) names ONE of them, host A here; the voter is on host B. The Helios sign-in must return to
 * host B, and the session check must accept the callback message only from host B.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'

vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_BASE_URL: 'https://a.example.org' } }))

const created = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown>> }))
vi.mock('$lib/client/helios-voter-session.svelte', () => ({
  createHeliosVoterSession: (o: Record<string, unknown>) => {
    created.opts.push(o)
    return { state: 'needed', destroy() {} }
  },
}))
vi.mock('$lib/client/ballot-engine', () => ({ loadJsCrypto: async () => {}, encryptAnswer: () => ({}) }))
vi.mock('$lib/client/cast-service', () => ({ castBallot: async () => ({ auditUrl: '' }) }))

import BallotStepper from './BallotStepper.svelte'

afterEach(() => {
  cleanup()
  created.opts.length = 0
})

const props = { electionUuid: 'e1', questions: [], publicKey: {}, heliosBase: 'https://helios.example.org' }

describe('BallotStepper on a secondary customer host', () => {
  it('opens the Helios session check against this host', () => {
    render(BallotStepper, { props })
    expect(created.opts).toHaveLength(1)
    expect(created.opts[0]?.gremionUiOrigin).toBe('https://b.example.org')
  })

  it('sends the re-login back to this host', () => {
    const { container } = render(BallotStepper, { props })
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    expect(new URL(href).searchParams.get('return_url')).toBe('https://b.example.org/elections/e1/helios-cb')
  })
})
