/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://a.example.org/" }
 *
 * The same component on the PRIMARY host, where the page origin and the process env name the same host: a
 * single-customer install must see exactly the values it saw before the frame was derived from the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/svelte'
import { startRoomCall, endCall } from '$lib/stores/call-store.svelte'
import VideoCallPip from './VideoCallPip.svelte'
// The very module the component imports, resolved to the mock below (see the test that pins it).
import { env as publicEnv } from '$env/dynamic/public'

vi.mock('$env/dynamic/public', () => ({
  env: { PUBLIC_ELEMENT_CALL_URL: 'https://a.example.org/element-call', PUBLIC_BASE_URL: 'https://a.example.org' },
}))

const ROOM = '!room:platform.example.org'
const CREDS = {
  userId: '@user:platform.example.org',
  matrixBaseUrl: 'https://platform.example.org',
  openidToken: { access_token: 't', token_type: 'Bearer', matrix_server_name: 'platform.example.org', expires_in: 60 },
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(CREDS), { headers: { 'content-type': 'application/json' } })),
  )
})
afterEach(() => {
  endCall()
  cleanup()
  vi.unstubAllGlobals()
})

async function mountCall() {
  const r = render(VideoCallPip, { props: { user: { name: 'Test Person' } as never } })
  startRoomCall(ROOM, 'Testraum')
  const iframe = await waitFor(() => {
    const el = r.container.ownerDocument.querySelector('iframe')
    if (!el) throw new Error('no iframe yet')
    return el
  })
  return iframe
}

describe('VideoCallPip on the primary host', () => {
  it('the page and the process env name the same host (the mock is what the component imports)', () => {
    expect(window.location.origin).toBe('https://a.example.org')
    expect(publicEnv.PUBLIC_ELEMENT_CALL_URL).toBe('https://a.example.org/element-call')
    expect(publicEnv.PUBLIC_BASE_URL).toBe('https://a.example.org')
  })

  it('builds the same iframe URL the process env gave before', async () => {
    const iframe = await mountCall()
    const src = new URL(iframe.getAttribute('src') ?? '')
    expect(`${src.origin}${src.pathname}`).toBe(`https://a.example.org/element-call/room/${encodeURIComponent(ROOM)}`)
    expect(src.searchParams.get('parentUrl')).toBe('https://a.example.org')
  })

  it('answers a message from this host with targetOrigin this host and ignores another host', async () => {
    const iframe = await mountCall()
    const frame = iframe.contentWindow as Window
    const post = vi.spyOn(frame, 'postMessage')
    const send = (origin: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source: frame,
          data: { api: 'fromWidget', widgetId: 'element-call-pip', requestId: 'r', action: 'supported_api_versions' },
        }),
      )
    send('https://b.example.org')
    expect(post).not.toHaveBeenCalled()
    send('https://a.example.org')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[1]).toBe('https://a.example.org')
  })
})
