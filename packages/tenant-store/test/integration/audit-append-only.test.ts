// TASK-033-a on the scratch stack: the kernel audit_log is a GOVERNANCE RECORD
// (RC-GOV-CHAIN, operator decision 2026-10-28): append-only for the app. The
// app role (and the owner role it is a member of) holds no DELETE, UPDATE or
// TRUNCATE on it, and nothing in this package purges it. ensureKernelAuditAppendOnly
// applies that through the hardened admin path (asAdminIn + execFormatted,
// qualified names), at provisioning and on reconcile.
import { randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dropKernelDatabase,
  ensureKernelAuditAppendOnly,
  ensureKernelDatabase,
  kernelAuditAppendOnlyProblems,
  kernelDbName,
  kernelRoles,
} from '../../src/lifecycle/index.js'
import type { ModuleServer } from '../../src/lifecycle/index.js'
import { connect, connectAs } from '../harness/db.js'
import { uuidv7 } from '../harness/lifecycle.js'

/** The kernel server as customer-adapters.ts builds it; `bare` forgets the startup search_path pin. */
function kernelServer(opts: { bare?: boolean } = {}): ModuleServer & { close(): Promise<void> } {
  const admin = connect('t020_test_admin', { max: 2 })
  const pools: Sql[] = []
  return {
    admin,
    open(database) {
      const sql = connect(database, { max: 2, ...(opts.bare ? {} : { connection: { search_path: 'pg_catalog' } }) })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

const sqlState = (e: unknown) => (e as { code?: string }).code

describe('ensureKernelAuditAppendOnly (TASK-033-a: audit_log is a governance record)', () => {
  let server: ReturnType<typeof kernelServer>
  const pw = randomBytes(24).toString('base64url')
  const pools: Sql[] = []
  const tenants: string[] = []
  const as = (t: string, user: string) => {
    const s = connectAs(kernelDbName(t), user, pw, { connection: { search_path: 'pg_catalog' }, max: 1 })
    pools.push(s)
    return s
  }

  /** the tables the chain migrations 0009 / 0043 / 0059 create, owned by the owner role */
  async function seed(t: string, opts: { tables?: boolean } = { tables: true }) {
    const { owner } = kernelRoles(t)
    await ensureKernelDatabase(server, t, pw)
    tenants.push(t)
    if (!opts.tables) return
    const d = connect(kernelDbName(t), { max: 1 })
    try {
      await d.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${owner}`)
        await tx.unsafe(`
          CREATE TABLE public.audit_log (id bigserial PRIMARY KEY, user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
          CREATE TABLE public.audit_log_chain_anchor (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), anchor_hash text NOT NULL);
          INSERT INTO public.audit_log (user_id) VALUES ('0192f3e0-1a2b-7c3d-8e4f-0123456789ab'), ('0192f3e0-1a2b-7c3d-8e4f-0123456789ac');
          INSERT INTO public.audit_log_chain_anchor (anchor_hash) VALUES (repeat('a', 64));`)
      })
    } finally {
      await d.end({ timeout: 5 })
    }
  }

  beforeAll(() => {
    server = kernelServer()
  })

  afterAll(async () => {
    for (const t of tenants) await dropKernelDatabase(server, t).catch((e: unknown) => console.error('[audit-append-only] teardown', e))
    await Promise.all(pools.map((s) => s.end({ timeout: 5 }).catch(() => {})))
    await server.close()
  })

  it('baseline: before the call the app role CAN delete, update and truncate audit_log (membership in the owner), and the checker names it', async () => {
    const T = uuidv7()
    await seed(T)
    const { app } = kernelRoles(T)
    const problems = (await kernelAuditAppendOnlyProblems(server, T)).join('\n')
    expect(problems).toMatch(/audit_log: .*DELETE/)
    expect(problems).toMatch(/audit_log: .*UPDATE/)
    expect(problems).toMatch(/audit_log: .*TRUNCATE/)
    expect(problems).toMatch(/audit_log_chain_anchor: .*INSERT/)
    const a = as(T, app)
    const del = await a`DELETE FROM public.audit_log WHERE id = (SELECT min(id) FROM public.audit_log) RETURNING id`
    expect(del.length).toBe(1)
  })

  it('after the call: the app and the owner cannot DELETE / UPDATE / TRUNCATE audit_log (42501); INSERT and SELECT still work; the anchor is read-only', async () => {
    const T = uuidv7()
    await seed(T)
    const { app, owner } = kernelRoles(T)
    expect(await ensureKernelAuditAppendOnly(server, T)).toEqual({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    expect(await kernelAuditAppendOnlyProblems(server, T)).toEqual([])

    const a = as(T, app)
    const code = async (p: PromiseLike<unknown>) => {
      try {
        await p
        return 'ok'
      } catch (e) {
        return sqlState(e)
      }
    }
    expect(await code(a`DELETE FROM public.audit_log`)).toBe('42501')
    expect(await code(a`UPDATE public.audit_log SET user_id = 'x'`)).toBe('42501')
    expect(await code(a`TRUNCATE public.audit_log`)).toBe('42501')
    expect(await code(a`INSERT INTO public.audit_log (user_id) VALUES ('0192f3e0-1a2b-7c3d-8e4f-0123456789ad')`)).toBe('ok')
    expect(await code(a`SELECT count(*)::int AS n FROM public.audit_log`), 'select audit_log').toBe('ok')
    expect(await code(a`UPDATE public.audit_log_chain_anchor SET anchor_hash = repeat('b', 64)`)).toBe('42501')
    expect(await code(a`INSERT INTO public.audit_log_chain_anchor (singleton, anchor_hash) VALUES (false, repeat('c', 64))`)).toBe('42501')
    expect(await code(a`DELETE FROM public.audit_log_chain_anchor`)).toBe('42501')
    expect(await code(a`SELECT anchor_hash FROM public.audit_log_chain_anchor`), 'select anchor').toBe('ok')

    // the app session's SET ROLE owner (the migrations' own session role) is not a way round
    const session = await a.reserve()
    let viaOwner: string | undefined
    try {
      await session.unsafe(`SET ROLE ${owner}`)
      try {
        await session.unsafe('DELETE FROM public.audit_log')
        viaOwner = 'ok'
      } catch (e) {
        viaOwner = sqlState(e)
      }
    } finally {
      session.release()
    }
    expect(viaOwner).toBe('42501')
  })

  it('is idempotent, and a customer whose chain has not created the tables yet is reported absent (no throw)', async () => {
    const T = uuidv7()
    await seed(T)
    await ensureKernelAuditAppendOnly(server, T)
    expect(await ensureKernelAuditAppendOnly(server, T)).toEqual({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    expect(await kernelAuditAppendOnlyProblems(server, T)).toEqual([])
    const E = uuidv7()
    await seed(E, { tables: false })
    expect(await ensureKernelAuditAppendOnly(server, E)).toEqual({ revoked: [], absent: ['audit_log', 'audit_log_chain_anchor'] })
    // nothing to check on an absent table is not a problem
    expect(await kernelAuditAppendOnlyProblems(server, E)).toEqual([])
  })

  it('CRIT: a tenant ALTER DATABASE SET search_path + planted public.format / current_database cannot escalate through the call (startup pin and bare server)', async () => {
    const Z = uuidv7()
    await seed(Z)
    const bare = kernelServer({ bare: true })
    try {
      const { owner, app } = kernelRoles(Z)
      const esc = `EXECUTE pg_catalog.format('ALTER ROLE %I SUPERUSER', '${app}')`
      const d = connect(kernelDbName(Z), { max: 1 })
      try {
        await d.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${owner}`)
          await tx.unsafe(`
            CREATE FUNCTION public.format(t text, a text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.format(t, a); END $$;
            CREATE FUNCTION public.format(t text, a text, b text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.format(t, a, b); END $$;
            CREATE FUNCTION public.current_database() RETURNS name LANGUAGE plpgsql AS $$ BEGIN ${esc}; RETURN pg_catalog.current_database(); END $$;
            ALTER DATABASE ${kernelDbName(Z)} SET search_path = public, pg_catalog;`)
        })
      } finally {
        await d.end({ timeout: 5 })
      }
      const isSuper = async () => (await server.admin<{ s: boolean }[]>`SELECT rolsuper AS s FROM pg_roles WHERE rolname = ${app}`)[0]!.s
      for (const [label, s] of [['startup search_path', server], ['bare server', bare]] as const) {
        await ensureKernelAuditAppendOnly(s, Z)
        expect(await isSuper(), `${label}: ensureKernelAuditAppendOnly`).toBe(false)
        await kernelAuditAppendOnlyProblems(s, Z)
        expect(await isSuper(), `${label}: kernelAuditAppendOnlyProblems`).toBe(false)
      }
    } finally {
      await server.admin.unsafe(`ALTER ROLE ${kernelRoles(Z).app} NOSUPERUSER`).catch(() => {})
      await bare.close()
    }
  })

  it('refuses a tenant id that is not a uuid (the identifiers are derived, never spliced)', async () => {
    await expect(ensureKernelAuditAppendOnly(server, "x'; DROP ROLE y; --")).rejects.toThrow()
    await expect(kernelAuditAppendOnlyProblems(server, 'nope')).rejects.toThrow()
  })
})
