// TASK-036 TDD items 3 and 6 (image arm, builder argv). Docker is a
// recording fake: every call is captured with its argv.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { buildArgv, buildImages, censusTag, inspectHealthchecks, planImages } from './inspect.mjs'

function recorder(handler) {
  const calls = []
  const docker = (cmd, args, opts) => {
    calls.push(args)
    return { stdout: '', stderr: '', error: null, durationMs: 5, ...handler(args, opts) }
  }
  return { calls, docker }
}

const render = (services) => [{ project: 'state', render: { ok: true, services } }]

test('first-party services are built at the tested SHA, never inspected as their :latest image name', () => {
  const { entries, errors } = planImages(
    render({
      vector: { image: 'ghcr.io/example/gremion-vector:latest', build: { context: '/r/docker/vector', dockerfile: 'Dockerfile' } },
      traefik: { image: 'traefik:v3.7.1' },
    }),
    { sha8: 'abcdef12' },
  )
  assert.deepEqual(errors, [])
  const vector = entries.find((e) => e.service === 'vector')
  assert.equal(vector.kind, 'build')
  assert.equal(vector.ref, 'census-abcdef12/vector')
  assert.ok(!entries.some((e) => e.ref.endsWith(':latest')), 'a :latest reference was planned for inspection')
  assert.equal(entries.find((e) => e.service === 'traefik').ref, 'traefik:v3.7.1')
})

test('the builder argv carries the render build.args plus BUILD_SHA, with -f resolved against the context', () => {
  const entry = { ref: censusTag('abcdef12', 'gremion-public'), build: { context: '/r', dockerfile: 'gremion-public/Dockerfile', args: { BASE_PATH: '' } } }
  const argv = buildArgv(entry, { buildSha: 'abcdef1' })
  assert.equal(argv[0], 'build')
  assert.equal(argv[argv.indexOf('-t') + 1], 'census-abcdef12/gremion-public')
  assert.equal(argv[argv.indexOf('-f') + 1], path.resolve('/r', 'gremion-public/Dockerfile'))
  const buildArgs = argv.flatMap((a, i) => (a === '--build-arg' ? [argv[i + 1]] : []))
  assert.deepEqual(buildArgs, ['BASE_PATH=', 'BUILD_SHA=abcdef1'])
  assert.equal(argv.at(-1), '/r')
  // A render-supplied BUILD_SHA never overrides the tested one.
  const pinned = buildArgv({ ref: 'x', build: { context: '/r', args: { BUILD_SHA: 'stale00' } } }, { buildSha: 'abcdef1' })
  assert.ok(pinned.includes('BUILD_SHA=abcdef1'))
  assert.ok(!pinned.includes('BUILD_SHA=stale00'))
})

test('a build block the census cannot reproduce, or a service with neither build nor image, is an error', () => {
  const { errors } = planImages(
    render({
      s: { build: { context: '/r', secrets: ['x'] } },
      n: { environment: {} },
    }),
    { sha8: 'abcdef12' },
  )
  assert.equal(errors.length, 2)
  assert.match(errors.map((e) => e.detail).join('\n'), /uses secrets/)
  assert.match(errors.map((e) => e.detail).join('\n'), /neither build: nor image:/)
})

test('a failed build is reported with its reason and timing', () => {
  const { docker } = recorder(() => ({ code: 1, stderr: 'failed to solve: boom' }))
  const logs = []
  const res = buildImages([{ kind: 'build', service: 'vector', ref: 'census-x/vector', build: { context: '/r' } }], { docker, buildSha: 'abcdef1', log: (l) => logs.push(l) })
  assert.equal(res.get('census-x/vector').ok, false)
  assert.match(res.get('census-x/vector').detail, /failed to solve: boom/)
  assert.match(logs[0], /build vector -> census-x\/vector: FAILED in /)
})

test('batched inspect maps one line per ref, in order', () => {
  const { calls, docker } = recorder(() => ({ code: 0, stdout: 'null\n{"Test":["CMD","true"]}\n' }))
  const res = inspectHealthchecks(['a', 'b'], { docker })
  assert.equal(calls.length, 1)
  assert.deepEqual(res.get('a'), { ok: true, healthcheck: null })
  assert.deepEqual(res.get('b').healthcheck, { Test: ['CMD', 'true'] })
})

test('inspect exit != 0 is a failed result, never a null healthcheck', () => {
  const { docker } = recorder((args) => (args[0] === 'pull' ? { code: 1, stderr: 'denied' } : { code: 1, stderr: 'Error: No such image' }))
  const res = inspectHealthchecks(['gone:1'], { docker })
  assert.equal(res.get('gone:1').ok, false)
  assert.equal(res.get('gone:1').healthcheck, undefined)
  assert.match(res.get('gone:1').detail, /No such image.*docker pull exited 1: denied/)
})

test('an absent third-party image is pulled once, then inspected; a census tag is never pulled', () => {
  let pulled = false
  const { calls, docker } = recorder((args) => {
    if (args[0] === 'pull') {
      pulled = true
      return { code: 0 }
    }
    if (args.length > 5) return { code: 1, stderr: 'No such image' } // the batch
    return pulled || args.at(-1) === 'census-x/v' ? { code: 0, stdout: 'null\n' } : { code: 1, stderr: 'No such image' }
  })
  const res = inspectHealthchecks(['third:1', 'census-x/v'], { docker, pullable: (r) => !r.startsWith('census-') })
  assert.equal(res.get('third:1').ok, true)
  assert.deepEqual(calls.filter((c) => c[0] === 'pull'), [['pull', '-q', 'third:1']])
})

test('inspect output that is not one JSON Healthcheck per ref is a failure', () => {
  const garbage = recorder(() => ({ code: 0, stdout: 'not json\n' }))
  assert.equal(inspectHealthchecks(['a'], { docker: garbage.docker }).get('a').ok, false)
  const array = recorder(() => ({ code: 0, stdout: '[1]\n' }))
  assert.equal(inspectHealthchecks(['a'], { docker: array.docker }).get('a').ok, false)
})
