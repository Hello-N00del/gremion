// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the board module's erasure hook. A card carries two
// personal data: assignee_keycloak_id (who owns the task) and created_by (who
// opened it). The subject is unassigned (NULL: an unowned card is a valid state)
// and the authorship is replaced by a marker that matches no user. The boards,
// stacks and cards themselves are council planning records and stay.
//
// Where the board lives decides what the hook does. The two updates ALWAYS run on the kernel tables (a
// board that moved leaves its old copy behind, and that copy holds the id too). kernel / moving: that is
// all. module (or BOARD_BACKEND=service): the board's own database is erased as well, through the leaf; a
// blocked database is `deferred`, any other failure throws, and nothing ever says `erased` for rows it
// did not reach. The flag is read AFTER the updates, so a flip that the updates queued behind is seen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const h = vi.hoisted(() => ({
  eraseSubject: vi.fn(),
  deleteBoardsForOrgUnit: vi.fn(),
  dbHandle: { current: null as unknown },
}))

vi.mock('./backend/service-client', async () => {
  const actual = await vi.importActual<typeof import('./backend/service-client')>('./backend/service-client')
  class ServiceBoardClient {
    eraseSubject = h.eraseSubject
    deleteBoardsForOrgUnit = h.deleteBoardsForOrgUnit
  }
  return { ...actual, ServiceBoardClient }
})
vi.mock('$lib/server/db', () => ({ getDb: () => h.dbHandle.current }))

import { BoardServiceError } from './backend/service-client'
import { boardErasureHook, BOARD_ERASED_MARKER, deleteBoardsOfOrgUnit } from './erasure'

const TENANT = { id: 'tenant-1', slug: 'tenant-one' } as unknown as TenantContext
const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT, fn)
const SUBJECT = 'u-secret-subject-id'

// `location` is what the board_location row says ('none' = no row: never moved); `ageS` is the
// database's own age of that row. The flag read is a SELECT and is kept out of `calls`, which holds
// the UPDATEs only.
function fakeDb(counts: number[], location: 'kernel' | 'moving' | 'module' | 'none' | Error = 'kernel', ageS = 1) {
  const calls: { text: string; values: unknown[] }[] = []
  const reads: string[] = []
  // every statement in the order the transaction saw it: 'update' or 'read' (the flag)
  const order: string[] = []
  const state = { rolledBack: false, committed: false }
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (/FROM board_location/.test(text)) {
      reads.push(text)
      order.push('read')
      if (location instanceof Error) return Promise.reject(location)
      return Promise.resolve(location === 'none' ? [] : [{ location, age_s: ageS }])
    }
    calls.push({ text, values })
    order.push('update')
    return Promise.resolve({ count: counts[calls.length - 1] ?? 0 })
  }
  const db = Object.assign(tag, {
    begin: async (fn: (tx: typeof tag) => Promise<unknown>) => {
      try {
        const out = await fn(tag)
        state.committed = true
        return out
      } catch (err) {
        state.rolledBack = true
        throw err
      }
    },
  })
  return { db: db as unknown as Sql, calls, reads, order, state }
}

const notProvisioned = () => new BoardServiceError(404, 'tenant_not_provisioned', 'tenant_not_provisioned')

