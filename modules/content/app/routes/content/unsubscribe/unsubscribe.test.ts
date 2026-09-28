import { beforeEach, describe, expect, it, vi } from 'vitest'

// Public content unsubscribe page load — reads ?token=, consumes it, and maps
// the three consume outcomes to a render status. No auth.

const { mockConsume } = vi.hoisted(() => ({ mockConsume: vi.fn() }))
vi.mock('$lib/server/content/content-db', () => ({ consumeUnsubscribeToken: mockConsume }))

import { load } from './+page.server'

type Ev = Parameters<typeof load>[0]
function makeEvent(token: string | null): Ev {
  const url = new URL('http://stura.test/content/unsubscribe')
  if (token !== null) url.searchParams.set('token', token)
  return { url } as unknown as Ev
}

describe('/content/unsubscribe load', () => {
  beforeEach(() => mockConsume.mockReset())

  it('returns ok for a valid token', async () => {
    mockConsume.mockResolvedValue({ ok: true })
    expect(await load(makeEvent('good'))).toEqual({ status: 'ok' })
    expect(mockConsume).toHaveBeenCalledWith('good')
  })

  it('returns expired for an expired token', async () => {
    mockConsume.mockResolvedValue({ ok: false, reason: 'expired' })
    expect(await load(makeEvent('old'))).toEqual({ status: 'expired' })
  })

  it('returns invalid for an unknown token', async () => {
    mockConsume.mockResolvedValue({ ok: false, reason: 'invalid' })
    expect(await load(makeEvent('nope'))).toEqual({ status: 'invalid' })
  })

  it('returns invalid (without consuming) when no token is present', async () => {
    expect(await load(makeEvent(null))).toEqual({ status: 'invalid' })
    expect(mockConsume).not.toHaveBeenCalled()
  })
})
