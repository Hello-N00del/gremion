// gremion-ui/src/routes/protokolle/page.server.test.ts
// #458-2 (audit:code-quality — swallowed-error/load): the protokolle overview
// degraded a listProtocols() fault to an empty list with a bare
// `.catch(() => [])`, so a genuine query fault was indistinguishable from
// "no protocols exist" — nothing was recorded anywhere. The sibling
// resolutions/+page.server.ts already logs before degrading (#439); this pins
// the same log-before-degrade contract here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { listProtocols } = vi.hoisted(() => ({ listProtocols: vi.fn() }))
vi.mock('$lib/server/governance/protocols-db', () => ({ listProtocols }))

import { load } from './+page.server'

/** The loader reads nothing off the event. */
const ev = {} as unknown as Parameters<typeof load>[0]

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  listProtocols.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('protokolle load — log before degrading (#458-2)', () => {
  it('returns the rows and logs nothing on the happy path', async () => {
    const rows = [{ id: 'p1' }]
    listProtocols.mockResolvedValue(rows)
    // TASK-009 lane A (P1): load() now also reports `isAdmin` (session-less
    // `ev` here → false); see protocols-admin-link.test.ts for the
    // role-driven cases.
    await expect(load(ev)).resolves.toEqual({ protocols: rows, isAdmin: false })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still degrades to an empty list when listProtocols rejects', async () => {
    listProtocols.mockRejectedValue(new Error('control-db down'))
    await expect(load(ev)).resolves.toEqual({ protocols: [], isAdmin: false })
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
