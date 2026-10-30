// TASK-045 round 2: the integration suite's two make-target sub-checks are
// judged by exit code AND the target's own printed post-condition, and their
// counts come from what the target says it proved, not a fixed 1.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  INTEGRATION_PARTS,
  integrationVitestEnv,
  judgeEventsTest,
  judgeFreshInit,
  judgeKeycloakStepup,
  judgeNatsAuthTest,
  judgeNatsTest,
  KEYCLOAK_STEPUP_FILE,
  psqlExecArgs,
  psqlProbeArgs,
  startTestDb,
} from './suites/integration.mjs'

const NATS_OK =
  '[nats-test] running the ports suite against nats://127.0.0.1:4222\n' +
  '[nats-test] 20 passing tests from src/nats-broker.integration.test.ts (minimum 12)\n' +
  '[nats-test] OK -- the JetStream proofs ran against a real server\n'

test('test-ports-nats: exit 0 plus both post-condition lines passes, counting the proofs it ran', () => {
  const p = judgeNatsTest({ code: 0, stdout: NATS_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 20)
  assert.equal(p.passed, 20)
  assert.equal(p.failed, 0)
})

test('test-ports-nats: exit 0 WITHOUT its post-condition line is untrusted, never a pass (round-1 MEDIUM)', () => {
  const p = judgeNatsTest({ code: 0, stdout: '[nats-test] running the ports suite\n', stderr: '' })
  assert.equal(p.unparseable, true)
})

test('test-ports-nats: a non-zero exit is a failure', () => {
  const p = judgeNatsTest({ code: 1, stdout: '[nats-test] FAILED: ports suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 || p.unparseable, JSON.stringify(p))
  assert.notEqual(p.unparseable === false && p.failed === 0, true)
})

// TASK-024: make test-nats-auth -- the package's unit suite, then
// packages/nats-auth/scripts/proof.sh --auth against a real broker.
const NATS_AUTH_OK =
  '      Tests  69 passed (69)\n' +
  '[nats-auth-proof] auth broker t024-0123abcd-nats-auth on 127.0.0.1:32768\n' +
  '      Tests  25 passed (25)\n' +
  '[nats-auth-proof] 25 passing (minimum 25)\n' +
  '[nats-auth-proof] OK -- the authenticated broker admits and refuses as specified\n'

test('test-nats-auth: exit 0 plus the unit summary and both proof lines passes, counting unit + live cases', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 94)
  assert.equal(p.passed, 94)
  assert.equal(p.failed, 0)
})

// One test, a loop inside it: scripts/verify/suites/unit.mjs compares node's collected count with the
// number of `test(` declarations, and a `test(` inside a loop declares 1 and collects N (judged
// unparseable). The message names the case that failed.
test('test-nats-auth: exit 0 without a proof line is untrusted, never a pass', () => {
  for (const [missing, drop] of [
    ['the "N passing" line', /^\[nats-auth-proof\] \d+ passing.*\n/m],
    ['the OK line', /^\[nats-auth-proof\] OK.*\n/m],
    ['the unit summary', /^\s+Tests  69 passed \(69\)\n/m],
  ]) {
    const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK.replace(drop, ''), stderr: '' })
    assert.equal(p.unparseable, true, `without ${missing}: ${JSON.stringify(p)}`)
  }
})

test('test-nats-auth: a proof run with its floor lowered below 25 is untrusted', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK.replace('25 passing (minimum 25)', '3 passing (minimum 3)'), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})

