// org-units-db.board-cleanup.test.ts - what deleteOrgUnit does about the boards of a deleted org unit.
//
// While a customer's boards live in the kernel tables, the database cascade (board.org_unit_id ON DELETE
// CASCADE) removes them with the org unit. In the board module's own database nothing does, so the
// delete asks the board module (through the runtime-registry provider 'board:delete-org-unit-boards';
// the kernel never imports module code) to remove them. The rules:
//   - deleteOrgUnit(id), the form every production caller uses, asks AFTER its own transaction commits;
//   - deleteOrgUnit(tx, id) NEVER asks: it runs inside a caller's transaction that may still roll back,
//     and a call made before that commit would delete boards of an org unit that survives;
//   - a failure of the call does not undo the delete, and is logged without a name or id;
//   - no provider registered (the board module is off) means no call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: [] as string[],
  failOutboxInsert: false,
}))

vi.mock('../db', () => {
  const ORG_ROW = { id: 'ou-1', name: 'Referat Finanzen', kind: 'committee', parent_id: 'ou-parent' }
  const runner = (on: 'pool' | 'tx') => {
    const fn = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      const q = strings.join(' ')
      if (q.includes('INSERT INTO org_unit_event_outbox') && state.failOutboxInsert) {
        return Promise.reject(new Error('outbox insert failed'))
      }
      if (q.includes('DELETE FROM org_units')) {
        state.events.push(`dml:${on}`)
        // an id that is not in the table matches no row
        return Promise.resolve(args[0] === 'ou-gone' ? [] : [{ id: ORG_ROW.id }])
      }
      return Promise.resolve([])
    }) as unknown as { (...a: unknown[]): Promise<unknown[]>; json: (x: unknown) => unknown }
    fn.json = (x: unknown) => x
    return fn
  }
  const pool = runner('pool') as ReturnType<typeof runner> & { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  pool.begin = async (cb) => {
    const tx = runner('tx')
    try {
      const out = await cb(tx)
      state.events.push('commit')
      return out
    } catch (err) {
      state.events.push('rollback')
      throw err
    }
  }
  return { getDb: () => pool }
})

import { deleteOrgUnit } from './org-units-db'
import { registerDataProvider, _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'

const KEY = 'board:delete-org-unit-boards' as const

type Cleanup = { status: 'not-due' } | { status: 'deleted'; boards: number } | { status: 'deferred' }
const deleted = (boards: number): Cleanup => ({ status: 'deleted', boards })

function provider(result: Cleanup | Error = deleted(2)) {
  return vi.fn(async (id: string): Promise<Cleanup> => {
    state.events.push(`board:${id}`)
    if (result instanceof Error) throw result
    return result
  })
}

describe('deleteOrgUnit and the boards of the deleted org unit', () => {
  beforeEach(() => {
    state.events.length = 0
    state.failOutboxInsert = false
    _resetRuntimeRegistryForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetRuntimeRegistryForTests()
  })

  it('deleteOrgUnit(id) asks the board module for that id AFTER its own transaction committed', async () => {
    const p = provider()
    registerDataProvider(KEY, p)
    await deleteOrgUnit('ou-1')
    expect(p).toHaveBeenCalledExactlyOnceWith('ou-1')
    expect(state.events).toEqual(['dml:tx', 'commit', 'board:ou-1'])
  })

  it('deleteOrgUnit(tx, id) NEVER asks the board module', async () => {
    const p = provider()
    registerDataProvider(KEY, p)
    const tx = Object.assign((() => Promise.resolve([{ id: 'ou-1' }])) as never, { json: (x: unknown) => x })
    await deleteOrgUnit(tx, 'ou-1')
    expect(p).not.toHaveBeenCalled()
  })

  it('deleteOrgUnit(tx, id) never asks even when the caller\'s transaction rolls back afterwards', async () => {
    const p = provider()
    registerDataProvider(KEY, p)
    const { getDb } = await import('../db')
    await expect(
      getDb().begin(async (tx) => {
        await deleteOrgUnit(tx as never, 'ou-1')
        throw new Error('the caller fails after the delete')
      }),
    ).rejects.toThrow('the caller fails')
    expect(state.events).toContain('rollback')
    expect(p).not.toHaveBeenCalled()
  })

  it('does not ask when the delete itself rolled back (the org unit survives)', async () => {
    const p = provider()
    registerDataProvider(KEY, p)
    process.env.NATS_URL = 'nats://localhost:4222'
    state.failOutboxInsert = true
    try {
      await expect(deleteOrgUnit('ou-1')).rejects.toThrow('outbox insert failed')
    } finally {
      delete process.env.NATS_URL
    }
    expect(p).not.toHaveBeenCalled()
  })

  it('a failing board call does not undo or fail the delete, and is logged without the id', async () => {
    const p = provider(new Error('leaf unreachable for ou-1'))
    registerDataProvider(KEY, p)
    await expect(deleteOrgUnit('ou-1')).resolves.toBeUndefined()
    expect(state.events).toEqual(['dml:tx', 'commit', 'board:ou-1'])
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).toMatch(/board/i)
    expect(logged).not.toContain('ou-1')
    expect(logged).not.toContain('Referat')
  })

  it('logs the number of boards removed, never an id or a name', async () => {
    registerDataProvider(KEY, provider(deleted(3)))
    await deleteOrgUnit('ou-1')
    const logged = vi.mocked(console.info).mock.calls.flat().join(' ')
    expect(logged).toContain('3')
    expect(logged).not.toContain('ou-1')
  })

  it('a provider that answers not-due (the boards live in the kernel tables, the cascade did it) logs nothing', async () => {
    registerDataProvider(KEY, provider({ status: 'not-due' }))
    await deleteOrgUnit('ou-1')
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
  })

  it('a provider that answers deleted with zero boards logs nothing', async () => {
    registerDataProvider(KEY, provider(deleted(0)))
    await deleteOrgUnit('ou-1')
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
  })

  it('a provider that answers deferred (the call was owed and could not be made) warns, does not fail the delete, and names no id', async () => {
    registerDataProvider(KEY, provider({ status: 'deferred' }))
    await expect(deleteOrgUnit('ou-1')).resolves.toBeUndefined()
    const warned = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(warned).toMatch(/board/i)
    expect(warned).not.toContain('ou-1')
    expect(warned).not.toContain('Referat')
  })

  it('no provider registered (the board module is off): the delete runs as before, no call, no log', async () => {
    await deleteOrgUnit('ou-1')
    expect(state.events).toEqual(['dml:tx', 'commit'])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('asks even when the delete matched no row (the leaf delete is idempotent)', async () => {
    const p = provider(deleted(0))
    registerDataProvider(KEY, p)
    await deleteOrgUnit('ou-gone')
    expect(p).toHaveBeenCalledExactlyOnceWith('ou-gone')
  })
})
