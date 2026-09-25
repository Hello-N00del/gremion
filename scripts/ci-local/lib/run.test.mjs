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
