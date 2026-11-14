// Pilot wave 2, Task 1: the `isolation:tenant` suite part, the PRODUCER of the
// isolation evidence the module enable gate reads
// (packages/tenant-store/src/lifecycle/enable-gate/{gate,record}.ts).
//
// `isolation` (suites/isolation.mjs) proves the storage seam. THIS part proves,
// per module the pilot enables, that customer B's data cannot be read or
// written as customer A, on the code path the pilot actually runs. The backend
// column is the contract (the plan's Interfaces, "Backend per module"); it is
// pinned on the compose side by scripts/check-app-compose-env.test.mjs:
//
//   module      backend        proof
//   calendar    leaf service   real Postgres, the leaf's own two-tenant suite
//   content     leaf service   real Postgres, the leaf's own two-tenant suite
//   publishing  leaf service   real Postgres, the leaf's own two-tenant suite
//   votes       in-process     app half, recording fake Nextcloud
//   files       in-process     app half, recording fake WebDAV
//   messaging   in-process     app half, recording fake Synapse
//   board       in-process     real route handlers, real getDb(), two real tenant databases
//
// elections, finance, vault and handover have NO case on purpose: a result for
// a module that cannot be enabled would be evidence for code that is not running.
// The board case is `real-pg-app`: the board's data lives in the kernel's own
// per-customer database, so the proof runs the handlers the pilot runs against two
// physically separate Postgres databases (gremion-ui's integration config), not
// against a recording fake. The board LEAF (BOARD_BACKEND=service, test
// environment only) is not what this case proves.
// The board case states GREMION_PRODUCTION_STACK=none for the databases it creates
// itself, which replaces the production-stack guard for that case: the safety rests
// on the server being a throwaway one (loopback, not 5432, see throwawayServerProblem;
// the producer starts one in its own network namespace). Point the variable only at
// a server created for the run, never at a loopback port that forwards to a real one.
//
// Every part is judged by lib/guard.mjs (combineParts) like any other suite, so
// zero collected, one skip, a missing tool and an unparseable report all fail it.
// On top of that:
//   - every DECLARED module must have a case, and every case's test file must
//     be among the files vitest reported running (the pin, like isolation.mjs);
//   - a leaf case with no throwaway Postgres (ISOLATION_TENANT_PG_URL) fails
//     instead of running against nothing;
//   - a real-pg-app case runs the kernel's integration harness, whose guard
//     (assert-safe-test-db-url) needs GREMION_PRODUCTION_STACK and database URLs
//     it can place. The runner owns that database, so it states `none` and
//     derives the harness URLs from the throwaway server, but only after
//     checking that server is loopback and not port 5432;
//   - the overlay preparation (the modules' app halves are copied into
//     gremion-ui before their tests can import `$lib/...`) failing fails the part.
//
// The suite result carries `evidence` (per-module counts, the kept vitest
// report and its hash). lib/isolation-evidence.mjs turns that into the stamped
// file, and verify.mjs calls it only after its own dirty-tree and HEAD-moved
// checks, for a run of this part alone.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { run, tail } from '../lib/proc.mjs'
import { REPO_ROOT, runVitestJson } from '../lib/vitest.mjs'

export const ISOLATION_TENANT_PART = 'isolation:tenant'

/** Catalogue ids (modules/<id>/module.json), the keys plt.module and the gate use. */
export const ISOLATION_TENANT_MODULES = Object.freeze(['calendar', 'content', 'publishing', 'votes', 'files', 'messaging', 'board'])

/** The throwaway Postgres every leaf case connects to (localhost, a non-5432 port). */
export const PG_URL_VAR = 'ISOLATION_TENANT_PG_URL'

const leaf = (module, dir, pgVar) => ({
  module,
  proofKind: 'real-pg-leaf',
  cwd: `modules/${dir}`,
  cmd: 'pnpm',
  args: ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'test/tenant-isolation.integration.test.ts'],
  files: [`modules/${dir}/test/tenant-isolation.integration.test.ts`],
  needsPg: true,
  pgEnv: [pgVar],
})

