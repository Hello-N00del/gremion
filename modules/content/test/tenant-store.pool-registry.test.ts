/**
 * tenant-store pool registry — TRUE LRU, LOUD but throttled on capacity
 * eviction, and an evicted pool that is ALWAYS ended.
 *
 * The bounded per-tenant pool registry evicts on capacity. It must evict the
 * LEAST RECENTLY USED entry, and a `getPool` HIT counts as a use — that hit is
 * what `storeFor` performs on every warm request. A registry that stamps
 * recency only on INSERT is a FIFO wearing an LRU's name: under steady load it
 * evicts the HOTTEST tenant (the one inserted first and touched on every
 * request) and immediately reconnects it, thrashing the pool it was supposed
 * to keep alive.
 *
 * Determinism (T05 rounds 2+3): the LRU contract is pinned TWICE — once
 * directly on the recency stamp `getPool` writes (`registry.order()`), and once
 * on the eviction outcome it causes. Fake timers are installed in `beforeEach`,
 * BEFORE the reset, and uninstalled in `afterEach`: every test in this file
 * therefore runs on a fresh, fully-controlled clock and NO test here ever
 * creates a real timer that could fire into a later one. Installing them inside
 * individual test bodies left the surrounding tests on real timers and made the
 * three timer cases flake (~1 full-suite run in 23).
 *
 * Capacity eviction (kernel parity with
 * gremion-ui/src/lib/server/db/pool-registry.ts) — the contract pinned here:
 *   1. WARN naming the victim tenant, THROTTLED per victim: past
 *      POOL_REGISTRY_MAX live tenants every cold request evicts, and a warn per
 *      request is as silent as no warn at all.
 *   2. DEFER the drain by a grace period so the victim's in-flight queries can
 *      finish, and LOG a drain that fails instead of swallowing it.
 *   3. ALWAYS END the pool — on the deferred timer, on `reset()`, and on the
 *      shutdown path. After eviction the entry is out of `_poolMap`, so a path
 *      that only cancels the timer orphans the handle and leaks its connections.
 *   4. BOUND the pending drains: deferring otherwise removes POOL_REGISTRY_MAX
 *      as a bound on LIVE pools for the whole grace window.
 *
 * PG-free: the registry only ever calls `end()` on the handles it stores, so a
 * stub is enough to exercise eviction order. Survival/eviction is asserted on
 * registry MEMBERSHIP, not on a side effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _poolRegistryForTests,
  closeAllPools,
  requireRuntimePgUrl,
  ShuttingDownError,
  storeFor,
  type Sql,
} from '../src/tenant-store.ts'

const registry = _poolRegistryForTests

/** Minimal stand-in for a postgres-js pool: the registry only calls end(). */
function stubPool(): Sql {
  return { end: async (): Promise<void> => {} } as unknown as Sql
}

/** Insert `tenant-0` … `tenant-(n-1)` in ascending order. */
function fill(n: number): void {
  for (let i = 0; i < n; i++) registry.set(`tenant-${i}`, stubPool())
}

let warn: ReturnType<typeof vi.spyOn>

/** Warn messages emitted so far, one string per call. */
function warnMessages(): string[] {
  return warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '))
}

/** How many capacity-eviction warns named `tenantId` as the victim. */
function warnsNaming(tenantId: string): number {
  return warnMessages().filter((m: string) => m.includes(`tenant ${tenantId}'s`)).length
}

beforeEach(() => {
  // Fake timers FIRST: the reset below cancels timers, and every timer this
  // file creates must belong to this test's clock and no other.
  vi.useFakeTimers()
  registry.reset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  registry.reset()
  warn.mockRestore()
  vi.useRealTimers()
})

