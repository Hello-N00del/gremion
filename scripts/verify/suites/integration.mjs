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
import { stripVTControlCharacters } from 'node:util'
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

// The official postgres image starts TWO servers on a first run: a
// temporary one for initdb's scripts (docker-entrypoint.sh starts it with
// `-c listen_addresses=''`, so it answers on the unix socket ONLY), then
// stops it and execs the real one. Every psql this suite runs therefore goes
// over TCP to 127.0.0.1 inside the container, which only the real server
// answers: a socket probe can pass against the temporary server moments
// before it shuts down, and the next socket command then dies with "server
// closed the connection unexpectedly" (CI run 4, CREATE DATABASE control).
export const PSQL_HOST = '127.0.0.1'

// The throwaway server must answer this many probes in a row to count as ready.
export const READY_PROBES = 2

/** argv for the readiness probe: a `SELECT 1` over TCP. */
export function psqlProbeArgs(name) {
  return ['exec', '-e', 'PGPASSWORD', name, 'psql', '-h', PSQL_HOST, '-U', 'gremion_test', '-d', 'postgres', '-tAc', 'SELECT 1']
}

/** argv for every other psql this suite runs against the throwaway server: over TCP too. */
export function psqlExecArgs(name, database, args, { interactive = false } = {}) {
  return ['exec', ...(interactive ? ['-i'] : []), '-e', 'PGPASSWORD', name, 'psql', '-h', PSQL_HOST, '-v', 'ON_ERROR_STOP=1', '-U', 'gremion_test', '-d', database, ...args]
}

