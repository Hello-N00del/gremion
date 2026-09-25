#!/usr/bin/env node
// node --test suite for the RUNNING half of the Postgres-major pin (TASK-019).
//
// `docker` is injected: every case below hands checkRunning() a fake that
// answers `docker ps` and `docker exec ... psql` the way a real daemon would,
// so each failure mode is exercised without a daemon — and the same function
// runs unchanged against real containers from the CLI. Post-conditions on the
// returned problems, never an exit code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  expectedServices,
  listContainers,
  checkRunning,
  PS_FORMAT,
} from './check-postgres-major-running.mjs'
import { POSTGRES_MAJOR, MODULE_POSTGRES_IDS } from './check-postgres-major.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = 't019-test'

// A server_version_num for the pinned major and for an older one, BUILT from
// POSTGRES_MAJOR like the stale tags in check-postgres-major.test.mjs.
const GOOD_NUM = POSTGRES_MAJOR * 10000 + 6
const OLD_NUM = (POSTGRES_MAJOR - 2) * 10000 + 4
const versionText = (num) =>
  `PostgreSQL ${Math.floor(num / 10000)}.${num % 10000} on x86_64-pc-linux-musl, compiled by gcc`

/**
 * A fake docker. `containers`: [{id, state, service, label, num, uuid, empty,
 * fail}] — `num` is the server_version_num the server reports, `uuid` what
 * uuid_extract_version(uuidv7()) returns, `empty` makes psql print nothing,
 * `fail` makes the uuid probe exit non-zero (no uuidv7() before 18).
 */
