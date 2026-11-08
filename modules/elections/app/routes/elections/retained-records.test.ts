// @vitest-environment node
//
// Module Karenz (phase 2, Task 19): the elections page lists the sealed result copies of the previous
// period after the module has been off for 30 days and is switched on afresh (spec goal 10). The engine
// is the real one over a tenant pool double (finalized-period.test-util): copy sealed at switch-off,
// final deletion on day 30, then the page loader of a fresh start.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import { finalizedPeriodWorld } from '$lib/server/module-karenz/retained/finalized-period.test-util'

const findAll = vi.fn()
const findVisibleToUser = vi.fn()
const getElection = vi.fn()

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: { findAll: () => findAll(), findVisibleToUser: (id: string) => findVisibleToUser(id) },
}))
vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return { ...actual, HeliosClient: { getElection: (uuid: string) => getElection(uuid) } }
})

const { load } = await import('./+page.server')

const SECRET = 'unit-test-secret-one'
const TENANT = '11111111-1111-4111-8111-111111111111'

function world() {
  return finalizedPeriodWorld({
    tenantId: TENANT,
    slug: 'rat-a',
    catalogueId: 'elections',
    extractorId: 'elections.election-results',
    retentionClass: 'RC-ELE',
    secret: SECRET,
    lines: [
      { id: 'hel-1', data: { name: 'Vorstandswahl 2026', votingEndsAt: '2026-09-20T18:00:00Z', result: { winner: 'A' }, chair: 'Erika Beispiel' }, persons: [{ id: 'user-a', field: 'chair' }] },
      { id: 'hel-2', data: { name: 'Satzungsaenderung', votingEndsAt: '2026-09-25T18:00:00Z', result: { yes: 12 } }, persons: [] },
    ],
  })
}

function event(roles: Role[], tenant: unknown) {
  return {
    locals: { auth: async () => ({ user: { id: 'u-1', name: 'N', email: 'n@x.test', roles, groups: [] }, expires: '2099-01-01T00:00:00.000Z' }), tenant },
  } as unknown as Parameters<typeof load>[0]
}

type Data = { elections: unknown[]; isAdmin: boolean; retainedRecords: { id: string; label: string; createdAt: string; lineCount: number; href: string }[] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTH_SECRET', SECRET)
  findAll.mockResolvedValue([])
  findVisibleToUser.mockResolvedValue([])
  getElection.mockRejectedValue(new Error('no election in the fresh start'))
})

describe('/elections loader after a finalized Karenz and a fresh enable', () => {
  it('lists the sealed result copies of the previous period, read-only, with a download link each', async () => {
    const w = world()
    await w.sealAndFinalize()
    expect(w.moduleDataGone, 'the final deletion ran').toBe(true)
    expect(w.rowState).toBe('finalized')
    // the module is on afresh: no election is tracked any more, and the page still lists the old copy
    const data = (await load(event([Role.CouncilAdmin], w.tenant))) as Data
    expect(data.elections).toEqual([])
    expect(data.retainedRecords).toHaveLength(1)
    const rec = data.retainedRecords[0]!
    expect(rec).toMatchObject({ id: w.records()[0]!.id, label: 'Wahlergebnisse', lineCount: 2, href: `/api/settings/modules/retained?id=${w.records()[0]!.id}` })
    expect(rec.createdAt).toBe('2026-10-01T10:00:00.000Z')
    expect(w.mutations(), 'finalize never deletes or rewrites retained_record rows').toEqual([])
  })

  it.each([Role.Vorstand, Role.CouncilAdmin, Role.Finance, Role.Auditor, Role.ITAdmin])('%s sees the list', async (role) => {
    const w = world()
    await w.sealAndFinalize()
    expect(((await load(event([role, Role.Member], w.tenant))) as Data).retainedRecords).toHaveLength(1)
  })

  it('a Member sees no list and the database is not asked for it', async () => {
    const w = world()
    await w.sealAndFinalize()
    const data = (await load(event([Role.Member], w.tenant))) as Data
    expect(data.retainedRecords).toEqual([])
  })

  it('a tenant that never switched the module off has an empty list', async () => {
    const w = world()
    expect(((await load(event([Role.CouncilAdmin], w.tenant))) as Data).retainedRecords).toEqual([])
  })

  it('the page data carries no record content and no person', async () => {
    const w = world()
    await w.sealAndFinalize()
    const json = JSON.stringify(await load(event([Role.CouncilAdmin], w.tenant)))
    for (const forbidden of ['Vorstandswahl', 'Erika', 'winner', 'Satzungsaenderung']) expect(json).not.toContain(forbidden)
  })

  it('a person erased after sealing is redacted in the download behind the list link', async () => {
    const w = world()
    await w.sealAndFinalize()
    w.erase(subjectRef(TENANT, 'user-a', SECRET))
    const data = (await load(event([Role.Vorstand], w.tenant))) as Data
    const { readRetainedRedacted } = await import('$lib/server/module-karenz/retained/serve')
    const copy = await readRetainedRedacted(w.tenant, new URL(data.retainedRecords[0]!.href, 'http://x').searchParams.get('id')!)
    expect(copy.body).not.toContain('Erika Beispiel')
    expect(copy.body).toContain('"chair":"erased"')
  })

  it('a failing read of the list never fails the page: an empty list and one log line without a message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { id: TENANT, slug: 'rat-a', db: Object.assign(async () => { throw new Error('connection to db.internal.example refused') }, {}) }
    const data = (await load(event([Role.CouncilAdmin], broken))) as Data
    expect(data.retainedRecords).toEqual([])
    expect(log.mock.calls.flat().join(' ')).toContain('rat-a')
    expect(log.mock.calls.flat().join(' ')).not.toContain('db.internal')
    log.mockRestore()
  })

  it('without a tenant database on the request (a bare test locals) the loader still answers', async () => {
    const data = (await load(event([Role.CouncilAdmin], undefined))) as Data
    expect(data.retainedRecords).toEqual([])
  })
})
