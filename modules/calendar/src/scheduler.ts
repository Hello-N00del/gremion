// services/calendar/src/scheduler.ts
//
// Task 18: per-tenant scheduler tick for the calendar leaf.
//
// Mirrors services/newsletter/src/scheduler.ts's shape (forEachActiveTenant-
// style fleet iteration): one tick walks the ACTIVE tenant catalog and runs
// the per-tenant work inside a per-(label, tenantId) single-flight guard with
// per-tenant fail-safe try/catch, so one slow/throwing tenant never starves
// or aborts the fleet. A control-plane listing failure is logged and
// SWALLOWED — a worker tick must never reject.
//
// UNLIKE the newsletter leaf, there is ONLY ONE per-tenant unit of work:
//   • drainCaldav — drain the leaf's caldav_sync_queue via the ported ICS
//     builder + WebDAV pusher (ported from
//     gremion-ui/src/lib/server/calendar/caldav-sync.ts's drainCaldavQueue).
//
// There is NO notification tick (the governance notification-scheduler stays
// in the kernel — design §5, it imports ../governance/governance-db and is
// not calendar's concern) and NO dispatchDue/purgeTokens/resetStuck (those
// are newsletter/content concerns, not calendar's).
//
// Tick cadence: 30s (TICK_INTERVAL_MS), matching the kernel's CalDAV drain
// cron cadence ("*/30 * * * * *" in caldav-sync.ts) — CalDAV is push-only and
// the DB is always the source of truth, so a 30s cadence keeps clients that
// speak iCal reasonably fresh without hammering Nextcloud.
//
// ── SCHEDULER_ENABLED (§D.3 step-0 cutover hold) ──────────────────────────────
// The WHOLE tick is gated on SCHEDULER_ENABLED (default 'true'). When 'false',
// startScheduler() registers NO interval at all and logs ONE boot line — there
// is no tick, not even a no-op one. This is the cutover hold: during the
// leaf's step-0 deploy the scheduler is brought up with SCHEDULER_ENABLED=false
// so the monolith's cron-based worker keeps owning the CalDAV drain until we
// flip the flag.
//
// Dependency injection: listTenants + the drainCaldav work callback are
// injected so unit tests exercise the fleet/single-flight/gate logic with no
// PG and no timers. Production wires listTenants → tenant-store catalog and
// the work callback → a per-tenant storeFor(tenant) + drainCaldavQueue(sql).

import type { TenantRef } from './tenant-store.js'

// ── constants ──────────────────────────────────────────────────────────────────

/** Tick cadence — every 30 seconds (matches the kernel's CalDAV drain cron). */
export const TICK_INTERVAL_MS = 30_000

/** Single-flight / structured-log label (mirrors the worker-fleet label). */
const LABEL = 'calendar-scheduler'

// ── types ──────────────────────────────────────────────────────────────────────

/** Per-tenant unit-of-work callback. Receives the resolved tenant. */
export interface TickWork {
  /** Drain the leaf's caldav_sync_queue for this tenant. */
  drainCaldav(tenant: TenantRef): Promise<{ succeeded: number; failed: number }>
}

export interface SchedulerDeps {
  /** List the ACTIVE tenants to tick over (production → tenant catalog). */
  listTenants(): Promise<TenantRef[]>
  /** Per-tenant work callback. */
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
 * NEVER rejects: a listing failure is logged + swallowed, and each tenant's
 * drainCaldav call is wrapped in its own try/catch so one tenant's throw
 * never aborts the rest.
 *
 * @param deps  injected lister + work callback.
 */
export async function runSchedulerTick(deps: SchedulerDeps): Promise<void> {
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
      await runTenantTick(deps.work, tenant)
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

/** The per-tenant work: drain the CalDAV sync queue. */
async function runTenantTick(work: TickWork, tenant: TenantRef): Promise<void> {
  const { succeeded, failed } = await work.drainCaldav(tenant)
  if (failed > 0) {
    console.warn(
      `[${LABEL}] tenant ${tenant.slug} CalDAV drain: ${succeeded} succeeded, ${failed} failed`,
    )
  }
}

// ── start / stop ────────────────────────────────────────────────────────────────

/** Resolve the enabled flag: explicit option wins, else env (default true).
 *
 * H4 (per-service kill-switch split): a per-service CALENDAR_SCHEDULER_ENABLED,
 * when set to a NON-EMPTY value, wins over the shared SCHEDULER_ENABLED — so a
 * single leaf can be held (or re-enabled) independently of the fleet. An unset
 * OR empty per-service value (the compose `${CALENDAR_SCHEDULER_ENABLED:-}`
 * default) falls through to the shared flag, preserving byte-identical
 * back-compat: all vars unset → the exact base expression below.
 */
function resolveEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit
  const perService = process.env.CALENDAR_SCHEDULER_ENABLED
  if (perService !== undefined && perService !== '') {
    // Only the exact string 'false' disables; anything else → enabled.
    return perService !== 'false'
  }
  // Only the exact string 'false' disables; unset or anything else → enabled.
  return (process.env.SCHEDULER_ENABLED ?? 'true') !== 'false'
}

/**
 * Start the scheduler. When enabled, registers a 30s interval that ticks the
 * fleet's CalDAV drain. When disabled, registers NO interval and logs one
 * boot line (cutover hold).
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
        `The §D.3 step-0 cutover hold is active; set SCHEDULER_ENABLED=true to start draining CalDAV.`,
    )
    return { enabled: false, stop: () => {} }
  }

  const setIntervalFn = opts.setIntervalImpl ?? setInterval
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval
  const intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS

  console.log(`[${LABEL}] scheduler enabled — ticking every ${intervalMs}ms`)

  let ticking = false
  const timer = setIntervalFn(() => {
    // Guard against a tick that runs longer than the interval (defence in depth;
    // per-tenant single-flight already prevents per-tenant overlap).
    if (ticking) return
    ticking = true
    void runSchedulerTick(deps)
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