test('test-nats-auth: a non-zero exit is a failure', () => {
  const p = judgeNatsAuthTest({ code: 1, stdout: '[nats-auth-proof] FAILED: the live suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 && !p.unparseable, JSON.stringify(p))
})

test('the nats-auth part is registered beside nats', () => {
  assert.equal(typeof INTEGRATION_PARTS['nats-auth'], 'function')
  const keys = Object.keys(INTEGRATION_PARTS)
  const at = keys.indexOf('nats')
  assert.notEqual(at, -1)
  assert.deepEqual(keys.slice(at, at + 3), ['nats', 'nats-auth', 'events'])
})

// The live Keycloak step-up deny proof (kernel-api test/keycloak/stepup-deny.int.test.ts) as a verify part:
// a user WITHOUT a second factor who asks gremion-ui for acr loa2 is refused, never offered authenticator
// set-up. It starts its own Keycloak container, so it runs wherever the part runs. A vitest run that
// collected zero files or skipped its cases exits 0, so the part pins the file, the case count and no skips.
const stepupPart = (over = {}) => ({
  label: 'kernel-api keycloak step-up deny (live)',
  toolMissing: null,
  unparseable: false,
  collected: 2,
  passed: 2,
  failed: 0,
  skipped: 0,
  skipsByFile: {},
  collectedFiles: [KEYCLOAK_STEPUP_FILE],
  detail: '',
  ...over,
})

test('the keycloak-stepup part is registered', () => {
  assert.equal(typeof INTEGRATION_PARTS['keycloak-stepup'], 'function')
})

test('keycloak-stepup: both live cases passing with the file collected is a pass', () => {
  const p = judgeKeycloakStepup(stepupPart())
  assert.equal(p.failed, 0, JSON.stringify(p))
  assert.equal(p.passed, 2)
})

// One test, a loop inside it (see the test-nats-auth note above for why).
test('keycloak-stepup: a green run that did not collect the file, ran fewer cases or skipped one is a failure, never a pass', () => {
  const cases = [
    { what: 'the file was not collected', over: { collectedFiles: [] }, expected: /was not among the files vitest reported running/ },
    { what: 'only one case ran', over: { collected: 1, passed: 1 }, expected: /only 1 of the 2 live cases passed/ },
    { what: 'a case skipped', over: { skipped: 1, passed: 1 }, expected: /skipped 1 case\(s\); a live Keycloak proof allows no skips/ },
  ]
  for (const { what, over, expected } of cases) {
    const p = judgeKeycloakStepup(stepupPart(over))
    assert.ok(p.failed >= 1, `${what}: ${JSON.stringify(p)}`)
    assert.match(p.detail, expected, what)
  }
})

// A real failing case is already a failure in the record: the judge must not count it a second time.
test('keycloak-stepup: a real case failure is reported once, with no synthetic extra case or failure', () => {
  const p = judgeKeycloakStepup(stepupPart({ passed: 1, failed: 1 }))
  assert.equal(p.collected, 2, JSON.stringify(p))
  assert.equal(p.failed, 1, JSON.stringify(p))
  assert.doesNotMatch(p.detail, /live cases passed/, 'the failure is not also reported as a short pass count')
})

test('keycloak-stepup: a missing docker or an unparseable report passes through untouched (never turned into a pass)', () => {
  assert.equal(judgeKeycloakStepup({ label: 'x', toolMissing: 'docker' }).toolMissing, 'docker')
  assert.equal(judgeKeycloakStepup(stepupPart({ unparseable: true })).unparseable, true)
})

// TASK-079: make test-events -- the unit suite, four live groups, three alert phases, the image check.
const EVENTS_OK =
  '      Tests  83 passed (83)\n' +
  '[events-proof] stack t079-0123abcd up\n' +
  '      Tests  16 passed (16)\n' +
  '[events-proof] 16 passing (minimum 15)\n' +
  '[events-proof] group core OK\n' +
  '[events-proof] 15 passing (minimum 15)\n' +
  '[events-proof] group consumer OK\n' +
  '[events-proof] 6 passing (minimum 6)\n' +
  '[events-proof] group deadletter OK\n' +
  '[events-proof] 2 passing (minimum 2)\n' +
  '[events-proof] group rebuild OK\n' +
  '[events-proof] group alert-red OK\n' +
  '[events-proof] group alert-fire OK\n' +
  '[events-proof] group alert-hold OK\n' +
  '[events-proof] group alert-resolve OK\n' +
  '[events-proof] OK\n' +
  '[events-image] OK -- pnpm exec events and the package import work in t079-0123abcd-migrate\n'

test('test-events: the unit summary, every group at its floor, the alert phases, OK and the image line pass, counting unit + live', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.equal(p.collected, 83 + 16 + 15 + 6 + 2)
  assert.equal(p.failed, 0)
})

// One test, a loop inside it (see the test-nats-auth note above for why).
test('test-events: exit 0 without a proof line is untrusted, never a pass', () => {
  for (const [missing, drop] of [
    ['the unit summary', /^\s+Tests  83 passed \(83\)\n/m],
    ['the rebuild group', /^\[events-proof\] 2 passing \(minimum 2\)\n\[events-proof\] group rebuild OK\n/m],
    ['an alert phase', /^\[events-proof\] group alert-hold OK\n/m],
    ['the final OK line', /^\[events-proof\] OK\n/m],
    ['the image line', /^\[events-image\] OK.*\n/m],
  ]) {
    const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK.replace(drop, ''), stderr: '' })
    assert.equal(p.unparseable, true, `without ${missing}: ${JSON.stringify(p)}`)
  }
})

