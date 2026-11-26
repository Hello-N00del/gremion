// GET /api/protocols?committeeId=<junk>: a unit id that is not a UUID names no unit, so the list
// answers the same 404 as an unknown unit instead of handing the value to the uuid column (the
// driver rejects it with SQLSTATE 22P02, a 500). The fake client behaves like that column.
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: 0 }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async () => {
    h.calls++
    throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
  }),
  isMemberOf: vi.fn(async () => false),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  createProtocol: vi.fn(),
  listProtocols: vi.fn(async () => []),
  updateProtocol: vi.fn(),
  deleteProtocol: vi.fn(),
}))
vi.mock('$lib/server/protocols/document-port', () => ({ getTenantProtocolDocumentPort: vi.fn() }))

import { GET } from './+server'

function listEvent(committeeId: string) {
  return {
    locals: { user: { id: 'u1', roles: ['member'] } },
    url: new URL(`https://pilot.test/api/protocols?committeeId=${encodeURIComponent(committeeId)}`),
    params: {},
  } as never
}

async function statusOf(fn: () => Promise<Response>): Promise<number | Error> {
  try {
    return (await fn()).status
  } catch (err) {
    const status = (err as { status?: number })?.status
    return typeof status === 'number' ? status : (err as Error)
  }
}

describe('GET /api/protocols with a malformed committeeId', () => {
  it.each(['not-a-uuid', '../clients', '123'])('%s answers 404 and never reaches the store', async (id) => {
    expect(await statusOf(() => GET(listEvent(id)))).toBe(404)
    expect(h.calls).toBe(0)
  })
})