describe('pool registry — bounded at POOL_REGISTRY_MAX', () => {
  it('exposes a positive capacity', () => {
    expect(registry.MAX).toBeGreaterThan(1)
  })

  it('holds exactly MAX entries once filled', () => {
    fill(registry.MAX)
    expect(registry.keys()).toHaveLength(registry.MAX)
  })

  it('never grows past MAX when a new tenant arrives', () => {
    fill(registry.MAX)
    registry.set('tenant-overflow', stubPool())
    expect(registry.keys()).toHaveLength(registry.MAX)
  })
})

describe('pool registry — a get() HIT stamps recency (the LRU bump itself)', () => {
  it('raises the recency stamp of the entry it returns above every other entry', () => {
    fill(registry.MAX)

    const before = registry.order('tenant-0')
    expect(before, 'tenant-0 must be present with a recency stamp').toBeTypeOf('number')

    expect(registry.get('tenant-0')).toBeDefined()

    const after = registry.order('tenant-0')
    expect(after, 'a get() HIT must re-stamp the entry — this IS the LRU bump').toBeGreaterThan(
      before as number,
    )

    // And that stamp must now be the HIGHEST in the registry, i.e. tenant-0 is
    // the most-recently-used entry and therefore the furthest from eviction.
    const others = registry
      .keys()
      .filter((k) => k !== 'tenant-0')
      .map((k) => registry.order(k) as number)
    expect(Math.max(...others), 'tenant-0 must be the most recently used entry').toBeLessThan(
      after as number,
    )
  })

  it('leaves every other stamp untouched', () => {
    fill(registry.MAX)
    const beforeAll = registry.keys().map((k) => [k, registry.order(k)] as const)

    registry.get('tenant-0')

    for (const [k, o] of beforeAll) {
      if (k === 'tenant-0') continue
      expect(registry.order(k), `${k}'s recency stamp must not move on a get() of tenant-0`).toBe(o)
    }
  })

  it('a get() MISS stamps nothing', () => {
    fill(registry.MAX)
    const beforeAll = registry.keys().map((k) => [k, registry.order(k)] as const)

    expect(registry.get('tenant-never-inserted')).toBeUndefined()
    expect(registry.order('tenant-never-inserted')).toBeUndefined()

    for (const [k, o] of beforeAll) expect(registry.order(k)).toBe(o)
  })
})

describe('pool registry — evicts the LEAST RECENTLY USED entry', () => {
  it('keeps a just-read entry and evicts the next-oldest instead', () => {
    fill(registry.MAX)

    // Touch the oldest entry. A read IS a use.
    expect(registry.get('tenant-0')).toBeDefined()

    // One more tenant → exactly one eviction.
    registry.set('tenant-overflow', stubPool())

    const keys = registry.keys()
    expect(keys).toHaveLength(registry.MAX)
    expect(keys).toContain('tenant-overflow')
    expect(
      keys,
      'tenant-0 was read immediately before the overflow — it must NOT be the victim',
    ).toContain('tenant-0')
    expect(
      keys,
      'tenant-1 is the least recently used once tenant-0 was touched — it must be evicted',
    ).not.toContain('tenant-1')
  })

  it('a get() MISS does not disturb the eviction order', () => {
    fill(registry.MAX)
    expect(registry.get('tenant-never-inserted')).toBeUndefined()

    registry.set('tenant-overflow', stubPool())

    const keys = registry.keys()
    expect(keys).not.toContain('tenant-0')
    expect(keys).toContain('tenant-1')
  })

  it('re-setting an existing key refreshes recency and evicts nothing', () => {
    fill(registry.MAX)

    registry.set('tenant-0', stubPool())
    expect(registry.keys()).toHaveLength(registry.MAX)

    registry.set('tenant-overflow', stubPool())

    const keys = registry.keys()
    expect(keys).toContain('tenant-0')
    expect(keys).not.toContain('tenant-1')
  })
})

