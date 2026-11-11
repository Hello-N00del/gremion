// TASK-021 TDD 8 + 9 (+ Amendment R27 test 9) on the scratch stack: disable
// exports FIRST and, since the module Karenz, BLOCKS (it no longer drops) only
// after the export is verified and recorded; a failing or empty export leaves
// the database open and 'disabling'; the real export is a pg_dump -Fc that
// pg_restore --list parses, whose sha256 equals the record; a platform
// server's database (synapse) is never touched. The Karenz itself (30 days,
// restore, day-30 drop) is lifecycle-karenz.test.ts.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableModule, enableModule } from '../../src/lifecycle/index.js'
import type { Exporter } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connectModule } from '../harness/db.js'
import {
  containerExporter,
  databasesOn,
  lcfixModule,
  lifecycleDeps,
  MODULE_SERVICE,
  moduleServer,
  OPERATOR,
  platformDb,
  resetModuleServer,
  seedCatalogue,
  uuidv7,
} from '../harness/lifecycle.js'

describe('disableModule on the scratch stack', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>

  const state = async (X: string) =>
    (
      await platform<{ state: string; export_sha256: string | null; export_path: string | null; export_bytes: string | null }[]>`
        SELECT d.state, d.export_sha256, d.export_path, d.export_bytes::text
          FROM plt.module_database d JOIN plt.module m USING (module_id)
         WHERE d.customer_id = ${X} AND m.module_key = 'lcfix'`
    )[0]

  const enableWithRow = async (X: string) => {
    await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    const sql = connectModule(tenantModuleDbName(X, 'lcfix'), { max: 1 })
    try {
      await sql`INSERT INTO item (customer_id, note) VALUES (${X}, 'kept in the export')`
    } finally {
      await sql.end()
    }
  }

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
  })

  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
  })

  it('TDD 8: a recording exporter proves the order — the dump and its verification happen before the block', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    await enableWithRow(X)
    const events: string[] = []
    const real = containerExporter()
    const recording: Exporter = {
      async dump(t, file) {
        events.push(`dump:${(await databasesOn(server.admin)).includes(t.database) ? 'present' : 'absent'}`)
        await real.dump(t, file)
      },
      async list(file) {
        events.push('list')
        return real.list(file)
      },
    }
    const admin = server.admin
    const recordingAdmin = new Proxy(admin, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver)
        if (prop === 'unsafe') {
          return (q: string, ...rest: unknown[]) => {
            if (q.startsWith('REVOKE CONNECT ON DATABASE')) events.push('block')
            if (q.startsWith('DROP DATABASE')) events.push('drop')
            return (v as (...a: unknown[]) => unknown).call(target, q, ...rest)
          }
        }
        return typeof v === 'function' ? v.bind(target) : v
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
      },
    })
    const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, { ...server, admin: recordingAdmin, open: server.open }, { exporter: recording }))
    expect(events).toEqual(['dump:present', 'list', 'block'])
    expect(r).toMatchObject({ dropped: false, blocked: true })
    expect(await databasesOn(server.admin)).toContain(db) // kept for the 30 days
  })

  it('TDD 8: an exporter that throws, or writes 0 bytes, leaves the database present and the row "disabling"; a later call resumes', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    await enableWithRow(X)
    const throwing: Exporter = { dump: async () => { throw new Error('pg_dump: could not connect') }, list: async () => '' }
    await expect(disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { exporter: throwing }))).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
    expect(await databasesOn(server.admin)).toContain(db)
    expect((await state(X))?.state).toBe('disabling')

    const empty: Exporter = { dump: async (_t, file) => writeFileSync(file, ''), list: async () => '' }
    await expect(disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { exporter: empty }))).rejects.toMatchObject({ code: 'EXPORT_UNVERIFIED' })
    expect(await databasesOn(server.admin)).toContain(db)
    expect(await state(X)).toMatchObject({ state: 'disabling', export_sha256: null })

    const unlistable: Exporter = { dump: async (_t, file) => writeFileSync(file, 'not an archive'), list: containerExporter().list }
    await expect(disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { exporter: unlistable }))).rejects.toMatchObject({ code: 'EXPORT_UNVERIFIED' })
    expect(await databasesOn(server.admin)).toContain(db)

    // the enable switch went off with 'disabling' and stays off
    const [en] = await platform<{ state: string }[]>`
      SELECT e.state FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${X} AND m.module_key = 'lcfix'`
    expect(en?.state).toBe('disabled')

    const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(r).toMatchObject({ dropped: false, blocked: true })
    expect(await databasesOn(server.admin)).toContain(db)
  })

  it('TDD 9: the real export — the dump exists, pg_restore --list parses it, its sha256 equals the record, the database is blocked, not gone', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    await enableWithRow(X)
    const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(r.export).not.toBeNull()
    const exp = r.export!
    const bytes = readFileSync(exp.path)
    expect(bytes.length).toBe(exp.bytes)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('PGDMP') // custom format magic
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(sha).toBe(exp.sha256)
    expect(readFileSync(`${exp.path}.sha256`, 'utf8').startsWith(`${sha}  `)).toBe(true)
    const toc = await containerExporter().list(exp.path)
    expect(toc).toMatch(new RegExp(`^;\\s+dbname: ${db}$`, 'm'))
    expect(toc).toMatch(/TABLE DATA public item /)
    expect(await state(X)).toEqual({ state: 'blocked', export_sha256: sha, export_path: exp.path, export_bytes: String(exp.bytes) })
    expect(await databasesOn(server.admin)).toContain(db)
    // a second disable is a no-op
    expect(await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ dropped: false, noop: true })
  })

  it('TDD 9 (r2, pipe buffer): a database whose dump is > 1 MB exports, verifies through pg_restore --list and blocks, with no stray EPIPE/EOF', async () => {
    const strays: unknown[] = []
    const onStray = (err: unknown) => strays.push(err)
    process.on('uncaughtException', onStray)
    process.on('unhandledRejection', onStray)
    try {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      const sql = connectModule(db, { max: 1 })
      try {
        // hex digests barely compress, so the -Fc archive stays well above the pipe buffer
        await sql`INSERT INTO item (customer_id, note)
                  SELECT ${X}, md5(g::text) || md5((g::bigint * 7919)::text) || md5((g::bigint * 104729)::text)
                    FROM generate_series(1, 40000) AS g`
      } finally {
        await sql.end()
      }
      const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(r.blocked).toBe(true)
      expect(r.export!.bytes).toBeGreaterThan(1024 * 1024)
      expect(await state(X)).toMatchObject({ state: 'blocked', export_sha256: r.export!.sha256 })
      expect(await databasesOn(server.admin)).toContain(db)
      await new Promise((res) => setTimeout(res, 500))
      expect(strays).toEqual([])
    } finally {
      process.off('uncaughtException', onStray)
      process.off('unhandledRejection', onStray)
    }
  }, 120_000)

  it('re-enable within the Karenz brings the blocked database back as it was (the fresh start after day 30 is lifecycle-karenz.test.ts)', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    await enableWithRow(X)
    await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    const r = await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(r).toMatchObject({ database: db, created: false, restored: true, applied: [] })
    expect((await state(X))?.state).toBe('enabled')
    const sql = connectModule(db, { max: 1 })
    try {
      expect((await sql<{ note: string }[]>`SELECT note FROM item`).map((x) => x.note)).toEqual(['kept in the export'])
    } finally {
      await sql.end()
    }
    await platform`UPDATE plt.module_karenz SET state = 'restored', restored_at = now() WHERE customer_id = ${X}` // the pass would report this
    await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
  })

  it('Amendment R27 test 9: disabling a platform-server module leaves the pre-created synapse database on the server', async () => {
    await server.admin.unsafe('DROP DATABASE IF EXISTS synapse WITH (FORCE)')
    await server.admin.unsafe('CREATE DATABASE synapse')
    try {
      const X = uuidv7()
      const messagingLike = lcfixModule({ database: null, export: null, platformServer: { postgresService: MODULE_SERVICE, databases: ['synapse'] } })
      await enableModule(X, messagingLike, OPERATOR, lifecycleDeps(platform, server))
      const r = await disableModule(X, messagingLike, OPERATOR, lifecycleDeps(platform, server))
      expect(r).toMatchObject({ dropped: false, blocked: false, database: null })
      expect(await databasesOn(server.admin)).toContain('synapse')
    } finally {
      await server.admin.unsafe('DROP DATABASE IF EXISTS synapse WITH (FORCE)')
    }
  })
})
