// TASK-077 residual: the per-customer pool must not outlive the customer's credentials.
// A rotated db_conn_ref (or a rotated password behind the same ref) is picked up: the
// pool is evicted on a ref change and on a failed (unavailable) check, and that check
// is retried once on a fresh pool.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCustomerGate } from '../../src/app/gate.ts'
import { createSecretResolver } from '../../src/tenancy/secrets.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'
import { A_ID, tenantRow } from '../harness/fakes.ts'

const dbA = kernelDatabaseOf(A_ID)
const urlWith = (pw: string) => `postgres://k_app:${pw}@pgbouncer:6432/${dbA}`
const ROW = { filename: '0001_idt_setup.sql', sha256: '5959761784f2363867c83a17281d13766d04bf5280b0f010754e6983c041602d', phase: 'expand', contract_after: null }

function harness(accepts: (pw: string) => boolean) {
  const opened: string[] = []
  const ended: string[] = []
  const createDb = (p: { url: string }) => {
    const pw = decodeURIComponent(new URL(p.url).password)
    opened.push(pw)
    const tx = Object.assign(async (strings: TemplateStringsArray) => (strings.join('?').includes('to_regclass') ? [{ present: true }] : [ROW]), { unsafe: async () => [ROW] })
    return {
      // the server refuses a new session with a stale password (28P01): the pool can no longer connect
      begin: async (_m: string, cb: (t: unknown) => unknown) => {
        if (!accepts(pw)) throw Object.assign(new Error('password authentication failed'), { code: '28P01' })
        return cb(tx)
      },
      end: async () => {
        ended.push(pw)
      },
      options: { max: 2 },
    } as never
  }
  return { opened, ended, createDb }
}

const gateOf = (env: Record<string, string>, h: ReturnType<typeof harness>) =>
  createCustomerGate({
    dirs: [fileURLToPath(new URL('../../migrations/core/', import.meta.url))],
    resolveSecret: createSecretResolver({ env, allowEnvRefs: true }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    createDb: h.createDb,
    evictGraceMs: 0,
  })

describe('the customer gate and a rotated credential', () => {
  it('a rotated password behind the same ref: the stale pool is evicted on the failed check and the retry on a fresh pool serves', async () => {
    let serverPw = 'pw1'
    const env = { KERNEL_DB_A: urlWith('pw1') }
    const h = harness((pw) => pw === serverPw)
    const gate = gateOf(env, h)
    expect(await gate.check(tenantRow(A_ID, 'a'))).toEqual({ ok: true })
    serverPw = 'pw2'
    env.KERNEL_DB_A = urlWith('pw2')
    expect(await gate.check(tenantRow(A_ID, 'a'))).toEqual({ ok: true })
    expect(h.opened).toEqual(['pw1', 'pw2'])
    await gate.close()
  })

  it('a changed db_conn_ref is picked up on the very next request, without waiting for a failure', async () => {
    const env = { KERNEL_DB_A: urlWith('x1'), KERNEL_DB_A2: urlWith('x2') }
    const h = harness(() => true)
    const gate = gateOf(env, h)
    expect(await gate.check(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A' }))).toEqual({ ok: true })
    expect(await gate.check(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A' }))).toEqual({ ok: true })
    expect(h.opened).toEqual(['x1']) // one pool while the ref is unchanged
    expect(await gate.check(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A2' }))).toEqual({ ok: true })
    expect(h.opened).toEqual(['x1', 'x2'])
    await gate.close()
  })

  it('db() evicts the stale pool on a changed db_conn_ref exactly as check() does (a sweep must not hide the rotation)', async () => {
    const env = { KERNEL_DB_A: urlWith('y1'), KERNEL_DB_A2: urlWith('y2') }
    const h = harness(() => true)
    const gate = gateOf(env, h)
    await gate.db(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A' }))
    await gate.db(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A' }))
    expect(h.opened).toEqual(['y1']) // unchanged ref: one pool
    await gate.db(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A2' }))
    expect(h.opened).toEqual(['y1', 'y2'])
    await new Promise((r) => setTimeout(r, 25)) // evictGraceMs 0 ends the old pool on the next timer tick
    expect(h.ended).toEqual(['y1'])
    // and the very next gate check, with the new ref, does not reopen a third pool
    expect(await gate.check(tenantRow(A_ID, 'a', 'active', { dbConnRef: 'env:KERNEL_DB_A2' }))).toEqual({ ok: true })
    expect(h.opened).toEqual(['y1', 'y2'])
    await gate.close()
  })

  it('a database that is really unreachable stays 503 (one retry, no loop)', async () => {
    const h = harness(() => false)
    const gate = gateOf({ KERNEL_DB_A: urlWith('pw1') }, h)
    expect(await gate.check(tenantRow(A_ID, 'a'))).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.opened).toHaveLength(2)
    await gate.close()
  })
})
