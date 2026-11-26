/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://b.example.org/" }
 *
 * The call frame on a secondary customer host. One gremion-ui serves every host, so the process env
 * (PUBLIC_ELEMENT_CALL_URL, PUBLIC_BASE_URL) names ONE host: host A here. This page was opened on host B.
 * The frame, the postMessage target, the accepted message origin and the widget's parent URL must all be
 * host B, or the iframe is cross-origin and `frame-src 'self'` blocks it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/svelte'
import { startRoomCall, endCall } from '$lib/stores/call-store.svelte'
import VideoCallPip from './VideoCallPip.svelte'
// The very module the component imports, resolved to the mock below: what the component can read from the
// process env. The test that follows pins it, so a mock that stops reaching the component cannot go unseen.
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
  return { r, iframe }
}

function fromWidget(origin: string, action: string, source: Window | null) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source,
      data: { api: 'fromWidget', widgetId: 'element-call-pip', requestId: 'req-1', action },
    }),
  )
}

describe('VideoCallPip on a secondary customer host', () => {
  it('the page itself is on host B and the process env names host A', () => {
    expect(window.location.origin).toBe('https://b.example.org')
    // The component's import of the process env is this mock; without it the frame tests below would
    // pass for any env, host A or none.
    expect(publicEnv.PUBLIC_ELEMENT_CALL_URL).toBe('https://a.example.org/element-call')
    expect(publicEnv.PUBLIC_BASE_URL).toBe('https://a.example.org')
  })

  it('points the iframe at this host\'s Element Call, not at the process env host', async () => {
    const { iframe } = await mountCall()
    const src = new URL(iframe.getAttribute('src') ?? '')
    expect(src.origin).toBe('https://b.example.org')
    expect(src.pathname).toBe(`/element-call/room/${encodeURIComponent(ROOM)}`)
  })

  it('hands the widget this host as its parent URL', async () => {
    const { iframe } = await mountCall()
    expect(new URL(iframe.getAttribute('src') ?? '').searchParams.get('parentUrl')).toBe('https://b.example.org')
  })

  it('answers a message from this host with targetOrigin this host', async () => {
    const { iframe } = await mountCall()
    const frame = iframe.contentWindow as Window
    const post = vi.spyOn(frame, 'postMessage')
    fromWidget('https://b.example.org', 'supported_api_versions', frame)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[1]).toBe('https://b.example.org')
  })

  it('ignores a message from the process env host', async () => {
    const { iframe } = await mountCall()
    const frame = iframe.contentWindow as Window
    const post = vi.spyOn(frame, 'postMessage')
    fromWidget('https://a.example.org', 'supported_api_versions', frame)
    fromWidget('https://b.example.org.evil.example', 'supported_api_versions', frame)
    expect(post).not.toHaveBeenCalled()
  })
})
