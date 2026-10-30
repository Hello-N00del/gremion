// org-unit-events-pool.test.ts - the POOL overloads of the org_units writes.
//
// Production routes call updateOrgUnit(id, patch) / deleteOrgUnit(id) with no tx.
// The org_units DML and the org_unit_event_outbox INSERT must still commit as ONE
// unit there: an outbox INSERT that fails after an autocommitted DML would leave the
// change committed with no outbox row, and nothing downstream (the drain, the
// not-draining signal, the give-up scan) can see a row that was never written.
//
// So with no caller-supplied tx the choke point opens its own transaction on the
// pool and runs BOTH statements on it. The fake pool below emulates that: `begin`
// runs the callback on a recording tx handle and reports commit vs rollback.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Call {
  q: string
  args: unknown[]
  on: 'pool' | 'tx'
}

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  begins: 0,
  outcome: null as null | 'committed' | 'rolled-back',
  failOutboxInsert: false,
}))

vi.mock('../db', () => {
  const ORG_ROW = {
    id: 'ou-1',
    name: 'Referat Finanzen',
    kind: 'committee',
    parent_id: 'ou-parent',
  }
  const runner = (on: 'pool' | 'tx') => {
    const fn = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      const q = strings.join(' ')
      state.calls.push({ q, args, on })
      if (q.includes('INSERT INTO org_unit_event_outbox') && state.failOutboxInsert) {
        return Promise.reject(new Error('outbox insert failed'))
      }
      if (q.includes('INSERT INTO org_units') || q.includes('UPDATE org_units')) return Promise.resolve([ORG_ROW])
      if (q.includes('DELETE FROM org_units')) return Promise.resolve([{ id: ORG_ROW.id }])
      return Promise.resolve([])
    }) as unknown as { (...a: unknown[]): Promise<unknown[]>; json: (x: unknown) => unknown }
    fn.json = (x: unknown) => x
    return fn
  }
  const pool = runner('pool') as ReturnType<typeof runner> & { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  pool.begin = async (cb) => {
    state.begins += 1
    const tx = runner('tx')
    try {
      const out = await cb(tx)
      state.outcome = 'committed'
      return out
    } catch (err) {
      state.outcome = 'rolled-back'
      throw err
    }
  }
  return { getDb: () => pool }
})

import { createOrgUnit, updateOrgUnit, deleteOrgUnit } from './org-units-db'

const CREATE_INPUT = {
  name: 'Referat Finanzen',
  description: null,
  parentId: 'ou-parent',
  kind: 'committee',
  visibility: 'all_members' as const,
  wantsMatrixRoom: false,
  wantsNextcloudFolder: false,
}

const writes: Array<[string, () => Promise<unknown>, string]> = [
  ['createOrgUnit', () => createOrgUnit(CREATE_INPUT), 'INSERT INTO org_units'],
  ['updateOrgUnit', () => updateOrgUnit('ou-1', { name: 'Referat Finanzen' }), 'UPDATE org_units'],
  ['deleteOrgUnit', () => deleteOrgUnit('ou-1'), 'DELETE FROM org_units'],
]

describe('org-units pool overloads - DML and outbox row commit together', () => {
  beforeEach(() => {
    process.env.NATS_URL = 'nats://localhost:4222'
    state.calls.length = 0
    state.begins = 0
    state.outcome = null
    state.failOutboxInsert = false
  })
  afterEach(() => {
    delete process.env.NATS_URL
  })

  it.each(writes)('%s runs the DML and the outbox INSERT on ONE pool transaction', async (_name, run, dml) => {
    await run()
    const dmlCall = state.calls.find((c) => c.q.includes(dml))
    const outbox = state.calls.filter((c) => c.q.includes('INSERT INTO org_unit_event_outbox'))
    expect(outbox).toHaveLength(1)
    expect(dmlCall?.on).toBe('tx')
    expect(outbox[0]!.on).toBe('tx')
    expect(state.begins).toBe(1)
    expect(state.outcome).toBe('committed')
    // Nothing ran as a bare autocommit statement on the pool.
    expect(state.calls.filter((c) => c.on === 'pool')).toHaveLength(0)
  })

  it.each(writes)('%s: an outbox INSERT that fails rolls the org_units write back and surfaces the error', async (_name, run) => {
    state.failOutboxInsert = true
    await expect(run()).rejects.toThrow('outbox insert failed')
    expect(state.outcome).toBe('rolled-back')
  })
})