describe('pool registry — capacity eviction is LOUD and drains on a grace period', () => {
  it('warns naming the evicted tenant and the capacity it was pushed past', () => {
    fill(registry.MAX)
    warn.mockClear()

    registry.set('tenant-overflow', stubPool())

    expect(warn, 'a capacity eviction must not be silent').toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]?.[0] ?? '')
    expect(msg, 'the warning must name the evicted tenant').toContain('tenant-0')
    expect(msg, 'the warning must name the capacity that was exceeded').toContain(
      `POOL_REGISTRY_MAX=${registry.MAX}`,
    )
  })

  it('defers the drain by the grace period instead of yanking in-flight queries', () => {
    let ended = 0
    const victim = {
      end: async (): Promise<void> => {
        ended++
      },
    } as unknown as Sql

    registry.set('tenant-victim', victim)
    fill(registry.MAX) // pushes the registry over capacity; victim is the LRU

    expect(registry.keys()).not.toContain('tenant-victim')
    expect(
      ended,
      'the victim may still have queries in flight — its pool must NOT be ended synchronously',
    ).toBe(0)

    vi.advanceTimersByTime(registry.DRAIN_GRACE_MS - 1)
    expect(ended, 'the drain must not fire before the grace period elapses').toBe(0)

    vi.advanceTimersByTime(1)
    expect(ended, 'the drain must fire exactly once once the grace period elapses').toBe(1)
  })

  it('logs a drain that fails instead of swallowing it', async () => {
    const victim = {
      end: async (): Promise<void> => {
        throw new Error('connection reset by peer')
      },
    } as unknown as Sql

    registry.set('tenant-victim', victim)
    fill(registry.MAX)
    warn.mockClear()

    await vi.advanceTimersByTimeAsync(registry.DRAIN_GRACE_MS)

    const messages = warnMessages()
    const drainWarn = messages.find((m: string) => m.includes('connection reset by peer'))
    expect(
      drainWarn,
      `a failed drain must be logged (leaked connections, otherwise no signal at all); saw: ${JSON.stringify(messages)}`,
    ).toBeDefined()
    expect(drainWarn, 'the drain failure must name the tenant whose pool leaked').toContain(
      'tenant-victim',
    )
  })
})

describe('pool registry — an evicted pool is ALWAYS ended', () => {
  it('ends the pending pool on reset() instead of orphaning the handle', () => {
    let ended = 0
    const victim = {
      end: async (): Promise<void> => {
        ended++
      },
    } as unknown as Sql

    registry.set('tenant-victim', victim)
    fill(registry.MAX) // evicts tenant-victim, scheduling a deferred drain
    expect(registry.pending(), 'the eviction must have scheduled a deferred drain').toBe(1)

    registry.reset()

    expect(registry.keys(), 'reset() must clear every entry').toHaveLength(0)
    expect(
      ended,
      'reset() must END the evicted pool, not merely cancel its timer: after eviction the ' +
        'entry is out of the map, so cancelling alone leaks the connections forever',
    ).toBe(1)
    expect(registry.pending(), 'reset() must leave no pending drain behind').toBe(0)

    // And a cancelled timer must never fire a SECOND end() into a later test.
    vi.advanceTimersByTime(registry.DRAIN_GRACE_MS * 2)
    expect(ended, 'the cancelled timer must not double-end the pool').toBe(1)

    // The recency counter restarts, so stamps are comparable run to run.
    registry.set('tenant-a', stubPool())
    expect(registry.order('tenant-a'), 'reset() must restart the recency counter').toBe(0)
  })

  it('ends every pending pool on the shutdown path', async () => {
    let ended = 0
    const pool = (): Sql =>
      ({
        end: async (): Promise<void> => {
          ended++
        },
      }) as unknown as Sql

    registry.set('tenant-victim-a', pool())
    registry.set('tenant-victim-b', pool())
    fill(registry.MAX) // evicts both victims
    expect(registry.pending()).toBe(2)

    await registry.drainPending()

    expect(
      ended,
      'the shutdown path must END every pending pool — the drain timer is unref-d, so a ' +
        'process leaving inside the grace window would otherwise abandon the sockets',
    ).toBe(2)
    expect(registry.pending()).toBe(0)

    vi.advanceTimersByTime(registry.DRAIN_GRACE_MS * 2)
    expect(ended, 'the drained timers must not fire again').toBe(2)
  })

  it('installs exactly one drain-on-exit hook however many pools are evicted', () => {
    // R4: the snapshot is taken BEFORE the first eviction. Without it the
    // assertion was toBeGreaterThanOrEqual(1) against a PROCESS-wide counter
    // that other test files in the same vitest worker had already raised — it
    // could not fail even with the hook deleted. reset() now REMOVES the
    // listener (uninstallDrainOnExit), which is what makes this delta exact.
    const before = process.listenerCount('beforeExit')

    registry.set('tenant-victim', stubPool())
    fill(registry.MAX)

    const installed = process.listenerCount('beforeExit')
    expect(
      installed,
      'the deferred drain timer is unref-d, so an exit inside the grace window needs a ' +
        'beforeExit hook or the evicted pool is never ended at all',
    ).toBe(before + 1)

    for (let i = 0; i < 5; i++) registry.set(`tenant-extra-${i}`, stubPool())
    expect(
      process.listenerCount('beforeExit'),
      'the hook must be installed once per process, not once per eviction',
    ).toBe(installed)
  })
})

