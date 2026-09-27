// TASK-036 TDD item 8: runCensusSuite maps onto TASK-045's suite shape and is
// synchronous. Docker is a fake answering compose config / build / inspect.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { evaluateSuite } from '../lib/guard.mjs'
import { runCensusSuite } from './suite.mjs'

const ROOT = path.join(import.meta.dirname, '__fixtures__', 'suite-root')
const PROJECTS = [{ name: 'state', template: 'state.env.tmpl', dir: '.', exemptKey: 'HEALTH_EXEMPT_SERVICES' }]
const SHA = 'abcdef1234567890abcdef1234567890abcdef12'

function fakeDocker({ services, inspect = () => ({ code: 0, stdout: 'null\n' }), build = () => ({ code: 0 }) }) {
  const calls = []
  const docker = (_cmd, args) => {
    calls.push(args)
    const base = { stdout: '', stderr: '', error: null, durationMs: 1 }
    if (args[0] === 'compose') return { ...base, code: 0, stdout: JSON.stringify({ services }) }
    if (args[0] === 'build') return { ...base, ...build(args) }
    if (args[0] === 'image' && args[1] === 'inspect') return { ...base, ...inspect(args.slice(4)) }
    if (args[0] === 'image' && args[1] === 'rm') return { ...base, code: 0 }
    if (args[0] === 'pull') return { ...base, code: 1, stderr: 'no network in tests' }
    throw new Error(`unexpected docker call: ${args.join(' ')}`)
  }
  return { calls, docker }
}

const opts = (docker, extra = {}) => ({ root: ROOT, projects: PROJECTS, docker, toolAvailableFn: () => true, stubEnv: () => {}, sha: SHA, log: () => {}, ...extra })

test('collected = rendered services; probed services pass; the verdict is PASS', () => {
  const { docker } = fakeDocker({ services: { a: { image: 'a', healthcheck: { test: ['CMD', 'true'] } }, b: { image: 'b' } }, inspect: (refs) => ({ code: 0, stdout: refs.map((r) => (r === 'b' ? '{"Test":["CMD","true"]}' : 'null')).join('\n') }) })
  const r = runCensusSuite(opts(docker))
  assert.equal(r.collected, 2)
  assert.equal(r.passed, 2)
  assert.equal(r.failed, 0)
  assert.equal(r.skipped, 0)
  assert.match(r.detail, /probed a \(compose\) \[state\]\nprobed b \(image\) \[state\]/)
  assert.equal(evaluateSuite(r).status, 'pass')
})

test('an unprobed service fails the suite by name', () => {
  const { docker } = fakeDocker({ services: { a: { image: 'a' } } })
  const r = runCensusSuite(opts(docker))
  assert.equal(r.failed, 1)
  assert.match(r.detail, /UNPROBED a \[state\]/)
  assert.equal(evaluateSuite(r).status, 'fail')
})

test('missing docker is toolMissing, never a skip', () => {
  const r = runCensusSuite(opts(() => assert.fail('docker must not be called'), { toolAvailableFn: () => false }))
  assert.equal(r.toolMissing, 'docker')
  assert.equal(evaluateSuite(r).reason, 'missing tool: docker')
})

test('0 collected fails TASK-045\'s guard even if the census itself said nothing', () => {
  const r = { toolMissing: null, unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0 }
  assert.equal(evaluateSuite(r).reason, 'collected 0 tests')
  const { docker } = fakeDocker({ services: {} })
  const empty = runCensusSuite(opts(docker))
  assert.equal(empty.collected, 0)
  assert.equal(evaluateSuite(empty).status, 'fail')
  assert.match(empty.detail, /state rendered 0 services/)
})

test('a first-party build failure is unparseable naming the image; the build carries BUILD_SHA', () => {
  const { calls, docker } = fakeDocker({ services: { v: { image: 'ghcr.io/x/v:latest', build: { context: ROOT } } }, build: () => ({ code: 1, stderr: 'failed to solve' }) })
  const r = runCensusSuite(opts(docker))
  assert.equal(r.unparseable, true)
  assert.match(r.detail, /image of v \[state\] could not be inspected: docker build exited 1: failed to solve/)
  const build = calls.find((c) => c[0] === 'build')
  assert.ok(build.includes('BUILD_SHA=abcdef1'), build.join(' '))
  assert.ok(!calls.some((c) => c.includes('ghcr.io/x/v:latest')), 'the :latest image name was used')
})

test('an inspect failure is unparseable even with a compose healthcheck; built tags are removed', () => {
  const { calls, docker } = fakeDocker({ services: { v: { image: 'x', build: { context: ROOT }, healthcheck: { test: ['CMD', 'true'] } } }, inspect: () => ({ code: 1, stderr: 'No such image' }) })
  const r = runCensusSuite(opts(docker))
  assert.equal(r.unparseable, true)
  assert.ok(calls.some((c) => c[0] === 'image' && c[1] === 'rm' && c.includes('census-abcdef12/v')))
})

test('runCensusSuite is synchronous: it returns the result, never a Promise', () => {
  assert.notEqual(runCensusSuite.constructor.name, 'AsyncFunction')
  const { docker } = fakeDocker({ services: { a: { image: 'a', healthcheck: { test: ['CMD', 'true'] } } } })
  const r = runCensusSuite(opts(docker))
  assert.equal(typeof r?.then, 'undefined', 'a thenable reaches runAll() as `collected 0`')
  assert.equal(r.collected, 1)
})

test('a failed census tag cleanup is named in the suite detail', () => {
  const { docker: base } = fakeDocker({ services: { v: { image: 'x', build: { context: ROOT }, healthcheck: { test: ['CMD', 'true'] } } }, inspect: () => ({ code: 0, stdout: 'null\n' }) })
  const docker = (cmd, args, o) => (args[0] === 'image' && args[1] === 'rm' ? { stdout: '', stderr: 'conflict: unable to remove', error: null, durationMs: 1, code: 1 } : base(cmd, args, o))
  const r = runCensusSuite(opts(docker))
  assert.match(r.detail, /census-abcdef12\/v/)
  assert.match(r.detail, /image rm exited 1.*unable to remove/s)
})
