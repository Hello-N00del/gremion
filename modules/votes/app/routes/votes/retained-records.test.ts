// @vitest-environment node
//
// Module Karenz (phase 2, Task 19): the votes page lists the sealed poll tallies of the previous period
// after the module has been off for 30 days and is switched on afresh (spec goal 10). The engine is the
// real one over a tenant pool double (finalized-period.test-util): copy sealed at switch-off, final
// deletion on day 30, then the page loader of a fresh start.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import { finalizedPeriodWorld } from '$lib/server/module-karenz/retained/finalized-period.test-util'

const findAll = vi.fn()
const findVisibleToUser = vi.fn()
const getElection = vi.fn()
const getOrgUnit = vi.fn()
const listPolls = vi.fn()

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: { findAll: () => findAll(), findVisibleToUser: (id: string) => findVisibleToUser(id) },
}))
vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return { ...actual, HeliosClient: { getElection: (uuid: string) => getElection(uuid) } }
})
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: (id: string) => getOrgUnit(id) }))
vi.mock('$lib/server/polls/polls-client', () => ({ NextcloudPollsClient: { listPolls: () => listPolls() } }))

const { load } = await import('./+page.server')

const SECRET = 'unit-test-secret-one'
const TENANT = '11111111-1111-4111-8111-111111111111'

function world() {
  return finalizedPeriodWorld({
    tenantId: TENANT,
    slug: 'rat-a',
    catalogueId: 'votes',
    extractorId: 'votes.poll-results',
    retentionClass: 'RC-GOV-RES',
    secret: SECRET,
    lines: [
      { id: '7', data: { title: 'Sommerfest', options: ['Ja', 'Nein'], tally: [{ option: 'Ja', count: 9 }, { option: 'Nein', count: 2 }] }, persons: [] },
      { id: '8', data: { title: 'Raumplan', options: ['A', 'B'], tally: [{ option: 'A', count: 4 }, { option: 'B', count: 4 }] }, persons: [] },
      { id: '9', data: { title: 'Getraenke', options: ['X'], tally: [{ option: 'X', count: 1 }] }, persons: [] },
    ],
  })
}

function event(roles: Role[], tenant: unknown) {
  return {
    locals: { auth: async () => ({ user: { id: 'u-1', name: 'N', email: 'n@x.test', roles, groups: [] }, expires: '2099-01-01T00:00:00.000Z' }), tenant },
  } as unknown as Parameters<typeof load>[0]
}

type Data = { votes: unknown[]; retainedRecords: { id: string; label: string; createdAt: string; lineCount: number; href: string }[] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTH_SECRET', SECRET)
  findAll.mockResolvedValue([])
  findVisibleToUser.mockResolvedValue([])
  getElection.mockRejectedValue(new TypeError('fetch failed'))
  getOrgUnit.mockResolvedValue(null)
  listPolls.mockResolvedValue([])
})

describe('/votes loader after a finalized Karenz and a fresh enable', () => {
  it('lists the sealed tallies of the previous period, read-only, with a download link each', async () => {
    const w = world()
    await w.sealAndFinalize()
    expect(w.moduleDataGone, 'the final deletion ran').toBe(true)
    expect(w.rowState).toBe('finalized')
    const data = (await load(event([Role.CouncilAdmin], w.tenant))) as Data
    expect(data.votes).toEqual([])
    expect(data.retainedRecords).toHaveLength(1)
    const rec = data.retainedRecords[0]!
    expect(rec).toMatchObject({ id: w.records()[0]!.id, label: 'Umfrageergebnisse', lineCount: 3, href: `/api/settings/modules/retained?id=${w.records()[0]!.id}` })
    expect(w.mutations(), 'finalize never deletes or rewrites retained_record rows').toEqual([])
  })

  it.each([Role.Vorstand, Role.CouncilAdmin, Role.Finance, Role.Auditor, Role.ITAdmin])('%s sees the list', async (role) => {
    const w = world()
    await w.sealAndFinalize()
    expect(((await load(event([role, Role.Member], w.tenant))) as Data).retainedRecords).toHaveLength(1)
  })

  it('a Member sees no list', async () => {
    const w = world()
    await w.sealAndFinalize()
    expect(((await load(event([Role.Member], w.tenant))) as Data).retainedRecords).toEqual([])
  })

  it('the page data carries no tally and no title of a sealed poll', async () => {
    const w = world()
    await w.sealAndFinalize()
    const json = JSON.stringify(await load(event([Role.CouncilAdmin], w.tenant)))
    for (const forbidden of ['Sommerfest', 'Raumplan', 'Nein', 'tally']) expect(json).not.toContain(forbidden)
  })

  it('a failing read of the list never fails the page', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { id: TENANT, slug: 'rat-a', db: Object.assign(async () => { throw new Error('connection to db.internal.example refused') }, {}) }
    const data = (await load(event([Role.CouncilAdmin], broken))) as Data
    expect(data.retainedRecords).toEqual([])
    expect(log.mock.calls.flat().join(' ')).not.toContain('db.internal')
    log.mockRestore()
  })

  it('without a tenant database on the request the loader still answers', async () => {
    expect(((await load(event([Role.CouncilAdmin], undefined))) as Data).retainedRecords).toEqual([])
  })
})
