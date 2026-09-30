// TASK-043 TDD 4 and TDD 7 (database half) on one scratch PostgreSQL 18
// (test/integration/run.mjs) that holds NO gremion_platform at the start:
//  - enabling anything before `init` fails (RED without init, Q15);
//  - bootstrapPlatform creates, migrates and loads the catalogue rows (Q20),
//    and a rerun changes nothing;
//  - pgLedger / pgAttestations round-trip against 0004;
//  - pgModules enables calendar and vault through the interim operator gate
//    (Q19) with the ONE attestation as both references; an id outside
//    --enable is GATE_REFUSED with no database; a module Q20 left undecided
//    is MODULE_VERSION_UNKNOWN.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LifecycleModule, ModuleServer } from '@gremion/tenant-store/lifecycle'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapPlatform,
  isDuplicateDone,
  operatorAllowGate,
  pgAttestations,
  pgLedger,
  pgModules,
} from '../../src/index.ts'

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const OWNER = 't043_platform'
const OWNER_PW = randomBytes(24).toString('base64url')
const APP_PW = randomBytes(24).toString('base64url')
const OPERATOR = randomUUID()

function adminUrl(db = 'postgres', user?: string, password?: string): string {
  const raw = process.env.T043_PG_ADMIN_URL
  if (!raw) throw new Error('T043_PG_ADMIN_URL is unset: run through `pnpm test:integration` (test/integration/run.mjs)')
  const u = new URL(raw)
  if (u.hostname !== '127.0.0.1' || decodeURIComponent(u.username) !== 't043_admin') throw new Error('[t043] refusing a database url that is not the scratch server')
  u.pathname = `/${db}`
  if (user) u.username = user
  if (password) u.password = encodeURIComponent(password)
  return u.toString()
}

const open = (db = 'postgres', max = 2, user?: string, password?: string): Sql =>
  postgres(adminUrl(db, user, password), { max, onnotice: () => {}, connect_timeout: 10 })