beforeEach(() => {
  h.eraseSubject.mockReset()
  h.deleteBoardsForOrgUnit.mockReset()
  h.dbHandle.current = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('boardErasureHook', () => {
  it('is registered under the module id and needs a connection', () => {
    expect(boardErasureHook.moduleId).toBe('board')
    expect(boardErasureHook.requiresConnection).not.toBe(false)
  })

  it('uses the marker the leaf writes: one that matches no user', () => {
    expect(BOARD_ERASED_MARKER).toBe('erased')
  })

  it('unassigns the subject and pseudonymises card authorship, reporting both counts', async () => {
    const { db, calls } = fakeDb([2, 5])
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({ status: 'erased', counts: { card_assignee: 2, card_created_by: 5 } })
    expect(calls).toHaveLength(2)
    expect(calls[0].text).toMatch(/UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id/)
    expect(calls[0].values).toEqual(['u-1'])
    expect(calls[1].text).toMatch(/UPDATE card SET created_by/)
    expect(calls[1].values).toEqual([BOARD_ERASED_MARKER, 'u-1'])
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it.each(['kernel', 'none'] as const)('auto, location %s: runs the kernel updates and never calls the leaf', async (loc) => {
    const { db, calls } = fakeDb([1, 2], loc)
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({ status: 'erased', counts: { card_assignee: 1, card_created_by: 2 } })
    expect(calls).toHaveLength(2)
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it('auto, location moving: the kernel copy still serves, so the updates run (the flip lock of the move covers the race)', async () => {
    const { db, calls } = fakeDb([1, 2], 'moving')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(calls).toHaveLength(2)
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it('auto, a stale moving row (older than the router limit) reads as kernel: the updates run', async () => {
    const { db, calls } = fakeDb([0, 0], 'moving', 301)
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(calls).toHaveLength(2)
  })

  it('auto, the flag cannot be read: throws (reported failed), the transaction rolls back, the leaf is not called, never a guess', async () => {
    const { db, state } = fakeDb([9, 9], new Error('connection refused'))
    await expect(boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })).rejects.toThrow(/nicht verf/)
    expect(state).toEqual({ rolledBack: true, committed: false })
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it('auto: the flag is read AFTER the two updates, in the same transaction (a flip the updates waited behind is then seen)', async () => {
    const { db, order, state } = fakeDb([1, 2], 'kernel')
    await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(order).toEqual(['update', 'update', 'read'])
    expect(state.committed).toBe(true)
  })

  it('BOARD_BACKEND=inprocess forces the kernel tables and ignores the flag, as the router does', async () => {
    vi.stubEnv('BOARD_BACKEND', 'inprocess')
    const { db, calls, reads } = fakeDb([1, 1], 'module')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(2)
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it.each([undefined, 'auto', 'inprocess', 'service'])('no connection (BOARD_BACKEND=%s): skipped, nothing called', async (mode) => {
    if (mode !== undefined) vi.stubEnv('BOARD_BACKEND', mode)
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db: null })
    expect(res.status).toBe('skipped')
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  it.each(['', 'Service', 'kernel', 'module'])('an unknown BOARD_BACKEND value %j throws, as the router does: nothing is updated or called', async (value) => {
    vi.stubEnv('BOARD_BACKEND', value)
    const { db, calls } = fakeDb([9, 9], 'module')
    await expect(boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })).rejects.toThrow(/BOARD_BACKEND/)
    expect(calls).toHaveLength(0)
    expect(h.eraseSubject).not.toHaveBeenCalled()
  })

  describe('the board lives in its own database', () => {
    it('location module: the kernel copy is erased in the same transaction, then the leaf is called; both sets of counts are reported', async () => {
      h.eraseSubject.mockResolvedValue({ card_assignee: 3, card_created_by: 4 })
      const { db, calls, order, state } = fakeDb([5, 6], 'module')
      const res = await inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))
      expect(res).toEqual({
        status: 'erased',
        counts: { card_assignee: 3, card_created_by: 4, card_assignee_kernel_copy: 5, card_created_by_kernel_copy: 6 },
      })
      expect(h.eraseSubject).toHaveBeenCalledExactlyOnceWith('u-1')
      expect(order).toEqual(['update', 'update', 'read'])
      expect(calls[0]!.text).toMatch(/UPDATE card SET assignee_keycloak_id = NULL/)
      expect(calls[1]!.text).toMatch(/UPDATE card SET created_by/)
      expect(state.committed).toBe(true)
    })

    it('the kernel updates are committed before the leaf is asked (no transaction waits on an HTTP call), and a leaf failure does not undo them', async () => {
      const seenAtLeaf: boolean[] = []
      const { db, state } = fakeDb([1, 1], 'module')
      h.eraseSubject.mockImplementation(async () => {
        seenAtLeaf.push(state.committed)
        throw new BoardServiceError(500, 'HTTP 500')
      })
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))).rejects.toBeInstanceOf(BoardServiceError)
      expect(seenAtLeaf).toEqual([true])
    })

    it('BOARD_BACKEND=auto spelled out behaves the same as unset', async () => {
      vi.stubEnv('BOARD_BACKEND', 'auto')
      h.eraseSubject.mockResolvedValue({ card_assignee: 0, card_created_by: 0 })
      const { db, calls } = fakeDb([0, 0], 'module')
      const res = await inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))
      expect(res.status).toBe('erased')
      expect(calls).toHaveLength(2)
    })

    it('BOARD_BACKEND=service: the kernel copy and the leaf, whatever the flag says; the flag is not read', async () => {
      vi.stubEnv('BOARD_BACKEND', 'service')
      h.eraseSubject.mockResolvedValue({ card_assignee: 1, card_created_by: 0 })
      const { db, calls, reads } = fakeDb([2, 0], 'kernel')
      const res = await inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))
      expect(res).toEqual({
        status: 'erased',
        counts: { card_assignee: 1, card_created_by: 0, card_assignee_kernel_copy: 2, card_created_by_kernel_copy: 0 },
      })
      expect(reads).toHaveLength(0)
      expect(calls).toHaveLength(2)
    })

    it('a blocked board database (leaf 404 tenant_not_provisioned) is deferred, naming no subject, never erased', async () => {
      h.eraseSubject.mockRejectedValue(notProvisioned())
      const { db } = fakeDb([9, 9], 'module')
      const res = await inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: SUBJECT, db }))
      expect(res.status).toBe('deferred')
      expect(res.status === 'deferred' && res.reason).toMatch(/blocked|switched off/i)
      expect(JSON.stringify(res)).not.toContain(SUBJECT)
    })

    it('a leaf 404 that is NOT the blocked-database answer (an unknown route, an old leaf) throws instead of deferring', async () => {
      h.eraseSubject.mockRejectedValue(new BoardServiceError(404, 'not found', 'not found'))
      const { db } = fakeDb([9, 9], 'module')
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))).rejects.toBeInstanceOf(BoardServiceError)
    })

    it.each([500, 503, 400, 403])('a leaf %i throws (the orchestrator reports failed and retries): no silent success', async (status) => {
      h.eraseSubject.mockRejectedValue(new BoardServiceError(status, `HTTP ${status}`))
      const { db } = fakeDb([9, 9], 'module')
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))).rejects.toBeInstanceOf(BoardServiceError)
    })

    it('a network failure and a malformed leaf answer throw as well', async () => {
      const { db } = fakeDb([9, 9], 'module')
      h.eraseSubject.mockRejectedValue(new TypeError('fetch failed'))
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))).rejects.toThrow(/fetch failed/)
      h.eraseSubject.mockRejectedValue(new Error('[board-service-client] malformed eraseSubject response'))
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db }))).rejects.toThrow(/malformed/)
    })

    it('refuses to call the leaf when the request tenant is not the tenant the erasure is for', async () => {
      const { db } = fakeDb([9, 9], 'module')
      await expect(inTenant(() => boardErasureHook.erase({ tenantId: 'another-tenant', subjectId: 'u-1', db }))).rejects.toThrow(/tenant/i)
      expect(h.eraseSubject).not.toHaveBeenCalled()
    })

    it('outside any tenant context the leaf is not called either (the client needs the tenant headers)', async () => {
      const { db } = fakeDb([9, 9], 'module')
      await expect(boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db })).rejects.toThrow(/tenant/i)
      expect(h.eraseSubject).not.toHaveBeenCalled()
    })

    it('every outcome that reaches no rows is a deferral or a throw, never erased', async () => {
      const { db } = fakeDb([9, 9], 'module')
      for (const failure of [notProvisioned(), new BoardServiceError(500, 'HTTP 500'), new Error('x')]) {
        h.eraseSubject.mockRejectedValue(failure)
        const outcome = await inTenant(() => boardErasureHook.erase({ tenantId: TENANT.id, subjectId: 'u-1', db })).then(
          (r) => r.status,
          () => 'threw',
        )
        expect(['deferred', 'threw']).toContain(outcome)
      }
    })
  })
})

