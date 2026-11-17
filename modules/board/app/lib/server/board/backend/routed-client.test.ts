// The router: one port, three places the board can live. The location flag decides per call.
//
//   kernel → the in-process client (the kernel tables)
//   moving → reads from the in-process client, every write refused (503, Retry-After 5)
//   module → the service client (the board module's own database) for reads and writes
//   flag unreadable → 503 for every method, never a guess
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const methods = [
    'listBoardsForOrgUnits',
    'getBoard',
    'deckFor',
    'createCard',
    'moveCard',
    'updateCard',
    'promoteActionItem',
    'listPromotedActionItemIds',
    'createBoard',
    'createStack',
  ] as const
  const doubles = (prefix: string) =>
    Object.fromEntries(methods.map((m) => [m, vi.fn(async () => `${prefix}:${m}`)])) as Record<(typeof methods)[number], ReturnType<typeof vi.fn>>
  return { methods, location: vi.fn(), inprocess: doubles('inprocess'), service: doubles('service'), serviceOpts: [] as unknown[] }
})
const METHODS = h.methods

vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
}))
vi.mock('./location', async (orig) => ({
  ...(await orig<typeof import('./location')>()),
  getBoardLocation: h.location,
}))
vi.mock('./inprocess-client', () => {
  class InprocessBoardClient {
    readonly kind = 'inprocess' as const
    constructor() {
      for (const m of METHODS) (this as any)[m] = h.inprocess[m]
    }
  }
  return { InprocessBoardClient }
})
vi.mock('./service-client', () => {
  class ServiceBoardClient {
    readonly kind = 'service' as const
    constructor(opts: unknown) {
      h.serviceOpts.push(opts)
      for (const m of METHODS) (this as any)[m] = h.service[m]
    }
  }
  return { ServiceBoardClient, BoardServiceError: class extends Error {} }
})

import { RoutedBoardBackend, BOARD_READ_METHODS, BOARD_WRITE_METHODS } from './routed-client'
import { InprocessBoardClient as RealInprocessType } from './inprocess-client'
import { BoardMovingError, BoardLocationUnreadableError, BoardUnavailableError } from './location'

// a call with arguments of the right arity, whatever the method; the doubles ignore them
const call = (b: RoutedBoardBackend, m: (typeof METHODS)[number]) => (b[m] as (...a: unknown[]) => Promise<unknown>)('x', 'y', 'z')

const make = () => new RoutedBoardBackend({ correlationId: 'corr-1' })

beforeEach(() => {
  h.location.mockReset()
  for (const m of METHODS) {
    h.inprocess[m].mockClear()
    h.service[m].mockClear()
  }
  h.serviceOpts.length = 0
})

describe('which methods read and which write', () => {
  it('every method of the port is classified exactly once (a new write cannot bypass the freeze)', () => {
    const all = [...BOARD_READ_METHODS, ...BOARD_WRITE_METHODS]
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...METHODS].sort())
  })

  it('the router implements every classified method', () => {
    const b = make()
    for (const m of [...BOARD_READ_METHODS, ...BOARD_WRITE_METHODS]) expect(typeof (b as any)[m], m).toBe('function')
  })

  it('the in-process client has no method the router does not classify', async () => {
    // the real class, not the double: every public method of the real client must be a known one
    const real = await vi.importActual<{ InprocessBoardClient: typeof RealInprocessType }>('./inprocess-client')
    const names = Object.getOwnPropertyNames(real.InprocessBoardClient.prototype).filter((n) => n !== 'constructor')
    expect([...names].sort()).toEqual([...METHODS].sort())
  })
})

describe('kernel', () => {
  it.each(METHODS)('%s goes to the in-process client', async (m) => {
    h.location.mockResolvedValue('kernel')
    expect(await call(make(), m)).toBe(`inprocess:${m}`)
    expect(h.service[m]).not.toHaveBeenCalled()
  })
})

describe('module', () => {
  it.each(METHODS)('%s goes to the service client, reads and writes alike', async (m) => {
    h.location.mockResolvedValue('module')
    expect(await call(make(), m)).toBe(`service:${m}`)
    expect(h.inprocess[m]).not.toHaveBeenCalled()
  })

  it('hands the correlation id on to the service client', async () => {
    h.location.mockResolvedValue('module')
    await call(make(), 'getBoard')
    expect(h.serviceOpts[0]).toMatchObject({ correlationId: 'corr-1' })
  })
})

describe('moving', () => {
  it.each(BOARD_READ_METHODS)('%s is a read: served from the in-process client', async (m) => {
    h.location.mockResolvedValue('moving')
    expect(await call(make(), m)).toBe(`inprocess:${m}`)
  })

  it.each(BOARD_WRITE_METHODS)('%s is a write: refused with 503, Retry-After 5 and the German text, nothing called', async (m) => {
    h.location.mockResolvedValue('moving')
    const err = (await call(make(), m).catch((e: unknown) => e)) as BoardMovingError
    expect(err).toBeInstanceOf(BoardMovingError)
    expect(err).toBeInstanceOf(BoardUnavailableError)
    expect(err.status).toBe(503)
    expect(err.retryAfterSeconds).toBe(5)
    expect(err.message).toBe('Das Board wird gerade verschoben.')
    expect(h.inprocess[m]).not.toHaveBeenCalled()
    expect(h.service[m]).not.toHaveBeenCalled()
  })
})

describe('an unreadable flag', () => {
  it.each(METHODS)('%s is a 503 and touches neither client', async (m) => {
    h.location.mockRejectedValue(new BoardLocationUnreadableError(new Error('db down')))
    const err = await call(make(), m).catch((e) => e)
    expect(err).toBeInstanceOf(BoardLocationUnreadableError)
    expect(h.inprocess[m]).not.toHaveBeenCalled()
    expect(h.service[m]).not.toHaveBeenCalled()
  })
})

describe('the router is a port like the others', () => {
  it('reports kind routed, and each call reads the flag again (the cache lives in location.ts)', async () => {
    h.location.mockResolvedValueOnce('kernel').mockResolvedValueOnce('module')
    const b = make()
    expect(b.kind).toBe('routed')
    expect(await b.getBoard('x')).toBe('inprocess:getBoard')
    expect(await b.getBoard('x')).toBe('service:getBoard')
  })
})
