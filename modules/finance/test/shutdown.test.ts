/**
 * SIGTERM must not exit before the pools are drained.
 *
 * Round 3 shipped `void drainEvictedPools()` in ONE leaf (newsletter),
 * immediately followed by `server.close(cb => process.exit(0))`. Nothing
 * sequenced the two: `server.close`'s callback fires as soon as the last
 * connection goes away — on an idle leaf, or one whose only client is the wget
 * healthcheck, that is the next tick — while `sql.end()` is a network round
 * trip to Postgres. `process.exit(0)` does not wait for pending promises, so the
 * pools died by exactly the TCP reset the drain existed to prevent. The other
 * three leaves never called the drain at all, and `process.exit()` never emits
 * `beforeExit`, so their `installDrainOnExit` hook was structurally unreachable.
 *
 * POST-CONDITIONS pinned here — on the SHUTDOWN HELPER, which is the whole
 * point of extracting it: an inline handler inside `main()` cannot be tested
 * without booting a server and killing a process.
 *   1. ORDERING — exit() is called only AFTER the drain promise settles. The
 *      probe resolves end() a tick late precisely so a fire-and-forget drain
 *      loses the race and the test goes RED.
 *   2. BOUNDED — a drain that never settles does not hang the shutdown: the
 *      forced-exit timer fires, LOGS that it timed out, and exits non-zero.
 *   3. ONE EXIT — the late drain must not exit a second time after the forced
 *      timer already did.
 *   4. WIRED — the leaf's own src/index.ts installs this handler for BOTH
 *      SIGTERM and SIGINT and hands it the pool drain. A helper nothing calls
 *      is the round-3 defect wearing a test.
 *
 * PG-free and server-free: every collaborator is injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createShutdown,
  resolveShutdownTimeoutMs,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from '../src/shutdown.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_TS = path.join(__dirname, '..', 'src', 'index.ts')
const ORG_UNIT_CONSUMER_TS = path.join(__dirname, '..', 'src', 'org-unit-consumer.ts')

/** Records the order of every observable side effect, in one list. */
type Trace = string[]

/**
 * A server stub whose close() callback fires on the NEXT TICK — the fast path
 * that beat the drain in production. `closeErr` drives the error branch.
 */
function serverStub(trace: Trace, closeErr?: Error): { close(cb: (err?: Error) => void): void } {
  return {
    close(cb: (err?: Error) => void): void {
      queueMicrotask(() => {
        trace.push('server-closed')
        cb(closeErr)
      })
    },
  }
}

let exits: number[]
let trace: Trace
let logs: string[]
let errors: string[]

beforeEach(() => {
  exits = []
  trace = []
  logs = []
  errors = []
})
afterEach(() => {
  vi.useRealTimers()
})

function deps(over: Partial<Parameters<typeof createShutdown>[0]> = {}): Parameters<
  typeof createShutdown
>[0] {
  return {
    name: 'probe',
    server: serverStub(trace),
    drain: async (): Promise<void> => {},
    exit: (code: number): void => {
      trace.push(`exit(${code})`)
      exits.push(code)
    },
    log: (msg: string): void => {
      logs.push(msg)
    },
    errorLog: (msg: string): void => {
      errors.push(msg)
    },
    forceAfterMs: 10_000,
    ...over,
  }
}

