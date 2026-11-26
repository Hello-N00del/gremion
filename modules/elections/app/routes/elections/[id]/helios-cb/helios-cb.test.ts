/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://b.example.org/elections/e1/helios-cb" }
 *
 * The Helios sign-in callback page runs inside the voter's hidden iframe and tells the page that opened it
 * the sign-in worked. One gremion-ui serves every customer host and its process env names ONE of them
 * (host A here); the page that embeds this frame is on the host the voter is on (host B), so the message
 * must be addressed to that origin or the browser drops it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import HeliosCallback from './+page.svelte'

vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_BASE_URL: 'https://a.example.org' } }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('helios-cb on a secondary customer host', () => {
  it('addresses the sign-in message to this host, not to the process env host', () => {
    const parentPost = vi.fn()
    Object.defineProperty(window, 'parent', { value: { postMessage: parentPost }, configurable: true })
    render(HeliosCallback)
    expect(parentPost).toHaveBeenCalledTimes(1)
    expect(parentPost.mock.calls[0]).toEqual([{ type: 'helios_auth', status: 'ok' }, 'https://b.example.org'])
  })
})