test('test-events: a group run with its floor lowered below the pinned one is untrusted', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK.replace('6 passing (minimum 6)', '1 passing (minimum 1)'), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
})

test('test-events: a non-zero exit is a failure', () => {
  const p = judgeEventsTest({ code: 1, stdout: '[events-proof] FAILED: the core suite exited 1\n', stderr: '' })
  assert.ok(p.failed > 0 && !p.unparseable, JSON.stringify(p))
})

const FRESH_OK = '  ok tables exist\n  ok column present\n  ok check definition\n[fresh-init] all post-conditions hold\n'

test('fresh-init-proof: exit 0 plus its post-condition line passes, counting its ok checks', () => {
  const p = judgeFreshInit({ code: 0, stdout: FRESH_OK, stderr: '' })
  assert.equal(p.collected, 3)
  assert.equal(p.passed, 3)
  assert.equal(p.failed, 0)
})

test('fresh-init-proof: exit 0 without its post-condition line is untrusted', () => {
  assert.equal(judgeFreshInit({ code: 0, stdout: '  ok tables exist\n', stderr: '' }).unparseable, true)
})

test('fresh-init-proof: a non-zero exit is a failure even with ok lines printed', () => {
  const p = judgeFreshInit({ code: 1, stdout: '  ok a\nFAIL b: expected x\n[fresh-init] FAILED\n', stderr: '' })
  assert.ok(p.failed > 0, JSON.stringify(p))
})

// TASK-028 intake round 3 (verify-r1/r2 HIGH 2): gremion-ui's integration
// config has NO default for GREMION_PRODUCTION_STACK (D2) and refuses to load
// while it is unset. This suite is a whole-tree caller: it points DATABASE_URL
// at a throwaway container IT started on an ephemeral loopback port, so it
// declares `none` itself -- and must do so even over an ambient value, since
// the guard refuses loopback on a host that declares a production stack.
const DB = { password: 'fake-pw-0000', port: 54321 }

test('integrationVitestEnv declares GREMION_PRODUCTION_STACK=none for the harness-owned database', () => {
  const env = integrationVitestEnv({ baseEnv: {}, db: DB, uiDir: '/ui' })
  assert.equal(env.GREMION_PRODUCTION_STACK, 'none')
})

test('integrationVitestEnv overrides an ambient GREMION_PRODUCTION_STACK (the URL is the run-owned container)', () => {
  const env = integrationVitestEnv({ baseEnv: { GREMION_PRODUCTION_STACK: 'gremion' }, db: DB, uiDir: '/ui' })
  assert.equal(env.GREMION_PRODUCTION_STACK, 'none')
})

test('integrationVitestEnv points both URLs at the loopback test container and drops the raw password keys', () => {
  const env = integrationVitestEnv({ baseEnv: { POSTGRES_PASSWORD: 'x', PGPASSWORD: 'y', KEEP: 'k' }, db: DB, uiDir: '/ui' })
  assert.equal(env.DATABASE_URL, 'postgres://gremion_test:fake-pw-0000@127.0.0.1:54321/gremion')
  assert.equal(env.CONTROL_DATABASE_URL, 'postgres://gremion_test:fake-pw-0000@127.0.0.1:54321/control')
  assert.equal(env.POSTGRES_PASSWORD, undefined)
  assert.equal(env.PGPASSWORD, undefined)
  assert.equal(env.KEEP, 'k')
})

// CI run 3: `make test-nats-auth` ran its unit step as an unprivileged user, where one root-only case was
// SKIPPED, vitest printed "Tests  170 passed | 1 skipped (171)" and the judge, which only knows
// "Tests  N passed (N)", reported the whole part "unparseable". A summary that carries skipped or failed
// tests is not unparseable, it is a named failure: an integration part allows no skips, and exit 0 with a
// failed test is a lie to be called one. The summary line actually seen is in the detail either way.
const withUnitSummary = (ok, from, to) => ok.replace(from, to)

