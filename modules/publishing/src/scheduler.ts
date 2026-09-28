// services/newsletter/src/scheduler.ts
//
// Task 8: per-tenant scheduler tick for the newsletter leaf.
//
// Mirrors the P2.1b gremion-ui worker-fleet shape (forEachActiveTenant): one tick
// iterates the ACTIVE tenant catalog and runs the per-tenant work inside a
// per-(label, tenantId) single-flight guard with per-tenant fail-safe try/catch,
// so one slow/throwing tenant never starves or aborts the fleet. A control-plane
// listing failure is logged and SWALLOWED — a worker tick must never reject.
//
// Per-tenant work, in order:
//   1. resetStuckSending  — clear 'sending' rows whose sender crashed (G-017),
//                           BEFORE picking up new work so a stuck row from a
//                           previous tick stops blocking its newsletter.
//   2. dispatchDue        — dispatch every due 'scheduled' newsletter.
//   3. purgeTokens        — WEEKLY only (withPurge): delete send tokens for
//                           newsletters sent >90d ago.
//
// Tick cadence: 60s (TICK_INTERVAL_MS). The weekly purge runs on the Nth tick
// (PURGE_EVERY_TICKS) rather than a second timer, keeping one interval.
//
// ── SCHEDULER_ENABLED (§D.3 step-0 cutover hold) ──────────────────────────────
// The WHOLE tick is gated on SCHEDULER_ENABLED (default 'true'). When 'false',
// startScheduler() registers NO interval at all and logs ONE boot line — there
// is no tick, not even a no-op one. This is the cutover hold: during the leaf's
// step-0 deploy the scheduler is brought up with SCHEDULER_ENABLED=false so the
// monolith keeps owning sends until we flip the flag.
//
// Dependency injection: listTenants + the three work callbacks are injected so
// unit tests exercise the fleet/single-flight/gate logic with no PG and no
// timers. Production wires listTenants → tenant-store catalog and the work
// callbacks → dispatch()/resetStuckSending()/purgeSendTokensOlderThan90Days().

import type { TenantRef } from './tenant-store.js'

// ── constants ──────────────────────────────────────────────────────────────────

/** Tick cadence — one tick per minute. */
export const TICK_INTERVAL_MS = 60_000

/** Run the weekly token purge every Nth tick (60s × 10080 = 7 days). */
export const PURGE_EVERY_TICKS = 7 * 24 * 60

/** Single-flight / structured-log label (mirrors the worker-fleet label). */
const LABEL = 'newsletter-scheduler'

// ── types ──────────────────────────────────────────────────────────────────────

/** Per-tenant unit-of-work callbacks. Each receives the resolved tenant. */
export interface TickWork {
  /** G-017: reset stuck 'sending' rows for this tenant. */
  resetStuck(tenant: TenantRef): Promise<void>
  /** Dispatch every due 'scheduled' newsletter for this tenant. */
  dispatchDue(tenant: TenantRef): Promise<void>
  /** Weekly: purge send tokens for newsletters sent >90d ago. */
  purgeTokens(tenant: TenantRef): Promise<void>
}

export interface SchedulerDeps {
  /** List the ACTIVE tenants to tick over (production → tenant catalog). */
  listTenants(): Promise<TenantRef[]>
  /** Per-tenant work callbacks. */
  work: TickWork
}

export interface StartSchedulerOptions {
  /**
   * Whether the scheduler is enabled. Defaults to reading SCHEDULER_ENABLED from
   * env (default 'true'; only the exact string 'false' disables). When false,
   * NO interval is registered (the §D.3 step-0 cutover hold).
   */
  enabled?: boolean
  /** Injectable setInterval (tests). Defaults to global setInterval. */
  setIntervalImpl?: typeof setInterval
  /** Injectable clearInterval (tests). Defaults to global clearInterval. */
  clearIntervalImpl?: typeof clearInterval
  /** Tick interval override (tests). Defaults to TICK_INTERVAL_MS. */
  intervalMs?: number
}

export interface SchedulerHandle {
  /** Whether the scheduler is enabled and ticking. */
  readonly enabled: boolean
  /** Stop the interval (no-op when disabled). */
  stop(): void
}

// ── single-flight registry ──────────────────────────────────────────────────────

/** In-flight (label, tenantId) pairs — per-tenant single-flight. */
const _inFlight = new Set<string>()

/** Test-only: clear the module-scoped single-flight registry between cases. */
export function _resetSchedulerForTests(): void {
  _inFlight.clear()
}

// ── tick ──────────────────────────────────────────────────────────────────────

/**
 * Run ONE scheduler tick over the active tenant fleet.
 *
 * NEVER rejects: a listing failure is logged + swallowed, and each tenant's work
 * is wrapped in its own try/catch so one tenant's throw never aborts the rest.
 *
 * @param deps  injected lister + work callbacks.
 * @param opts.withPurge  also run the weekly token purge this tick.
 */