describe('createShutdown — the drain is AWAITED before the process exits', () => {
  it('exits only after every pool end() has resolved', async () => {
    let drainStarted = false
    const shutdown = createShutdown(
      deps({
        drain: async (): Promise<void> => {
          drainStarted = true
          trace.push('drain-start')
          // Two ticks: a fire-and-forget drain loses this race every time.
          await Promise.resolve()
          await Promise.resolve()
          trace.push('drain-end')
        },
      }),
    )

    shutdown('SIGTERM')
    expect(exits, 'the handler must not exit synchronously').toEqual([])

    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(drainStarted, 'the drain must actually run').toBe(true)
    expect(
      trace,
      'process.exit() does not wait for pending promises: an exit issued before the drain ' +
        'settles kills the sockets by the TCP reset the drain exists to prevent',
    ).toEqual(['server-closed', 'drain-start', 'drain-end', 'exit(0)'])
    expect(exits).toEqual([0])
  })

  it('logs what it drained on the clean path', async () => {
    const shutdown = createShutdown(deps())
    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(logs.join('\n'), 'the signal must be logged').toContain('SIGTERM')
    expect(
      logs.join('\n'),
      'a shutdown that drained cleanly must say so — otherwise the timeout path and the ' +
        'clean path are indistinguishable in the container log',
    ).toContain('pools drained')
  })

  it('is idempotent: a second signal does not start a second shutdown', async () => {
    let drains = 0
    const shutdown = createShutdown(
      deps({
        drain: async (): Promise<void> => {
          drains++
        },
      }),
    )

    shutdown('SIGTERM')
    shutdown('SIGINT')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(drains, 'SIGINT after SIGTERM must not re-enter the drain').toBe(1)
    expect(exits).toEqual([0])
  })
})

describe('createShutdown — the drain is BOUNDED by the forced-exit timer', () => {
  it('exits non-zero and logs when the drain never settles', async () => {
    vi.useFakeTimers()
    const shutdown = createShutdown(
      deps({
        drain: () => new Promise<void>(() => {}), // never settles
        forceAfterMs: 10_000,
      }),
    )

    shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(exits, 'the forced exit must not fire early').toEqual([])

    await vi.advanceTimersByTimeAsync(1)

    expect(exits, 'a hung sql.end() must not hold the container open forever').toEqual([1])
    expect(
      errors.join('\n'),
      'the timeout path must be LOUD: a silent forced exit is indistinguishable from a clean one',
    ).toMatch(/timed out/)
  })

  it('does not exit twice when a late drain settles after the forced exit', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const shutdown = createShutdown(
      deps({
        drain: () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
        forceAfterMs: 1_000,
      }),
    )

    shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(exits).toEqual([1])

    release?.()
    await vi.advanceTimersByTimeAsync(1)

    expect(exits, 'the first exit decision wins — a second exit() call is a lie in the log').toEqual(
      [1],
    )
  })

  it('cancels the forced timer once the clean path has exited', async () => {
    vi.useFakeTimers()
    const shutdown = createShutdown(deps({ forceAfterMs: 1_000 }))

    shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([0])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(
      exits,
      'an uncancelled forced timer turns a clean shutdown into a spurious exit(1)',
    ).toEqual([0])
  })
})

describe('createShutdown — failure paths', () => {
  it('exits non-zero when server.close reports an error and does not fall through to exit(0)', async () => {
    trace = []
    const shutdown = createShutdown(
      deps({ server: serverStub(trace, new Error('close failed')) }),
    )

    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(exits, 'the error branch must not also reach the success exit').toEqual([1])
    expect(errors.join('\n')).toContain('close failed')
  })

  it('exits non-zero and logs when the drain itself rejects', async () => {
    const shutdown = createShutdown(
      deps({
        drain: async (): Promise<void> => {
          throw new Error('pool end exploded')
        },
      }),
    )

    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(exits).toEqual([1])
    expect(
      errors.join('\n'),
      'a rejected drain must be reported, not swallowed into a clean exit(0)',
    ).toContain('pool end exploded')
  })
})

