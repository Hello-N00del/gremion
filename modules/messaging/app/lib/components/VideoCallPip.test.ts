/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://b.example.org/" }
 *
 * The call frame on a secondary customer host. One gremion-ui serves every host, so the process env
 * (PUBLIC_ELEMENT_CALL_URL, PUBLIC_BASE_URL) names ONE host: host A here. This page was opened on host B.
 * The frame, the postMessage target, the accepted message origin and the widget's parent URL must all be
 * host B, or the iframe is cross-origin and `frame-src 'self'` blocks it.
 *
 * The mocked env below is a live object: the tests change its values and look at what the frame does, so a
 * component that stops reading the env, or reads it where it must not, fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/svelte'
import { startRoomCall, endCall } from '$lib/stores/call-store.svelte'
import VideoCallPip from './VideoCallPip.svelte'
import { pageOrigin } from './page-origin'

// What the component can read from the process env: host A, until a test changes it.
const HOST_A_ENV = { PUBLIC_ELEMENT_CALL_URL: 'https://a.example.org/element-call', PUBLIC_BASE_URL: 'https://a.example.org' }
const ENV = vi.hoisted(() => ({}) as Record<string, string | undefined>)
vi.mock('$env/dynamic/public', () => ({ env: ENV }))

// The one place the component asks "is there a page?". Real by default; the server-render test answers "no page"
// for the one component it renders, so nothing depends on which other test touched `window` first.
vi.mock('./page-origin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./page-origin')>()
  return { pageOrigin: vi.fn(actual.pageOrigin) }
})
const realPageOrigin = (await vi.importActual<typeof import('./page-origin')>('./page-origin')).pageOrigin

const ROOM = '!room:platform.example.org'
const CREDS = {
  userId: '@user:platform.example.org',
  matrixBaseUrl: 'https://platform.example.org',
  openidToken: { access_token: 't', token_type: 'Bearer', matrix_server_name: 'platform.example.org', expires_in: 60 },
}

beforeEach(() => {
  vi.mocked(pageOrigin).mockImplementation(realPageOrigin)
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
  it('the page itself is on host B', () => {
    expect(window.location.origin).toBe('https://b.example.org')
  })

  it('takes the frame from the page: another value in the process env moves nothing', async () => {
    ENV.PUBLIC_ELEMENT_CALL_URL = 'https://c.example.org/element-call'
    ENV.PUBLIC_BASE_URL = 'https://c.example.org'
    const { iframe } = await mountCall()
    const src = new URL(iframe.getAttribute('src') ?? '')
    expect(src.origin).toBe('https://b.example.org')
    expect(src.searchParams.get('parentUrl')).toBe('https://b.example.org')
  })

  it('without a page (server render) the frame base and the parent URL are the process env, and follow it', async () => {
    const withoutPage = async () => {
      // The component decides between page and env once, when it is created: answer "no page" for that one.
      vi.mocked(pageOrigin).mockClear()
      vi.mocked(pageOrigin).mockReturnValueOnce(null)
      render(VideoCallPip, { props: { user: { name: 'Test Person' } as never } })
      expect(pageOrigin).toHaveBeenCalledTimes(1)
      startRoomCall(ROOM, 'Testraum')
      const iframe = await waitFor(() => {
        const el = document.querySelector('iframe')
        if (!el) throw new Error('no iframe yet')
        return el
      })
      const src = new URL(iframe.getAttribute('src') ?? '')
      cleanup()
      endCall()
      return { origin: src.origin, base: `${src.origin}${src.pathname}`, parentUrl: src.searchParams.get('parentUrl') }
    }
    const first = await withoutPage()
    expect(first).toEqual({ origin: 'https://a.example.org', base: `https://a.example.org/element-call/room/${encodeURIComponent(ROOM)}`, parentUrl: 'https://a.example.org' })
    ENV.PUBLIC_ELEMENT_CALL_URL = 'https://d.example.org/call'
    ENV.PUBLIC_BASE_URL = 'https://d.example.org'
    const second = await withoutPage()
    expect(second).toEqual({ origin: 'https://d.example.org', base: `https://d.example.org/call/room/${encodeURIComponent(ROOM)}`, parentUrl: 'https://d.example.org' })
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
