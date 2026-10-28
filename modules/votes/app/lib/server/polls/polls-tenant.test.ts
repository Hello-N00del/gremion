import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeNc } from './fake-nc'

// Tenant isolation on the in-process/app polls client: every poll id route
// (read, options, vote) must refuse another tenant's poll as "not found".
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

async function client(bearer = 'tok-1') {
  const { createPollsClient } = await import('./polls-client')
  return createPollsClient({ oidcBearer: bearer })
}
async function admin() {
  const { NextcloudPollsClient } = await import('./polls-client')
  return NextcloudPollsClient
}

async function aPollAsTenantB() {
  current = 'B'
  const poll = await (await admin()).createPoll(dto('B-Poll'))
  current = 'A'
  return poll
}

describe('creation binding + list', () => {
  it('createPoll binds to the calling tenant and the title round-trips unmarked', async () => {
    const p = await (await admin()).createPoll(dto('Mensa'))
    expect(p.configuration.title).toBe('Mensa')
    expect([...nc.polls.values()][0].title).toMatch(/^\[gt:A\] Mensa$/)
  })

  it('A cannot list B polls', async () => {
    await (await admin()).createPoll(dto('A-Poll'))
    await aPollAsTenantB()
    expect((await (await client()).listPolls()).map((p) => p.configuration.title)).toEqual(['A-Poll'])
  })
})

describe('by-id routes refuse another tenant (404 semantics, no existence oracle)', () => {
  it('getPoll / getPollWithOptions', async () => {
    const b = await aPollAsTenantB()
    const c = await client()
    await expect(c.getPoll(b.id)).rejects.toMatchObject({ pollsStatus: 404 })
    await expect(c.getPollWithOptions(b.id)).rejects.toMatchObject({ pollsStatus: 404 })
    // the options of a foreign poll are not even requested upstream
    expect(nc.calls.some((x) => x.path === `/poll/${b.id}/options` && x.method === 'GET')).toBe(false)
  })

  it('vote on B poll by id (with its real option id) is refused and records nothing', async () => {
    const b = await aPollAsTenantB()
    const optionId = nc.polls.get(b.id)!.options[0].id
    await expect((await client()).vote(b.id, optionId)).rejects.toMatchObject({ pollsStatus: 404 })
    expect(nc.polls.get(b.id)!.voters.size).toBe(0)
  })

  it("vote cannot smuggle a foreign option through the caller's own poll id", async () => {
    const own = await (await admin()).createPoll(dto('A-Poll'))
    const b = await aPollAsTenantB()
    const foreignOption = nc.polls.get(b.id)!.options[0].id
    await expect((await client()).vote(own.id, foreignOption)).rejects.toMatchObject({ pollsStatus: 404 })
    expect(nc.polls.get(b.id)!.voters.size).toBe(0)
  })

  it('B can still use its own poll', async () => {
    const b = await aPollAsTenantB()
    current = 'B'
    const c = await client()
    expect((await c.getPollWithOptions(b.id)).configuration.title).toBe('B-Poll')
  })
})

describe('vote integrity on the same route', () => {
  it('one vote per member: a second vote is a 409', async () => {
    const p = await (await admin()).createPoll(dto('P'))
    const [o1, o2] = nc.polls.get(p.id)!.options
    const c = await client('tok-1')
    await c.vote(p.id, o1.id)
    await expect(c.vote(p.id, o2.id)).rejects.toMatchObject({ pollsStatus: 409 })
    // a different member is unaffected
    await (await client('tok-2')).vote(p.id, o1.id)
  })

  it('voting window: an expired poll rejects votes (409)', async () => {
    const p = await (await admin()).createPoll({ ...dto('P'), expire: 1 })
    const o = nc.polls.get(p.id)!.options[0]
    await expect((await client()).vote(p.id, o.id)).rejects.toMatchObject({ pollsStatus: 409 })
    expect(nc.polls.get(p.id)!.voters.size).toBe(0)
  })

  it('without an acting-user bearer a vote is refused (never cast as admin)', async () => {
    const p = await (await admin()).createPoll(dto('P'))
    const { createPollsClient } = await import('./polls-client')
    await expect(createPollsClient().vote(p.id, nc.polls.get(p.id)!.options[0].id)).rejects.toMatchObject({ pollsStatus: 401 })
  })
})

describe('provenance: a forged tenant marker on a poll the module did not create is not trusted', () => {
  // Any NC user can create a poll titled "[gt:A] ..." straight in the shared Nextcloud.
  // Only polls owned by the module's NC admin singleton count for a tenant.
  const forge = (id: number, title: string, owner = 'mallory') =>
    nc.polls.set(id, { id, type: 'textPoll', title, description: '', anonymous: false, expire: 0, options: [{ id: 700 + id, text: 'ja' }], voters: new Map(), owner })

  it('listPolls hides a marker-forged poll owned by a non-admin NC user', async () => {
    await (await admin()).createPoll(dto('Echt'))
    forge(900, '[gt:A] Urabstimmung')
    expect((await (await client()).listPolls()).map((p) => p.configuration.title)).toEqual(['Echt'])
  })

  it('getPoll / getPollWithOptions / vote answer 404 for the forged poll and record nothing', async () => {
    forge(901, '[gt:A] Urabstimmung')
    const c = await client()
    await expect(c.getPoll(901)).rejects.toMatchObject({ pollsStatus: 404 })
    await expect(c.getPollWithOptions(901)).rejects.toMatchObject({ pollsStatus: 404 })
    await expect(c.vote(901, 1701)).rejects.toMatchObject({ pollsStatus: 404 })
    expect(nc.polls.get(901)!.voters.size).toBe(0)
  })

  it('a legacy unmarked poll is claimed only when it is also admin-owned', async () => {
    privEnv.env.VOTES_LEGACY_POLL_TENANT_ID = 'A'
    forge(902, 'Legacy fremd')
    forge(903, 'Legacy echt', 'admin')
    const { createPollsClient } = await import('./polls-client')
    const titles = (await createPollsClient({ oidcBearer: 't' }).listPolls()).map((p) => p.configuration.title)
    expect(titles).toEqual(['Legacy echt'])
  })
})
