import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeNc } from './fake-nc'

// Closing a running poll: the deadline moves into the past (the same lock the module Karenz uses), so the
// list, the poll page and the vote guard all read one "closed" value. Another tenant's poll is a 404 and is
// never written.
vi.mock('$lib/server/env/service-env', () => ({
  serviceEnv: (n: string) => ({ NEXTCLOUD_URL: 'http://nc', NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: 'pw' } as Record<string, string>)[n],
}))
const privEnv = vi.hoisted(() => ({ env: {} as Record<string, string> }))
vi.mock('$env/dynamic/private', () => privEnv)
let current = 'A'
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: current, slug: current.toLowerCase() }),
}))

const dto = (title: string) => ({ title, type: 'textPoll' as const, options: ['ja', 'nein'], anonymous: false })

let nc: ReturnType<typeof makeFakeNc>
beforeEach(() => {
  nc = makeFakeNc()
  current = 'A'
  privEnv.env = {}
  vi.stubGlobal('fetch', vi.fn((u: string, i?: RequestInit) => nc.handler(String(u), i)))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function admin() {
  const { NextcloudPollsClient } = await import('./polls-client')
  return NextcloudPollsClient
}
async function member() {
  const { createPollsClient } = await import('./polls-client')
  return createPollsClient({ oidcBearer: 'tok-1' })
}

describe('closePoll', () => {
  it('closes a running poll: it reads as closed afterwards and refuses a vote with 409', async () => {
    const poll = await (await admin()).createPoll(dto('Mensa'))
    expect(poll.status.expired).toBe(false)
    const closed = await (await admin()).closePoll(poll.id)
    expect(closed.status.expired).toBe(true)
    expect((await (await admin()).getPoll(poll.id)).status.expired).toBe(true)
    const options = (await (await member()).getPollWithOptions(poll.id)).options!
    await expect((await member()).vote(poll.id, options[0]!.id)).rejects.toMatchObject({ pollsStatus: 409 })
    expect(nc.calls.some((c) => c.path.includes('/vote/'))).toBe(false)
  })

  it('closes a poll that still has a deadline ahead of it', async () => {
    const poll = await (await admin()).createPoll({ ...dto('Mensa'), expire: Math.floor(Date.now() / 1000) + 86400 })
    const closed = await (await admin()).closePoll(poll.id)
    expect(closed.status.expired).toBe(true)
  })

  it('a poll that is closed already is not written again (its own deadline stays)', async () => {
    const poll = await (await admin()).createPoll({ ...dto('Mensa'), expire: Math.floor(Date.now() / 1000) - 3600 })
    const before = nc.calls.length
    const closed = await (await admin()).closePoll(poll.id)
    expect(closed.status.expired).toBe(true)
    expect(nc.calls.slice(before).some((c) => c.method === 'PUT')).toBe(false)
  })

  it('another tenant\'s poll answers 404 and is not written', async () => {
    current = 'B'
    const foreign = await (await admin()).createPoll(dto('B-Poll'))
    current = 'A'
    const before = nc.calls.length
    await expect((await admin()).closePoll(foreign.id)).rejects.toMatchObject({ pollsStatus: 404 })
    expect(nc.calls.slice(before).some((c) => c.method === 'PUT')).toBe(false)
    expect(nc.polls.get(foreign.id)!.expire).toBe(0)
  })
})
