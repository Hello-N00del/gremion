// Self-test for nats-test-nruns.sh: the N-run recorder is itself a gate, so its
// own RED cases are proven without Docker. NATS_NRUN_TARGET points it at a
// stand-in that fails on chosen runs and prints the lines the real target
// prints, so what is checked is the recorder's bookkeeping -- the exit status,
// the per-run rows, the distribution -- not NATS.
//
//   node --test packages/ports/scripts/nats-test-nruns.test.mjs   (make lint-nats-nruns)

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'nats-test-nruns.sh')

// The stand-in: counts its own invocations in $FAKE_DIR/count, and fails (with a
// vitest-style FAIL line, then exit 1) on the invocations listed in $FAKE_FAIL.
const FAKE_TARGET = `#!/usr/bin/env bash
set -eu
n=0
[ -f "$FAKE_DIR/count" ] && n="$(cat "$FAKE_DIR/count")"
n=$((n + 1))
echo "$n" >"$FAKE_DIR/count"
for f in \${FAKE_FAIL:-}; do
  if [ "$f" = "$n" ]; then
    echo " FAIL  src/nats-broker.integration.test.ts > NatsBroker > the flaky proof"
    echo "[nats-test] FAILED: ports suite exited 1" >&2
    exit 1
  fi
done
echo "[nats-test] 20 passing tests from src/nats-broker.integration.test.ts (minimum 20)"
echo "[nats-test] OK -- the JetStream proofs ran against a real server"
`

let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'nats-nruns-test-'))
  writeFileSync(join(root, 'fake-target.sh'), FAKE_TARGET, { mode: 0o755 })
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

let caseNo = 0
/** Run the recorder against the stand-in; every case gets its own out dir and counter. */
function record(args, env = {}) {
  const dir = join(root, `case-${++caseNo}`)
  mkdirSync(join(dir, 'state'), { recursive: true })
  const out = join(dir, 'out')
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NATS_NRUN_TARGET: join(root, 'fake-target.sh'),
      NATS_NRUN_OUT: out,
      FAKE_DIR: join(dir, 'state'),
      ...env,
    },
  })
  const read = (f) => {
    try {
      return readFileSync(join(out, f), 'utf8')
    } catch {
      return undefined
    }
  }
  const rows = (read('runs.tsv') ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(1)
    .map((l) => l.split('\t'))
  return { ...res, out, rows, summary: read('summary.txt'), files: () => readdirSync(out) }
}

describe('nats-test-nruns.sh', () => {
  it('records every run of an all-green series and exits 0', () => {
    const r = record(['3'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.rows.length, 3)
    for (const [i, row] of r.rows.entries()) {
      assert.equal(row[0], String(i + 1))
      assert.equal(row[1], '0', 'exit status of a passing run')
      assert.equal(row[3], '20', 'the integration proof count is parsed from the run log')
      assert.equal(row[4], '-', 'a passing run lists no failing test')
    }
    assert.deepEqual(r.files().filter((f) => f.startsWith('run-')).sort(), ['run-01.log', 'run-02.log', 'run-03.log'])
    assert.match(r.summary, /runs\s+3 of 3 requested/)
    assert.match(r.summary, /passed\s+3\n/)
    assert.match(r.summary, /failed\s+0\n/)
    assert.match(r.summary, /pass rate\s+100%/)
    assert.match(r.summary, /seconds\/run\s+min \d+, median \d+, max \d+/)
    assert.match(r.stdout, /OK -- all 3 run\(s\) passed/)
  })

  it('a failing run does not stop the series, is named in the distribution, and fails the script', () => {
    const r = record(['4'], { FAKE_FAIL: '2' })
    assert.equal(r.status, 1)
    assert.equal(r.rows.length, 4, 'the series ran to its end: the point is the distribution')
    assert.deepEqual(r.rows.map((row) => row[1]), ['0', '1', '0', '0'])
    assert.equal(r.rows[1][4], 'src/nats-broker.integration.test.ts > NatsBroker > the flaky proof')
    assert.match(r.summary, /passed\s+3\n/)
    assert.match(r.summary, /failed\s+1\n/)
    assert.match(r.summary, /pass rate\s+75%/)
    assert.match(r.summary, /failing tests[^\n]*\n\s+1x src\/nats-broker\.integration\.test\.ts > NatsBroker > the flaky proof/)
    assert.match(r.stderr, /run 2\/4: FAIL exit 1/)
    assert.match(r.stderr, /FAILED: 3 of 4 run\(s\) passed/)
    assert.ok(readFileSync(join(r.out, 'run-02.log'), 'utf8').includes('the flaky proof'), 'the failing run keeps its full log')
  })

  it('counts a test once per run that failed it', () => {
    const r = record(['5'], { FAKE_FAIL: '1 3 4' })
    assert.equal(r.status, 1)
    assert.match(r.summary, /3x src\/nats-broker\.integration\.test\.ts > NatsBroker > the flaky proof/)
    assert.match(r.summary, /pass rate\s+40%/)
  })

  it('NATS_NRUN_STOP_ON_FAIL=1 stops at the first failure, and a short series still fails', () => {
    const r = record(['4'], { FAKE_FAIL: '2', NATS_NRUN_STOP_ON_FAIL: '1' })
    assert.equal(r.status, 1)
    assert.equal(r.rows.length, 2)
    assert.match(r.summary, /runs\s+2 of 4 requested/)
  })

  it('NATS_NRUN_COUNT sets the default, the positional argument wins', () => {
    assert.equal(record([], { NATS_NRUN_COUNT: '2' }).rows.length, 2)
    assert.equal(record(['1'], { NATS_NRUN_COUNT: '2' }).rows.length, 1)
  })

  // node:test has no it.each: the invalid counts are looped.
  for (const bad of ['0', '-1', 'x', '1.5', '007', '']) {
    it(`refuses the run count ${JSON.stringify(bad)} (exit 2) without running anything`, () => {
      const r = record([bad])
      assert.equal(r.status, 2)
      assert.equal(r.rows.length, 0)
      assert.match(r.stderr, /run count must be a positive whole number/)
    })
  }

  it('refuses a missing target (exit 2)', () => {
    const r = record(['1'], { NATS_NRUN_TARGET: join(root, 'does-not-exist.sh') })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no script to repeat/)
  })
})
