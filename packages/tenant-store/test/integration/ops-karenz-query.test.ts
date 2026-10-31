// The host collector's Karenz query (infra/host/ops/metrics-textfile.sh) run
// as rendered, on the real platform schema. test/host/ops.bats shims
// `docker exec` and only sees the text, so a query that does not parse (an
// unclosed parenthesis once took out every Karenz gauge and left the absent()
// alert firing for good) is green there. This one fails on it.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformDb } from '../harness/lifecycle.js'

const SCRIPT = fileURLToPath(new URL('../../../../infra/host/ops/metrics-textfile.sh', import.meta.url))
const render = (mode: 'on' | 'off') => execFileSync('bash', [SCRIPT, '--print-karenz-sql', mode], { encoding: 'utf8' }).trim()

const C = (n: string) => `0192f0c1-0000-7000-8000-0000000000${n}`
const KEY = 'kzmetrics'

class Rollback extends Error {}

describe('the collector Karenz query on the real platform schema', () => {
  let platform: Sql
  beforeAll(() => {
    platform = platformDb()
  })
  afterAll(async () => {
    await platform.end({ timeout: 5 })
  })

  /** Seeds inside a transaction that is rolled back: the event table is append-only, so nothing may be left behind. */
  const run = async (mode: 'on' | 'off') => {
    const sql = render(mode)
    let rows: { kind: string; customer: string; module: string; n: string }[] = []
    try {
      await platform.begin(async (tx) => {
        await tx`INSERT INTO plt.module (module_key, name, owning_context_code, toggleable, created_by_kind, updated_by_kind)
                 VALUES (${KEY}, ${KEY}, 'ops', true, 'system', 'system')`
        const open = (customer: string, off: string, fin: string) =>
          tx`INSERT INTO plt.module_karenz (customer_id, module_id, state, switched_off_at, final_at, actor_kind)
             SELECT ${customer}, module_id, 'open', now() - ${off}::interval, now() + ${fin}::interval, 'operator' FROM plt.module WHERE module_key = ${KEY}`
        const restoring = (customer: string, since: string) =>
          tx`INSERT INTO plt.module_karenz (customer_id, module_id, state, switched_off_at, final_at, restore_requested_at, actor_kind)
             SELECT ${customer}, module_id, 'restoring', now() - interval '5 days', now() + interval '25 days', now() - ${since}::interval, 'operator' FROM plt.module WHERE module_key = ${KEY}`
        const event = (customer: string, level: string, step: string) =>
          tx`INSERT INTO plt.module_karenz_event (karenz_id, level, step, message)
             SELECT karenz_id, ${level}, ${step}, 'x' FROM plt.module_karenz WHERE customer_id = ${customer}`
        await open(C('a1'), '2 hours', '28 days') // no switch-off notice after 1 h: stale
        await restoring(C('b1'), '3 hours') // waiting for the restored report over an hour: stale
        await restoring(C('c1'), '10 minutes') // fresh: not stale
        await open(C('d1'), '2 hours', '28 days') // noticed, one step failing: failed, not stale
        await event(C('d1'), 'info', 'notice:switchoff')
        await event(C('d1'), 'error', 'export')
        await open(C('e1'), '31 days', '-7 hours') // 7 h past its final day: overdue (switch on only)
        for (const step of ['notice:switchoff', 'notice:t23', 'notice:t29']) await event(C('e1'), 'info', step)
        // positional: the UNION's columns are all unnamed or share a name
        const out = await tx.unsafe(sql).values()
        rows = out.map((r) => ({ kind: String(r[0]), customer: String(r[1] ?? ''), module: String(r[2] ?? ''), n: String(r[3]) }))
        throw new Rollback()
      })
    } catch (err) {
      if (!(err instanceof Rollback)) throw err
    }
    return rows
  }

  const mine = (rows: Awaited<ReturnType<typeof run>>, kind: string) =>
    rows
      .filter((r) => r.kind === kind && r.module === KEY)
      .map((r) => r.customer)
      .sort()

  it('parses and answers: live count, failed, stale (open and restoring) and no overdue with the deletion switch off', async () => {
    const rows = await run('off')
    expect(rows.find((r) => r.kind === 'live')).toBeTruthy()
    expect(Number(rows.find((r) => r.kind === 'live')!.n)).toBeGreaterThanOrEqual(5)
    expect(mine(rows, 'failed')).toEqual([C('d1')])
    expect(mine(rows, 'stale')).toEqual([C('a1'), C('b1')])
    expect(mine(rows, 'overdue')).toEqual([])
  })

  it('adds the overdue arm with the deletion switch on', async () => {
    const rows = await run('on')
    expect(mine(rows, 'overdue')).toEqual([C('e1')])
    expect(mine(rows, 'stale')).toEqual([C('a1'), C('b1')])
  })
})
