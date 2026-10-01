// services/content/src/scheduler.ts
//
// Task 20: per-tenant scheduler tick for the content leaf.
//
// Mirrors services/newsletter/src/scheduler.ts but adapted for the content
// publish pipeline:
//
// Per-tenant work, in order:
//   0. resetStuck         — F1-FIX-07 K5#6 / S4#8: a whole-post dispatch that
//                           died mid-flight left its post 'sending' (which
//                           claimPostForPublish never re-claims) forever. Posts
//                           'sending' for STUCK_PUBLISHING_MINUTES go to
//                           'failed', so a re-dispatch can claim them again
//                           (per-recipient deliveries keep it double-send-safe).
//   1. dispatchDue        — publish scheduled posts whose scheduled_at <= now().
//   2. drainPublishOps    — Instagram L3 reconcile loop.
//   3. purgeTokens        — WEEKLY only (withPurge): delete send tokens for
//                           content sent >90d ago.
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
// callbacks → dispatch()/drainPublishOps()/purgeSendTokensOlderThan90Days().

import type { TenantRef, Sql } from './tenant-store.js'
import type { KernelClient } from './kernel-client.js'
import type { ChannelTransport } from './dispatch.js'
import type { TracerPort } from '@gremion/ports/tracer'
import { publishChannel } from './publish-channel.js'
import { listDueScheduledChannels, resetStuckPublishing } from './store/index.js'

// ── constants ──────────────────────────────────────────────────────────────────

/** Tick cadence — one tick per minute. */
export const TICK_INTERVAL_MS = 60_000

/**
 * A post 'sending' for longer than this is treated as a dead dispatch (30 min,
 * as in the newsletter leaf). Twice the 15-minute stale-claim window, so a live
 * dispatch's per-recipient claims are already stale-takeable when it is reset.
 */
export const STUCK_PUBLISHING_MINUTES = 30

/** Run the weekly token purge every Nth tick (60s × 10080 = 7 days). */
export const PURGE_EVERY_TICKS = 7 * 24 * 60

/** Single-flight / structured-log label (mirrors the worker-fleet label). */
const LABEL = 'content-scheduler'

// ── types ──────────────────────────────────────────────────────────────────────

/** Per-tenant unit-of-work callbacks. Each receives the resolved tenant. */
export interface TickWork {
  /** Reset posts stuck in 'sending' (dead dispatch) to 'failed' — runs first. */
  resetStuck(tenant: TenantRef): Promise<void>
  /** Dispatch every due 'scheduled' content post for this tenant. */
  dispatchDue(tenant: TenantRef): Promise<void>
  /** Instagram L3 reconcile loop: drain pending publish ops. */
  drainPublishOps(tenant: TenantRef): Promise<void>
  /** Weekly: purge send tokens for content sent >90d ago. */
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
  // 0. Un-stick dead whole-post dispatches (K5#6). Its failure is logged and
  //    never blocks this tenant's due publishes.
  await work.resetStuck(tenant).catch((err: unknown) => {
    console.error(
      `[${LABEL}] tenant ${tenant.slug} stuck-publish reset failed:`,
      err instanceof Error ? err.message : String(err),
    )
  })
  // 1. Dispatch due scheduled content posts.
  await work.dispatchDue(tenant)
  // 2. Instagram L3 reconcile loop.
  await work.drainPublishOps(tenant)
  // 3. Weekly token purge.
  if (withPurge) {
    await work.purgeTokens(tenant)
  }
}

// ── stuck whole-post dispatch reset (K5#6 / S4#8) ──────────────────────────────

/**
 * Flip this tenant's posts stuck in 'sending' for STUCK_PUBLISHING_MINUTES to
 * 'failed' (the production TickWork.resetStuck). Logs how many were reset.
 */
export async function resetStuckDispatches(tenant: TenantRef, sql: Sql): Promise<number> {
  const n = await resetStuckPublishing(sql, STUCK_PUBLISHING_MINUTES)
  if (n > 0) {
    console.warn(
      `[${LABEL}] tenant ${tenant.slug}: ${n} post(s) stuck in 'sending' for ` +
        `>${STUCK_PUBLISHING_MINUTES} min reset to 'failed' (re-dispatchable)`,
    )
  }
  return n
}

// ── due-channel dispatch (A1: key off post_channels, not posts.status) ──────────

export interface DispatchDueDeps {
  /** Per-tenant postgres-js Sql (from storeFor(tenant)). */
  sql: Sql
  /** Kernel callback client (resolveGroup + sendMail + portalPublish). */
  kernel: KernelClient
  /** Email transport (the kernel send-mail adapter) — used by the email channel. */
  emailTransport: ChannelTransport
  /** This tenant's external origin for unsubscribe links (no trailing slash). */
  origin: string
  /** Local development only: accept a loopback origin (K5#8). */
  allowLoopbackLinks?: boolean
  /**
   * Whether Instagram is configured (resolveInstagramCredentials() != null).
   * When false, a scheduled instagram channel is SKIPPED (disabled-by-default) —
   * left armed until credentials are provisioned, rather than churning the drain.
   */
  instagramConfigured: boolean
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
}

/**
 * Publish every DUE scheduled channel for one tenant.
 *
 * A1: keys off content.post_channels (enabled=true, status='scheduled',
 * scheduled_at<=now()) — the rows the per-channel arm path
 * (PATCH /posts/:id/channels/:channel) writes — NOT content.posts.status, which
 * that path never sets. Each due channel is published via publishChannel(), which
 * advances post_channels.status (email→'sent', portal→'published') and writes the
 * delivery / publication row.
 *
 * Instagram is disabled-by-default: a scheduled instagram channel is skipped
 * unless instagramConfigured is true. One channel's failure never aborts the rest.
 */
export async function dispatchDueChannels(
  tenant: TenantRef,
  deps: DispatchDueDeps,
): Promise<void> {
  const due = await listDueScheduledChannels(deps.sql)
  for (const { post_id, channel } of due) {
    if (channel === 'instagram' && !deps.instagramConfigured) {
      // Disabled-by-default seam: leave the channel armed until IG is provisioned.
      continue
    }
    await publishChannel(tenant, post_id, channel, {
      sql: deps.sql,
      kernel: deps.kernel,
      emailTransport: deps.emailTransport,
      origin: deps.origin,
      allowLoopbackLinks: deps.allowLoopbackLinks,
      // A scheduled tick has no inbound x-correlation-id header, so the scheduler
      // is the origin of this publish: correlate the co-committed outbox row (and
      // downstream NATS envelope) explicitly on the postId rather than leaning on
      // publishChannel's implicit `?? postId` fallback.
      correlationId: post_id,
      tracer: deps.tracer,
    }).catch((err) => {
      console.error(
        `[${LABEL}] scheduled publish failed for post ${post_id} channel ${channel} (${tenant.slug}):`,
        err instanceof Error ? err.message : String(err),
      )
    })
  }
}

// ── start / stop ────────────────────────────────────────────────────────────────

/** Resolve the enabled flag: explicit option wins, else env (default true).
 *
 * H4 (per-service kill-switch split): a per-service CONTENT_SCHEDULER_ENABLED,
 * when set to a NON-EMPTY value, wins over the shared SCHEDULER_ENABLED — so a
 * single leaf can be held (or re-enabled) independently of the fleet. An unset
 * OR empty per-service value (the compose `${CONTENT_SCHEDULER_ENABLED:-}`
 * default) falls through to the shared flag, preserving byte-identical
 * back-compat: all vars unset → the exact base expression below.
 */
function resolveEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit
  const perService = process.env.CONTENT_SCHEDULER_ENABLED
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
