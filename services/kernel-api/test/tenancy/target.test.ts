// TDD 5 (resolver), brief s.1 "Targets" (Q3): a customer's connection comes
// ONLY from its own control row's db_conn_ref, and must name exactly its own
// t_<hex32>__kernel. A's ref resolving to B's database is refused; an unset
// secret is refused (the gate turns it into a 503 for that customer only);
// RED reference: the env fallback (GREMION_KERNEL_PG_URL) is never consulted.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createSecretResolver, SecretRefError } from '../../src/tenancy/secrets.ts'
import { directUrlFor, kernelDatabaseOf, kernelTargetResolver } from '../../src/tenancy/target.ts'
import { createCustomerGate } from '../../src/app/gate.ts'
import { A_ID, B_ID, tenantRow } from '../harness/fakes.ts'

const dbA = kernelDatabaseOf(A_ID)
const dbB = kernelDatabaseOf(B_ID)
const url = (db: string, q = '') => `postgres://k_app:pw@pgbouncer:6432/${db}${q}`

describe('kernelTargetResolver (Q3)', () => {
  const env = { KERNEL_DB_A: url(dbA), KERNEL_DB_B: url(dbB), A_POINTS_AT_B: url(dbB), GREMION_KERNEL_PG_URL: 'postgres://admin:pw@postgres:5432/postgres' }
  const refs = new Map([
    [A_ID, 'env:KERNEL_DB_A'],
    [B_ID, 'env:KERNEL_DB_B'],
  ])
  const resolve = kernelTargetResolver({ refOf: (id) => refs.get(id), resolveSecret: createSecretResolver({ env }) })

  it("A's ref resolves to A's kernel database, B's to B's", async () => {
    expect((await resolve(A_ID, 'kernel')).url).toBe(url(dbA))
    expect((await resolve(B_ID, 'kernel')).url).toBe(url(dbB))
  })

  it("A's ref pointing at B's database is refused (A can never name B's database)", () => {
    const bad = kernelTargetResolver({ refOf: () => 'env:A_POINTS_AT_B', resolveSecret: createSecretResolver({ env }) })
    expect(() => bad(A_ID, 'kernel')).toThrow(/does not name database/)
  })

  it('RED reference: no ref in hand -> refused; the env fallback (GREMION_KERNEL_PG_URL) is never used', () => {
    const none = kernelTargetResolver({ refOf: () => undefined, resolveSecret: createSecretResolver({ env }) })
    expect(() => none(A_ID, 'kernel')).toThrow(/no db_conn_ref/)
  })

  it('an unset secret is refused, naming the ref and not a value', () => {
    const unset = kernelTargetResolver({ refOf: () => 'env:NOT_SET', resolveSecret: createSecretResolver({ env }) })
    expect(() => unset(A_ID, 'kernel')).toThrow(/env:NOT_SET is unset/)
  })

  it('only the kernel module, and only a canonical UUIDv7 customer', () => {
    expect(() => resolve(A_ID, 'calendar')).toThrow(/only kernel databases/)
    expect(() => kernelDatabaseOf('../x')).toThrow()
  })

  it('a url carrying a startup parameter (options=-c role=...) is refused (tenant-store assertTargetMatches)', () => {
    const r = kernelTargetResolver({ refOf: () => 'env:X', resolveSecret: createSecretResolver({ env: { X: url(dbA, '?options=-c%20role%3Dpostgres') } }) })
    expect(() => r(A_ID, 'kernel')).toThrow(/query parameter 'options'/)
  })
})

describe('directUrlFor (migrate, C10)', () => {
  it('keeps the credentials and database, takes the DIRECT server host and port', () => {
    const u = new URL(directUrlFor(url(dbA), 'postgres://postgres:5432/postgres', A_ID))
    expect([u.username, u.password, u.hostname, u.port, u.pathname]).toEqual(['k_app', 'pw', 'postgres', '5432', `/${dbA}`])
  })

  it('refuses a direct base that carries userinfo (a superuser password must never ride along)', () => {
    expect(() => directUrlFor(url(dbA), 'postgres://postgres:s3cret@postgres:5432/postgres', A_ID)).toThrow(/credentials/)
    expect(() => directUrlFor(url(dbA), 'postgres://postgres@postgres:5432/postgres', A_ID)).toThrow(/credentials/)
  })

  it("refuses a runtime url of another customer's database", () => {
    expect(() => directUrlFor(url(dbB), 'postgres://postgres:5432/x', A_ID)).toThrow(/does not name database/)
  })
})

describe('createSecretResolver (C10)', () => {
  it('file: refs must stay under /run/secrets/ after normalisation', () => {
    const r = createSecretResolver({ readFile: (p) => `secret-of ${p}\n` })
    expect(r('file:/run/secrets/tenants/a-db')).toBe('secret-of /run/secrets/tenants/a-db')
    expect(() => r('file:/run/secrets/../../etc/passwd')).toThrow(SecretRefError)
    expect(() => r('file:/etc/passwd')).toThrow(/outside \/run\/secrets\//)
  })

  it('refuses an unknown scheme and an empty secret', () => {
    expect(() => createSecretResolver({ env: {} })('vault:x')).toThrow(/unsupported/)
    expect(() => createSecretResolver({ readFile: () => '  \n' })('file:/run/secrets/x')).toThrow(/empty/)
  })
})

describe('the customer gate opens only the customer target (Q3) and caches nothing (A3)', () => {
  it('an unset secret for B is a 503 verdict for B only; A is judged on its own database', async () => {
    const opened: string[] = []
    const fakeSql = (db: string) => {
      const tx = Object.assign(async (strings: TemplateStringsArray) => (strings.join('?').includes('to_regclass') ? [{ present: true }] : [{ filename: '0001_idt_setup.sql', sha256: '5959761784f2363867c83a17281d13766d04bf5280b0f010754e6983c041602d', phase: 'expand', contract_after: null }]), {
        unsafe: async () => [{ filename: '0001_idt_setup.sql', sha256: '5959761784f2363867c83a17281d13766d04bf5280b0f010754e6983c041602d', phase: 'expand', contract_after: null }],
      })
      return { begin: async (_m: string, cb: (t: unknown) => unknown) => cb(tx), end: async () => {}, options: { max: 2 }, db } as never
    }
    const gate = createCustomerGate({
      dirs: [fileURLToPath(new URL('../../migrations/core/', import.meta.url))],
      resolveSecret: createSecretResolver({ env: { KERNEL_DB_A: url(dbA) } }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      createDb: (p) => {
        opened.push(new URL(p.url).pathname.slice(1))
        return fakeSql(new URL(p.url).pathname.slice(1))
      },
    })
    expect(await gate.check(tenantRow(A_ID, 'a'))).toEqual({ ok: true })
    expect(await gate.check(tenantRow(B_ID, 'b', 'active', { dbConnRef: 'env:KERNEL_DB_B' }))).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(opened).toEqual([dbA])
    await gate.close()
  })
})
