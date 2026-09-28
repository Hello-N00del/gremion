// TASK-045: integration suite (brief S5, S9). Three sub-checks, combined
// with lib/guard.mjs#combineParts so none can hide inside another's count:
//   - vitest: gremion-ui `test:integration` against a throwaway Postgres 18
//     started with a PLAIN `docker run` (never `docker compose` -- the repo's
//     base docker-compose.yml pins gremion_* volume names host-wide; a
//     2026-09-24 incident wiped 7 of them when a worktree's compose run
//     collided with other work's shared volumes). The container is named
//     uniquely per run and torn down in a `finally` with plain
//     `docker rm -f`, never `docker compose down`.
//   - fresh-init: `make fresh-init-proof` (its own throwaway container).
//   - nats: `make test-ports-nats` (its own throwaway container).
// Each is judged by exit code AND its own printed post-condition line.
// Each can run alone as `verify --only integration:<part>`.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { headSha } from '../lib/git.mjs'
import { run, spawnMissing, tail, toolAvailable } from '../lib/proc.mjs'
import { REPO_ROOT, runVitestJson } from '../lib/vitest.mjs'

// Q4 (recommended default, applied): test/integration/*.bats needs the full
// stack including Keycloak, so it is excluded from every suite and listed in
// every record as deferred -- never run, never reported as passed.
export const DEFERRED_BATS_NOTE =
  'test/integration/*.bats: deferred to TASK-036/re-init (needs the full stack including Keycloak) -- never run or reported as passed by this suite (Q4)'

// A fresh, unguessable password per run -- never committed, never logged,
// never on a command line: it reaches docker and psql through the child
// process's ENVIRONMENT (`-e NAME` with no value makes docker read NAME
// from its own env), so it is not visible in the host process list or in
// `docker inspect`'s recorded command (round-1 LOW: it used to be passed
// as `-e POSTGRES_PASSWORD=<value>` on argv).
function randomTestPassword() {
  return randomBytes(24).toString('base64url')
}

function startTestDb({ sha8, pid }) {
  // Brief S9: unique per run, and identifiable by the commit under test
  // (verify.mjs refuses a dirty tree, so HEAD is the tree being tested).
  const name = `verify-${sha8}-${pid}-db`
  const password = randomTestPassword()
  const env = { ...process.env, POSTGRES_PASSWORD: password, PGPASSWORD: password }
  // POSTGRES_USER contains "test" so assert-safe-test-db-url.ts's non-5432
  // convention check passes (brief S9). `-p 127.0.0.1::5432` binds an
  // ephemeral host port so this run can never collide with another
  // worktree's, or with staging's 5433.
  //
  // POSTGRES_DB is "gremion", not "gremion_test": migrations/008 hardcodes
  // `GRANT CONNECT ON DATABASE gremion` (058's header names it as a known,
  // un-fixed defect in a hash-pinned file). The safety convention (db name
  // OR user name contains "test") is satisfied by POSTGRES_USER alone.
  const runRes = run(
    'docker',
    ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=gremion_test', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=gremion', '-p', '127.0.0.1::5432', 'postgres:18-alpine'],
    { env },
  )
  if (runRes.code !== 0) {
    return { ok: false, name, detail: `docker run failed: ${runRes.stderr || runRes.stdout}` }
  }
  // The official postgres image starts TWO servers on a first run: a
  // temporary, unix-socket-only one for initdb's scripts, then the real one.
  // `pg_isready` can see the temporary one moments before it shuts down; a
  // real `SELECT 1`, retried, rides out the restart gap.
  const deadline = Date.now() + 60_000
  let port = null
  while (Date.now() < deadline) {
    const probe = run('docker', ['exec', '-e', 'PGPASSWORD', name, 'psql', '-U', 'gremion_test', '-d', 'postgres', '-tAc', 'SELECT 1'], { env })
    if (probe.code === 0 && probe.stdout.trim() === '1') {
      const portRes = run('docker', ['port', name, '5432/tcp'])
      const m = portRes.stdout.match(/:(\d+)\s*$/m)
      if (m) {
        port = Number(m[1])
        break
      }
    }
    sleepMs(300)
  }
  if (port === null) {
    return { ok: false, name, detail: `${name} never became ready within 60s` }
  }
  return { ok: true, name, port, password, env }
}