test('test-nats-auth: a unit step that SKIPPED a test is a named failure, not "unparseable"', () => {
  const stdout = withUnitSummary(NATS_AUTH_OK, 'Tests  69 passed (69)', 'Tests  68 passed | 1 skipped (69)')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.ok(p.failed >= 1, JSON.stringify(p))
  assert.match(p.detail, /unit run inside make test-nats-auth skipped 1 test\(s\); an integration part allows no skips/)
  assert.match(p.detail, /Tests {2}68 passed \| 1 skipped \(69\)/)
})

test('test-nats-auth: a unit step that reports a FAILED test yet exited 0 is a named failure', () => {
  const stdout = withUnitSummary(NATS_AUTH_OK, 'Tests  69 passed (69)', 'Tests  1 failed | 68 passed (69)')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.ok(p.failed >= 1, JSON.stringify(p))
  assert.match(p.detail, /unit run inside make test-nats-auth reported 1 failed test\(s\) although the target exited 0/)
  assert.match(p.detail, /Tests {2}1 failed \| 68 passed \(69\)/)
})

test('test-nats-auth: failed, skipped and todo tests are all named in one failure', () => {
  const stdout = withUnitSummary(NATS_AUTH_OK, 'Tests  69 passed (69)', 'Tests  1 failed | 65 passed | 2 skipped | 1 todo (69)')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.match(p.detail, /reported 1 failed test\(s\)/)
  assert.match(p.detail, /skipped 3 test\(s\)/)
  assert.equal(p.failed, 4)
})

test('test-nats-auth: a skipped test in the unit step is a failure even when the proof lines are missing', () => {
  const stdout = withUnitSummary(NATS_AUTH_OK, 'Tests  69 passed (69)', 'Tests  68 passed | 1 skipped (69)').replace(/^\[nats-auth-proof\] OK.*\n/m, '')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.match(p.detail ?? '', /skipped 1 test\(s\); an integration part allows no skips/)
})

test('test-nats-auth: an unrecognised summary shape stays untrusted, and the line seen is in the detail', () => {
  const stdout = withUnitSummary(NATS_AUTH_OK, 'Tests  69 passed (69)', 'Tests  67 passed | 2 wobbly (69)')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
  assert.match(p.detail, /unit summary seen: "Tests {2}67 passed \| 2 wobbly \(69\)"/)
})

