// entrypoint.sh under the SYNAPSE_JWT_LOGIN switch. The script names absolute image paths
// (/data, /render-homeserver.sh, /inject-jwt-key.py, ...), so the test runs a copy with those
// paths pointed at a scratch directory of recording stubs: what is asserted is which steps the
// entrypoint TRIED, in order.
//   on / unset: fetch URL, key injection (retried until the realm serves a key set; the container
//               never boots without jwt_config), preflight, start.
//   off:        render, preflight, start -- no realm contact and no key injection (which would put
//               a jwt_config block back into the rendered file).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { requireTools, scratchDir } from './helpers.mjs'

const ENTRYPOINT = fileURLToPath(new URL('../entrypoint.sh', import.meta.url))

function stub(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** Runs the entrypoint copy; returns { status, stderr, calls } -- calls is the ordered log of stub invocations. */
function run(env = {}) {
  requireTools(['bash', 'sh'])
  const dir = scratchDir()
  const bin = join(dir, 'bin')
  const data = join(dir, 'data')
  mkdirSync(bin)
  mkdirSync(data)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const tpl = join(dir, 'homeserver.yaml.tpl')
  writeFileSync(tpl, 'server_name: x\n')
  const q = (p) => p.replaceAll('\\', '/')
  stub(join(dir, 'render.sh'), `if [ "$1" = "--fetch-url" ]; then echo "fetch-url" >> "${q(log)}"; echo http://idp.test/realm; exit 0; fi\necho "render $*" >> "${q(log)}"`)
  stub(join(dir, 'start.sh'), `echo "start $*" >> "${q(log)}"`)
  // python3 stands in for inject-jwt-key.py and db-preflight.py: the script name says which
  // inject-jwt-key.py: the first FAKE_INJECT_FAILS calls end with FAKE_INJECT_RC (3 = the realm has no key set yet)
  const cnt = q(join(dir, 'inject.count'))
  stub(
    join(bin, 'python3'),
    [
      'name="$(basename "$1")"',
      `echo "python3 $name" >> "${q(log)}"`,
      'if [ "$name" = inject-jwt-key.py ]; then',
      `  n=0; [ -f "${cnt}" ] && n="$(cat "${cnt}")"`,
      `  n=$((n + 1)); echo "$n" > "${cnt}"`,
      '  if [ "$n" -le "${FAKE_INJECT_FAILS:-0}" ]; then exit "${FAKE_INJECT_RC:-3}"; fi',
      'fi',
    ].join('\n'),
  )
  stub(join(bin, 'curl'), `echo "curl" >> "${q(log)}"\nexit 1`)
  const src = readFileSync(ENTRYPOINT, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll('/config/homeserver.yaml.tpl', q(tpl))
    .replaceAll('/render-homeserver.sh', q(join(dir, 'render.sh')))
    .replaceAll('/start.py', q(join(dir, 'start.sh')))
    .replaceAll('/data', q(data))
  const script = join(dir, 'entrypoint.sh')
  writeFileSync(script, src)
  const r = spawnSync('bash', [script], {
    env: { PATH: `${q(bin)}:${process.env.PATH}`, SYNAPSE_KC_MAX: '1', ...env },
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) }
}

const STEPS_ON = ['render true', 'fetch-url', 'python3 inject-jwt-key.py', 'python3 db-preflight.py', 'start']

test('switch unset: the realm key is fetched and injected between the render and the preflight', () => {
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, STEPS_ON)
})

test('switch on: the same steps as unset', () => {
  const r = run({ SYNAPSE_JWT_LOGIN: 'on' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, STEPS_ON)
})

test('switch off: render, preflight and start only -- no fetch URL, no realm contact, no key injection', () => {
  const r = run({ SYNAPSE_JWT_LOGIN: 'off' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, ['render true', 'python3 db-preflight.py', 'start'])
  assert.match(r.stdout, /SYNAPSE_JWT_LOGIN=off/)
})

test('a switch value other than on or off ends the container before any step ran', () => {
  const r = run({ SYNAPSE_JWT_LOGIN: 'maybe' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /SYNAPSE_JWT_LOGIN/)
  assert.deepEqual(r.calls, [])
})

const INJECT = 'python3 inject-jwt-key.py'
const FAST = { SYNAPSE_KC_WAIT_S: '20', SYNAPSE_KC_INTERVAL: '0' }

test('switch on: the key injection is retried until the realm serves a key set, then the boot goes on', () => {
  const r = run({ ...FAST, FAKE_INJECT_FAILS: '2' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, ['render true', 'fetch-url', INJECT, INJECT, INJECT, 'python3 db-preflight.py', 'start'])
  assert.equal(r.stdout.split('\n').filter((l) => /realm key not available yet/.test(l)).length, 2, 'one log line per failed attempt')
})

test('switch on: a realm that never serves a key set ends the container non-zero, and neither the preflight nor Synapse starts', () => {
  const r = run({ SYNAPSE_KC_WAIT_S: '2', SYNAPSE_KC_INTERVAL: '1', FAKE_INJECT_FAILS: '9999' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /realm key/)
  assert.ok(r.calls.filter((c) => c === INJECT).length >= 2, 'it retried within the budget')
  assert.equal(r.calls.includes('python3 db-preflight.py'), false)
  assert.equal(r.calls.includes('start'), false)
})

test('switch on: a failure of the injection that is not "no key yet" ends the container at once, without a retry', () => {
  const r = run({ ...FAST, FAKE_INJECT_FAILS: '9999', FAKE_INJECT_RC: '1' })
  assert.notEqual(r.status, 0)
  assert.deepEqual(r.calls, ['render true', 'fetch-url', INJECT])
})

test('switch off: no key fetch is attempted even with a retry budget set', () => {
  const r = run({ ...FAST, SYNAPSE_JWT_LOGIN: 'off', FAKE_INJECT_FAILS: '9999' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, ['render true', 'python3 db-preflight.py', 'start'])
})

test('a retry budget or interval that is not a number of seconds is refused before any step ran', () => {
  for (const bad of [{ SYNAPSE_KC_WAIT_S: 'soon' }, { SYNAPSE_KC_INTERVAL: '1.5x' }, { SYNAPSE_KC_WAIT_S: '0' }]) {
    const r = run(bad)
    assert.notEqual(r.status, 0, JSON.stringify(bad))
    assert.deepEqual(r.calls, [], JSON.stringify(bad))
  }
})