// Synchronous (this whole suite is spawnSync throughout): Atomics.wait on a
// fresh SharedArrayBuffer blocks for exactly `ms` without a process per poll.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stopTestDb(name) {
  // Tolerant: never masks the real result, and must run even when the caller
  // is already unwinding from a failure.
  run('docker', ['rm', '-f', name])
}

function psqlAsTestUser(db, database, args, opts = {}) {
  return run('docker', ['exec', ...(opts.input ? ['-i'] : []), '-e', 'PGPASSWORD', db.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'gremion_test', '-d', database, ...args], {
    env: db.env,
    ...opts,
  })
}

/**
 * The environment gremion-ui's `migrate` and `test:integration` run with.
 * Exported for the unit test (scripts/verify/integration.test.mjs).
 *
 * GREMION_PRODUCTION_STACK is `none`, set HERE and over any ambient value
 * (TASK-028, D2): the integration config gives it no default and refuses to
 * load while it is unset, and every truncating harness refuses a loopback URL
 * on a host that declares a production stack. Both URLs below are built in
 * this file and name only the throwaway container this run started on an
 * ephemeral loopback port -- no production database can answer there, so
 * `none` is a statement about this run's database, not a guess about the
 * host. It is never a default for a URL that came from the ambient env.
 */
export function integrationVitestEnv({ baseEnv, db, uiDir }) {
  const env = {
    ...baseEnv,
    DATABASE_URL: `postgres://gremion_test:${db.password}@127.0.0.1:${db.port}/gremion`,
    CONTROL_DATABASE_URL: `postgres://gremion_test:${db.password}@127.0.0.1:${db.port}/control`,
    GREMION_PRODUCTION_STACK: 'none',
    // TASK-042: every tenant's config is TENANT_DATA_ROOT/<slug>/config.json; the
    // harness fixture tenant's lives in this committed tree.
    TENANT_DATA_ROOT: path.join(uiDir, 'tests', 'integration', 'fixtures', 'tenant-data'),
    GREMION_DISABLE_SEEDS: 'true',
    KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-kc-admin-secret',
    AUTH_KEYCLOAK_SECRET: 'test-ui-client-secret',
  }
  delete env.POSTGRES_PASSWORD
  delete env.PGPASSWORD
  return env
}

function vitestPart({ root }) {
  const label = 'gremion-ui vitest (test:integration)'
  if (!toolAvailable('docker')) return { label, toolMissing: 'docker' }
  const uiDir = path.join(root, 'gremion-ui')
  const db = startTestDb({ sha8: headSha(root).slice(0, 8), pid: process.pid })
  try {
    if (!db.ok) return { label, unparseable: true, detail: db.detail }

    const createControl = psqlAsTestUser(db, 'postgres', ['-c', 'CREATE DATABASE control'])
    if (createControl.code !== 0) {
      return { label, unparseable: true, detail: `CREATE DATABASE control failed: ${createControl.stderr || createControl.stdout}` }
    }

    // migrations/058 ABORTS the chain when `gremion_public_reader` does not
    // exist; on a real deployment docker/postgres/init-databases.sh creates
    // it. This suite owns its throwaway Postgres, so it creates the role the
    // same way (its password is never read back; only its existence
    // matters). `-c` does not expand a `-v` psql variable, stdin does.
    const publicReaderPassword = randomTestPassword()
    const createPublicReader = psqlAsTestUser(db, 'gremion', ['-v', `_password=${publicReaderPassword}`], {
      input:
        "SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') " +
        "THEN format('CREATE ROLE gremion_public_reader LOGIN PASSWORD %L', :'_password') ELSE 'SELECT 1' END \\gexec\n",
    })
    if (createPublicReader.code !== 0) {
      return { label, unparseable: true, detail: `provisioning gremion_public_reader failed: ${createPublicReader.stderr || createPublicReader.stdout}` }
    }

    const env = integrationVitestEnv({ baseEnv: process.env, db, uiDir })

    // TASK-042 (G2): boot and `migrate` register no tenant; the harness creates
    // and migrates its fixture tenant (scripts/migrate-test-fixture.mjs).
    const migrate = run('pnpm', ['run', 'migrate:test-fixture'], { cwd: uiDir, env })
    if (spawnMissing(migrate)) return { label, toolMissing: 'pnpm' }
    if (migrate.code !== 0) {
      return { label, unparseable: true, detail: `pnpm migrate:test-fixture failed: ${tail(migrate.stdout + migrate.stderr)}` }
    }
    return runVitestJson({ label, cwd: uiDir, cmd: 'pnpm', args: ['run', 'test:integration'], env, root })
  } finally {
    stopTestDb(db.name)
  }
}

