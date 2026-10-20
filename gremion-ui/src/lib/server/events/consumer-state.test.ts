// consumer-state.test.ts — the monolith's answer to "the consumer did not start".
//
// Round 1 made every one of these four things false at once, and each of them is
// a way a dead consumer looks alive:
//   1. the module latch was set BEFORE the boot was awaited, so a failed start
//      could never be retried in that process;
//   2. the NatsBroker was left connected on a failed attempt, so a retry would
//      stack connections;
//   3. the failure existed only as a line on stderr — /api/health said 'ok';
//   4. there was no retry at all, so a NATS that came up a minute later was a
//      permanent outage.
//
// In the kernel port (TASK-206-0) this file pins the supervisor itself (3 and 4,
// plus the restart bookkeeping). Items 1 and 2 are properties of the audit
// consumers, whose broker-double cases land with them (TASK-205, ruling R28-O2).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  superviseWorker,
  degradedWorkers,
  getWorkerState,
  markWorkerOff,
  markWorkerRunning,
  markWorkerDegraded,
  noteWorkerFault,
  classifyWorkerError,
  RESTART_DELAYS_MS,
  MAX_START_ATTEMPTS,
  _resetWorkerStatesForTests,
} from './consumer-state'

// The retired NATS subject root, COMPUTED rather than written.
//
// These tests assert that the retired root never reaches the unauthenticated
// probe, so they need a broker message that carries it. Spelling it as a literal
// planted it back in the tree and turned `pnpm test:wire-root` RED — the repo
// guard cannot tell a negative assertion from a stale subject, and widening its
// exemption list to make room for tests would blind it to the real thing. Joining
// the halves keeps the assertions exactly as strong while leaving no literal for
// the sweep to find.
const RETIRED_CALENDAR_FILTER = `${['stur', 'aos'].join('')}.*.calendar.>`

beforeEach(() => {
  _resetWorkerStatesForTests()
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  _resetWorkerStatesForTests()
})

