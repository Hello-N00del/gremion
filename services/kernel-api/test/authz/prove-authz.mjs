#!/usr/bin/env node
// prove-authz.mjs -- TASK-081 plan step 9: the scratch-stack proof, run from a commit.
//
//   node services/kernel-api/test/authz/prove-authz.mjs [--allow-dirty]
//
// Starts the unit's own scratch PostgreSQL 18 through test/authz/stack.mjs (names t081-<sha8>-*,
// removed by name), runs the authz integration suites with vitest's JSON reporter, and then asserts
// POST-CONDITIONS from that report -- not the exit code:
//   - the commit under test is printed, and the tree is clean (or --allow-dirty is named),
//   - every REQUIRED title below was collected and PASSED (a suite that collected nothing fails),
//   - the collected total is at least the named floor of test/suite-size.test.ts (authz),
//   - no t081-* container is left on the host afterwards.
// Prints one evidence line per required proof and writes the full report next to the run
// (T081_REPORT or <scratchdir>/authz-report.json). Never touches a resource it did not create.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE = resolve(HERE, '../..')
const REPO = resolve(SERVICE, '../..')

// brief s.1 clauses and plan section 2 (M-OFF-1..4) and section 5 (guards), by title fragment
const REQUIRED = [
  ['M-OFF-1', 'M-OFF-1: zero modules enabled'],
  ['M-OFF-2 (decision)', 'M-OFF-2: disabling publishing denies on the NEXT decision'],
  ['M-OFF-2 (sweep)', 'M-OFF-2: disabling publishing revokes the live grant'],
  ['M-OFF-3', 'M-OFF-3: a module absent from the registry'],
  ['M-OFF-4', 'M-OFF-4: enable -> disable -> enable does not resurrect'],
  ['M-OFF-2/4 per module: board', 'board (brd.card.own): the NEXT decision denies'],
  ['M-OFF-2/4 per module: calendar', 'calendar (cal.event.manage): the NEXT decision denies'],
  ['M-OFF-1 every module capability', 'M-OFF-1: finance / fin.expense.approve decides deny with module_not_enabled'],
  ['M-OFF-3 absent module', 'sync with no registry row for a module succeeds'],
  ['M-OFF over HTTP, no module call', 'M-OFF over HTTP: with the votes module off'],
  ['TRD-091 granter role', 'a mismatching client-supplied granterRole is 403'],
  ['TRD-090 step-up', 'refuses 401 insufficient_user_authentication'],
  ['TRD-113 inclusion', 'a body_admin granting a role it does not include'],
  ['cross-tenant', 'cannot grant into another tenant'],
  ['customer-wide authority', 'council_admin held in the verwaltung grants the FIRST body_admin'],
  ['customer-wide: other customer', 'the same role of ANOTHER customer is refused'],
  ['customer-wide: body A -> body B', 'a body_admin of body A cannot grant in body B'],
  ['customer-wide: non-verwaltung', 'an it_admin held in a non-verwaltung body does not count'],
]

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...o })
const fail = (m) => {
  console.error(`[prove-authz] FAIL: ${m}`)
  process.exit(1)
}

const head = sh('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim()
const dirty = sh('git', ['status', '--porcelain'], { cwd: REPO }).stdout.trim()
console.log(`[prove-authz] commit under test: ${head}`)
if (dirty && !process.argv.includes('--allow-dirty')) fail('the working tree is dirty: prove a commit (or name --allow-dirty)')

const report = process.env.T081_REPORT ?? join(mkdtempSync(join(tmpdir(), 't081-proof-')), 'authz-report.json')
const run = spawnSync(process.execPath, [join(HERE, 'stack.mjs'), '--reporter=json', `--outputFile=${report}`], { cwd: SERVICE, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
let json
try {
  json = JSON.parse(readFileSync(report, 'utf8'))
} catch {
  fail(`no report at ${report}: the suite never ran (stack.mjs exit ${run.status})`)
}

const tests = json.testResults.flatMap((f) => f.assertionResults.map((a) => ({ file: f.name, title: a.fullName ?? a.title, status: a.status })))
const passed = tests.filter((t) => t.status === 'passed')
const bad = tests.filter((t) => t.status !== 'passed')
if (tests.length === 0) fail('the suite collected 0 tests')
if (bad.length) fail(`${bad.length} test(s) not passed: ${bad.map((b) => `${b.status}: ${b.title}`).join(' | ')}`)

const suite = readFileSync(join(SERVICE, 'test', 'suite-size.test.ts'), 'utf8')
const authzBlock = /authz: \{([\s\S]*?)\n  \}/.exec(suite)?.[1] ?? ''
const floor = [...authzBlock.matchAll(/:\s*(\d+),?/g)].reduce((n, m) => n + Number(m[1]), 0)
if (floor === 0) fail('could not read the authz floor from test/suite-size.test.ts')
if (passed.length < floor) fail(`collected ${passed.length} < named floor ${floor}`)

for (const [label, frag] of REQUIRED) {
  const hit = passed.find((t) => t.title.includes(frag))
  if (!hit) fail(`required proof not collected/passed: ${label} (${frag})`)
  console.log(`[prove-authz] PASS  ${label}: ${hit.title}`)
}

const left = sh('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=${process.env.T081_NAME_PREFIX ?? 't081'}-`]).stdout.trim()
if (left) fail(`scratch containers left behind: ${left.replace(/\s+/g, ' ')}`)
console.log(`[prove-authz] OK ${passed.length} tests passed (floor ${floor}), ${REQUIRED.length} required proofs present, 0 scratch containers left, report ${report}`)
