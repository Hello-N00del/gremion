// TASK-205b (TASK-058 Q10): /votes is owned by the votes module and merges polls with the tracked elections'
// Helios ballots; while the elections module is OFF for the tenant it shows polls only. These cases drive the
// real loader with the tenant's module map in `locals.tenant.config.modules` (the same map the module gate
// reads) and assert the POST-CONDITION: nothing of Helios is read, probed or offered, and the page's
// `electionsEnabled` / `heliosStatus` data say so; with elections on (or the key absent) nothing changes.
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

const getElection = vi.fn()
const findAll = vi.fn()
const findVisibleToUser = vi.fn()
const getOrgUnit = vi.fn()
const listPolls = vi.fn()

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: {
    findAll: () => findAll(),
    findVisibleToUser: (id: string) => findVisibleToUser(id),
  },
}))

vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return { ...actual, HeliosClient: { getElection: (uuid: string) => getElection(uuid) } }
})

vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: (id: string) => getOrgUnit(id) }))

vi.mock('$lib/server/polls/polls-client', () => ({ NextcloudPollsClient: { listPolls: () => listPolls() } }))

const { load } = await import('./+page.server')

function row(uuid: string) {
  return {
    id: `row-${uuid}`,
    helios_uuid: uuid,
    org_unit_id: 'ou-1',
    created_by: 'seed',
    calendar_linked: false,
    created_at: new Date('2026-05-22T19:50:00.000Z'),
    archived_at: null,
  }
}

function event(modules?: Record<string, boolean>) {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'admin-1', name: 'Admin', email: 'a@x.de', roles: [Role.ITAdmin], groups: [] },
        expires: '2099-01-01T00:00:00.000Z',
      }),
      ...(modules ? { tenant: { config: { modules } } } : {}),
    },
  } as unknown as Parameters<typeof load>[0]
}

type Data = { votes: unknown[]; heliosStatus: { label: string } | null; electionsEnabled: boolean }

describe('/votes loader — the Helios items follow the elections module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findAll.mockResolvedValue([row('hel-vorstand-26')])
    findVisibleToUser.mockResolvedValue([row('hel-vorstand-26')])
    getElection.mockRejectedValue(new TypeError('fetch failed'))
    getOrgUnit.mockResolvedValue({ id: 'ou-1', name: 'Vorstand' })
    listPolls.mockResolvedValue([])
  })

  test('elections OFF: no committee_elections read, no Helios probe, no Helios status, no ballot item', async () => {
    const data = (await load(event({ votes: true, elections: false }))) as Data
    expect(data.electionsEnabled).toBe(false)
    expect(data.heliosStatus).toBeNull()
    expect(data.votes).toEqual([])
    expect(findAll).not.toHaveBeenCalled()
    expect(findVisibleToUser).not.toHaveBeenCalled()
    expect(getElection).not.toHaveBeenCalled()
  })

  test('elections ON: the tracked ballot appears (degraded here, Helios unreachable) and the Helios status is present', async () => {
    const data = (await load(event({ votes: true, elections: true }))) as Data
    expect(data.electionsEnabled).toBe(true)
    expect(data.heliosStatus).not.toBeNull()
    expect(data.votes).toHaveLength(1)
    expect(findAll).toHaveBeenCalledTimes(1)
  })

  test('the key absent (a map that does not mention elections) means ON, never a silent off', async () => {
    const data = (await load(event({ votes: true }))) as Data
    expect(data.electionsEnabled).toBe(true)
    expect(data.votes).toHaveLength(1)
  })

  test('no tenant on locals (a bare event) means ON as well: the gate is an explicit false only', async () => {
    const data = (await load(event())) as Data
    expect(data.electionsEnabled).toBe(true)
  })
})
