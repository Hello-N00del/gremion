// services/calendar/src/index.ts
// Process entrypoint for the calendar leaf service. Boots:
//   1. HTTP server (with all /api/v1/* routes + /healthz/tenants).
//   2. Per-tenant scheduler tick (CalDAV drain; gated on SCHEDULER_ENABLED,
//      default true — §D.3 step-0 cutover hold).
//   3. NATS relay loop (gated on NATS_URL being set; absent → off + one boot log).
// Graceful shutdown (SIGTERM/SIGINT) stops all loops and the HTTP server.
//
// D6 (thin leaf): there is NO dispatch/mail pipeline here (that is the
// newsletter leaf's concern) and NO kernel callback (design §8 — CalDAV is
// direct; kernel-client.ts exposes only the SP-3 header-plumbing seam, unused
// today). The kernel-client import + KERNEL_BASE_URL env are still read (per
// the brief) so the seam is wired for a future callback, but nothing calls it.

import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { storeFor, listTenants, closeAllPools } from './tenant-store.js'
import { createShutdown, resolveShutdownTimeoutMs } from './shutdown.js'
import { createRelaySupervisor, type RelaySupervisor } from './relay-supervisor.js'
import { startScheduler } from './scheduler.js'
import { drainCaldavQueue } from './caldav/sync.js'
import { NatsBroker } from './nats-broker.js'
import { runRelayPass } from './relay.js'
import type { TenantRef } from './tenant-store.js'
import { makeLogTracer, noopTracer, type TracerPort } from '@gremion/ports/tracer'
import { STREAMS } from '@gremion/ports/broker'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
// 7s by default (compose's stop_grace_period is 10s, so a 10s timer raced the
// SIGKILL and the forced-exit log line lost). SHUTDOWN_TIMEOUT_MS overrides it —
// k8s gives this container 30s, compose gives it 10, and one constant cannot suit both.
const SHUTDOWN_TIMEOUT_MS = resolveShutdownTimeoutMs(process.env)
const RELAY_INTERVAL_MS = 30_000

/**
 * End the process, naming the way out.
 *
 * Reached ONLY through `isRepointRefusal` — see below for why that is the one
 * class that may kill the leaf.
 *
 * This used to be caught, logged as "NATS connect failed — relay is OFF" and
 * survived: the leaf kept serving HTTP with its outbox draining nowhere, which
 * is indistinguishable from healthy until someone notices events stopped. The
 * one failure an operator hits on the wire-root gitlink bump is
 * `ensureStream()` refusing to repoint a stream still on the retired root; its
 * message is emitted verbatim, because paraphrasing it loses the stream name
 * and both subject lists — the only things that say which stream to drain.
 */
