// TASK-036 TDD item 7: running.mjs judges RUNNING containers. Docker and the
// clock are injected; the scratch-stack proof against real containers is in
// the commit that added running.mjs (brief S9).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRunning, judgeContainers, parseArgs } from './running.mjs'

const c = (service, status, health, exitCode = 0) => ({ name: `p-${service}-1`, project: 'p', service, status, exitCode, health })

function fakeDocker(frames) {
  // frames: array of container lists, one per poll; the last one repeats.
  let poll = 0
  return (_cmd, args) => {
    const frame = frames[Math.min(poll, frames.length - 1)]
    if (args[0] === 'ps') {
      const project = args[args.indexOf('--filter') + 1].split('=').at(-1)
      return { code: 0, stdout: frame.filter((x) => x.project === project).map((x) => x.name).join('\n'), stderr: '' }
    }
    if (args[0] === 'inspect') {
      poll++
      const names = args.slice(1)
      const docs = frame
        .filter((x) => names.includes(x.name))
        .map((x) => ({
          Name: `/${x.name}`,
          Config: { Labels: { 'com.docker.compose.project': x.project, 'com.docker.compose.service': x.service } },
          State: { Status: x.status, ExitCode: x.exitCode, ...(x.health ? { Health: { Status: x.health } } : {}) },
        }))
      return { code: 0, stdout: JSON.stringify(docs), stderr: '' }
    }
    throw new Error(`unexpected docker call ${args.join(' ')}`)
  }
}

function clock() {
  let t = 0
  return { now: () => t, sleep: (ms) => { t += ms } }
}

const run = (frames, extra = {}) => checkRunning({ projects: ['p'], exempt: [], docker: fakeDocker(frames), timeoutMs: 60_000, intervalMs: 5_000, ...clock(), ...extra })

test('all healthy -> pass', () => {
  const r = run([[c('a', 'running', 'healthy'), c('b', 'running', 'healthy')]])
  assert.equal(r.pass, true, r.lines.join('\n'))
  assert.deepEqual(r.lines, ['healthy a [p]', 'healthy b [p]'])
})

test('0 containers in a project -> FAIL', () => {
  const r = run([[]])
  assert.equal(r.pass, false)
  assert.match(r.failures.join('\n'), /project p: 0 containers/)
})

test('.State.Health absent -> FAIL at once, without waiting out the deadline', () => {
  let slept = 0
  const r = run([[c('a', 'running', 'healthy'), c('bare', 'running', null)]], { sleep: (ms) => { slept += ms } })
  assert.equal(r.pass, false)
  assert.match(r.failures.join('\n'), /bare \[p\]: no healthcheck \(\.State\.Health absent\)/)
  assert.equal(slept, 0)
})

test('unhealthy, or starting past the deadline -> FAIL naming the status', () => {
  const unhealthy = run([[c('a', 'running', 'unhealthy')]])
  assert.equal(unhealthy.pass, false)
  assert.match(unhealthy.failures.join('\n'), /a \[p\]: health unhealthy after 60s/)
  const starting = run([[c('a', 'running', 'starting')]])
  assert.match(starting.failures.join('\n'), /a \[p\]: health starting after 60s/)
})

test('the wait is bounded: polls stop at the deadline', () => {
  let polls = 0
  const docker = fakeDocker([[c('a', 'running', 'starting')]])
  const counting = (cmd, args) => {
    if (args[0] === 'inspect') polls++
    return docker(cmd, args)
  }
  const r = checkRunning({ projects: ['p'], exempt: [], docker: counting, timeoutMs: 20_000, intervalMs: 5_000, ...clock() })
  assert.equal(r.pass, false)
  assert.ok(polls <= 6, `polled ${polls} times for a 20s deadline at 5s intervals`)
})

test('starting then healthy within the deadline -> pass', () => {
  const r = run([[c('a', 'running', 'starting')], [c('a', 'running', 'healthy')]])
  assert.equal(r.pass, true, r.failures.join('\n'))
})

test('an exempt one-shot must have exited 0; exited 1 fails, still running waits', () => {
  const ok = run([[c('a', 'running', 'healthy'), c('job', 'exited', null, 0)]], { exempt: ['job'] })
  assert.equal(ok.pass, true, ok.failures.join('\n'))
  assert.ok(ok.lines.includes('exempt job exited 0 [p]'))
  const bad = run([[c('a', 'running', 'healthy'), c('job', 'exited', null, 1)]], { exempt: ['job'] })
  assert.match(bad.failures.join('\n'), /job \[p\]: exempt one-shot exited 1/)
  const stuck = run([[c('a', 'running', 'healthy'), c('job', 'running', null)]], { exempt: ['job'] })
  assert.match(stuck.failures.join('\n'), /job \[p\]: exempt one-shot still running after 60s/)
  // exact names: job does not exempt job-x
  const sub = run([[c('job-x', 'running', null)]], { exempt: ['job'] })
  assert.match(sub.failures.join('\n'), /job-x \[p\]: no healthcheck/)
})

test('a docker failure is a FAIL, never an empty pass', () => {
  const r = checkRunning({ projects: ['p'], exempt: [], docker: () => ({ code: 1, stdout: '', stderr: 'daemon down' }), timeoutMs: 1000, intervalMs: 500, ...clock() })
  assert.equal(r.pass, false)
  assert.match(r.failures.join('\n'), /daemon down/)
})

test('judgeContainers: a non-exempt container that is not running fails', () => {
  const j = judgeContainers([c('a', 'exited', 'healthy', 0)], new Set())
  assert.match(j.failures.join('\n'), /a \[p\]: not running \(exited\)/)
})

test('parseArgs: --project is required and repeatable; unknown flags are errors', () => {
  assert.deepEqual(parseArgs(['--project', 'a', '--project', 'b', '--exempt', 'x y', '--timeout', '30']).projects, ['a', 'b'])
  assert.deepEqual(parseArgs(['--project', 'a', '--exempt', 'x y']).exempt, ['x', 'y'])
  assert.throws(() => parseArgs([]), /--project/)
  assert.throws(() => parseArgs(['--project', 'a', '--skip']), /unknown argument/)
})