test('test-nats-auth: a missing summary says so in the detail', () => {
  const p = judgeNatsAuthTest({ code: 0, stdout: NATS_AUTH_OK.replace(/^\s+Tests {2}69 passed \(69\)\n/m, ''), stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
  assert.match(p.detail, /unit summary seen: none/)
})

test('test-nats-auth: the proof\'s own echoed summary is not mistaken for the unit one', () => {
  const stdout = NATS_AUTH_OK.replace(/^\s+Tests {2}69 passed \(69\)\n/m, '').replace('Tests  25 passed (25)', 'Tests  24 passed | 1 skipped (25)')
  const p = judgeNatsAuthTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
  assert.match(p.detail, /unit summary seen: none/)
})

test('test-events: a unit step that SKIPPED a test is a named failure, not "unparseable"', () => {
  const stdout = withUnitSummary(EVENTS_OK, 'Tests  83 passed (83)', 'Tests  82 passed | 1 skipped (83)')
  const p = judgeEventsTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable ?? false, false, JSON.stringify(p))
  assert.ok(p.failed >= 1, JSON.stringify(p))
  assert.match(p.detail, /unit run inside make test-events skipped 1 test\(s\); an integration part allows no skips/)
  assert.match(p.detail, /Tests {2}82 passed \| 1 skipped \(83\)/)
})

test('test-events: a unit step that reports a FAILED test yet exited 0 is a named failure', () => {
  const stdout = withUnitSummary(EVENTS_OK, 'Tests  83 passed (83)', 'Tests  2 failed | 81 passed (83)')
  const p = judgeEventsTest({ code: 0, stdout, stderr: '' })
  assert.match(p.detail, /unit run inside make test-events reported 2 failed test\(s\) although the target exited 0/)
})

test('test-events: an unrecognised summary shape stays untrusted, with the line seen in the detail', () => {
  const stdout = withUnitSummary(EVENTS_OK, 'Tests  83 passed (83)', 'Tests  81 passed | 2 wobbly (83)')
  const p = judgeEventsTest({ code: 0, stdout, stderr: '' })
  assert.equal(p.unparseable, true, JSON.stringify(p))
  assert.match(p.detail, /unit summary seen: "Tests {2}81 passed \| 2 wobbly \(83\)"/)
})

test('test-events: a missing summary says so in the detail', () => {
  const p = judgeEventsTest({ code: 0, stdout: EVENTS_OK.replace(/^\s+Tests {2}83 passed \(83\)\n/m, ''), stderr: '' })
  assert.match(p.detail, /unit summary seen: none/)
})

// CI run 4: `CREATE DATABASE control` died with "connection to server on socket
// /var/run/postgresql/.s.PGSQL.5432 failed: server closed the connection unexpectedly". The official postgres
// image first runs a temporary initdb server with listen_addresses='' (unix socket ONLY) and then stops it;
// the readiness probe, a `docker exec psql` over the socket, can pass against it moments before it goes. Only
// the real server answers TCP, so the probe and every later psql go to 127.0.0.1 inside the container.
//
// A scripted docker: `phases` is the server's life as seen by successive readiness probes -- 'temp' (the
// temporary server: answers the socket, refuses TCP), 'gap' (nothing answers) and 'real' (answers both).
// The clock is virtual and advanced only by the fake sleep.
function fakeDocker(phases) {
  const calls = []
  let t = 0
  let probes = 0
  const exec = (cmd, args) => {
    calls.push(args)
    if (args[0] === 'run') return { code: 0, stdout: 'cid\n', stderr: '' }
    if (args[0] === 'port') return { code: 0, stdout: '127.0.0.1:49153\n', stderr: '' }
    const phase = phases[Math.min(probes++, phases.length - 1)]
    const overTcp = args.includes('-h')
    const answers = phase === 'real' || (phase === 'temp' && !overTcp)
    return answers ? { code: 0, stdout: ' 1\n', stderr: '' } : { code: 2, stdout: '', stderr: 'psql: error: connection failed' }
  }
  return { calls, exec, sleep: (ms) => (t += ms), now: () => t, probes: () => probes }
}

test('startTestDb is not ready while only the temporary initdb server (unix socket only) answers', () => {
  const d = fakeDocker(['temp', 'temp', 'temp', 'gap', 'gap', 'real', 'real'])
  const db = startTestDb({ sha8: 'abcd1234', pid: 1, exec: d.exec, sleep: d.sleep, now: d.now })
  assert.equal(db.ok, true, JSON.stringify(db))
  assert.equal(db.port, 49153)
  assert.ok(d.probes() >= 7, `declared ready after ${d.probes()} probes, before the real server answered`)
})

test('startTestDb needs consecutive successes: an answer followed by a failure restarts the count', () => {
  const d = fakeDocker(['real', 'gap', 'real', 'real'])
  const db = startTestDb({ sha8: 'abcd1234', pid: 1, exec: d.exec, sleep: d.sleep, now: d.now })
  assert.equal(db.ok, true, JSON.stringify(db))
  assert.equal(d.probes(), 4)
})

test('startTestDb gives up with a named failure when only the temporary server ever answers', () => {
  const d = fakeDocker(['temp'])
  const db = startTestDb({ sha8: 'abcd1234', pid: 1, exec: d.exec, sleep: d.sleep, now: d.now })
  assert.equal(db.ok, false)
  assert.match(db.detail, /never became ready within 60s/)
})

test('every psql argv runs over TCP to loopback, never the default unix socket', () => {
  const probe = psqlProbeArgs('c')
  const other = psqlExecArgs('c', 'postgres', ['-c', 'CREATE DATABASE control'])
  const stdin = psqlExecArgs('c', 'gremion', [], { interactive: true })
  for (const argv of [probe, other, stdin]) {
    const i = argv.indexOf('-h')
    assert.ok(i > argv.indexOf('psql'), `no -h after psql in ${argv.join(' ')}`)
    assert.equal(argv[i + 1], '127.0.0.1')
  }
  assert.ok(stdin.indexOf('-i') > 0 && stdin.indexOf('-i') < stdin.indexOf('c'), 'docker exec -i comes before the container name')
  assert.ok(!other.includes('-i'))
})

test('the suite builds psql argv in exactly one place (a hand-written socket psql cannot creep back in)', () => {
  const src = readFileSync(new URL('./suites/integration.mjs', import.meta.url), 'utf8')
  assert.equal(src.match(/'psql'/g)?.length, 2, "a third `'psql'` argv is outside psqlProbeArgs / psqlExecArgs")
})
