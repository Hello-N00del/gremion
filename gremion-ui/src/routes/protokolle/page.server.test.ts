// gremion-ui/src/routes/protokolle/page.server.test.ts
// #458-2 (audit:code-quality — swallowed-error/load): the protokolle overview
// degraded a listProtocols() fault to an empty list with a bare
// `.catch(() => [])`, so a genuine query fault was indistinguishable from
// "no protocols exist" — nothing was recorded anywhere. The sibling
// resolutions/+page.server.ts already logs before degrading (#439); this pins
// the same log-before-degrade contract here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { listProtocols, getOrgUnitIdsForUser } = vi.hoisted(() => ({
  listProtocols: vi.fn(),
  getOrgUnitIdsForUser: vi.fn(),
}))
vi.mock('$lib/server/governance/protocols-db', () => ({ listProtocols }))
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnitIdsForUser, isMemberOf: vi.fn() }))

import { load } from './+page.server'

/** A CouncilAdmin session: R29-F104-KTWIN filters rows by the D-3 visibility
 *  rule (no session sees nothing), and an admin sees every row unfiltered, so
 *  the log-before-degrade contract stays independent of that rule. */
const ev = { locals: { user: { id: 'admin', roles: ['council-admin'] } } } as unknown as Parameters<typeof load>[0]

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  listProtocols.mockReset()
  getOrgUnitIdsForUser.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('protokolle load — log before degrading (#458-2)', () => {
  it('returns the rows and logs nothing on the happy path', async () => {
    const rows = [{ id: 'p1' }]
    listProtocols.mockResolvedValue(rows)
    // TASK-009 lane A (P1): load() now also reports `isAdmin` (admin `ev`
    // here → true); see protokolle-admin-link.test.ts for the role-driven cases.
    await expect(load(ev)).resolves.toEqual({ protocols: rows, isAdmin: true })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still degrades to an empty list when listProtocols rejects', async () => {
    listProtocols.mockRejectedValue(new Error('control-db down'))
    await expect(load(ev)).resolves.toEqual({ protocols: [], isAdmin: true })
  })

  it('logs at ERROR level — with the route, the message and the code — before degrading', async () => {
    const boom = Object.assign(new Error('relation "protocol" does not exist'), { code: '42P01' })
    listProtocols.mockRejectedValue(boom)

    await load(ev)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const args = errorSpy.mock.calls[0] as unknown[]
    const record = args.map((a) => String(a)).join(' ')
    expect(record).toContain('protokolle')
    // the underlying cause must reach the record — not just a generic message
    expect(record).toContain('relation "protocol" does not exist')
    expect(record).toContain('42P01')
  })

  // Review finding: the first fix logged the raw Error OBJECT. postgres.js
  // attaches the failing `query` and its bound `parameters` to its errors, so
  // a query fault put tenant ids and row filter values into the container log.
  // The sibling seam established the convention two files over
  // (messages/backend/service-client.ts logs only `name: message`); match it.
  it('does NOT log the raw error object — postgres.js carries query + parameters', async () => {
    const boom = Object.assign(new Error('syntax error'), {
      code: '42601',
      query: 'select * from protocol where tenant_id = $1',
      parameters: ['tenant-secret-id'],
    })
    listProtocols.mockRejectedValue(boom)

    await load(ev)

    const args = errorSpy.mock.calls[0] as unknown[]
    expect(args).not.toContain(boom)
    const record = args.map((a) => String(a)).join(' ')
    expect(record).not.toContain('tenant-secret-id')
    expect(record).not.toContain('select * from protocol')
  })
})

// R29-F104-KTWIN (D-3): the fail-closed branch of the visibility filter. A
// non-admin viewer whose membership lookup fails keeps only the rows that need
// no membership, and the failure is logged, never swallowed.
describe('protokolle load — membership lookup failure fails closed (R29-F104-KTWIN)', () => {
  const row = (id: string, committeeId: string, visibility: string, status: string) =>
    ({ id, committeeId, visibility, status })
  const ROWS = [
    row('closed-pub', 'u-closed', 'committee_only', 'published'),
    row('open-draft', 'u-open', 'all_members', 'draft'),
    row('open-pub', 'u-open', 'all_members', 'published'),
  ]
  const memberEv = { locals: { user: { id: 'm', roles: ['member'] } } } as unknown as Parameters<typeof load>[0]
  const guestEv = { locals: { user: { id: 'g', roles: ['guest'] } } } as unknown as Parameters<typeof load>[0]
  const noSessionEv = { locals: {} } as unknown as Parameters<typeof load>[0]

  it('a Member keeps the all_members rows (drafts included) and nothing of the committee_only unit; logged', async () => {
    listProtocols.mockResolvedValue(ROWS)
    getOrgUnitIdsForUser.mockRejectedValue(new Error('membership db down'))
    const out = (await load(memberEv)) as unknown as { protocols: Array<{ id: string }> }
    expect(out.protocols.map((p) => p.id)).toEqual(['open-draft', 'open-pub'])
    const record = errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')
    expect(record).toContain('[protokolle] membership lookup failed')
    expect(record).toContain('membership db down')
  })

  it('a Guest keeps only the published all_members row', async () => {
    listProtocols.mockResolvedValue(ROWS)
    getOrgUnitIdsForUser.mockRejectedValue(new Error('membership db down'))
    const out = (await load(guestEv)) as unknown as { protocols: Array<{ id: string }> }
    expect(out.protocols.map((p) => p.id)).toEqual(['open-pub'])
  })

  it('no session sees no row', async () => {
    listProtocols.mockResolvedValue(ROWS)
    const out = (await load(noSessionEv)) as unknown as { protocols: Array<{ id: string }> }
    expect(out.protocols).toEqual([])
  })
})
