// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the board module's erasure hook. A card carries two
// personal data: assignee_keycloak_id (who owns the task) and created_by (who
// opened it). The subject is unassigned (NULL: an unowned card is a valid state)
// and the authorship is replaced by a marker that matches no user. The boards,
// stacks and cards themselves are council planning records and stay. With
// BOARD_BACKEND=service the board leaf owns its own database, which the kernel
// holds no connection to: that is `skipped`, never `erased`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { boardErasureHook, BOARD_ERASED_MARKER } from './erasure'

function fakeDb(counts: number[]) {
  const calls: { text: string; values: unknown[] }[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values })
    return Promise.resolve({ count: counts[calls.length - 1] ?? 0 })
  }
  const db = Object.assign(tag, { begin: async (fn: (tx: typeof tag) => Promise<unknown>) => fn(tag) })
  return { db: db as unknown as Sql, calls }
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
    expect(res.status === 'skipped' && res.reason).toMatch(/board service/i)
    expect(calls).toHaveLength(0)
  })

  it('no connection: skipped', async () => {
    const res = await boardErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db: null })
    expect(res.status).toBe('skipped')
  })
})