function fatalBrokerFailure(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[calendar] NATS relay failed to start: ${detail}`)
  console.error(
    '[calendar] If that message is "[nats-broker] refusing to repoint stream …", the stream is still on the ' +
      'retired wire root. Run `pnpm nats:migrate-streams` against this deployment BEFORE redeploying the leaves ' +
      '(docs/runbooks/netcup-cutover.md, "Migrating the wire-subject root"). Exiting.',
  )
  process.exit(1)
}

/**
 * The ONE broker failure that must end this process.
 *
 * `ensureStream()` refuses to repoint a stream whose filter still holds the
 * retired wire root, and `subscribe()` refuses a pattern the bound stream does
 * not cover. Both refusals are terminal by construction: no amount of retrying
 * clears them, because clearing them is an OPERATOR action (drain the stream,
 * then `pnpm nats:migrate-streams`). Staying up on those would mean serving
 * HTTP with the outbox draining nowhere, which is indistinguishable from
 * healthy until someone notices the events stopped.
 *
 * Everything ELSE a broker throws is transient by construction — the broker is
 * thirty seconds behind the leaves in a `compose up`, DNS is not up yet, the
 * broker restarted during a deploy. Round 2 exited on those too, and compose's
 * `restart: unless-stopped` then crash-looped this container against a NATS
 * that was about to come back on its own, taking the leaf's whole HTTP surface
 * with it. Those are retried, bounded, with the relay OFF in between.
 */
function isRepointRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.name === 'StreamCoverError' ||
    err.message.includes('refusing to repoint stream') ||
    err.message.includes('does not cover subscription')
  )
}


// Tenancy D1 HARDENING-3: there is nothing host-shaped in this leaf either.
// `resolveApexDomain()` is deleted, and no `x-tenant-host` threading replaced
// it: a kernel callback selects its tenant from `x-tenant-id`. This leaf makes
// no kernel callback at all today (design §8, CalDAV-direct) and nothing
// constructs its kernel-client in production; kernel-client.ts carries the
// contract for whoever adds the first real one.

async function main(): Promise<void> {
  const secret = process.env.INTERNAL_CALENDAR_SECRET
  if (!secret) {
    // Boot anyway (health probe is exempt); every guarded route will 403.
    console.warn('[calendar] INTERNAL_CALENDAR_SECRET is unset — all guarded routes will 403')
  }

  const kernelBaseUrl = process.env.KERNEL_BASE_URL ?? ''
  if (!kernelBaseUrl) {
    console.warn('[calendar] KERNEL_BASE_URL is unset (no callback is made today; reserved for future use)')
  }

  // TRACE_EXPORTER — 'log' activates logTracer (default for the leaf);
  // anything else (incl. 'none') falls back to the behaviorally-silent noopTracer.
  // A factory is used so each relay pass gets a tracer bound to THAT pass's
  // correlation id (not a shared singleton with a stale id).
  const traceExporter = process.env.TRACE_EXPORTER ?? 'log'
  function makeTracer(correlationId: string): TracerPort {
    return traceExporter === 'log' ? makeLogTracer(correlationId) : noopTracer
  }

  // ── API routes ───────────────────────────────────────────────────────────────
  // D-P1-1: pure node:http — no web framework.
  const routes = buildApiRoutes((tenant) => storeFor(tenant))

  // ── HTTP server ──────────────────────────────────────────────────────────────
  const server = createServer({
    secret,
    routes,
    healthz: {
      listTenants: () => listTenants(),
      storeFn: (tenant) => storeFor(tenant),
    },
  })

  server.listen(PORT, () => {
    console.log(`[calendar] listening on :${PORT}`)
  })

  // ── Scheduler (CalDAV drain) ──────────────────────────────────────────────────
  // Gated on SCHEDULER_ENABLED (default true); §D.3 step-0 cutover hold.
  // IMPORTANT: storeFor() returns a per-tenant pool — NEVER share across tenants.
  const schedulerHandle = startScheduler({
    listTenants: () => listTenants(),
    work: {
      async drainCaldav(tenant: TenantRef): Promise<{ succeeded: number; failed: number }> {
        const sql = await storeFor(tenant)
        return drainCaldavQueue(sql)
      },
    },
  })

  // ── NATS relay loop ──────────────────────────────────────────────────────────
  // Gated on NATS_URL. Absent → relay is OFF (staging-safe; one boot log line).
  const natsUrl = process.env.NATS_URL
  let relayTimer: ReturnType<typeof setInterval> | null = null
  // The BROKER-RETRY ladder lives in relay-supervisor.ts, byte-identical across
  // the three leaves. It was a closure inside main(): nothing could observe the
  // retry timer, so the shutdown seam that clears it had no coverage, and the
  // catch branch re-armed a timer even after before() had run.
  let relaySupervisor: RelaySupervisor | null = null
  let natsBroker: NatsBroker | null = null

  /**
   * Drop whatever an attempt left open — the relay interval FIRST, then the
   * broker: a tick that starts after the broker is nulled would dereference it.
   * A close that rejects is LOGGED; a swallowed one hides a leaked connection.
   */
  const teardownRelay = (): void => {
    if (relayTimer !== null) {
      clearInterval(relayTimer)
      relayTimer = null
    }
    if (natsBroker !== null) {
      const dying = natsBroker
      natsBroker = null
      void dying.close().catch((err: unknown) => {
        console.warn(
          '[calendar] NATS broker close failed — the connection may be leaked until the process ' +
            `exits: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  if (!natsUrl) {
    console.warn('[calendar] NATS_URL is unset — relay loop is OFF (staging-safe)')
  } else {
    const startRelay = async (): Promise<void> => {
        // WP-A: publish calendar events to the CALENDAR stream (not the NEWSLETTER
        // default) so the leaf's gremion.<t>.calendar.> subjects land in a matching
        // stream and the relay does not hit "no stream matches subject" at boot.
        natsBroker = await NatsBroker.connect(natsUrl, STREAMS.CALENDAR.name)
        await natsBroker.ensureStream(STREAMS.CALENDAR.name, STREAMS.CALENDAR.subjects)
        console.log(`[calendar] NATS relay connected — draining outbox every ${RELAY_INTERVAL_MS}ms`)

        relayTimer = setInterval(() => {
          void (async () => {
            try {
              const tenants = await listTenants()
              for (const tenant of tenants) {
                const sql = await storeFor(tenant)
                // Per-pass tracer mint so relay spans are traceable.
                const { randomUUID: relayUUID } = await import('node:crypto')
                const relayTracer = makeTracer(relayUUID())
                await runRelayPass(sql, tenant.id, natsBroker!, { tracer: relayTracer }).catch((err) => {
                  console.error(
                    `[relay] pass failed tenant ${tenant.slug}:`,
                    err instanceof Error ? err.message : String(err),
                  )
                })
              }
            } catch (err) {
              console.error('[relay] tick error:', err instanceof Error ? err.message : String(err))
            }
          })()
        }, RELAY_INTERVAL_MS)

        if (typeof (relayTimer as { unref?: () => void }).unref === 'function') {
          ;(relayTimer as { unref: () => void }).unref()
        }
    }

    relaySupervisor = createRelaySupervisor({
      name: 'calendar',
      start: startRelay,
      teardown: teardownRelay,
      isUnretryable: isRepointRefusal,
      onUnretryable: fatalBrokerFailure,
    })

    await relaySupervisor.start()
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // The drain is AWAITED inside the helper, bounded by the forced-exit timer.
  // This leaf never called the pool drain at all before R4: drainEvictedPools()
  // was exported and never invoked, and process.exit() never emits 'beforeExit',
  // so the store's drain-on-exit hook was structurally unreachable here.
  // closeAllPools() ends the LIVE tenant pools too, not only the evicted ones.
  const shutdown = createShutdown({
    name: 'calendar',
    server,
    drain: () => closeAllPools(),
    exit: (code) => process.exit(code),
    forceAfterMs: SHUTDOWN_TIMEOUT_MS,
    before: () => {
      schedulerHandle.stop()
      // ONE call: the supervisor cancels a pending broker retry, refuses to arm
      // another, and tears down the relay interval plus the broker. A backoff
      // window that straddles SIGTERM used to reconnect behind the drain.
      relaySupervisor?.stop()
    },
  })

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[calendar] fatal boot error:', err)
  process.exit(1)
})
