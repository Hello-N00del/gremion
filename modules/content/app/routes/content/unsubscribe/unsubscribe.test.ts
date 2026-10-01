import { beforeEach, describe, expect, it, vi } from 'vitest'

// Public content unsubscribe page. No auth.
// K5#19 / S3#38 (F1-FIX-07): the GET load NEVER consumes the token — link
// scanners and mail-client prefetchers issue GETs, and a GET that consumed the
// single-use token unsubscribed recipients who never clicked. GET renders a
// confirmation; the POST form action (also the RFC 8058 one-click target)
// consumes and maps the three outcomes to a render status.

const { mockConsume } = vi.hoisted(() => ({ mockConsume: vi.fn() }))
vi.mock('$lib/server/content/content-db', () => ({ consumeUnsubscribeToken: mockConsume }))

import { load, actions } from './+page.server'

type LoadEv = Parameters<typeof load>[0]
function getEvent(token: string | null): LoadEv {
  const url = new URL('http://stura.test/content/unsubscribe')
  if (token !== null) url.searchParams.set('token', token)
  return { url } as unknown as LoadEv
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postEvent(opts: { formToken?: string; urlToken?: string; oneClick?: boolean }): any {
  const url = new URL('http://stura.test/content/unsubscribe')
  if (opts.urlToken) url.searchParams.set('token', opts.urlToken)
  const form = new URLSearchParams()
  if (opts.formToken) form.set('token', opts.formToken)
  if (opts.oneClick) form.set('List-Unsubscribe', 'One-Click')
  return {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }),
  }
}

describe('/content/unsubscribe GET load (never consumes)', () => {
  beforeEach(() => mockConsume.mockReset())

  it('a token renders the confirmation and does NOT consume it', async () => {
    expect(await load(getEvent('good'))).toEqual({ status: 'confirm', token: 'good' })
    expect(mockConsume).not.toHaveBeenCalled()
  })

  it('returns invalid (without consuming) when no token is present', async () => {
    expect(await load(getEvent(null))).toEqual({ status: 'invalid', token: null })
    expect(mockConsume).not.toHaveBeenCalled()
  })
})

describe('/content/unsubscribe POST action (consumes)', () => {
  beforeEach(() => mockConsume.mockReset())

  it('returns ok for a valid form token', async () => {
    mockConsume.mockResolvedValue({ ok: true })
    expect(await actions.default(postEvent({ formToken: 'good' }))).toEqual({ status: 'ok' })
    expect(mockConsume).toHaveBeenCalledWith('good')
  })

  it('returns expired for an expired token', async () => {
    mockConsume.mockResolvedValue({ ok: false, reason: 'expired' })
    expect(await actions.default(postEvent({ formToken: 'old' }))).toEqual({ status: 'expired' })
  })

  it('returns invalid for an unknown token', async () => {
    mockConsume.mockResolvedValue({ ok: false, reason: 'invalid' })
    expect(await actions.default(postEvent({ formToken: 'nope' }))).toEqual({ status: 'invalid' })
  })

  it('RFC 8058 one-click: the token in the URL plus List-Unsubscribe=One-Click consumes', async () => {
    mockConsume.mockResolvedValue({ ok: true })
    expect(await actions.default(postEvent({ urlToken: 'click', oneClick: true }))).toEqual({ status: 'ok' })
    expect(mockConsume).toHaveBeenCalledWith('click')
  })

  it('returns invalid (without consuming) when no token is posted', async () => {
    expect(await actions.default(postEvent({}))).toEqual({ status: 'invalid' })
    expect(mockConsume).not.toHaveBeenCalled()
  })
})