describe('pool registry — pending drains are BOUNDED', () => {
  it('keeps PENDING_MAX a SMALL constant, not a second copy of POOL_REGISTRY_MAX', () => {
    expect(registry.PENDING_MAX, 'the pending-drain cap must be a positive bound').toBeGreaterThan(0)
    expect(
      registry.PENDING_MAX,
      'PENDING_DRAIN_MAX = POOL_REGISTRY_MAX permits exactly the 2x pool doubling the bound ' +
        'exists to prevent (16 live + 16 pending = 32 pools x 4 connections). The cap must be ' +
        'a small constant.',
    ).toBeLessThanOrEqual(4)
  })

  it('caps pending drains at PENDING_MAX after EVERY insertion, not just at the end', () => {
    let ended = 0
    const pool = (): Sql =>
      ({
        end: async (): Promise<void> => {
          ended++
        },
      }) as unknown as Sql

    for (let i = 0; i < registry.MAX; i++) registry.set(`base-${i}`, pool())
    expect(registry.pending(), 'filling to capacity exactly must evict nothing').toBe(0)

    // Every one of these evicts, so each WOULD add one pending drain. R4: the
    // bound is now asserted after EACH individual insert. The round-3 version
    // looked once, at the end, and when it failed (21 pending against a cap of
    // 16, twice in six runs) there was no way to tell which insert escaped it.
    const overflow = registry.PENDING_MAX + 5
    for (let i = 0; i < overflow; i++) {
      registry.set(`burst-${i}`, pool())
      expect(
        registry.pending(),
        `insert ${i} left ${registry.pending()} pending drains: the bound must hold ` +
          'SYNCHRONOUSLY at every insertion, never "eventually"',
      ).toBeLessThanOrEqual(registry.PENDING_MAX)
      expect(
        registry.keys().length + registry.pending(),
        'simultaneously-open pools must never exceed MAX + PENDING_MAX',
      ).toBeLessThanOrEqual(registry.MAX + registry.PENDING_MAX)
    }

    expect(
      registry.pending(),
      'without a cap the grace window holds one pending pool per evicted tenant, so ' +
        'POOL_REGISTRY_MAX stops bounding live pools entirely',
    ).toBe(registry.PENDING_MAX)
    expect(
      ended,
      'past the cap the OLDEST pending drain must be performed immediately, not deferred',
    ).toBe(5)
  })

  it('logs the forced overflow drain instead of tearing the pool down silently', () => {
    for (let i = 0; i < registry.MAX; i++) registry.set(`base-${i}`, stubPool())
    warn.mockClear()
    for (let i = 0; i <= registry.PENDING_MAX; i++) registry.set(`burst-${i}`, stubPool())

    const overflowWarn = warnMessages().find((m: string) => m.includes('PENDING_DRAIN_MAX'))
    expect(
      overflowWarn,
      'ending a pool BEFORE its grace period elapses is the exact harm the grace period ' +
        'exists to avoid; an operator seeing mid-flight connection errors needs the cap named. ' +
        `Saw: ${JSON.stringify(warnMessages())}`,
    ).toBeDefined()
  })
})

