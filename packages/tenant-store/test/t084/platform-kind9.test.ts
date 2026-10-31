// TASK-084-a Task 2: step kind 9 (governance_database_created) in the platform
// provisioning ledger. A fresh gremion_platform is migrated up to the chain as
// it was BEFORE the new file, three customers get their eight kinds, then the
// full chain is applied and the ledger is read back.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensurePlatformDatabase, migratePlatform, PLATFORM_CHAIN, PLATFORM_DATABASE, PLATFORM_MIGRATIONS_DIR } from '../../src/lifecycle/platform.js'
import { pinnedPhaseFor } from '../../src/phase.js'
import { PINNED_BASELINE } from '../../src/phase-baseline.js'
import { runMigrations } from '../../src/runner.js'
import { admin, dbUrlFor, genPassword, uuidv7 } from '../harness/t084.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const PRE = join(REPO, '.scratch', 't084', 'platform-pre')
const OWNER = 't084_plt_owner'
const NEW_SUFFIX = '_plt_provisioning_step_governance.sql'
const EIGHT = [
  'realm_created',
  'database_created',
  'domain_bound',
  'storage_prefix_reserved',
  'first_body_created',
  'first_accounts_created',
  'broker_account_created',
  'mail_principal_issued',
] as const
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

type Err = { code?: string; constraint_name?: string; message?: string }
async function sqlError(p: PromiseLike<unknown>): Promise<Err | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as Err
  }
}

describe('plt.provisioning_step accepts kind 9 (platform migration)', () => {
  let a: postgres.Sql
  let sql: postgres.Sql
  const customers = [uuidv7(), uuidv7(), uuidv7()]
  let newFile: string | undefined
  let refusedBefore: Err | null = null
  let ledgerBefore: { filename: string; sha256: string }[] = []
  let snapBefore: { id: string; step_order: number }[] = []
  let snapAfter: { id: string; step_order: number }[] = []
  let result: Awaited<ReturnType<typeof migratePlatform>>

  beforeAll(async () => {
    a = admin(2)
    const files = readdirSync(PLATFORM_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    newFile = files.find((f) => f.endsWith(NEW_SUFFIX))
    // the partial chain: every file but the new one, and a manifest without it
    rmSync(PRE, { recursive: true, force: true })
    mkdirSync(PRE, { recursive: true })
    for (const f of files) if (f !== newFile) cpSync(join(PLATFORM_MIGRATIONS_DIR, f), join(PRE, f))
    const manifest = JSON.parse(readFileSync(join(PLATFORM_MIGRATIONS_DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    if (newFile) delete manifest[newFile]
    writeFileSync(join(PRE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const pw = genPassword()
    await ensurePlatformDatabase(a, { owner: OWNER, ownerPassword: pw })
    sql = postgres(dbUrlFor(PLATFORM_DATABASE, OWNER, pw), { max: 3, onnotice: () => {} })
    await runMigrations({ sql, dir: PRE, releaseRef: 'dist-t084', phaseFor: pinnedPhaseFor(PLATFORM_CHAIN, PINNED_BASELINE), log: () => {} })

    refusedBefore = await sqlError(
      sql`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${uuidv7()}, 'governance_database_created', 'pending')`,
    )
    for (const c of customers) for (const k of EIGHT) await sql`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, ${k}, 'done')`
    const snap = () => sql<{ id: string; step_order: number }[]>`SELECT provisioning_step_id::text AS id, step_order FROM plt.provisioning_step ORDER BY 1`
    snapBefore = [...(await snap())]
    ledgerBefore = [...(await sql<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename`)]
    result = await migratePlatform(sql, { releaseRef: 'dist-t084', log: () => {} })
    snapAfter = [...(await snap())]
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch((e) => console.error('[t084] sql.end', e))
    try {
      await a`DROP DATABASE IF EXISTS gremion_platform WITH (FORCE)`
      await a`DROP ROLE IF EXISTS t084_plt_owner`
    } catch (e) {
      console.error('[t084] platform cleanup failed', e)
    }
    await a?.end({ timeout: 5 }).catch(() => {})
    rmSync(PRE, { recursive: true, force: true })
  })

  it('the new migration file exists in the platform chain', () => {
    expect(newFile, `a *${NEW_SUFFIX} file in ${PLATFORM_MIGRATIONS_DIR}`).toBeDefined()
  })

  it('before the migration a ninth kind is refused by the CHECK (23514)', () => {
    expect(refusedBefore?.code).toBe('23514')
    expect(refusedBefore?.constraint_name).toBe('provisioning_step_step_kind_check')
  })

  it('migratePlatform applies exactly the new file over the 13 pre-applied rows, which are unchanged', async () => {
    expect(result.applied).toEqual([newFile])
    expect(result.alreadyApplied).toBe(13)
    const now = await sql<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename`
    expect(now.filter((r) => r.filename !== newFile)).toEqual(ledgerBefore)
    expect(now.find((r) => r.filename === newFile)?.sha256).toBe(sha(readFileSync(join(PLATFORM_MIGRATIONS_DIR, newFile!))))
  })

  it('seeds 8 kinds for 3 customers and the (id, step_order) snapshot is EQUAL after the migration', () => {
    expect(snapBefore).toHaveLength(24)
    expect(snapAfter).toEqual(snapBefore)
  })

  it('accepts kind 9 and generates step_order 9; the other eight keep 1..8', async () => {
    const c = uuidv7()
    for (const k of EIGHT) await sql`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, ${k}, 'pending')`
    const [r] = await sql<{ step_order: number }[]>`
      INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'governance_database_created', 'done') RETURNING step_order`
    expect(r?.step_order).toBe(9)
    const rows = await sql<{ step_kind: string; step_order: number }[]>`
      SELECT step_kind, step_order FROM plt.provisioning_step WHERE customer_id = ${c} AND status = 'pending' ORDER BY step_order`
    expect(rows.map((x) => x.step_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.map((x) => x.step_kind)).toEqual([...EIGHT])
  })

  it('stays append-only: UPDATE, DELETE and TRUNCATE are refused with 23514', async () => {
    const c = customers[0]!
    const upd = await sqlError(sql`UPDATE plt.provisioning_step SET status = 'failed' WHERE customer_id = ${c}`)
    const del = await sqlError(sql`DELETE FROM plt.provisioning_step WHERE customer_id = ${c}`)
    const trunc = await sqlError(sql`TRUNCATE plt.provisioning_step`)
    for (const e of [upd, del, trunc]) {
      expect(e?.code).toBe('23514')
      expect(e?.message).toContain('plt.provisioning_step is append-only')
    }
    const trg = await sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'plt.provisioning_step'::regclass AND NOT tgisinternal ORDER BY 1`
    expect(trg.map((t) => t.tgname)).toEqual(['provisioning_step_append_only_trg', 'provisioning_step_no_truncate_trg'])
  })

  it('keeps done-at-most-once per kind (23505 on provisioning_step_customer_id_step_kind_key)', async () => {
    const c = uuidv7()
    await sql`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'governance_database_created', 'done')`
    const e = await sqlError(sql`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'governance_database_created', 'done')`)
    expect(e?.code).toBe('23505')
    expect(e?.constraint_name).toBe('provisioning_step_customer_id_step_kind_key')
  })

  it('keeps the step_order index', async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'plt' AND tablename = 'provisioning_step' ORDER BY 1`
    expect(idx.map((i) => i.indexname)).toContain('provisioning_step_customer_id_step_order_idx')
  })
})