/**
 * `make test-ports-nats` (packages/ports/scripts/nats-test.sh). Exit 0 is
 * not enough (round-1 MEDIUM: this was trusted on exit code alone while the
 * comment claimed a post-condition check): the script's own final OK line
 * and its "<N> passing tests from <file>" count must both be present, and N
 * is the part's collected count.
 */
export function judgeNatsTest(res) {
  const label = 'make test-ports-nats'
  const out = `${res.stdout}\n${res.stderr}`
  const count = out.match(/^\[nats-test\] (\d+) passing tests from \S+ \(minimum \d+\)\s*$/m)
  const ok = /^\[nats-test\] OK -- the JetStream proofs ran against a real server\s*$/m.test(out)
  if (res.code !== 0) {
    return { label, collected: Math.max(1, count ? Number(count[1]) : 1), passed: 0, failed: Math.max(1, count ? Number(count[1]) : 1), skipped: 0, detail: tail(out) }
  }
  if (!count || !ok) {
    return { label, unparseable: true, detail: `exit 0 but no "[nats-test] N passing tests" + "[nats-test] OK" post-condition lines -- untrusted\n${tail(out)}` }
  }
  const n = Number(count[1])
  return { label, collected: n, passed: n, failed: 0, skipped: 0 }
}

/**
 * `make fresh-init-proof` (gremion-ui/scripts/fresh-init-proof.sh). Its
 * checks print `  ok <name>` / `FAIL <name>: ...`; collected is their count,
 * and exit 0 must come with its own "[fresh-init] all post-conditions hold".
 */
export function judgeFreshInit(res) {
  const label = 'make fresh-init-proof'
  const out = `${res.stdout}\n${res.stderr}`
  const oks = (out.match(/^\s+ok \S/gm) ?? []).length
  const fails = (out.match(/^FAIL \S/gm) ?? []).length
  const holds = /^\[fresh-init\] all post-conditions hold\s*$/m.test(out)
  if (res.code !== 0) {
    const failed = Math.max(1, fails)
    return { label, collected: oks + failed, passed: oks, failed, skipped: 0, detail: tail(out) }
  }
  if (!holds || fails > 0) {
    return { label, unparseable: true, detail: `exit 0 but no "[fresh-init] all post-conditions hold" line (or a FAIL line was printed) -- untrusted\n${tail(out)}` }
  }
  return { label, collected: oks, passed: oks, failed: 0, skipped: 0 }
}

function makePart(target, judge, root) {
  if (!toolAvailable('docker')) return { label: `make ${target}`, toolMissing: 'docker' }
  const res = run('make', [target], { cwd: root })
  if (spawnMissing(res)) return { label: `make ${target}`, toolMissing: 'make' }
  return judge(res)
}

export const INTEGRATION_PARTS = {
  vitest: (root) => vitestPart({ root }),
  'fresh-init': (root) => makePart('fresh-init-proof', judgeFreshInit, root),
  nats: (root) => makePart('test-ports-nats', judgeNatsTest, root),
}

export function runIntegrationSuite({ root = REPO_ROOT, only } = {}) {
  const names = only ?? Object.keys(INTEGRATION_PARTS)
  for (const n of names) {
    if (!INTEGRATION_PARTS[n]) throw new Error(`unknown integration part: ${n} (known: ${Object.keys(INTEGRATION_PARTS).join(', ')})`)
  }
  return combineParts(names.map((n) => INTEGRATION_PARTS[n](root)))
}