describe('pool registry — bookkeeping does not outlive the pools', () => {
  it('KEEPS the eviction-warn entry for the whole window, then prunes it on the next insert', async () => {
    // T05R5: round 4 deleted this entry the moment the victim's pool drained.
    // DRAIN_GRACE_MS (30s) is HALF of WARN_THROTTLE_MS (60s), so the throttle it
    // was supposed to enforce expired twice as fast as advertised — and the
    // overflow path deleted it immediately, i.e. no throttle at all on the one
    // path that fires per request. Bounding the map is the job of prune-on-
    // insert, not of a deletion that also destroys the throttle.
    registry.set('tenant-victim', stubPool())
    fill(registry.MAX)

    expect(
      registry.warnedVictims(),
      'the victim must be recorded while its warn is throttled',
    ).toContain('tenant-victim')

    await vi.advanceTimersByTimeAsync(registry.DRAIN_GRACE_MS)

    expect(
      registry.warnedVictims(),
      'draining the pool does not end the throttle window — deleting here is what let the ' +
        'same victim warn again every DRAIN_GRACE_MS instead of every WARN_THROTTLE_MS',
    ).toContain('tenant-victim')

    // ... and the map is still BOUNDED: an insert after the window prunes it.
    await vi.advanceTimersByTimeAsync(registry.WARN_THROTTLE_MS)
    registry.reset()
    registry.set('tenant-other', stubPool())
    fill(registry.MAX)
    expect(
      registry.warnedVictims(),
      'prune-on-insert is what bounds the map: a stale entry must not outlive its window',
    ).not.toContain('tenant-victim')
  })

  it('does not re-warn the same victim inside the window even after its pool drained', async () => {
    registry.set('tenant-victim', stubPool())
    fill(registry.MAX)
    expect(warnsNaming('tenant-victim')).toBe(1)

    // The deferred drain lands at DRAIN_GRACE_MS — well inside the 60s window.
    await vi.advanceTimersByTimeAsync(registry.DRAIN_GRACE_MS + 1)

    // Re-insert the victim and evict it again, still inside the warn window.
    registry.set('tenant-victim', stubPool())
    fill(registry.MAX)

    expect(
      warnsNaming('tenant-victim'),
      'once the live fleet exceeds MAX every cold request evicts; a warn per eviction is a ' +
        'log that fires thousands of times an hour, which is as silent as no log at all',
    ).toBe(1)
  })

  it('throttles the pending-drain overflow warn too', () => {
    for (let i = 0; i < registry.MAX; i++) registry.set(`base-${i}`, stubPool())
    warn.mockClear()
    // Far past the cap: every insert past PENDING_MAX forces one overflow drain.
    for (let i = 0; i < registry.PENDING_MAX * 4; i++) registry.set(`burst-${i}`, stubPool())

    const overflowWarns = warnMessages().filter((m: string) => m.includes('PENDING_DRAIN_MAX'))
    expect(
      overflowWarns.length,
      'the overflow warn fires on the SAME per-request path the eviction warn is throttled ' +
        `on; leaving it unthrottled reintroduces the flood. Saw: ${JSON.stringify(overflowWarns)}`,
    ).toBe(1)
  })

  it('ends the pool a setPool OVERWRITE displaces instead of orphaning it', async () => {
    let ended = 0
    const first = {
      end: async (): Promise<void> => {
        ended++
      },
    } as unknown as Sql

    registry.set('tenant-a', first)
    registry.set('tenant-a', stubPool())

    expect(
      registry.pending(),
      'two concurrent storeFor() calls for one tenant both open a pool; the loser was dropped ' +
        'from the map with nothing left holding a reference to end() it',
    ).toBe(1)

    await registry.drainPending()
    expect(ended, 'the displaced pool must be ended, not left to idle_timeout').toBe(1)
  })

  it('closeAllPools() ends the LIVE pools too, not only the evicted ones', async () => {
    let ended = 0
    const pool = (): Sql =>
      ({
        end: async (): Promise<void> => {
          ended++
        },
      }) as unknown as Sql

    registry.set('tenant-victim', pool())
    for (let i = 0; i < registry.MAX; i++) registry.set(`tenant-${i}`, pool())
    expect(registry.pending(), 'the victim is pending a deferred drain').toBe(1)
    expect(registry.keys().length).toBe(registry.MAX)

    await closeAllPools()

    expect(
      ended,
      'SIGTERM tore down every LIVE pool by TCP reset while carefully draining the handful ' +
        'that happened to be evicted in the last 30s — the larger half of the same hole',
    ).toBe(registry.MAX + 1)
    expect(registry.keys(), 'closeAllPools() must empty the live registry').toHaveLength(0)
    expect(registry.pending(), 'closeAllPools() must leave no pending drain behind').toBe(0)
  })
})

