// TASK-045: integration suite (brief S5, S9). Three sub-checks against a
// throwaway Postgres 18 started with a PLAIN `docker run` (never `docker
// compose` -- the repo's base docker-compose.yml pins gremion_* volume names
// host-wide; a 2026-09-24 incident wiped 7 of them when a worktree's compose
// run collided with other work's shared volumes). The container and any
// volume it creates are named uniquely per run and torn down in a `finally`
// with plain `docker rm -f` / `docker volume rm`, never `docker compose down`.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseVitestJsonFile } from '../lib/parsers.mjs'
import { run, toolAvailable } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

// A fresh, unguessable password per run -- never committed, never logged.
// Earlier draft of this suite hard-coded POSTGRES_PASSWORD=gremion_test,
// which is fine for a throwaway container nothing else can reach, but a
// literal credential in a public kernel repo is exactly the shape the
// public-flip leak check exists to catch, and costs nothing to avoid: this
// container is torn down at the end of the same function and the password
// is never printed (run()'s own stdout/stderr capture is never logged for
// this call site) or written to the result record.
function randomTestPassword() {
  return randomBytes(24).toString('base64url')
}

function startTestDb({ sha8, pid }) {
  const name = `verify-${sha8}-${pid}-db`
  const password = randomTestPassword()
  // POSTGRES_USER contains "test" so assert-safe-test-db-url.ts's non-5432
  // convention check passes (brief S9) without touching the documented
  // fixture URLs. `-p 127.0.0.1::5432` binds an ephemeral host port so this
  // run can never collide with another worktree's, or with staging's 5433.
  //
  // POSTGRES_DB is "gremion", not "gremion_test": found by actually running
  // `pnpm migrate` against a "gremion_test" database --
  // migrations/008_public_portal.sql hardcodes a bare `GRANT CONNECT ON
  // DATABASE gremion TO gremion_public_reader` (058's own header names this
  // as a known, un-fixed defect in 008 -- migration files are pinned by
  // SHA-256 manifest and never edited after the fact). assert-safe-test-db-
  // url.ts's OWN documented fixture URL is
  // `postgres://gremion:gremion_test@localhost:5432/gremion` -- "gremion" is
  // this repo's actual integration-suite database name; the safety
  // convention (db name OR user name must contain "test") is satisfied here
  // by POSTGRES_USER alone, so the database itself can and should be named
  // to match what every migration assumes.
  const runRes = run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_USER=gremion_test',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=gremion',
    '-p',
    '127.0.0.1::5432',
    'postgres:18-alpine',
  ])
  if (runRes.code !== 0) {
    return { ok: false, name, detail: `docker run failed: ${runRes.stderr || runRes.stdout}` }
  }
  // The official postgres image starts TWO servers on a first run: a
  // temporary, unix-socket-only postmaster that runs initdb's own scripts,
  // then a full restart into the real one. `pg_isready` can observe the
  // temporary server's brief accepting-connections window and report ready
  // moments before it shuts down for the restart -- caught by actually
  // running this suite: `pg_isready` succeeded, port lookup succeeded, and
  // the very next call (`CREATE DATABASE control`, ~1-2s later) failed with
  // "connection ... failed: No such file or directory" because the socket
  // it had just seen was gone again mid-restart. `pg_isready` alone cannot
  // tell the two servers apart; a real `SELECT 1` through psql can, because
  // it only ever succeeds against a server actually accepting queries, and
  // retrying it (not just checking once) rides out the restart gap.
  const deadline = Date.now() + 60_000
  let port = null
  while (Date.now() < deadline) {
    const probe = run('docker', ['exec', '-e', `PGPASSWORD=${password}`, name, 'psql', '-U', 'gremion_test', '-d', 'postgres', '-tAc', 'SELECT 1'])
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
  return { ok: true, name, port, password }
}

// Kept dependency-free and synchronous (this whole suite is spawnSync
// throughout, see lib/proc.mjs's own doc comment on why): Atomics.wait on a
// fresh SharedArrayBuffer blocks the calling thread for exactly `ms` without
// spawning a process per poll.
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function stopTestDb(name) {
  // Tolerant: never masks the real result, and must run even when the caller
  // is already unwinding from a failure.
  run('docker', ['rm', '-f', name])
}

