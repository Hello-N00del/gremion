// TASK-077 (lane note C13, guard r): ensureKernelApiReader on the scratch
// kernel server. The kernel API's role reads exactly control public.tenant /
// public.tenant_domain and gremion_platform plt.module / module_version /
// module_enablement -- and has NO privilege on anything the provisioning
// engine or the operator path owns (plt.provisioning_step, the control
// registry's other tables, ...). Run against the REAL control migrations and
// the REAL platform chain (global-setup migrates gremion_platform).
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureKernelApiReader, KERNEL_API_READS, KernelApiReaderError, kernelApiReaderPrivilegeProblems } from '../../src/lifecycle/index.js'
import { connect, dbUrl } from '../harness/db.js'

const CONTROL = 't077_control'
const ROLE = 't077_kernel_api_reader'
const PASSWORD = randomBytes(24).toString('base64url')
const CONTROL_MIGRATIONS = fileURLToPath(new URL('../../../../gremion-ui/migrations-control/', import.meta.url))

function asReader(db: string) {
  const u = new URL(dbUrl(db))
  u.username = ROLE
  u.password = encodeURIComponent(PASSWORD)
  return postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 })
}

describe('ensureKernelApiReader (TASK-077 C13)', () => {
  // Opened in beforeAll, never at collect time (vitest list runs without the stack).
  let admin: ReturnType<typeof connect>

  beforeAll(async () => {
    admin = connect('postgres', { max: 2 })
    await admin.unsafe(`DROP DATABASE IF EXISTS ${CONTROL} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    await admin.unsafe(`CREATE DATABASE ${CONTROL}`)
    const control = connect(CONTROL, { max: 1 })
    try {
      for (const f of readdirSync(CONTROL_MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
        await control.unsafe(readFileSync(join(CONTROL_MIGRATIONS, f), 'utf8'))
      }
    } finally {
      await control.end()
    }
  })

  afterAll(async () => {
    for (const db of [CONTROL, 'gremion_platform']) {
      const sql = connect(db, { max: 1 })
      await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${db === CONTROL ? 'public' : 'plt'} FROM ${ROLE}`).catch(() => {})
      await sql.unsafe(`REVOKE ALL ON SCHEMA ${db === CONTROL ? 'public' : 'plt'} FROM ${ROLE}`).catch(() => {})
      await sql.end()
    }
    await admin.unsafe(`REVOKE CONNECT ON DATABASE gremion_platform FROM ${ROLE}`).catch(() => {})
    await admin.unsafe(`DROP DATABASE IF EXISTS ${CONTROL} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    await admin.end()
  })

  const deps = () => ({ kernelAdmin: admin, openAdminOn: (db: string) => connect(db, { max: 1 }), role: ROLE, password: PASSWORD, controlDatabase: CONTROL })

  it('creates a LOGIN NOINHERIT role reading exactly KERNEL_API_READS; a rerun is idempotent', async () => {
    expect(await ensureKernelApiReader(deps())).toEqual({ created: true })
    expect(await ensureKernelApiReader(deps())).toEqual({ created: false })
    const [role] = await admin<{ login: boolean; inherit: boolean; su: boolean; createdb: boolean; createrole: boolean; bypass: boolean }[]>`
      SELECT rolcanlogin AS login, rolinherit AS inherit, rolsuper AS su, rolcreatedb AS createdb, rolcreaterole AS createrole, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = ${ROLE}`
    expect(role).toEqual({ login: true, inherit: false, su: false, createdb: false, createrole: false, bypass: false })
  })

  it('the role logs in and reads its tables, and is refused writes and every other table (privilege test, guard r)', async () => {
    const control = asReader(CONTROL)
    const platform = asReader('gremion_platform')
    try {
      expect(await control`SELECT count(*)::int AS n FROM public.tenant`).toEqual([{ n: 0 }])
      expect(await control`SELECT count(*)::int AS n FROM public.tenant_domain`).toEqual([{ n: 0 }])
      for (const t of KERNEL_API_READS.platform) expect(await platform.unsafe(`SELECT count(*)::int AS n FROM ${t}`)).toHaveLength(1)
      await expect(control`DELETE FROM public.tenant`).rejects.toMatchObject({ code: '42501' })
      await expect(control`SELECT 1 FROM public.tenant_provisioning_resource`).rejects.toMatchObject({ code: '42501' })
      await expect(platform`SELECT 1 FROM plt.provisioning_step`).rejects.toMatchObject({ code: '42501' })
      await expect(platform`UPDATE plt.module SET name = name`).rejects.toMatchObject({ code: '42501' })
    } finally {
      await control.end()
      await platform.end()
    }
    // the whole-database sweep the function asserts, re-run from outside
    const c = connect(CONTROL, { max: 1 })
    const p = connect('gremion_platform', { max: 1 })
    try {
      expect(await kernelApiReaderPrivilegeProblems(c, ROLE, KERNEL_API_READS.control)).toEqual([])
      expect(await kernelApiReaderPrivilegeProblems(p, ROLE, KERNEL_API_READS.platform)).toEqual([])
    } finally {
      await c.end()
      await p.end()
    }
  })

  it('a stray grant (SELECT on plt.provisioning_step) is reported by the sweep and refuses the next ensure (POSTCONDITION)', async () => {
    const p = connect('gremion_platform', { max: 1 })
    try {
      await p.unsafe(`GRANT SELECT ON plt.provisioning_step TO ${ROLE}`)
      expect(await kernelApiReaderPrivilegeProblems(p, ROLE, KERNEL_API_READS.platform)).toEqual([
        'plt.provisioning_step: select=true write=false (want no privilege: not a kernel API read)',
      ])
      await expect(ensureKernelApiReader(deps())).rejects.toMatchObject({ code: 'POSTCONDITION' })
    } finally {
      await p.unsafe(`REVOKE SELECT ON plt.provisioning_step FROM ${ROLE}`)
      await p.end()
    }
  })

  it('refuses bad input before touching anything, and an unmigrated control database (PRECONDITION)', async () => {
    await expect(ensureKernelApiReader({ ...deps(), role: 'x; DROP ROLE y' })).rejects.toBeInstanceOf(KernelApiReaderError)
    await expect(ensureKernelApiReader({ ...deps(), password: 'short' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ensureKernelApiReader({ ...deps(), controlDatabase: 'postgres' })).rejects.toMatchObject({ code: 'PRECONDITION' })
  })

  it('refuses an existing role that has memberships or owns objects BEFORE any ALTER (a mistyped KERNEL_API_DB_ROLE naming a customer role must not be clobbered)', async () => {
    const VICTIM = 't077_victim_app'
    const PARENT = 't077_victim_owner'
    const OLD = 'old-victim-password-0123456789'
    await admin.unsafe(`DROP ROLE IF EXISTS ${VICTIM}`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${PARENT}`)
    await admin.unsafe(`CREATE ROLE ${PARENT} NOLOGIN`)
    // like k_<hex>_app: LOGIN, INHERIT (default), a member of its owner
    await admin.unsafe(`CREATE ROLE ${VICTIM} LOGIN PASSWORD '${OLD}'`)
    await admin.unsafe(`GRANT ${PARENT} TO ${VICTIM}`)
    const pw = async () => (await admin<{ p: string }[]>`SELECT rolpassword AS p FROM pg_authid WHERE rolname = ${VICTIM}`)[0]!.p
    const inherit = async () => (await admin<{ i: boolean }[]>`SELECT rolinherit AS i FROM pg_roles WHERE rolname = ${VICTIM}`)[0]!.i
    try {
      const before = await pw()
      await expect(ensureKernelApiReader({ ...deps(), role: VICTIM })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/member of, or has members in/) })
      expect(await pw()).toBe(before)
      expect(await inherit()).toBe(true)
      // owning an object (no membership) is refused just the same
      await admin.unsafe(`REVOKE ${PARENT} FROM ${VICTIM}`)
      const c = connect(CONTROL, { max: 1 })
      try {
        await c.unsafe(`CREATE TABLE public.t077_victim_owned (a int); ALTER TABLE public.t077_victim_owned OWNER TO ${VICTIM}`)
        await expect(ensureKernelApiReader({ ...deps(), role: VICTIM })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/owns/) })
        expect(await pw()).toBe(before)
        expect(await inherit()).toBe(true)
      } finally {
        await c.unsafe('DROP TABLE IF EXISTS public.t077_victim_owned')
        await c.end()
      }
    } finally {
      for (const d of [CONTROL, 'gremion_platform']) {
        const c = connect(d, { max: 1 })
        await c.unsafe(`DROP OWNED BY ${VICTIM}`).catch(() => {})
        await c.end()
      }
      await admin.unsafe(`REVOKE CONNECT ON DATABASE gremion_platform FROM ${VICTIM}`).catch(() => {})
      await admin.unsafe(`DROP ROLE IF EXISTS ${VICTIM}`)
      await admin.unsafe(`DROP ROLE IF EXISTS ${PARENT}`)
    }
  })
})
