import test from 'node:test'
import assert from 'node:assert/strict'
import { run } from './run.mjs'

test('run captures stdout and a zero exit code for a real command', () => {
  const r = run('node -e "console.log(\'hello-ci-local\')"', process.cwd())
  assert.equal(r.exitCode, 0)
  assert.match(r.output, /hello-ci-local/)
  assert.equal(r.timedOut, false)
  assert.equal(r.spawnError, null)
})

test('run reports a non-zero exit code and combined stdout+stderr on a failing command', () => {
  const r = run('node -e "console.error(\'boom\'); process.exit(3)"', process.cwd())
  assert.equal(r.exitCode, 3)
  assert.match(r.output, /boom/)
})

test('run with an argv ARRAY spawns without a shell: shell metacharacters in an argument stay inert data (CRITICAL fix)', () => {
  const payload = '$(echo INJECTED)`echo INJECTED2`; echo INJECTED3 && echo INJECTED4'
  const r = run([process.execPath, '-e', 'console.log(JSON.stringify(process.argv[1]))', payload], process.cwd())
  assert.equal(r.exitCode, 0)
  assert.equal(JSON.parse(r.output.trim()), payload, 'the argument must arrive byte-for-byte, never shell-expanded')

  let seen
  run(['tool', 'a b', '$(x)'], process.cwd(), {
    spawnFn: (file, args, opts) => {
      seen = { file, args, shell: opts.shell }
      return { stdout: '', stderr: '', status: 0, signal: null, error: null }
    },
  })
  assert.deepEqual(seen, { file: 'tool', args: ['a b', '$(x)'], shell: false })
})

test('run is RED (exitCode 1, spawnError set) on a missing tool, via an injected spawnFn — never exitCode 0', () => {
  const fakeEnoent = () => ({
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn definitely-not-a-real-binary ENOENT'), { code: 'ENOENT' }),
  })
  const r = run('definitely-not-a-real-binary', process.cwd(), { spawnFn: fakeEnoent })
  assert.equal(r.exitCode, 1)
  assert.ok(r.spawnError)
  assert.match(r.output, /ENOENT/)
})

test('run is RED (exitCode 1, timedOut true) when the process is killed by SIGTERM (a real timeout), via an injected spawnFn', () => {
  const fakeTimeout = () => ({
    stdout: 'partial output before the wedge\n',
    stderr: '',
    status: null,
    signal: 'SIGTERM',
    error: null,
  })
  const r = run('sleep 999', process.cwd(), { spawnFn: fakeTimeout })
  assert.equal(r.exitCode, 1)
  assert.equal(r.timedOut, true)
  assert.match(r.output, /partial output/)
})

test('run enforces a real timeout end-to-end on a command that never exits (short timeoutMs, no injected spawnFn)', () => {
  const isWindows = process.platform === 'win32'
  const command = isWindows ? 'node -e "setInterval(()=>{}, 1000)"' : 'sleep 30'
  const started = Date.now()
  const r = run(command, process.cwd(), { timeoutMs: 500 })
  const elapsed = Date.now() - started
  assert.equal(r.exitCode, 1)
  assert.ok(elapsed < 15_000, `expected the timeout to cut this off quickly, took ${elapsed}ms`)
})

test('run never leaks NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID into the spawned command\'s environment, even when THIS process has them set', () => {
  // Simulates snapshot.mjs (or any suite command) being spawned from inside
  // a node --test child-process-isolated test file, which is exactly what
  // happens for real: suites.json's kernel-scripts-node-test suite runs
  // `node --test .../*.test.mjs`, which includes this very file. Without
  // stripping these two vars, a suite command that is itself `node --test
  // ...` silently stops printing its TAP summary (see run.mjs's comment) —
  // this test proves the leak never reaches the child, using a plain env
  // dump rather than a nested node --test (so it stays fast and does not
  // depend on the reporter-default bug it is guarding against).
  const savedContext = process.env.NODE_TEST_CONTEXT
  const savedWorkerId = process.env.NODE_TEST_WORKER_ID
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  process.env.NODE_TEST_WORKER_ID = '7'
  try {
    const r = run('node -e "console.log(JSON.stringify({ctx: process.env.NODE_TEST_CONTEXT ?? null, wid: process.env.NODE_TEST_WORKER_ID ?? null}))"', process.cwd())
    assert.equal(r.exitCode, 0)
    const seen = JSON.parse(r.output)
    assert.equal(seen.ctx, null, 'NODE_TEST_CONTEXT must not reach the spawned command')
    assert.equal(seen.wid, null, 'NODE_TEST_WORKER_ID must not reach the spawned command')
  } finally {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = savedContext
    if (savedWorkerId === undefined) delete process.env.NODE_TEST_WORKER_ID
    else process.env.NODE_TEST_WORKER_ID = savedWorkerId
  }
})