describe('requireRuntimePgUrl — an explicit empty string is a misconfiguration', () => {
  it('refuses an explicitly-passed empty pgUrl instead of falling through to the env', () => {
    const ENV = 'T05R4_PROBE_PG_URL'
    process.env[ENV] = 'postgres://should-not-be-reached/db'
    try {
      expect(
        () => requireRuntimePgUrl('', ENV),
        'explicit || process.env[...] silently swaps a caller-supplied empty string for the ' +
          'ambient env value — the caller asked for THAT endpoint and got a different one',
      ).toThrow(/no Postgres URL configured/)
    } finally {
      delete process.env[ENV]
    }
  })
})

describe('pool registry — the capacity-eviction warn is throttled per victim', () => {
  /**
   * Force one more capacity eviction of `tenant-0`: put it back (which evicts
   * whatever is currently least-recently-used), bump every other entry above
   * it, then overflow once more.
   */
  function evictTenantZeroAgain(overflowKey: string): void {
    registry.set('tenant-0', stubPool())
    for (const k of registry.keys()) if (k !== 'tenant-0') registry.get(k)
    registry.set(overflowKey, stubPool())
  }

  it('warns once per victim inside the throttle window, however often it is evicted', () => {
    fill(registry.MAX)
    warn.mockClear()

    registry.set('overflow-1', stubPool()) // evicts tenant-0
    expect(warnsNaming('tenant-0'), 'the first eviction of a victim must warn').toBe(1)

    evictTenantZeroAgain('overflow-2')
    evictTenantZeroAgain('overflow-3')

    expect(
      warnsNaming('tenant-0'),
      'past POOL_REGISTRY_MAX tenants EVERY cold request evicts — an unthrottled warn fires ' +
        'per request and buries the signal it exists to raise',
    ).toBe(1)
  })

  it('warns again for the same victim once the throttle window elapses', () => {
    fill(registry.MAX)
    warn.mockClear()

    registry.set('overflow-1', stubPool()) // evicts tenant-0
    expect(warnsNaming('tenant-0')).toBe(1)

    vi.advanceTimersByTime(registry.WARN_THROTTLE_MS)
    evictTenantZeroAgain('overflow-2')

    expect(
      warnsNaming('tenant-0'),
      'throttling must SUPPRESS repeats, never silence the signal permanently',
    ).toBe(2)
  })
})