function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The catalogue as loadCatalogue reads it (one entry per modules/<id> with a
// module.json), read here directly: the package root of @gremion/module-
// catalogue does not type-check under this package's stricter flags.
const MODULES = resolve(REPO, 'modules')
const catalogue: LifecycleModule[] = readdirSync(MODULES)
  .sort()
  .filter((id) => existsSync(join(MODULES, id, 'module.json')))
  .map((id) => ({ id, dir: join(MODULES, id), moduleJson: JSON.parse(readFileSync(join(MODULES, id, 'module.json'), 'utf8')) as LifecycleModule['moduleJson'] }))

describe('the platform on a fresh server', () => {
  let admin: Sql
  const pools: Sql[] = []
  const server: ModuleServer = {
    get admin() {
      return admin
    },
    open(database, options) {
      const sql = postgres(adminUrl(database), {
        max: 2,
        onnotice: () => {},
        ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : {}),
      })
      pools.push(sql)
      return sql
    },
  }

  beforeAll(() => {
    admin = open('postgres', 2)
  })

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await admin.end({ timeout: 5 })
  })

  it('RED without init: there is no gremion_platform to enable against', async () => {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'`
    expect(rows.length).toBe(0)
    const p = open('gremion_platform', 1)
    let code: string | undefined
    try {
      await p`SELECT 1`
    } catch (err) {
      code = (err as { code?: string }).code
    } finally {
      await p.end({ timeout: 1 }).catch(() => {})
    }
    expect(code).toBe('3D000')
  })

  it('TDD 4: bootstrapPlatform creates, migrates and loads one module + one version row per decided module; a rerun changes nothing', async () => {
    const r = await bootstrapPlatform({
      kernelAdmin: admin,
      openPlatform: () => open('gremion_platform', 2, OWNER, OWNER_PW),
      owner: OWNER,
      ownerPassword: OWNER_PW,
      catalogue,
    })
    expect(r.platformCreated).toBe(true)
    expect(r.applied).toEqual(['0001_plt_setup.sql', '0002_plt_module.sql', '0003_plt_module_database.sql', '0004_plt_provisioning_step.sql'])
    expect(r.catalogue.insertedModules).toEqual(['board', 'calendar', 'content', 'finance', 'publishing', 'vault'])
    expect(r.catalogue.insertedVersions).toEqual(r.catalogue.insertedModules)
    expect(r.catalogue.undecided.map((u) => u.moduleKey)).toEqual(['elections', 'files', 'handover', 'messaging', 'votes'])

    const p = open('gremion_platform', 1, OWNER, OWNER_PW)
    try {
      const rows = await p<{ module_key: string; ctx: string; semver: string; rp: string; status: string; ck: string; uk: string; n: number }[]>`
        SELECT m.module_key, m.owning_context_code AS ctx, v.semver, v.retention_profile_default_id AS rp, v.status,
               v.created_by_kind AS ck, v.updated_by_kind AS uk,
               (SELECT count(*)::int FROM plt.module_version x WHERE x.module_id = m.module_id) AS n
          FROM plt.module m JOIN plt.module_version v USING (module_id) ORDER BY 1`
      expect(rows.map((x) => x.module_key)).toEqual(['board', 'calendar', 'content', 'finance', 'publishing', 'vault'])
      for (const x of rows) expect(x).toMatchObject({ status: 'draft', ck: 'system', uk: 'system', n: 1, semver: '1.0.0' })
      expect(rows.find((x) => x.module_key === 'calendar')).toMatchObject({ ctx: 'cal', rp: 'rp-cal-module-data' })
    } finally {
      await p.end()
    }

    const again = await bootstrapPlatform({
      kernelAdmin: admin,
      openPlatform: () => open('gremion_platform', 2, OWNER, OWNER_PW),
      owner: OWNER,
      ownerPassword: OWNER_PW,
      catalogue,
    })
    expect(again).toMatchObject({ platformCreated: false, applied: [] })
    expect(again.catalogue.insertedModules).toEqual([])
    expect(again.catalogue.insertedVersions).toEqual([])
  })

  it('pgLedger and pgAttestations round-trip on 0004', async () => {
    const p = open('gremion_platform', 2, OWNER, OWNER_PW)
    try {
      const ledger = pgLedger(p)
      const c = uuidv7()
      await ledger.append(c, 'realm_created', 'pending', OPERATOR)
      await ledger.append(c, 'realm_created', 'done', OPERATOR)
      let dup: unknown
      try {
        await ledger.append(c, 'realm_created', 'done', OPERATOR)
      } catch (err) {
        dup = err
      }
      expect(isDuplicateDone(dup)).toBe(true)
      expect((await ledger.rows(c)).map((r) => `${r.kind}=${r.status}`)).toEqual(['realm_created=pending', 'realm_created=done'])

      const att = pgAttestations(p)
      expect(await att.lookup(c, 'calendar')).toBeNull()
      const id = await att.ensure(c, 'calendar', OPERATOR, ['calendar', 'vault'])
      expect(await att.ensure(c, 'calendar', OPERATOR, ['calendar', 'vault'])).toBe(id)
      expect(await att.lookup(c, 'calendar')).toBe(id)
      expect((await att.list(c)).map((a) => a.moduleKey)).toEqual(['calendar'])
    } finally {
      await p.end()
    }
  })

  it('TDD 7: calendar and vault enable through the interim gate with the attestation as both references; publishing (not passed) is refused with no database; votes (undecided, Q20) is MODULE_VERSION_UNKNOWN', async () => {
    const p = open('gremion_platform', 3, OWNER, OWNER_PW)
    try {
      const X = uuidv7()
      const ref = { id: X, slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }
      const modules = pgModules({
        platform: p,
        catalogue,
        lifecycle: {
          server: () => server,
          secrets: { appPassword: () => APP_PW },
          exporter: { dump: async () => {}, list: async () => '' },
          exportDir: resolve(REPO, '.scratch/t043/exports'),
          log: () => {},
        },
      })
      const att = pgAttestations(p)
      const gate = operatorAllowGate(new Set(['calendar', 'vault']), (c, m) => att.lookup(c, m))
      const before = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
      for (const m of ['calendar', 'vault']) {
        await att.ensure(X, m, OPERATOR, ['calendar', 'vault'])
        expect((await modules.enable(ref, m, gate, OPERATOR)).noop).toBe(false)
      }
      const hex = X.replaceAll('-', '')
      const after = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
      expect(after.filter((d) => !before.includes(d)).sort()).toEqual([`t_${hex}__calendar`, `t_${hex}__vault`])
      expect(await modules.enabled(ref)).toEqual(['calendar', 'vault'])
      const rows = await p<{ module_key: string; iso: string; dpia: string; by_kind: string; by: string }[]>`
        SELECT m.module_key, e.isolation_test_result_id::text AS iso, e.dpia_decision_id::text AS dpia, e.enabled_by_kind AS by_kind, e.enabled_by::text AS by
          FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${X} ORDER BY 1`
      for (const r of rows) {
        const id = await att.lookup(X, r.module_key)
        expect(r).toEqual({ module_key: r.module_key, iso: id, dpia: id, by_kind: 'operator', by: OPERATOR })
      }
      // a second enable is a no-op (resume re-reads the same attestation)
      expect((await modules.enable(ref, 'calendar', gate, OPERATOR)).noop).toBe(true)

      await expect(modules.enable(ref, 'publishing', gate, OPERATOR)).rejects.toMatchObject({ code: 'GATE_REFUSED' })
      expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${`t_${hex}__publishing`}`).length).toBe(0)
      await expect(modules.enable(ref, 'votes', operatorAllowGate(new Set(['votes']), async () => randomUUID()), OPERATOR)).rejects.toMatchObject({
        code: 'MODULE_VERSION_UNKNOWN',
      })
    } finally {
      await p.end()
    }
  })
})