const inProcess = (module, files) => ({
  module,
  proofKind: 'fake-upstream-app',
  cwd: 'gremion-ui',
  cmd: 'pnpm',
  // The overlay puts modules/<id>/app/** under gremion-ui/src/**: the files are
  // named (and pinned) under their overlaid path.
  args: ['exec', 'vitest', 'run', '--project', 'unit', ...files.map((f) => f.replace(/^gremion-ui\//, ''))],
  files,
  needsPg: false,
  prepare: true,
})

/**
 * The databases the integration harness config insists on (its DATABASE_URL and
 * CONTROL_DATABASE_URL guard) are derived from the throwaway server, under names
 * the guard accepts on loopback ("test" in the database name). The case itself
 * creates and drops its own board_iso_test_* databases on that server.
 */
const HARNESS_DATABASES = Object.freeze({ DATABASE_URL: 'board_iso_test_fixture', CONTROL_DATABASE_URL: 'board_iso_test_control' })

// A real-pg-app case: an in-process app half proven against real Postgres through
// gremion-ui's integration config (the file is named *.integration.test.ts).
const realPgApp = (module, files) => ({
  module,
  proofKind: 'real-pg-app',
  cwd: 'gremion-ui',
  cmd: 'pnpm',
  args: ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...files.map((f) => f.replace(/^gremion-ui\//, ''))],
  files,
  needsPg: true,
  pgEnv: [],
  pgDatabases: HARNESS_DATABASES,
  harnessOwnedDb: true,
  prepare: true,
})

/** A reason the throwaway server is not acceptable to a harness-owned case, or null. */
export function throwawayServerProblem(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return `${PG_URL_VAR} is not a URL`
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return `${PG_URL_VAR} is not a postgres:// URL`
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return `${PG_URL_VAR} must name loopback, not ${host}`
  if (u.port === '' || u.port === '5432') return `${PG_URL_VAR} must not use port 5432 (a live server's port)`
  return null
}

/** The same server, another database. */
export function serverWithDatabase(url, database) {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

/** The case table: one entry per declared module. */
export function isolationTenantCases() {
  return [
    leaf('calendar', 'calendar', 'CALENDAR_TEST_PG_URL'),
    leaf('content', 'content', 'CONTENT_TEST_PG_URL'),
    // The catalogue id is `publishing`, the leaf package `newsletter-service`.
    leaf('publishing', 'publishing', 'NEWSLETTER_TEST_PG_URL'),
    inProcess('votes', ['gremion-ui/src/lib/server/polls/polls-tenant.test.ts']),
    inProcess('files', ['gremion-ui/src/lib/server/files/tenant-isolation.test.ts']),
    inProcess('messaging', [
      'gremion-ui/src/lib/server/messages/tenant-isolation.test.ts',
      'gremion-ui/src/lib/server/messages/matrix-synapse.tenant.test.ts',
      'gremion-ui/src/lib/server/messages/livekit.tenant.test.ts',
    ]),
    realPgApp('board', ['gremion-ui/src/lib/server/board/tenant-isolation.integration.test.ts']),
  ]
}

// The order matters: the overlay first (it writes the files vitest collects),
// then SvelteKit's generated types, then the compiled i18n catalogue.
const PREPARE_STEPS = [
  { label: 'node gremion-ui/scripts/interim-module-overlay.mjs', cmd: process.execPath, args: ['gremion-ui/scripts/interim-module-overlay.mjs'], cwd: '.' },
  { label: 'svelte-kit sync (apps/control-panel)', cmd: 'pnpm', args: ['--dir', 'apps/control-panel', 'exec', 'svelte-kit', 'sync'], cwd: '.' },
  { label: 'node src/lib/i18n/compile.js', cmd: process.execPath, args: ['src/lib/i18n/compile.js'], cwd: 'gremion-ui' },
]

/** Runs the overlay preparation; `{ ok, detail }`. Output is gitignored, so the tree stays clean. */
export function prepareOverlay({ root = REPO_ROOT } = {}) {
  for (const step of PREPARE_STEPS) {
    const res = run(step.cmd, step.args, { cwd: path.join(root, step.cwd) })
    if (res.code !== 0) {
      return { ok: false, detail: `${step.label} exited ${res.code ?? `on signal ${res.signal}`}\n${tail(String(res.stdout) + String(res.stderr))}` }
    }
  }
  return { ok: true, detail: '' }
}

function failingPart(label, detail) {
  return { label, collected: 1, passed: 0, failed: 1, skipped: 0, detail }
}

/** The pin: every named test file must be among the files vitest reported running. */
export function pinFilesPart(part, files, label) {
  const seen = part.collectedFiles ?? []
  const missing = files.filter((f) => !seen.includes(f))
  return {
    label: `${label} must collect its test files`,
    collected: 1,
    passed: missing.length === 0 ? 1 : 0,
    failed: missing.length === 0 ? 0 : 1,
    skipped: 0,
    detail: missing.length === 0 ? '' : `${missing.join(', ')} was not among the files vitest reported running (saw: ${seen.join(', ') || '(none)'})`,
  }
}

function hashFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] the tree under test (the run's cwd for every case)
 * @param {Array<object>} [opts.cases] defaults to isolationTenantCases(); tests pass a fixture set
 * @param {readonly string[]} [opts.declaredModules] every one must have a case
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {Function} [opts.runVitest] runVitestJson's contract; injectable
 * @param {Function} [opts.prepare] () => {ok, detail}; injectable
 * @param {string} [opts.tmpRoot] where the kept vitest reports wait until verify decides
 * @param {() => Date} [opts.now]
 */
export function runIsolationTenantSuite({
  root = REPO_ROOT,
  cases = isolationTenantCases(),
  declaredModules = ISOLATION_TENANT_MODULES,
  env = process.env,
  runVitest = runVitestJson,
  prepare = () => prepareOverlay({ root }),
  tmpRoot = tmpdir(),
  now = () => new Date(),
} = {}) {
  const reportsDir = mkdtempSync(path.join(tmpRoot, 'isolation-tenant-'))
  const parts = []
  const modules = []

  for (const m of declaredModules) {
    if (!cases.some((c) => c.module === m)) {
      parts.push(failingPart(`${ISOLATION_TENANT_PART} ${m}`, `declared module ${m} has no isolation case: nothing proves it, so no evidence is written`))
    }
  }
  for (const c of cases) {
    if (!declaredModules.includes(c.module)) {
      parts.push(failingPart(`${ISOLATION_TENANT_PART} ${c.module}`, `${c.module} is not a declared module of this part (${declaredModules.join(', ')})`))
    }
  }

  let prepared = { ok: true, detail: '' }
  if (cases.some((c) => c.prepare)) {
    prepared = prepare()
    if (!prepared.ok) parts.push(failingPart(`${ISOLATION_TENANT_PART} overlay preparation`, prepared.detail))
  }

  const pgUrl = env[PG_URL_VAR]
  for (const c of cases) {
    if (!declaredModules.includes(c.module)) continue
    const label = `${ISOLATION_TENANT_PART} ${c.module} (${c.proofKind})`
    if (c.prepare && !prepared.ok) continue
    if (c.needsPg && !pgUrl) {
      parts.push(failingPart(label, `${PG_URL_VAR} is not set: a leaf case needs the throwaway Postgres (localhost, a port other than 5432); the part never falls back to anything else`))
      continue
    }
    if (c.harnessOwnedDb) {
      const problem = throwawayServerProblem(pgUrl)
      if (problem) {
        parts.push(failingPart(label, `${problem}: this case states GREMION_PRODUCTION_STACK=none for the database it owns, so the server must be a throwaway one`))
        continue
      }
    }
    const caseEnv = c.needsPg
      ? {
          ...env,
          ...Object.fromEntries((c.pgEnv ?? []).map((k) => [k, pgUrl])),
          ...Object.fromEntries(Object.entries(c.pgDatabases ?? {}).map(([k, db]) => [k, serverWithDatabase(pgUrl, db)])),
          ...(c.harnessOwnedDb ? { GREMION_PRODUCTION_STACK: 'none' } : {}),
        }
      : undefined
    const keepReportAt = path.join(reportsDir, `${c.module}.vitest.json`)
    const part = runVitest({
      label,
      cwd: path.resolve(root, c.cwd),
      cmd: c.cmd,
      args: c.args,
      ...(caseEnv ? { env: caseEnv } : {}),
      root,
      keepReportAt,
    })
    const pin = pinFilesPart(part, c.files, label)
    parts.push(part, pin)
    const reportPath = part.reportFile ?? keepReportAt
    modules.push({
      module: c.module,
      proofKind: c.proofKind,
      location: `${c.proofKind} ${c.files.join(' ')}`,
      collected: part.collected ?? 0,
      passed: part.passed ?? 0,
      failed: part.failed ?? 0,
      skipped: part.skipped ?? 0,
      pinned: pin.failed === 0,
      reportPath,
      reportSha256: existsSync(reportPath) ? hashFile(reportPath) : null,
      runAt: now().toISOString(),
    })
  }

  return { ...combineParts(parts), evidence: { declaredModules: [...declaredModules], reportsDir, modules } }
}

/** Removes the kept reports of a run (idempotent; verify calls it on every path). */
export function discardIsolationEvidence(evidence) {
  if (evidence?.reportsDir) rmSync(evidence.reportsDir, { recursive: true, force: true })
}