export async function runSchedulerTick(
  deps: SchedulerDeps,
  opts: { withPurge?: boolean } = {},
): Promise<void> {
  let tenants: TenantRef[]
  try {
    tenants = await deps.listTenants()
  } catch (err) {
    // Fail-safe per tick: a control-plane listing failure must not crash the
    // worker — log and resolve (mirrors worker-fleet semantics).
    console.error(`[${LABEL}] listing active tenants failed — tick skipped:`, err)
    return
  }

  for (const tenant of tenants) {
    const key = `${LABEL}::${tenant.id}`
    if (_inFlight.has(key)) {
      // Overlapping tick for the SAME tenant — skip, never overlap.
      console.info(`[${LABEL}] tenant ${tenant.slug} still in flight — skipped (single-flight)`)
      continue
    }
    _inFlight.add(key)
    try {
      await runTenantTick(deps.work, tenant, opts.withPurge ?? false)
    } catch (err) {
      // One tenant's failure never stops the rest of the fleet.
      console.error(
        `[${LABEL}] tenant ${tenant.slug} tick failed:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      _inFlight.delete(key)
    }
  }
}

/** The per-tenant work, in order. */
async function runTenantTick(
  work: TickWork,
  tenant: TenantRef,
  withPurge: boolean,
): Promise<void> {
  // 1. Clear stuck 'sending' rows BEFORE picking up new work (G-017).
  await work.resetStuck(tenant)
  // 2. Dispatch due 'scheduled' newsletters.
  await work.dispatchDue(tenant)
  // 3. Weekly token purge.
  if (withPurge) {
    await work.purgeTokens(tenant)
  }
}

// ── start / stop ────────────────────────────────────────────────────────────────

/** Resolve the enabled flag: explicit option wins, else env (default true).
 *
 * H4 (per-service kill-switch split): a per-service NEWSLETTER_SCHEDULER_ENABLED,
 * when set to a NON-EMPTY value, wins over the shared SCHEDULER_ENABLED — so a
 * single leaf can be held (or re-enabled) independently of the fleet. An unset
 * OR empty per-service value (the compose `${NEWSLETTER_SCHEDULER_ENABLED:-}`
 * default) falls through to the shared flag, preserving byte-identical
 * back-compat: all vars unset → the exact base expression below.
 */
function resolveEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit
  const perService = process.env.NEWSLETTER_SCHEDULER_ENABLED
  if (perService !== undefined && perService !== '') {
    // Only the exact string 'false' disables; anything else → enabled.
    return perService !== 'false'
  }
  // Only the exact string 'false' disables; unset or anything else → enabled.
  return (process.env.SCHEDULER_ENABLED ?? 'true') !== 'false'
}

/**
 * Start the scheduler. When enabled, registers a 60s interval that ticks the
 * fleet (with the weekly purge folded in every PURGE_EVERY_TICKS-th tick).
 * When disabled, registers NO interval and logs one boot line (cutover hold).
 *
 * Returns a handle whose .stop() clears the interval (no-op when disabled).
 */
export function startScheduler(
  deps: SchedulerDeps,
  opts: StartSchedulerOptions = {},
): SchedulerHandle {
  const enabled = resolveEnabled(opts.enabled)

  if (!enabled) {
    // §D.3 step-0 cutover hold: ONE boot line, then nothing — no tick at all.
    console.warn(
      `[${LABEL}] SCHEDULER_ENABLED=false — scheduler is HELD (no ticks). ` +
        `The §D.3 step-0 cutover hold is active; set SCHEDULER_ENABLED=true to start sending.`,
    )
    return { enabled: false, stop: () => {} }
  }

  const setIntervalFn = opts.setIntervalImpl ?? setInterval
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval
  const intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS

  console.log(`[${LABEL}] scheduler enabled — ticking every ${intervalMs}ms`)

  let tickCount = 0
  let ticking = false
  const timer = setIntervalFn(() => {
    // Guard against a tick that runs longer than the interval (defence in depth;
    // per-tenant single-flight already prevents per-tenant overlap).
    if (ticking) return
    ticking = true
    tickCount += 1
    const withPurge = tickCount % PURGE_EVERY_TICKS === 0
    void runSchedulerTick(deps, { withPurge })
      .catch((err) => {
        // runSchedulerTick never rejects, but be defensive.
        console.error(`[${LABEL}] tick failed:`, err)
      })
      .finally(() => {
        ticking = false
      })
  }, intervalMs)

  // Don't keep the process alive solely for the scheduler timer.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }

  return {
    enabled: true,
    stop: () => clearIntervalFn(timer),
  }
}
