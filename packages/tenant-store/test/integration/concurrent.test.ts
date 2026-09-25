// TDD 2 — two runner PROCESSES against one (tenant, module) database apply
// each migration exactly once: one waits on the advisory lock, then no-ops.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { ADVISORY_LOCKS } from '../../src/advisory-locks.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect, dbUrl, ledgerFiles, resetWithProbe } from '../harness/db.js'
import { FIXTURE_MIGRATIONS } from '../harness/migrations.js'

const CHILD = fileURLToPath(new URL('../harness/child-runner.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))
const HOLD_MS = 1500

interface ChildResult {
  name: string
  applied: string[]
  error?: { code?: string; message: string; file?: string; sawPending?: string[] }
}

function startChild(name: string, db: string, variant: string) {
  const child = spawn(TSX, [CHILD], {
    env: {
      ...process.env,
      T020_CHILD_URL: dbUrl(db),
      T020_CHILD_DIR: FIXTURE_MIGRATIONS,
      T020_CHILD_NAME: name,
      T020_CHILD_VARIANT: variant,
      T020_HOLD_MS: String(HOLD_MS),
    },
  }) as ChildProcessWithoutNullStreams
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const lines = createInterface({ input: child.stdout })
  const queue: string[] = []
  const waiters: ((l: string) => void)[] = []
  lines.on('line', (l) => (waiters.shift() ?? ((x: string) => queue.push(x)))(l))
  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      const q = queue.shift()
      if (q !== undefined) return resolve(q)
      waiters.push(resolve)
      child.once('exit', (code) => reject(new Error(`${name} exited ${code} before answering: ${stderr}`)))
    })
  return { child, nextLine }
}

/** Two processes behind a barrier; a poller records who waits on the migration lock. */
async function raceTwoRunners(db: string, variant: 'runner' | 'readThenApply') {
  const p1 = startChild('t020-runner-1', db, variant)
  const p2 = startChild('t020-runner-2', db, variant)
  expect(await p1.nextLine()).toBe('ready')
  expect(await p2.nextLine()).toBe('ready')

  const watcher = connect(db, { max: 1 })
  const waiters = new Set<string>()
  let polling = true
  const poll = (async () => {
    while (polling) {
      const rows = await watcher<{ application_name: string }[]>`
        SELECT a.application_name
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory'
           AND l.classid = ${ADVISORY_LOCKS.migration.classid}::oid
           AND l.objid = ${ADVISORY_LOCKS.migration.objid}::oid
           AND l.objsubid = 2
           AND NOT l.granted
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      for (const r of rows) waiters.add(r.application_name)
      await new Promise((r) => setTimeout(r, 20))
    }
  })()

  // the barrier: release both at once
  p1.child.stdin.write('go\n')
  p2.child.stdin.write('go\n')
  const results = (await Promise.all([p1.nextLine(), p2.nextLine()])).map((l) => JSON.parse(l) as ChildResult)
  polling = false
  await poll
  const ledger = await ledgerFiles(watcher)
  await watcher.end()
  return { results, waiters, ledger }
}

const FILES = ['001_init.sql', '002_item_state.sql', '003_item_state_idx.sql']

describe('two concurrent runner processes, one (tenant, module) database', () => {
  const { A } = inject('tenants')
  const db = tenantModuleDbName(A, 'fixture')

  beforeEach(async () => {
    await resetWithProbe(db)
  })
  afterAll(async () => {
    await resetWithProbe(db)
  })

  it('RED guard: the readThenApply variant applies twice (the harness can see a double apply)', async () => {
    // The ledger exists before the race, so the only thing the two can
    // collide on is applying the same migration: not the ledger's own
    // CREATE TABLE IF NOT EXISTS (which can itself race on pg_type).
    const pre = connect(db, { max: 1 })
    await pre`CREATE TABLE public.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`
    await pre.end()
    const { results, ledger } = await raceTwoRunners(db, 'readThenApply')
    const failed = results.filter((r) => r.error)
    expect(failed).toHaveLength(1)
    const e = failed[0]!.error!
    // both read the same, empty ledger; the loser then re-applied 001
    expect(e.sawPending).toEqual(FILES)
    expect(e.file).toBe('001_init.sql')
    // duplicate_table (item), duplicate_object (the enum type), or the
    // catalog's unique index when both CREATE TABLE item at once (23505 on
    // pg_type) — every one of them a second apply of 001
    expect(['42P07', '42710', '23505']).toContain(e.code)
    expect(ledger).toEqual(FILES)
  })

  it('runMigrations: each file applied exactly once; process 2 waited on the lock, then applied nothing', async () => {
    const { results, waiters, ledger } = await raceTwoRunners(db, 'runner')
    expect(results.map((r) => r.error)).toEqual([undefined, undefined])
    const winner = results.find((r) => r.applied.length > 0)!
    const loser = results.find((r) => r !== winner)!
    expect(winner.applied).toEqual(FILES)
    expect(loser.applied).toEqual([])
    expect(ledger).toEqual(FILES)
    // the loser is the one pg_locks showed waiting, and only it
    expect([...waiters]).toEqual([loser.name])
  })
})