describe('wiring — this leaf actually installs the handler', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8')

  it('builds its shutdown handler with createShutdown', () => {
    expect(
      source,
      'src/index.ts must build its handler with createShutdown — an inline handler is the ' +
        'untestable shape that shipped the round-3 defect',
    ).toMatch(/createShutdown\(/)
  })

  it('hands createShutdown the pool drain', () => {
    expect(
      source,
      'the drain must close the LIVE pools as well as the evicted ones (closeAllPools), or ' +
        'SIGTERM still resets up to POOL_REGISTRY_MAX live pools',
    ).toMatch(/drain:\s*\(\)\s*=>\s*closeAllPools\(\)/)
  })

  it('registers the handler for BOTH SIGTERM and SIGINT', () => {
    expect(source).toMatch(/process\.on\('SIGTERM',\s*\(\)\s*=>\s*shutdown\('SIGTERM'\)\)/)
    expect(source).toMatch(/process\.on\('SIGINT',\s*\(\)\s*=>\s*shutdown\('SIGINT'\)\)/)
  })

  it('keeps no fire-and-forget drain behind', () => {
    expect(
      source,
      'void drainEvictedPools() is the exact round-3 defect: issued, never awaited, and ' +
        'raced by the process.exit() two lines below it',
    ).not.toMatch(/void\s+drainEvictedPools\(\)/)
  })

  it('routes the shutdown exit through the injected seam, not an inline one', () => {
    // main().catch(...) may still exit(1) on a fatal BOOT error; the SHUTDOWN
    // path must route its exit through the injected `exit` seam, which is what
    // lets the helper order it behind the drain.
    const at = source.indexOf('createShutdown(')
    expect(at, 'there is no shutdown region at all until createShutdown is wired').toBeGreaterThan(
      -1,
    )
    const region = source.slice(at)
    expect(region).toMatch(/exit:\s*\(code\)\s*=>\s*process\.exit\(code\)/)
    expect(
      region,
      'an inline success exit is the round-3 shape: it fires from the server.close callback ' +
        'on the next tick, ahead of the drain',
    ).not.toMatch(/process\.exit\(0\)/)
  })
})

/**
 * ────────────────────────────────────────────────────────────────────────────
 * T05R5 — the bound has to be REACHABLE, and it has to be the bound the
 * orchestrator actually waits for.
 *
 * Kubernetes' default terminationGracePeriodSeconds is 30s and compose's
 * `stop_grace_period` default is 10s; a 10_000ms forced-exit timer is therefore
 * exactly AT the compose bound, so the SIGKILL and the "forced exit" race and
 * the log line that would have explained the kill is the one that loses.
 * 7_000ms leaves 3s of headroom under the tighter of the two, and it has to be
 * overridable because the two orchestrators do not agree.
 *
 * Also pinned here: the two ordering defects round 4 left in the handler.
 *   - The forced timer was armed AFTER `before()`. `before()` closes the NATS
 *     broker and stops loops; anything it throws — or any of its handles that
 *     never settles — happened while NOTHING bounded the shutdown.
 *   - The `server.close` ERROR branch exited WITHOUT draining. A close error is
 *     precisely when connections are still open, i.e. the branch that needs the
 *     drain most, and it is the branch that skipped it.
 */
describe('resolveShutdownTimeoutMs — 7s by default, and overridable', () => {
  it('defaults to 7000ms, under compose\'s 10s stop_grace_period', () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(7_000)
    expect(resolveShutdownTimeoutMs({})).toBe(7_000)
    expect(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '' })).toBe(7_000)
  })

  it('honours SHUTDOWN_TIMEOUT_MS', () => {
    expect(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '2500' })).toBe(2_500)
    expect(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '25000' })).toBe(25_000)
  })

  it('falls back — loudly — on a value that is not a positive integer', () => {
    const warns: string[] = []
    const w = (m: string): void => {
      warns.push(m)
    }
    for (const bad of ['abc', '0', '-1', '1.5']) {
      expect(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: bad }, w)).toBe(7_000)
    }
    expect(
      warns.length,
      'a silently-ignored SHUTDOWN_TIMEOUT_MS is a setting the operator believes is in effect',
    ).toBe(4)
    expect(warns[0]).toContain('SHUTDOWN_TIMEOUT_MS')
  })
})

describe('createShutdown — the forced timer is armed BEFORE before()', () => {
  it('still forces an exit when before() throws', async () => {
    vi.useFakeTimers()
    const shutdown = createShutdown(
      deps({
        before: (): void => {
          throw new Error('broker close exploded')
        },
        drain: () => new Promise<void>(() => {}), // never settles
        forceAfterMs: 1_000,
      }),
    )

    expect(
      () => shutdown('SIGTERM'),
      'a throwing pre-stop hook must not escape the handler — the signal handler is the ' +
        'last thing running, so an exception there means nothing drains and nothing exits',
    ).not.toThrow()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(
      exits,
      'the timer was armed AFTER before(), so a before() that threw skipped the arming ' +
        'entirely and the container hung until the orchestrator SIGKILLed it',
    ).toEqual([1])
    expect(errors.join('\n')).toContain('broker close exploded')
  })

  it('reports the bound it is enforcing in the first log line', async () => {
    const shutdown = createShutdown(deps({ forceAfterMs: 4_321 }))
    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(
      logs.join('\n'),
      'an operator reading the container log has to know which bound applied — the default ' +
        'and an overridden one are otherwise indistinguishable',
    ).toContain('4321')
  })
})