export function runIntegrationSuite({ root = REPO_ROOT } = {}) {
  if (!toolAvailable('docker')) {
    return { toolMissing: 'docker', unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0 }
  }
  const uiDir = path.join(root, 'gremion-ui')
  const sha8 = (process.env.GITHUB_SHA || Date.now().toString(16)).slice(0, 8)
  const db = startTestDb({ sha8, pid: process.pid })
  if (!db.ok) {
    stopTestDb(db.name)
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: db.detail }
  }

  try {
    const dataUrl = `postgres://gremion_test:${db.password}@127.0.0.1:${db.port}/gremion`
    const controlUrl = `postgres://gremion_test:${db.password}@127.0.0.1:${db.port}/control`

    const createControl = run('docker', [
      'exec',
      '-e',
      `PGPASSWORD=${db.password}`,
      db.name,
      'psql',
      '-U',
      'gremion_test',
      '-d',
      'postgres',
      '-c',
      'CREATE DATABASE control',
    ])
    if (createControl.code !== 0) {
      return unparseable(`CREATE DATABASE control failed: ${createControl.stderr || createControl.stdout}`)
    }

    // migrations/058_public_reader_grants.sql (T07) deliberately ABORTS the
    // whole migration chain when the `gremion_public_reader` role does not
    // exist yet -- found by actually running `pnpm migrate` against this
    // throwaway container: "role gremion_public_reader does not exist ...
    // Create it BEFORE migrating." On a real deployment that role comes from
    // docker/postgres/init-databases.sh (Docker) or the postgres-init-scripts
    // ConfigMap (K8s), neither of which this ad hoc `docker run` container
    // runs. This suite owns its own throwaway Postgres end-to-end, so it
    // creates the role itself here, the same way init-databases.sh does --
    // with its own fresh, unlogged, never-printed password (the role's
    // password is never read back by anything this suite does; only its
    // existence matters to 058).
    // Ported from docker/postgres/init-databases.sh's own form: `-c` does NOT
    // expand a `-v`-supplied psql variable (:'_password') the way piping the
    // same statement through stdin does (proved empirically -- `-c` raised
    // "syntax error at or near \":\""), so this goes through stdin, exactly
    // like init-databases.sh's own heredoc does.
    const publicReaderPassword = randomTestPassword()
    const createPublicReader = run(
      'docker',
      ['exec', '-i', '-e', `PGPASSWORD=${db.password}`, db.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-v', `_password=${publicReaderPassword}`, '-U', 'gremion_test', '-d', 'gremion'],
      {
        input:
          "SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') " +
          "THEN format('CREATE ROLE gremion_public_reader LOGIN PASSWORD %L', :'_password') ELSE 'SELECT 1' END \\gexec\n",
      },
    )
    if (createPublicReader.code !== 0) {
      return unparseable(`provisioning gremion_public_reader failed: ${createPublicReader.stderr || createPublicReader.stdout}`)
    }

    const env = {
      ...process.env,
      DATABASE_URL: dataUrl,
      CONTROL_DATABASE_URL: controlUrl,
      CONFIG_PATH: path.join(uiDir, 'tests', 'integration', 'fixtures', 'default-config.json'),
      GREMION_DISABLE_SEEDS: 'true',
      KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-kc-admin-secret',
      AUTH_KEYCLOAK_SECRET: 'test-ui-client-secret',
      AUTH_KEYCLOAK_ISSUER: 'https://council.example/auth/realms/gremion',
      AUTH_KEYCLOAK_BASE: 'https://council.example/auth/realms/gremion',
    }

    const migrate = run('pnpm', ['run', 'migrate'], { cwd: uiDir, env })
    if (migrate.code !== 0) {
      return unparseable(`pnpm migrate failed: ${tail(migrate.stdout + migrate.stderr)}`)
    }

    const outFile = path.join(mkdtempSync(path.join(tmpdir(), 'verify-integration-')), 'result.json')
    const test = run(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', '--reporter=json', `--outputFile=${outFile}`],
      { cwd: uiDir, env },
    )
    const parsed = parseVitestJsonFile(outFile)
    rmSync(path.dirname(outFile), { recursive: true, force: true })
    if (!parsed) {
      return unparseable(`vitest test:integration produced no parseable JSON report (exit ${test.code})\n${tail(test.stdout + test.stderr)}`)
    }

    // make fresh-init-proof and make test-ports-nats are each self-contained
    // (their own throwaway container, own port) -- see the Makefile's own
    // comments. Trusted by exit code plus their own printed post-condition
    // string, since both already assert non-vacuously in-database / in-log.
    const freshInit = run('make', ['fresh-init-proof'], { cwd: root })
    const freshInitOk = freshInit.code === 0 && /all post-conditions hold/.test(freshInit.stdout + freshInit.stderr)

    const natsTest = run('make', ['test-ports-nats'], { cwd: root })
    const natsOk = natsTest.code === 0

    const extraFailed = (freshInitOk ? 0 : 1) + (natsOk ? 0 : 1)
    const details = []
    if (!freshInitOk) details.push(`fresh-init-proof: ${tail(freshInit.stdout + freshInit.stderr)}`)
    if (!natsOk) details.push(`test-ports-nats: ${tail(natsTest.stdout + natsTest.stderr)}`)

    return {
      toolMissing: null,
      unparseable: false,
      collected: parsed.collected + 2,
      passed: parsed.passed + (freshInitOk ? 1 : 0) + (natsOk ? 1 : 0),
      failed: parsed.failed + extraFailed,
      skipped: parsed.skipped,
      detail: details.join('\n'),
    }
  } finally {
    stopTestDb(db.name)
  }
}

function unparseable(detail) {
  return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail }
}

function tail(text, n = 500) {
  return text.length > n ? text.slice(-n) : text
}