describe('deleteBoardsOfOrgUnit (the kernel calls it after it deleted the org unit)', () => {
  const OU = '11111111-1111-1111-1111-111111111111'

  it.each(['kernel', 'moving', 'none'] as const)('location %s: the kernel cascade already removed the boards, so there is no call (null)', async (loc) => {
    h.dbHandle.current = fakeDb([], loc).db
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'not-due' })
    expect(h.deleteBoardsForOrgUnit).not.toHaveBeenCalled()
  })

  it('location module: calls the leaf for that org unit and returns how many boards it deleted', async () => {
    h.dbHandle.current = fakeDb([], 'module').db
    h.deleteBoardsForOrgUnit.mockResolvedValue(2)
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'deleted', boards: 2 })
    expect(h.deleteBoardsForOrgUnit).toHaveBeenCalledExactlyOnceWith(OU)
  })

  it('reads the flag fresh from the kernel database, not from a cache', async () => {
    const first = fakeDb([], 'kernel')
    h.dbHandle.current = first.db
    await inTenant(() => deleteBoardsOfOrgUnit(OU))
    const second = fakeDb([], 'module')
    h.dbHandle.current = second.db
    h.deleteBoardsForOrgUnit.mockResolvedValue(0)
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'deleted', boards: 0 })
    expect(h.deleteBoardsForOrgUnit).toHaveBeenCalledTimes(1)
  })

  it('BOARD_BACKEND=inprocess: no flag read, no call', async () => {
    vi.stubEnv('BOARD_BACKEND', 'inprocess')
    const f = fakeDb([], 'module')
    h.dbHandle.current = f.db
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'not-due' })
    expect(f.reads).toHaveLength(0)
    expect(h.deleteBoardsForOrgUnit).not.toHaveBeenCalled()
  })

  it('BOARD_BACKEND=service: the leaf, without reading the flag', async () => {
    vi.stubEnv('BOARD_BACKEND', 'service')
    const f = fakeDb([], 'kernel')
    h.dbHandle.current = f.db
    h.deleteBoardsForOrgUnit.mockResolvedValue(1)
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'deleted', boards: 1 })
    expect(f.reads).toHaveLength(0)
  })

  it('a flag that cannot be read throws (the caller logs it), the leaf is not called', async () => {
    h.dbHandle.current = fakeDb([], new Error('connection refused')).db
    await expect(inTenant(() => deleteBoardsOfOrgUnit(OU))).rejects.toThrow(/nicht verf/)
    expect(h.deleteBoardsForOrgUnit).not.toHaveBeenCalled()
  })

  it('a blocked board database (404 tenant_not_provisioned) is a call that was owed and could not be made: deferred, not "nothing to do", no throw', async () => {
    h.dbHandle.current = fakeDb([], 'module').db
    h.deleteBoardsForOrgUnit.mockRejectedValue(notProvisioned())
    expect(await inTenant(() => deleteBoardsOfOrgUnit(OU))).toEqual({ status: 'deferred' })
  })

  it.each(['', 'Service', 'kernel', 'module'])('an unknown BOARD_BACKEND value %j throws, as the router does: no flag read, no call', async (value) => {
    vi.stubEnv('BOARD_BACKEND', value)
    const f = fakeDb([], 'module')
    h.dbHandle.current = f.db
    await expect(inTenant(() => deleteBoardsOfOrgUnit(OU))).rejects.toThrow(/BOARD_BACKEND/)
    expect(f.reads).toHaveLength(0)
    expect(h.deleteBoardsForOrgUnit).not.toHaveBeenCalled()
  })

  it.each([new BoardServiceError(500, 'HTTP 500'), new BoardServiceError(404, 'not found', 'not found'), new TypeError('fetch failed')])(
    'any other leaf failure throws: %s',
    async (failure) => {
      h.dbHandle.current = fakeDb([], 'module').db
      h.deleteBoardsForOrgUnit.mockRejectedValue(failure)
      await expect(inTenant(() => deleteBoardsOfOrgUnit(OU))).rejects.toBe(failure)
    },
  )
})
