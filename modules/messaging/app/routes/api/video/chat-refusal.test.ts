// @vitest-environment node
//
// The video routes that exchange the session token for a Matrix token. When the exchange is refused on
// purpose (MATRIX_IDENTITY=namespaced: 503 chat not available, 403 token not this customer's) the
// refusal reaches the client as it is, in German; any other failure keeps the answer it had.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { error } from '@sveltejs/kit'

const h = vi.hoisted(() => ({ getMatrixToken: vi.fn() }))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({ matrix: () => ({ getMatrixToken: h.getMatrixToken }) }),
}))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: () => 'http://synapse.test:8008' }))
vi.mock('$env/dynamic/private', () => ({ env: { MATRIX_PUBLIC_URL: 'http://synapse.test' } }))

import { GET as openidGet } from './openid-token/+server'
import { POST as widgetPost } from './matrix-widget-action/+server'

function refusal(status: number, message: string): unknown {
  try {
    error(status, message)
  } catch (e) {
    return e
  }
  return undefined
}
const UNAVAILABLE = 'Der Chat ist derzeit nicht verfügbar. Bitte die Administration informieren.'

function event(body?: unknown) {
  return {
    locals: { auth: async () => ({ accessToken: 'kc-jwt' }) },
    request: new Request('http://localhost/api/video/x', {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never
}
const SEND = { action: 'send_event', roomId: '!r:synapse.test', type: 'm.call.member', content: {} }
const DELAYED = { action: 'update_delayed_event', delayId: 'd1', updateAction: 'restart' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

describe('POST /api/video/matrix-widget-action', () => {
  test('a refused exchange (503) reaches the client, for a room event and for a delayed event', async () => {
    h.getMatrixToken.mockRejectedValue(refusal(503, UNAVAILABLE))
    await expect(widgetPost(event(SEND))).rejects.toMatchObject({ status: 503, body: { message: UNAVAILABLE } })
    await expect(widgetPost(event(DELAYED))).rejects.toMatchObject({ status: 503, body: { message: UNAVAILABLE } })
  })

  test('a token that is not this customer\'s (403) reaches the client', async () => {
    h.getMatrixToken.mockRejectedValue(refusal(403, 'Die Anmeldung gehört nicht zu diesem Mandanten.'))
    await expect(widgetPost(event(SEND))).rejects.toMatchObject({ status: 403 })
  })

  test('any other failure is still a 500 with its message', async () => {
    h.getMatrixToken.mockRejectedValue(new Error('boom'))
    const res = (await widgetPost(event(SEND))) as Response
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
    const res2 = (await widgetPost(event(DELAYED))) as Response
    expect(res2.status).toBe(500)
  })
})

describe('GET /api/video/openid-token', () => {
  test('a refused exchange (503) reaches the client', async () => {
    h.getMatrixToken.mockRejectedValue(refusal(503, UNAVAILABLE))
    await expect(openidGet(event())).rejects.toMatchObject({ status: 503, body: { message: UNAVAILABLE } })
  })

  test('any other failure is still a 500 with its message', async () => {
    h.getMatrixToken.mockRejectedValue(new Error('boom'))
    const res = (await openidGet(event())) as Response
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