/**
 * ────────────────────────────────────────────────────────────────────────────
 * T05R5 — closeAllPools() is the SHUTDOWN seam, so what it misses is leaked.
 *
 * Round 4 drained the live registry and the pending set and stopped there. The
 * CONTROL pool — the one every leaf opens at boot, holds for the whole process
 * lifetime and never evicts, because it is not in the registry at all — was
 * left to die by TCP reset on every single SIGTERM. It is the one pool
 * guaranteed to exist in a running leaf.
 *
 * And a drain seam that reports nothing cannot be checked: `sql.end()` rejects
 * on a broken connection, the old code swallowed it into a resolved promise,
 * and the shutdown logged "pools drained" over the top of leaked connections.
 */
describe('closeAllPools — the control pool is a pool', () => {
  it('ends the control pool and counts it', async () => {
    let controlEnded = 0
    registry.setControl({
      end: async (): Promise<void> => {
        controlEnded++
      },
    } as unknown as Sql)
    registry.set('tenant-a', stubPool())
    registry.set('tenant-b', stubPool())

    const counts = await closeAllPools()

    expect(
      controlEnded,
      'the control pool is not in _poolMap, so a drain that walks only the registry never ' +
        'touches the one pool every leaf is guaranteed to hold',
    ).toBe(1)
    expect(counts.control).toBe(1)
    expect(counts.live).toBe(2)
    expect(counts.failed).toBe(0)
    expect(registry.hasControl(), 'the closed handle must not be handed out again').toBe(false)
  })

  it('reports a rejecting end() as a FAILURE instead of a clean drain', async () => {
    registry.setControl({
      end: async (): Promise<void> => {
        throw new Error('control end exploded')
      },
    } as unknown as Sql)
    registry.set('tenant-a', {
      end: async (): Promise<void> => {
        throw new Error('tenant end exploded')
      },
    } as unknown as Sql)
    registry.set('tenant-b', stubPool())

    const counts = await closeAllPools()

    expect(
      counts.failed,
      'a swallowed end() rejection is a leaked pool reported as a clean shutdown',
    ).toBe(2)
    expect(counts.live).toBe(2)
    expect(counts.control).toBe(1)
  })

  it('counts zero control pools when the leaf never opened one', async () => {
    registry.set('tenant-a', stubPool())
    const counts = await closeAllPools()
    expect(counts.control).toBe(0)
    expect(counts.live).toBe(1)
  })
})

describe('closeAllPools — the registry stays closed afterwards', () => {
  it('refuses storeFor() with ShuttingDownError once the pools are gone', async () => {
    await closeAllPools()
    expect(registry.closing()).toBe(true)
    await expect(
      storeFor({ id: '11111111-1111-1111-1111-111111111111', slug: 'demo' }),
      'an in-flight request that lands after the drain re-opened a pool the shutdown had ' +
        'just closed, and nothing would ever close THAT one',
    ).rejects.toBeInstanceOf(ShuttingDownError)
  })

  it('refuses ensureControlDb() with ShuttingDownError once the pools are gone', async () => {
    await closeAllPools()
    await expect(
      registry.ensureControl('postgres://u:p@127.0.0.1:5432/postgres', 'probe_'),
      'the control pool re-opens itself on demand: without this guard the drain ends it and ' +
        'the next listTenants() opens a replacement seconds before process.exit()',
    ).rejects.toBeInstanceOf(ShuttingDownError)
  })

  it('names the leaf state in the error so the log is diagnosable', async () => {
    await closeAllPools()
    const err = await storeFor({
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'demo',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ShuttingDownError)
    expect((err as Error).message).toMatch(/shutting down/i)
  })
})

describe('requireRuntimePgUrl — the leaf still refuses an empty env after a reset', () => {
  it('is unaffected by the shutdown flag once the registry is reset', () => {
    expect(registry.closing(), 'reset() must clear the shutdown flag or every later test lies').toBe(
      false,
    )
    expect(() => requireRuntimePgUrl(undefined, 'CONTENT_PG_URL')).toThrow(/CONTENT_PG_URL/)
  })
})