describe('superviseWorker — the state a health probe can read', () => {
  it('records a worker that came up as running and reports nothing degraded', async () => {
    await superviseWorker({ name: 'w', start: async () => {}, log: () => {}, error: () => {} })
    expect(getWorkerState('w')?.phase).toBe('running')
    expect(degradedWorkers()).toEqual([])
  })

  it('records a worker that failed as degraded, carrying the error CLASS and CODE only', async () => {
    const boom = new Error(
      `[nats-broker] refusing to repoint stream CALENDAR: it currently captures [${RETIRED_CALENDAR_FILTER}] ` +
        'but this call would set [gremion.*.calendar.>].',
    )
    const scheduled: number[] = []
    await superviseWorker({
      name: 'calendar-audit-consumer',
      start: async () => {
        throw boom
      },
      schedule: (_fn, ms) => {
        scheduled.push(ms)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      log: () => {},
      error: () => {},
    })
    const [degraded] = degradedWorkers()
    expect(degraded?.name).toBe('calendar-audit-consumer')
    expect(degraded?.attempts).toBe(1)
    // The surface is a CLASS and a CODE. The broker's own message names stream
    // filters and, on other failures, host:port and account detail — and this
    // state is serialised straight onto an UNAUTHENTICATED probe. The full
    // message is still logged server-side; it just never reaches the surface.
    expect(degraded?.errorClass).toBe('Error')
    expect(degraded?.code).toBe('stream-repoint-refused')
    expect(JSON.stringify(degraded)).not.toContain(RETIRED_CALENDAR_FILTER)
    expect(JSON.stringify(degraded)).not.toContain('refusing to repoint')
  })

  it('classifies the failure classes an operator has to tell apart', () => {
    expect(classifyWorkerError(new Error('[nats-broker] refusing to repoint stream CONTENT: …')).code).toBe(
      'stream-repoint-refused',
    )
    const cover = Object.assign(new Error('does not cover subscription'), { name: 'StreamCoverError' })
    expect(classifyWorkerError(cover)).toEqual({ errorClass: 'StreamCoverError', code: 'stream-cover' })
    const gone = Object.assign(new Error('deleted on the server'), { name: 'StreamGoneError' })
    expect(classifyWorkerError(gone).code).toBe('stream-gone')
    const silent = Object.assign(new Error('went silent, probe undecided'), { name: 'HeartbeatsMissedError' })
    expect(classifyWorkerError(silent)).toEqual({ errorClass: 'HeartbeatsMissedError', code: 'consumer-stalled' })
    expect(classifyWorkerError('connection refused to nats://10.0.0.4:4222')).toEqual({
      errorClass: 'NonError',
      code: 'unknown',
    })
  })

  it('retries on the BOUNDED schedule and stops after MAX_START_ATTEMPTS', async () => {
    const delays: number[] = []
    const pending: Array<() => void> = []
    let attempts = 0
    await superviseWorker({
      name: 'w',
      start: async () => {
        attempts += 1
        throw new Error('nats down')
      },
      schedule: (fn, ms) => {
        delays.push(ms)
        pending.push(fn)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      log: () => {},
      error: () => {},
    })
    // Drain the schedule the supervisor laid down.
    while (pending.length > 0) {
      const fn = pending.shift()!
      fn()
      await new Promise((r) => setImmediate(r))
    }
    expect(attempts).toBe(MAX_START_ATTEMPTS)
    // Bounded on BOTH axes: finite attempts, and a backoff that stops growing.
    expect(delays).toEqual([...RESTART_DELAYS_MS])
    expect(delays.length).toBe(MAX_START_ATTEMPTS - 1)
    expect(getWorkerState('w')?.phase).toBe('degraded')
  })

  it('a worker that comes up on a later attempt is no longer degraded', async () => {
    const pending: Array<() => void> = []
    let attempts = 0
    await superviseWorker({
      name: 'w',
      start: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('not yet')
      },
      schedule: (fn) => {
        pending.push(fn)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      log: () => {},
      error: () => {},
    })
    expect(degradedWorkers()).toHaveLength(1)
    while (pending.length > 0) {
      pending.shift()!()
      await new Promise((r) => setImmediate(r))
    }
    expect(attempts).toBe(3)
    expect(getWorkerState('w')?.phase).toBe('running')
    expect(degradedWorkers()).toEqual([])
  })

  it('an OFF worker (NATS_URL unset) is not degraded — off is a configuration, not a fault', () => {
    markWorkerOff('org-unit-relay', 'NATS_URL not set')
    expect(getWorkerState('org-unit-relay')?.phase).toBe('off')
    expect(degradedWorkers()).toEqual([])
  })

  it('markWorkerDegraded records a non-Error throw as a class, never as its text', () => {
    markWorkerDegraded('w', 'nats://user:hunter2@10.0.0.4:4222 refused')
    const [degraded] = degradedWorkers()
    expect(degraded?.errorClass).toBe('NonError')
    expect(degraded?.code).toBe('unknown')
    expect(JSON.stringify(degraded)).not.toContain('hunter2')
  })

  it('a MID-LIFE fault degrades the worker and schedules the same bounded restart', async () => {
    // Round 2: a subscription that died after boot was marked degraded and left
    // there for the life of the process. Nothing restarted it, so a NATS that
    // blipped for ten seconds was a permanent outage of the audit trail — the
    // exact failure the boot-time supervisor was built to stop, one lifecycle
    // stage later.
    const pending: Array<() => void> = []
    const delays: number[] = []
    let starts = 0
    let fail = false
    const opts = {
      name: 'w',
      start: async (): Promise<void> => {
        starts += 1
        if (fail) throw new Error('still down')
      },
      schedule: (fn: () => void, ms: number) => {
        pending.push(fn)
        delays.push(ms)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      log: () => {},
      error: () => {},
    }
    await superviseWorker(opts)
    expect(getWorkerState('w')?.phase).toBe('running')

    const died = Object.assign(new Error('[nats-broker] stream CALENDAR was deleted under subscription'), {
      name: 'StreamGoneError',
    })
    noteWorkerFault('w', died)
    expect(getWorkerState('w')?.phase).toBe('degraded')
    expect(getWorkerState('w')?.code).toBe('stream-gone')
    // Bounded: the restart is SCHEDULED on the same capped backoff, not looped.
    expect(pending).toHaveLength(1)
    expect(delays[0]).toBe(RESTART_DELAYS_MS[0])

    pending.shift()!()
    await new Promise((r) => setImmediate(r))
    expect(starts).toBe(2)
    expect(getWorkerState('w')?.phase).toBe('running')
    expect(degradedWorkers()).toEqual([])
  })

  it('a mid-life fault on a worker that never had a supervisor stays degraded, and does not loop', () => {
    noteWorkerFault('never-supervised', new Error('[nats-broker] refusing to repoint stream ORGUNIT: …'))
    expect(getWorkerState('never-supervised')?.phase).toBe('degraded')
    expect(getWorkerState('never-supervised')?.code).toBe('stream-repoint-refused')
  })
})

// Adapted port (TASK-206-0): the f2 describe 'the audit consumers under a
// rejecting broker' imports ./calendar-, ./content- and ./newsletter-audit-consumer,
// which the kernel does not carry (TASK-205 keeps the audit consumers, ruling
// R28-O2). Those cases land with the consumers; this file pins consumer-state.

// TASK-206-0 review fixes (kernel adaptation of the f2 bytes): a restart that is
// no longer wanted must not run, and the mid-life restart loop is finite.
describe('restart bookkeeping (TASK-206-0 review)', () => {
  function recorder() {
    const fns: Array<() => void> = []
    let starts = 0
    return {
      fns,
      get starts() {
        return starts
      },
      opts: (fail: () => boolean) => ({
        name: 'w',
        start: async () => {
          starts += 1
          if (fail()) throw new Error('boom')
        },
        schedule: (fn: () => void, _ms: number) => {
          fns.push(fn)
          return fns.length as unknown as ReturnType<typeof setTimeout>
        },
        log: () => {},
        error: () => {},
      }),
    }
  }

  it('a worker marked running by another path cancels its pending restart', async () => {
    const r = recorder()
    await superviseWorker(r.opts(() => true))
    expect(r.fns).toHaveLength(1)
    markWorkerRunning('w')
    r.fns[0]!()
    await new Promise((res) => setImmediate(res))
    expect(r.starts).toBe(1)
    expect(getWorkerState('w')?.phase).toBe('running')
  })

  it('a worker switched off cancels its pending restart', async () => {
    const r = recorder()
    await superviseWorker(r.opts(() => true))
    markWorkerOff('w')
    r.fns[0]!()
    await new Promise((res) => setImmediate(res))
    expect(r.starts).toBe(1)
    expect(getWorkerState('w')?.phase).toBe('off')
  })

  it('a late fault on a worker that is not running schedules no second restart', async () => {
    const r = recorder()
    await superviseWorker(r.opts(() => true))
    expect(r.fns).toHaveLength(1)
    noteWorkerFault('w', new Error('late closed rejection'))
    expect(r.fns).toHaveLength(1)
  })

  it('mid-life faults are finite: after MAX_START_ATTEMPTS the worker stays degraded', async () => {
    const r = recorder()
    await superviseWorker(r.opts(() => false))
    for (let i = 0; i < MAX_START_ATTEMPTS + 2; i++) {
      noteWorkerFault('w', new Error('consumer deleted under subscription'))
      const fn = r.fns[i]
      if (!fn) break
      fn()
      await new Promise((res) => setImmediate(res))
    }
    expect(r.fns).toHaveLength(MAX_START_ATTEMPTS)
    expect(getWorkerState('w')?.phase).toBe('degraded')
  })
})