// `exec`, `sleep` and `now` are seams for the unit test (a scripted docker and a
// fake clock); the defaults are the real ones.
export function startTestDb({ sha8, pid, exec = run, sleep = sleepMs, now = Date.now }) {
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
  const runRes = exec(
    'docker',
    ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=gremion_test', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=gremion', '-p', '127.0.0.1::5432', 'postgres:18-alpine'],
    { env },
  )
  if (runRes.code !== 0) {
    return { ok: false, name, detail: `docker run failed: ${String(runRes.stderr || runRes.stdout)}` }
  }
  // A real `SELECT 1` over TCP, retried, rides out the restart gap; it must
  // succeed READY_PROBES times in a row, so one lucky answer is not enough.
  const deadline = now() + 60_000
  let port = null
  let streak = 0
  while (now() < deadline) {
    const probe = exec('docker', psqlProbeArgs(name), { env })
    streak = probe.code === 0 && probe.stdout.trim() === '1' ? streak + 1 : 0
    if (streak >= READY_PROBES) {
      const portRes = exec('docker', ['port', name, '5432/tcp'])
      const m = portRes.stdout.match(/:(\d+)\s*$/m)
      if (m) {
        port = Number(m[1])
        break
      }
    }
    sleep(300)
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
  return run('docker', psqlExecArgs(db.name, database, args, { interactive: Boolean(opts.input) }), {
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

/**
 * The environment gremion-ui's `test:leaf-shred` runs with: the integration
 * environment plus LEAF_SHRED_TEST_PG_URL, the admin url of the same throwaway
 * container (loopback, ephemeral port, user `gremion_test`). The lane creates and
 * drops only `newsletter_test_*` / `calendar_test_*` databases on it, and its
 * own guard (assertNonProductionDbUrl) re-checks the url before connecting.
 * Exported for the unit test (scripts/verify/integration.test.mjs).
 */
export function leafShredVitestEnv({ baseEnv, db, uiDir }) {
  return {
    ...integrationVitestEnv({ baseEnv, db, uiDir }),
    LEAF_SHRED_TEST_PG_URL: `postgres://gremion_test:${db.password}@127.0.0.1:${db.port}/postgres`,
  }
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
      return { label, unparseable: true, detail: `CREATE DATABASE control failed: ${String(createControl.stderr || createControl.stdout)}` }
    }

    // migrations/058 ABORTS the chain when `gremion_public_reader` does not
    // exist; on a real deployment docker/postgres/init-databases.sh creates
    // it. This suite owns its throwaway Postgres, so it creates the role the
    // same way (its password is never read back; only its existence
    // matters). `-c` does not expand a `-v` psql variable, stdin does.
    const publicReaderPassword = randomTestPassword()
    const createPublicReader = psqlAsTestUser(db, 'gremion', [], {
      // The password is set on stdin (\set), never as a `-v` argv entry
      // (base64url: no quote or backslash, safe inside psql's single quotes).
      input:
        `\\set _password '${publicReaderPassword}'\n` +
        "SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') " +
        "THEN format('CREATE ROLE gremion_public_reader LOGIN PASSWORD %L', :'_password') ELSE 'SELECT 1' END \\gexec\n",
    })
    if (createPublicReader.code !== 0) {
      return { label, unparseable: true, detail: `provisioning gremion_public_reader failed: ${String(createPublicReader.stderr || createPublicReader.stdout)}` }
    }

    const env = integrationVitestEnv({ baseEnv: process.env, db, uiDir })

    // TASK-042 (G2): boot and `migrate` register no tenant; the harness creates
    // and migrates its fixture tenant (scripts/migrate-test-fixture.mjs).
    const migrate = run('pnpm', ['run', 'migrate:test-fixture'], { cwd: uiDir, env })
    if (spawnMissing(migrate)) return { label, toolMissing: 'pnpm' }
    if (migrate.code !== 0) {
      return { label, unparseable: true, detail: `pnpm migrate:test-fixture failed: ${tail(migrate.stdout + migrate.stderr)}` }
    }
    const integration = runVitestJson({ label, cwd: uiDir, cmd: 'pnpm', args: ['run', 'test:integration'], env, root })
    // The leaf-shred executors' real-Postgres proof (tenant delete), on the same
    // throwaway server: its own lane config, never the kernel database.
    const leafShred = runVitestJson({
      label: 'gremion-ui vitest (test:leaf-shred)',
      cwd: uiDir,
      cmd: 'pnpm',
      args: ['run', 'test:leaf-shred'],
      env: leafShredVitestEnv({ baseEnv: process.env, db, uiDir }),
      root,
    })
    // Two sub-checks of this one part: each is judged on its own in combineParts
    // (a lane that collected nothing cannot hide inside the other's count).
    return [integration, leafShred]
  } finally {
    stopTestDb(db.name)
  }
}

/**
 * A make target's stdout + stderr as the judges read it, with terminal colour
 * stripped. Vitest (and anything built on tinyrainbow) colours its summary when
 * CI is set even though stdout is a pipe, so on a CI runner the unit run prints
 * "\x1b[2m      Tests \x1b[22m \x1b[32m171 passed\x1b[39m ..." and a line-anchored
 * `^\s*Tests\s+N passed (N)` never matches: every part whose unit step goes
 * through `pnpm test` read as "unparseable" on ubuntu-latest, though it ran.
 * On a developer's terminal-less run (no CI) nothing is coloured, which is why
 * this only ever showed on the runner.
 */
export function capturedText(res) {
  return stripVTControlCharacters(`${res.stdout}\n${res.stderr}`)
}

/**
 * The unit step's vitest summary ("Tests  170 passed | 1 skipped (171)"), read from the text
 * printed BEFORE `marker`: the live proof that follows echoes a summary of its own, which must
 * not stand in for the unit one. `null` when there is no summary line at all. `wellFormed` is
 * false when a part is not one of failed/passed/skipped/todo or the parts do not add up to the
 * total in parentheses: the shape is then not understood and the part stays untrusted.
 */
function unitSummary(out, marker) {
  const m = out.split(marker)[0].match(/^[ \t]*Tests[ \t]+(.+?)[ \t]+\((\d+)\)[ \t]*$/m)
  if (!m) return null
  const n = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  let known = true
  for (const part of m[1].split('|')) {
    const c = part.trim().match(/^(\d+) (passed|failed|skipped|todo)$/)
    if (c) n[c[2]] += Number(c[1])
    else known = false
  }
  const total = Number(m[2])
  return { ...n, total, line: m[0].trim(), wellFormed: known && n.passed + n.failed + n.skipped + n.todo === total }
}

/**
 * Why a unit step that exited 0 is still not a pass, as a named failure -- or null when its
 * summary is clean (all passed) or not understood (the caller then calls it unparseable). The
 * unit step of an integration part runs wherever the part runs (an unprivileged CI runner
 * among them), and a case that skips there is a case nobody ran: the part allows no skips.
 */
function unitFault(label, unit) {
  if (!unit?.wellFormed) return null
  const skipped = unit.skipped + unit.todo
  const said = []
  if (unit.failed > 0) said.push(`reported ${unit.failed} failed test(s) although the target exited 0`)
  if (skipped > 0) said.push(`skipped ${skipped} test(s); an integration part allows no skips`)
  if (said.length === 0) return null
  return {
    label,
    collected: unit.total,
    passed: unit.passed,
    failed: unit.failed + skipped,
    skipped: 0,
    detail: `unit run inside ${label} ${said.join('; and ')}\nunit summary seen: "${unit.line}"`,
  }
}

/** The unit summary is the all-passed shape and nothing else. */
const cleanUnit = (unit) => unit !== null && unit.wellFormed && unit.passed === unit.total && unit.total > 0 && unit.failed + unit.skipped + unit.todo === 0

/**
 * `make test-ports-nats` (packages/ports/scripts/nats-test.sh). Exit 0 is
 * not enough (round-1 MEDIUM: this was trusted on exit code alone while the
 * comment claimed a post-condition check): the script's own final OK line
 * and its "<N> passing tests from <file>" count must both be present, and N
 * is the part's collected count.
 */
export function judgeNatsTest(res) {
  const label = 'make test-ports-nats'
  const out = capturedText(res)
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
 * `make test-nats-auth` (TASK-024): @gremion/nats-auth's unit suite, then
 * packages/nats-auth/scripts/proof.sh --auth against a real broker. Judged
 * like judgeNatsTest: exit 0 counts only with the unit run's all-passed
 * summary AND the proof's own "[nats-auth-proof] N passing" and OK lines;
 * collected is the unit count plus N.
 */
export const NATS_AUTH_MIN_PROOFS = 25

export function judgeNatsAuthTest(res) {
  const label = 'make test-nats-auth'
  const out = capturedText(res)
  // The unit run prints BEFORE the proof starts; the proof echoes its own
  // live-suite summary, which must not stand in for the unit one.
  const unit = unitSummary(out, /^\[nats-auth-proof\]/m)
  // The floor is proof.sh's own (25 live cases); a log claiming a lower one
  // did not run the proof this judge vouches for.
  const count = out.match(/^\[nats-auth-proof\] (\d+) passing \(minimum (\d+)\)\s*$/m)
  const floorOk = count !== null && Number(count[2]) >= NATS_AUTH_MIN_PROOFS && Number(count[1]) >= Number(count[2])
  const ok = /^\[nats-auth-proof\] OK -- the authenticated broker admits and refuses as specified\s*$/m.test(out)
  if (res.code !== 0) {
    const n = Math.max(1, (cleanUnit(unit) ? unit.passed : 0) + (count ? Number(count[1]) : 0))
    return { label, collected: n, passed: 0, failed: n, skipped: 0, detail: tail(out) }
  }
  const fault = unitFault(label, unit)
  if (fault) return fault
  if (!cleanUnit(unit) || !count || !ok || !floorOk) {
    return {
      label,
      unparseable: true,
      detail: `exit 0 but not all of the unit "Tests N passed (N)" summary, "[nats-auth-proof] N passing (minimum >= 25)" and "[nats-auth-proof] OK" lines -- untrusted\nunit summary seen: ${unit ? `"${unit.line}"` : 'none'}\n${tail(out)}`,
    }
  }
  const n = unit.passed + Number(count[1])
  return { label, collected: n, passed: n, failed: 0, skipped: 0 }
}

/**
 * `make test-events` (TASK-079): @gremion/events' unit suite, then
 * packages/events/scripts/proof.sh against a scratch Postgres and the
 * authenticated broker (four live groups and three alert phases), then the
 * migrate-image reach check. Judged like judgeNatsAuthTest: exit 0 counts only
 * with the unit run's all-passed summary, every live group's own
 * "[events-proof] N passing (minimum M)" + "group <g> OK" pair at or above the
 * floor pinned HERE (a log claiming a lower floor did not run the proof this
 * judge vouches for), the three alert phases' OK lines, the proof's final
 * "[events-proof] OK" and the image check's OK line. collected is the unit
 * count plus the live counts.
 */
export const EVENTS_MIN_PROOFS = { core: 15, consumer: 15, deadletter: 6, rebuild: 2 }
export const EVENTS_ALERT_PHASES = ['alert-red', 'alert-fire', 'alert-hold', 'alert-resolve']

export function judgeEventsTest(res) {
  const label = 'make test-events'
  const out = capturedText(res)
  // The unit run prints BEFORE the proof starts; the proof echoes its own live-suite
  // summaries, which must not stand in for the unit one.
  const unit = unitSummary(out, /^\[events-proof\]/m)
  const groups = new Map()
  for (const m of out.matchAll(/^\[events-proof\] (\d+) passing \(minimum (\d+)\)\s*\n\[events-proof\] group ([\w-]+) OK\s*$/gm)) {
    groups.set(m[3], { passing: Number(m[1]), minimum: Number(m[2]) })
  }
  const groupsOk = Object.entries(EVENTS_MIN_PROOFS).every(([g, floor]) => {
    const r = groups.get(g)
    return r !== undefined && r.minimum >= floor && r.passing >= r.minimum
  })
  const alertsOk = EVENTS_ALERT_PHASES.every((p) => new RegExp(`^\\[events-proof\\] group ${p} OK\\s*$`, 'm').test(out))
  const ok = /^\[events-proof\] OK\s*$/m.test(out)
  const image = /^\[events-image\] OK\b/m.test(out)
  const live = [...groups.values()].reduce((a, r) => a + r.passing, 0)
  if (res.code !== 0) {
    const n = Math.max(1, (cleanUnit(unit) ? unit.passed : 0) + live)
    return { label, collected: n, passed: 0, failed: n, skipped: 0, detail: tail(out) }
  }
  const fault = unitFault(label, unit)
  if (fault) return fault
  if (!cleanUnit(unit) || !groupsOk || !alertsOk || !ok || !image) {
    return {
      label,
      unparseable: true,
      detail: `exit 0 but not all of the unit "Tests N passed (N)" summary, the four "[events-proof] N passing (minimum >= floor)" group pairs, the four alert phase OK lines (red, fire, hold, resolve), "[events-proof] OK" and "[events-image] OK" -- untrusted\nunit summary seen: ${unit ? `"${unit.line}"` : 'none'}\n${tail(out)}`,
    }
  }
  const n = unit.passed + live
  return { label, collected: n, passed: n, failed: 0, skipped: 0 }
}

/**
 * `make fresh-init-proof` (gremion-ui/scripts/fresh-init-proof.sh). Its
 * checks print `  ok <name>` / `FAIL <name>: ...`; collected is their count,
 * and exit 0 must come with its own "[fresh-init] all post-conditions hold".
 */
export function judgeFreshInit(res) {
  const label = 'make fresh-init-proof'
  const out = capturedText(res)
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
  'nats-auth': (root) => makePart('test-nats-auth', judgeNatsAuthTest, root),
  events: (root) => makePart('test-events', judgeEventsTest, root),
}

export function runIntegrationSuite({ root = REPO_ROOT, only } = {}) {
  const names = only ?? Object.keys(INTEGRATION_PARTS)
  for (const n of names) {
    if (!INTEGRATION_PARTS[n]) throw new Error(`unknown integration part: ${n} (known: ${Object.keys(INTEGRATION_PARTS).join(', ')})`)
  }
  // A part is one sub-check, or an array of them (the vitest part runs two lanes).
  return combineParts(names.flatMap((n) => [INTEGRATION_PARTS[n](root)].flat()))
}