function fakeDocker(containers, { psFails = false } = {}) {
  const calls = []
  const docker = (args) => {
    calls.push(args)
    if (args[0] === 'ps') {
      if (psFails) return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
      const rows = containers.map((c) =>
        [c.id, c.state ?? 'running', c.service ?? '', c.label, c.name ?? `${PROJECT}-${c.service}-1`].join('\t'))
      return { status: 0, stdout: rows.join('\n') + (rows.length ? '\n' : ''), stderr: '' }
    }
    if (args[0] === 'exec') {
      const c = containers.find((x) => x.id === args[1])
      const sql = args[args.length - 1]
      if (c.empty) return { status: 0, stdout: '\n', stderr: '' }
      if (/uuidv7/.test(sql)) {
        if (c.fail) return { status: 1, stdout: '', stderr: 'ERROR:  function uuidv7() does not exist' }
        return { status: 0, stdout: `${c.uuid ?? 7}\n`, stderr: '' }
      }
      const num = c.num ?? GOOD_NUM
      return { status: 0, stdout: `${num}|${versionText(num)}\n`, stderr: '' }
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`)
  }
  return { docker, calls }
}

const KERNEL = { service: 'postgres', label: 'kernel' }
const CAL = { service: 'calendar-postgres', label: 'module:calendar' }
const good = (over = {}) => [
  { id: 'aaa', ...KERNEL, ...over.kernel },
  { id: 'bbb', ...CAL, ...over.cal },
]

test('expectedServices reads the kernel and all six module servers off the committed compose', () => {
  const text = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
  const exp = expectedServices([text])
  assert.deepEqual(exp.map((e) => e.service).sort(),
    ['postgres', ...MODULE_POSTGRES_IDS.map((id) => `${id}-postgres`)].sort())
  assert.equal(exp.find((e) => e.service === 'postgres').label, 'kernel')
})

test('listContainers asks docker for the project AND the label, and parses its rows', () => {
  const { docker, calls } = fakeDocker(good())
  const rows = listContainers(PROJECT, docker)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1], { id: 'bbb', state: 'running', service: 'calendar-postgres',
    label: 'module:calendar', name: `${PROJECT}-calendar-postgres-1` })
  const ps = calls[0]
  assert.ok(ps.includes(`label=com.docker.compose.project=${PROJECT}`), ps.join(' '))
  assert.ok(ps.includes('label=org.gremion.postgres'), ps.join(' '))
  assert.ok(ps.includes('-a'), 'stopped containers must be listed too, or a crash-looping one vanishes')
  assert.ok(ps.includes(PS_FORMAT))
})

test('the green case: every expected server runs major 18 and mints version-7 UUIDs', () => {
  const { docker, calls } = fakeDocker(good())
  const { problems, rows } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.deepEqual(problems, [])
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.major === POSTGRES_MAJOR && r.uuidVersion === '7'), JSON.stringify(rows))
  assert.match(rows[0].version, new RegExp(`^PostgreSQL ${POSTGRES_MAJOR}\\.`))
  // the SQL travels as its own argv entry, never spliced into the shell string
  const exec = calls.find((c) => c[0] === 'exec')
  assert.equal(exec[1], 'aaa')
  assert.ok(!exec[4].includes('SELECT'), `SQL must not be interpolated into the sh -c program: ${exec[4]}`)
})

test('TDD-7: zero containers is a FAILURE, never a vacuous pass', () => {
  const { docker } = fakeDocker([])
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL], docker })
  assert.match(problems.join('\n'), /found zero Postgres containers labelled org\.gremion\.postgres in project t019-test/)
})

test('TDD-7: zero containers fails even when nothing is expected', () => {
  const { docker } = fakeDocker([])
  assert.match(checkRunning({ project: PROJECT, expected: [], docker }).problems.join('\n'), /found zero/)
})

test('TDD-7: a server reporting server_version_num 160004 is RED', () => {
  const { docker } = fakeDocker(good({ cal: { num: 160004 } }))
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.equal(problems.length >= 1, true)
  assert.match(problems.join('\n'), new RegExp(`calendar-postgres.*server_version_num 160004 is major 16, expected ${POSTGRES_MAJOR}`))
})

test('TDD-7: an older major built from the pin is RED too (not only the literal 16)', () => {
  const { docker } = fakeDocker(good({ kernel: { num: OLD_NUM } }))
  assert.match(checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker }).problems.join('\n'),
    new RegExp(`server_version_num ${OLD_NUM} is major ${POSTGRES_MAJOR - 2}`))
})

test('TDD-7: an expected service with no container is RED', () => {
  const { docker } = fakeDocker(good().slice(0, 1))
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /expected service calendar-postgres \(module:calendar\) has no container in project t019-test/)
})

test('TDD-7: an expected service whose container is not running is RED, and is not probed', () => {
  const { docker, calls } = fakeDocker(good({ cal: { state: 'restarting' } }))
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.match(problems.join('\n'), /calendar-postgres .* is restarting, not running/)
  assert.ok(!calls.some((c) => c[0] === 'exec' && c[1] === 'bbb'), 'a stopped container must not be exec\'d')
})

test('TDD-7: a labelled container outside the expected set is still probed and judged', () => {
  // the section-7 re-break: a hand-started PG16 carrying the module label
  const { docker } = fakeDocker([...good(), { id: 'ccc', service: '', label: 'module:probe', name: 't019-pg16-probe', num: 160004 }])
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.match(problems.join('\n'), /t019-pg16-probe \(module:probe\).*server_version_num 160004 is major 16/)
})

test('TDD-7: the uuidv7 probe returning 4 is RED', () => {
  const { docker } = fakeDocker(good({ cal: { uuid: 4 } }))
  assert.match(checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker }).problems.join('\n'),
    /calendar-postgres.*uuid_extract_version\(uuidv7\(\)\) returned '4', expected '7'/)
})

test('TDD-7: a failing uuid probe (no uuidv7() before 18) is RED, with the server\'s error', () => {
  const { docker } = fakeDocker(good({ cal: { fail: true } }))
  assert.match(checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker }).problems.join('\n'),
    /calendar-postgres.*uuid probe failed.*function uuidv7\(\) does not exist/)
})

test('TDD-7: empty psql output is RED, never read as a pass', () => {
  const { docker } = fakeDocker(good({ kernel: { empty: true } }))
  const { problems } = checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker })
  assert.match(problems.join('\n'), /t019-test-postgres-1 \(kernel\): version probe returned empty output/)
  assert.match(problems.join('\n'), /t019-test-postgres-1 \(kernel\): uuid probe returned empty output/)
})

test('a version() text that disagrees with server_version_num is RED', () => {
  const { docker: base } = fakeDocker(good())
  const docker = (args) => {
    const r = base(args)
    if (args[0] === 'exec' && !/uuidv7/.test(args[args.length - 1])) {
      return { ...r, stdout: `${GOOD_NUM}|PostgreSQL 16.4 on x86_64\n` }
    }
    return r
  }
  assert.match(checkRunning({ project: PROJECT, expected: [KERNEL, CAL], docker }).problems.join('\n'),
    /version\(\) reads 'PostgreSQL 16\.4/)
})

test('a docker ps that fails throws instead of looking like zero containers', () => {
  const { docker } = fakeDocker([], { psFails: true })
  assert.throws(() => checkRunning({ project: PROJECT, expected: [KERNEL], docker }), /docker ps failed.*Cannot connect/)
})
