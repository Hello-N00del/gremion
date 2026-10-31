// TASK-033-a on the scratch stack: the kernel audit_log is a GOVERNANCE RECORD
// (RC-GOV-CHAIN, operator decision 2026-10-28): append-only for the app. The
// app role (and the owner role it is a member of) holds no DELETE, UPDATE or
// TRUNCATE on it, and nothing in this package purges it. ensureKernelAuditAppendOnly
// applies that through the hardened admin path (asAdminIn + execFormatted,
// qualified names), at provisioning and on reconcile.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const KERNEL_MIGRATIONS = fileURLToPath(new URL('../../../../gremion-ui/migrations/', import.meta.url))
/** The real chain files that define audit_log, its hash chain, its anchor and its actor CHECK (0009, 0040, 0043, 0059, 0061). */
const AUDIT_CHAIN_FILES = [
  '0009_audit_log.sql',
  '0040_event_consumption.sql',
  '0043_audit_log_hash_chain.sql',
  '0059_audit_log_chain_anchor.sql',
  '0061_audit_log_actor_uuid_check.sql',
  // Karenz phase 2: the sealed retained_record table is append-only too (no other chain file is needed to create it)
  '0064_module_karenz.sql',
]

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
          INSERT INTO public.audit_log_chain_anchor (anchor_hash) VALUES (repeat('a', 64));
          CREATE TABLE public.retained_record (id bigserial PRIMARY KEY, note text NOT NULL DEFAULT 'sealed');
          INSERT INTO public.retained_record (note) VALUES ('a'), ('b');`)
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
    expect(problems).toMatch(/retained_record: .*UPDATE/)
    expect(problems).toMatch(/retained_record: .*DELETE/)
    expect(problems).toMatch(/retained_record: .*TRUNCATE/)
    // every message names its own table, not "the audit record" for all of them
    expect(problems).toMatch(/retained_record: \S+ still holds UPDATE \(retained_record is append-only/)
    expect(problems).toMatch(/audit_log_chain_anchor: \S+ still holds INSERT \(audit_log_chain_anchor is append-only/)
    expect(problems).not.toMatch(/the kernel audit record/)
    const a = as(T, app)
    const del = await a`DELETE FROM public.audit_log WHERE id = (SELECT min(id) FROM public.audit_log) RETURNING id`
    expect(del.length).toBe(1)
  })

  it('after the call: the app and the owner cannot DELETE / UPDATE / TRUNCATE audit_log (42501); INSERT and SELECT still work; the anchor is read-only', async () => {
    const T = uuidv7()
    await seed(T)
    const { app, owner } = kernelRoles(T)
    expect(await ensureKernelAuditAppendOnly(server, T)).toEqual({ revoked: ['audit_log', 'audit_log_chain_anchor', 'retained_record'], absent: [] })
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
    // Karenz phase 2 (0064): a sealed retained copy is written once and read; it is never rewritten or removed by the app
    expect(await code(a`UPDATE public.retained_record SET note = 'x'`)).toBe('42501')
    expect(await code(a`DELETE FROM public.retained_record`)).toBe('42501')
    expect(await code(a`TRUNCATE public.retained_record`)).toBe('42501')
    expect(await code(a`INSERT INTO public.retained_record (note) VALUES ('c')`)).toBe('ok')
    expect(await code(a`SELECT count(*)::int AS n FROM public.retained_record`), 'select retained_record').toBe('ok')

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

  it('on the REAL chain DDL (0009, 0040, 0043, 0059, 0061, 0064): the app still appends through the hash-chain trigger, the chain verifies, DELETE / UPDATE / TRUNCATE are 42501, the actor CHECK holds', async () => {
    const T = uuidv7()
    await seed(T, { tables: false })
    const { owner, app } = kernelRoles(T)
    const d = connect(kernelDbName(T), { max: 1 })
    try {
      for (const f of AUDIT_CHAIN_FILES) {
        const sql = readFileSync(KERNEL_MIGRATIONS + f, 'utf8')
        await d.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${owner}`)
          await tx.unsafe(sql)
        })
      }
    } finally {
      await d.end({ timeout: 5 })
    }
    expect(await ensureKernelAuditAppendOnly(server, T)).toEqual({ revoked: ['audit_log', 'audit_log_chain_anchor', 'retained_record'], absent: [] })
    expect(await kernelAuditAppendOnlyProblems(server, T)).toEqual([])

    // the app's own session: the default search_path (the chain trigger calls digest() unqualified)
    const a = connectAs(kernelDbName(T), app, pw, { max: 1 })
    pools.push(a)
    const person = '0192f3e0-1a2b-7c3d-8e4f-0123456789ab'
    for (const [user, field] of [[person, 'org.name'], ['calendar-service', 'event.consumed'], [person, 'org.name']] as const) {
      await a`INSERT INTO public.audit_log (user_id, field, new_value) VALUES (${user}, ${field}, 'v')`
    }
    expect((await a`SELECT public.audit_log_verify_chain() AS broken`)[0]!.broken).toBeNull()
    const code = async (p: PromiseLike<unknown>) => {
      try {
        await p
        return 'ok'
      } catch (e) {
        return sqlState(e)
      }
    }
    expect(await code(a`DELETE FROM public.audit_log`)).toBe('42501')
    expect(await code(a`UPDATE public.audit_log SET new_value = 'x'`)).toBe('42501')
    expect(await code(a`TRUNCATE public.audit_log`)).toBe('42501')
    // 0061: a name or an address is not an actor
    expect(await code(a`INSERT INTO public.audit_log (user_id, field, new_value) VALUES ('Erika Mustermann', 'f', 'v')`)).toBe('23514')
    expect(await code(a`INSERT INTO public.audit_log (user_id, field, new_value) VALUES ('erika@example.org', 'f', 'v')`)).toBe('23514')
    expect(await code(a`INSERT INTO public.audit_log (user_id, field, new_value) VALUES ('Calendar-service', 'f', 'v')`)).toBe('23514')
    expect((await a`SELECT public.audit_log_verify_chain() AS broken`)[0]!.broken).toBeNull()

    // 0064 (the REAL retained_record): the app seals a copy once and reads it, and can neither rewrite nor remove it
    const [key] = await a<{ key_id: string }[]>`INSERT INTO public.karenz_data_key (wrapped, kek_version) VALUES (${Buffer.from('w')}, 1) RETURNING key_id`
    const seal = () => a`
      INSERT INTO public.retained_record (karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext)
      VALUES ('0192f3e0-1a2b-7c3d-8e4f-0123456789ab', 'votes', 'RC-VOTE', 'votes.polls', 1, ${'a'.repeat(64)}, ${key!.key_id}, ${Buffer.alloc(12)}, ${Buffer.from('c')})`
    expect(await code(seal())).toBe('ok')
    expect(await code(a`SELECT id FROM public.retained_record`)).toBe('ok')
    expect(await code(a`UPDATE public.retained_record SET line_count = 2`)).toBe('42501')
    expect(await code(a`DELETE FROM public.retained_record`)).toBe('42501')
    expect(await code(a`TRUNCATE public.retained_record`)).toBe('42501')
    // the key table is not append-only, but a key row is not free either: the wrapped key of
    // every sealed copy lives in it, so one stray UPDATE of `wrapped` would make every copy
    // sealed under that key unreadable for good. The row guard (0064) refuses it for the app.
    const wrappedOf = async () => Buffer.from((await a<{ wrapped: Buffer }[]>`SELECT wrapped FROM public.karenz_data_key WHERE key_id = ${key!.key_id}`)[0]!.wrapped).toString()
    expect(await code(a`UPDATE public.karenz_data_key SET wrapped = ${Buffer.from('overwritten')}`), 'overwrite wrapped').toBe('42501')
    expect(await code(a`UPDATE public.karenz_data_key SET wrapped = ${Buffer.from('overwritten')}, kek_version = kek_version + 1`), 'overwrite wrapped with a version bump').toBe('42501')
    expect(await code(a`UPDATE public.karenz_data_key SET kek_version = 7`), 'bump the version alone').toBe('42501')
    expect(await code(a`UPDATE public.karenz_data_key SET key_id = gen_random_uuid()`), 'rename the key').toBe('42501')
    expect(await code(a`DELETE FROM public.karenz_data_key`), 'delete the key').toBe('42501')
    expect(await wrappedOf()).toBe('w')
    // the one way to replace `wrapped` is the re-wrap function: compare-and-swap on the version it read
    const rewrap = async (expected: number, wrapped: string) =>
      (await a<{ ok: boolean }[]>`SELECT public.karenz_rewrap_data_key(${key!.key_id}, ${expected}, ${Buffer.from(wrapped)}) AS ok`)[0]!.ok
    expect(await rewrap(9, 'stale'), 'a stale expected version changes nothing').toBe(false)
    expect(await wrappedOf()).toBe('w')
    expect(await rewrap(1, 'w2')).toBe(true)
    expect(await wrappedOf()).toBe('w2')
    expect((await a<{ v: number }[]>`SELECT kek_version AS v FROM public.karenz_data_key WHERE key_id = ${key!.key_id}`)[0]!.v).toBe(2)
    expect(await code(a`SELECT public.karenz_rewrap_data_key(${key!.key_id}, 2, ${Buffer.alloc(0)})`), 'an empty wrapped key is refused').toBe('22023')
    // the flag the function sets is scoped to its own statement: a bare UPDATE after it is refused again
    expect(await code(a`UPDATE public.karenz_data_key SET wrapped = ${Buffer.from('again')}`)).toBe('42501')
    // a retired key is stamped by an UPDATE, once, and stays retired
    expect(await code(a`UPDATE public.karenz_data_key SET retired_at = now()`)).toBe('ok')
    expect(await code(a`UPDATE public.karenz_data_key SET retired_at = NULL`), 'un-retire').toBe('42501')
    // a retired key can still be re-wrapped (an AUTH_SECRET rotation covers every key a copy uses)
    expect(await rewrap(2, 'w3')).toBe(true)
  })

  it('is idempotent, and a customer whose chain has not created the tables yet is reported absent (no throw)', async () => {
    const T = uuidv7()
    await seed(T)
    await ensureKernelAuditAppendOnly(server, T)
    expect(await ensureKernelAuditAppendOnly(server, T)).toEqual({ revoked: ['audit_log', 'audit_log_chain_anchor', 'retained_record'], absent: [] })
    expect(await kernelAuditAppendOnlyProblems(server, T)).toEqual([])
    const E = uuidv7()
    await seed(E, { tables: false })
    expect(await ensureKernelAuditAppendOnly(server, E)).toEqual({ revoked: [], absent: ['audit_log', 'audit_log_chain_anchor', 'retained_record'] })
    // nothing to check on an absent table is not a problem
    expect(await kernelAuditAppendOnlyProblems(server, E)).toEqual([])
    // reconcile asks requirePresent: the same absent tables are then PROBLEMS, one per table
    const required = await kernelAuditAppendOnlyProblems(server, E, { requirePresent: true })
    expect(required).toHaveLength(3)
    expect(required.join(' | ')).toMatch(/audit_log: table is absent/)
    expect(required.join(' | ')).toMatch(/audit_log_chain_anchor: table is absent/)
    expect(required.join(' | ')).toMatch(/retained_record: table is absent/)
    expect(required.join(' | ')).toMatch(/so retained_record cannot be append-only/)
    expect(required.join(' | ')).not.toMatch(/audit record cannot/)
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
    await expect(ensureKernelAuditAppendOnly(server, "x'; DROP ROLE y; --")).rejects.toThrow(/not a canonical lowercase UUIDv7/)
    await expect(kernelAuditAppendOnlyProblems(server, 'nope')).rejects.toThrow(/not a canonical lowercase UUIDv7/)
  })
})