describe('createShutdown — the drain runs on BOTH server.close branches', () => {
  it('drains even when server.close reports an error', async () => {
    trace = []
    let drained = 0
    const shutdown = createShutdown(
      deps({
        server: serverStub(trace, new Error('close failed')),
        drain: async (): Promise<void> => {
          drained++
          trace.push('drain')
        },
      }),
    )

    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    expect(
      drained,
      'a close error is exactly when connections are still open: the error branch exited ' +
        'without draining, so the pools it left behind died by TCP reset',
    ).toBe(1)
    expect(exits, 'a failed close is still a failed shutdown').toEqual([1])
    expect(trace).toEqual(['server-closed', 'drain', 'exit(1)'])
  })

  it('reports the drain counts it got back', async () => {
    const shutdown = createShutdown(
      deps({
        drain: async () => ({ live: 3, evicted: 1, control: 1, failed: 0 }),
      }),
    )
    shutdown('SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))

    const line = logs.find((m) => m.includes('pools drained'))
    expect(line, `saw ${JSON.stringify(logs)}`).toBeDefined()
    expect(line, 'the control pool is invisible in the registry counts unless it is named').toContain(
      'control=1',
    )
    expect(line).toContain('live=3')
    expect(line).toContain('evicted=1')
    expect(line).toContain('failed=0')
  })
})

describe('wiring — the leaf takes its bound from the environment', () => {
  const src = fs.readFileSync(INDEX_TS, 'utf8')

  it('resolves the forced-exit bound through resolveShutdownTimeoutMs(process.env)', () => {
    expect(
      src,
      'a hard-coded constant cannot be raised for a cluster whose grace period is longer, ' +
        'and cannot be lowered for compose, whose default grace period it currently equals',
    ).toMatch(/resolveShutdownTimeoutMs\(process\.env/)
  })

  it('keeps no hard-coded 10s bound behind', () => {
    expect(src).not.toMatch(/SHUTDOWN_TIMEOUT_MS\s*=\s*10_000/)
  })
})

describe('wiring — finance stops its org-unit consumer before the server closes', () => {
  const src = fs.readFileSync(INDEX_TS, 'utf8')
  const consumerSrc = fs.readFileSync(ORG_UNIT_CONSUMER_TS, 'utf8')

  it('hands createShutdown a before() hook', () => {
    const at = src.indexOf('createShutdown(')
    expect(at).toBeGreaterThan(-1)
    expect(
      src.slice(at),
      'finance was the ONE leaf with no before() at all: its NATS org-unit consumer kept ' +
        'pulling messages, and kept calling storeFor(), while the pools were being drained',
    ).toMatch(/before:/)
  })

  it('closes the org-unit consumer handle in that hook', () => {
    const at = src.indexOf('createShutdown(')
    const region = src.slice(at)
    expect(
      region,
      'startOrgUnitConsumer must hand back something closable and the hook must close it — ' +
        'a fire-and-forget subscription is a handle nothing can stop',
    ).toMatch(/orgUnitConsumer/)
  })

  it('startOrgUnitConsumer returns a closable handle', () => {
    // The boot moved out of src/index.ts (which calls main() at import, so
    // nothing in it was reachable from a test) into src/org-unit-consumer.ts,
    // where its ready/closed behaviour is now driven by real doubles in
    // org-unit-consumer-boot.test.ts. This assertion follows it: the DECLARATION
    // must still return a closable handle, and index.ts must still capture one.
    expect(
      consumerSrc,
      'a consumer started with no returned handle cannot be stopped on SIGTERM at all',
    ).toMatch(/startOrgUnitConsumer\([^)]*\)\s*:\s*Promise<[^>]*Handle/)
    expect(src, 'src/index.ts must hold the handle it started').toMatch(/orgUnitConsumer = handle/)
  })
})
