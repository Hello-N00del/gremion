// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the board module's erasure hook. A card carries two
// personal data: assignee_keycloak_id (who owns the task) and created_by (who
// opened it). The subject is unassigned (NULL: an unowned card is a valid state)
// and the authorship is replaced by a marker that matches no user. The boards,
// stacks and cards themselves are council planning records and stay. With
// BOARD_BACKEND=service, or a location flag of 'module', the board lives in the module's own database, which the kernel
// holds no connection to: that is `skipped`, never `erased`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { boardErasureHook, BOARD_ERASED_MARKER } from './erasure'

// `location` is what the board_location row says ('none' = no row: never moved); `ageS` is the
// database's own age of that row. The flag read is a SELECT and is kept out of `calls`, which holds
// the UPDATEs only.
function fakeDb(counts: number[], location: 'kernel' | 'moving' | 'module' | 'none' | Error = 'kernel', ageS = 1) {
  const calls: { text: string; values: unknown[] }[] = []
  const reads: string[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (/FROM board_location/.test(text)) {
      reads.push(text)
      if (location instanceof Error) return Promise.reject(location)
      return Promise.resolve(location === 'none' ? [] : [{ location, age_s: ageS }])
    }
    calls.push({ text, values })
    return Promise.resolve({ count: counts[calls.length - 1] ?? 0 })
  }
  const db = Object.assign(tag, { begin: async (fn: (tx: typeof tag) => Promise<unknown>) => fn(tag) })
  return { db: db as unknown as Sql, calls, reads }
}

afterEach(() => vi.unstubAllEnvs())

describe('boardErasureHook', () => {
  it('is registered under the module id and needs a connection', () => {
    expect(boardErasureHook.moduleId).toBe('board')
    expect(boardErasureHook.requiresConnection).not.toBe(false)
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
  })

  it('BOARD_BACKEND=service: skipped with a reason, the kernel DB is not touched', async () => {
    vi.stubEnv('BOARD_BACKEND', 'service')
    const { db, calls } = fakeDb([9, 9])
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/module database/i)
    expect(calls).toHaveLength(0)
  })

  // The router's default is 'auto': the board_location row decides where the board lives. The hook
  // must follow the same row, or it reports 'erased' for kernel tables that no longer hold the board.
  it('auto (BOARD_BACKEND unset), location module: skipped, the kernel tables are not touched', async () => {
    const { db, calls, reads } = fakeDb([9, 9], 'module')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/module database/i)
    expect(reads).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  it('BOARD_BACKEND=auto spelled out behaves the same as unset', async () => {
    vi.stubEnv('BOARD_BACKEND', 'auto')
    const { db, calls } = fakeDb([9, 9], 'module')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(calls).toHaveLength(0)
  })

  it.each(['kernel', 'none'] as const)('auto, location %s: runs the kernel updates', async (loc) => {
    const { db, calls } = fakeDb([1, 2], loc)
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({ status: 'erased', counts: { card_assignee: 1, card_created_by: 2 } })
    expect(calls).toHaveLength(2)
  })

  it('auto, location moving: the kernel copy still serves, so the updates run (the flip lock of the move covers the race)', async () => {
    const { db, calls } = fakeDb([1, 2], 'moving')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(calls).toHaveLength(2)
  })

  it('auto, a stale moving row (older than the router limit) reads as kernel: the updates run', async () => {
    const { db, calls } = fakeDb([0, 0], 'moving', 301)
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(calls).toHaveLength(2)
  })

  it('auto, the flag cannot be read: throws (reported failed), never erased and never a guess', async () => {
    const { db, calls } = fakeDb([9, 9], new Error('connection refused'))
    await expect(boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })).rejects.toThrow(/nicht verf/)
    expect(calls).toHaveLength(0)
  })

  it('BOARD_BACKEND=inprocess forces the kernel tables and ignores the flag, as the router does', async () => {
    vi.stubEnv('BOARD_BACKEND', 'inprocess')
    const { db, calls, reads } = fakeDb([1, 1], 'module')
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('erased')
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  it('no connection: skipped', async () => {
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db: null })
    expect(res.status).toBe('skipped')
  })
})
