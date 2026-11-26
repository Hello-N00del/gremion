/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://a.example.org/" }
 *
 * The same component on the PRIMARY host, where the page origin and the process env name the same host: a
 * single-customer install must see exactly the values it saw before the frame was derived from the page.
 * That the component reads the env at all (its server-render fallback) is proven in VideoCallPip.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/svelte'
import { startRoomCall, endCall } from '$lib/stores/call-store.svelte'
import VideoCallPip from './VideoCallPip.svelte'

// What the component can read from the process env: the same host as the page, until a test changes it.
// The mock is a live object, so a test can move the env and look at what the frame does.
const HOST_A_ENV = { PUBLIC_ELEMENT_CALL_URL: 'https://a.example.org/element-call', PUBLIC_BASE_URL: 'https://a.example.org' }
const ENV = vi.hoisted(() => ({}) as Record<string, string | undefined>)
vi.mock('$env/dynamic/public', () => ({ env: ENV }))

const ROOM = '!room:platform.example.org'
const CREDS = {
  userId: '@user:platform.example.org',
  matrixBaseUrl: 'https://platform.example.org',
  openidToken: { access_token: 't', token_type: 'Bearer', matrix_server_name: 'platform.example.org', expires_in: 60 },
}

beforeEach(() => {
  Object.assign(ENV, HOST_A_ENV)
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
  it('the page is on host A', () => {
    expect(window.location.origin).toBe('https://a.example.org')
  })

  it('keeps following the page when the process env is changed (the env is a server-render fallback only)', async () => {
    ENV.PUBLIC_ELEMENT_CALL_URL = 'https://c.example.org/element-call'
    ENV.PUBLIC_BASE_URL = 'https://c.example.org'
    const src = new URL((await mountCall()).getAttribute('src') ?? '')
    expect(`${src.origin}${src.pathname}`).toBe(`https://a.example.org/element-call/room/${encodeURIComponent(ROOM)}`)
    expect(src.searchParams.get('parentUrl')).toBe('https://a.example.org')
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
