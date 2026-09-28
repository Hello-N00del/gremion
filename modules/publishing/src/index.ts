// services/newsletter/src/index.ts
// Process entrypoint for the newsletter leaf service. Boots:
//   1. HTTP server (with all T9 API routes + /healthz/tenants).
//   2. Per-tenant scheduler tick (gated on SCHEDULER_ENABLED, default true).
//   3. NATS relay loop (gated on NATS_URL being set; absent → off + one boot log).
// Graceful shutdown (SIGTERM/SIGINT) stops all loops and the HTTP server.

import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { storeFor, listTenants, closeAllPools } from './tenant-store.js'
import { startScheduler } from './scheduler.js'
import { dispatch, resolveLinkBase, logLinkBaseResolution } from './dispatch.js'
import { createShutdown, resolveShutdownTimeoutMs } from './shutdown.js'
import { createRelaySupervisor, type RelaySupervisor } from './relay-supervisor.js'
import {
  resetStuckSending,
  getScheduledDueNewsletters,
  purgeSendTokensOlderThan90Days,
} from './store/index.js'
import { createKernelClient, type KernelClient } from './kernel-client.js'
import { NatsBroker } from './nats-broker.js'
import { runRelayPass } from './relay.js'
import type { MailTransport } from './dispatch.js'
import type { TenantRef, Sql } from './tenant-store.js'
import { makeLogTracer, noopTracer, type TracerPort } from '@gremion/ports/tracer'
import { STREAMS } from '@gremion/ports/broker'

/**
 * INTEGRATION-DELTA §1 (Option B2): production MailTransport is a thin adapter
 * over the per-tenant kernel send-mail callback. The leaf owns ZERO SMTP
 * transport resolution — it POSTs the rendered message and the kernel resolves
 * the per-tenant transport (SP-2) + per-tenant from-fields and sends. The
 * adapter just narrows the KernelClient.sendMail port to the MailTransport port
 * dispatch depends on.
 */
function kernelMailTransport(kernel: KernelClient): MailTransport {
  return {
    sendMail: (msg) => kernel.sendMail(msg),
  }
}

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
// 7s by default (compose's stop_grace_period is 10s, so a 10s timer raced the
// SIGKILL and the forced-exit log line lost). SHUTDOWN_TIMEOUT_MS overrides it —
// k8s gives this container 30s, compose gives it 10, and one constant cannot suit both.
const SHUTDOWN_TIMEOUT_MS = resolveShutdownTimeoutMs(process.env)

/**
 * End the process, naming the way out.
 *
 * Reached ONLY through `isRepointRefusal` — see below for why that is the one
 * class that may kill the leaf.
 *
 * This used to be caught, logged as "NATS connect failed — relay is OFF" and
 * survived: the leaf kept serving HTTP with its outbox draining nowhere, which
 * is indistinguishable from healthy until someone notices sends stopped. The
 * one failure an operator hits on the wire-root gitlink bump is
 * `ensureStream()` refusing to repoint a stream still on the retired root; its
 * message is emitted verbatim, because paraphrasing it loses the stream name
 * and both subject lists — the only things that say which stream to drain.
 */
function fatalBrokerFailure(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[newsletter] NATS relay failed to start: ${detail}`)
  console.error(
    '[newsletter] If that message is "[nats-broker] refusing to repoint stream …", the stream is still on the ' +
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


// Tenancy D1 HARDENING-3: this leaf sends NO hostname on its kernel callbacks,
// and holds none. `resolveApexDomain()` (which built `<slug>.<apexDomain>` from
// PUBLIC_BASE_URL) is deleted, and so is the `x-tenant-host` threading that
// briefly replaced it: the kernel selects a callback's tenant from the
// `x-tenant-id` this leaf already sends, authenticated by the same shared secret
// the callback route validates. That removed the one thing the SCHEDULER could
// not have — a host, with no inbound request to read it from — so a scheduled
// send no longer depends on some earlier request having taught this process a
// control-plane fact.

async function main(): Promise<void> {
  const secret = process.env.INTERNAL_NEWSLETTER_SECRET
  if (!secret) {
    // Boot anyway (health probe is exempt); every guarded route will 403.
    console.warn('[newsletter] INTERNAL_NEWSLETTER_SECRET is unset — all guarded routes will 403')
  }

  const kernelBaseUrl = process.env.KERNEL_BASE_URL ?? ''
  if (!kernelBaseUrl) {
    console.warn('[newsletter] KERNEL_BASE_URL is unset — send dispatch will fail at render step')
  }

  // The link base is the public root every link in a rendered newsletter is
  // built from, including the UNSUBSCRIBE link. The per-call localhost defaults
  // this replaced meant an unconfigured leaf silently mailed localhost-rooted
  // links to real subscribers — broken for every recipient, with no signal
  // anywhere. (The literal is spelled out in test/origin.test.ts, which forbids
  // it appearing in this file at all.)
  //
  // It does NOT get the "boot anyway, warn loudly" treatment that
  // KERNEL_BASE_URL and INTERNAL_NEWSLETTER_SECRET get above: those degrade to a
  // 403 or a failed render INSIDE the deployment, whereas a bad link base
  // produces a plausible-looking unsubscribe link in mail that has already left
  // the building. Resolved ONCE at boot, FAILING CLOSED (#394 posture, same as
  // finance's requireRuntimePgUrl).
  //
  // ORIGIN ?? PUBLIC_BASE_URL, not ORIGIN alone: ORIGIN is declared in no
  // compose file, no k8s manifest and no .env.example, so requiring it would
  // fail closed on EVERY deployment — a crash-loop under `restart:
  // unless-stopped`, not a guard. PUBLIC_BASE_URL is provisioned to
  // newsletter-service in docker-compose.yml and k8s/base/newsletter/
  // configmap.yaml. That configmap's comment calls PUBLIC_BASE_URL "inert for
  // tenancy", which remains true and is a DIFFERENT concern: this leaf resolves
  // a tenant from the x-tenant-id it sends (Tenancy D1 HARDENING-3 below), never
  // from a host. Building an absolute link is not tenant selection.
  //
  // RESIDUAL (design, pre-existing): this is ONE global link base in a
  // multi-tenant dispatcher whose unsubscribe route resolves the tenant from the
  // request host. A second tenant on a different host gets working-but-wrong
  // unsubscribe links. Tracked as a follow-up, not fixed here.
  const linkBase = resolveLinkBase(process.env, 'boot')
  logLinkBaseResolution(linkBase, {
    error: (msg) => console.error(msg),
    warn: (msg) => console.warn(msg),
    info: (msg) => console.log(msg),
  })
  // BOOT CONTINUES on an unusable base. Both values this repo provisions (in
  // docker-compose.yml and k8s/base/newsletter/configmap.yaml) are loopback, so
  // failing the boot closed here would crash-loop the leaf on the DEPLOYED
  // configuration and take down every route that sends
  // no mail at all — the /healthz probes, the list and recipient CRUD, the
  // outbox relay. The refusal belongs on the one operation the bad value
  // corrupts, and dispatch() enforces it before a single recipient is claimed.
  // What is carried forward is the RAW value: it re-fails the same check inside
  // dispatch(), so the leaf cannot accidentally send with a sanitised stand-in.
  const origin = linkBase.usable ? linkBase.base : linkBase.raw
  const allowLoopbackLinks = linkBase.usable && linkBase.loopbackOverride

  // F3 (T16): TRACE_EXPORTER — 'log' activates logTracer (default for the leaf);
  // anything else (incl. 'none') falls back to the behaviorally-silent noopTracer.
  // A factory is used so each dispatch/relay pass gets a tracer bound to THAT
  // request's correlation id (not a shared singleton with a stale id).
  const traceExporter = process.env.TRACE_EXPORTER ?? 'log'
  function makeTracer(correlationId: string): TracerPort {
    return traceExporter === 'log' ? makeLogTracer(correlationId) : noopTracer
  }

  // ── SMTP transport (Option B2) ─────────────────────────────────────────────────
  // The leaf has NO SMTP env and NO leaf-local transport: every send goes through
  // the per-tenant kernel send-mail callback (see kernelMailTransport above). The
  // transport is built PER tenant alongside that tenant's kernel client so it
  // forwards the correct tenant headers; tests inject their own MailTransport.

  // ── API routes ───────────────────────────────────────────────────────────────
  // D-P1-1: pure node:http — no web framework.
  // sendDeps is the factory for dispatch dependencies used by the send route.
  const routes = buildApiRoutes(
    (tenant) => storeFor(tenant),
    {
      // F2 (T16): correlationId is now passed by the send route (read-or-minted
      // from the inbound x-correlation-id header) instead of a hard-coded 'send'.
      dispatchDeps: (tenant: TenantRef, sql: Sql, correlationId: string) => {
        const kernel = createKernelClient({
          baseUrl: kernelBaseUrl,
          secret: secret ?? '',
          tenant,
          correlationId,
        })
        return {
          sql,
          kernel,
          transport: kernelMailTransport(kernel),
          origin,
          allowLoopbackLinks,
          correlationId,
          tracer: makeTracer(correlationId),
        }
      },
    },
  )

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
    console.log(`[newsletter] listening on :${PORT}`)
  })

  // ── Scheduler ────────────────────────────────────────────────────────────────
  // Gated on SCHEDULER_ENABLED (default true); §D.3 step-0 cutover hold.
  // Per-tenant work: resetStuck → dispatchDue → purgeTokens.
  // IMPORTANT: storeFor() returns a per-tenant pool — NEVER share across tenants.
  const schedulerHandle = startScheduler({
    listTenants: () => listTenants(),
    work: {
      async resetStuck(tenant: TenantRef): Promise<void> {
        const sql = await storeFor(tenant)
        const n = await resetStuckSending(sql, 30)
        if (n > 0) {
          console.info(`[scheduler] tenant ${tenant.slug}: reset ${n} stuck newsletters`)
        }
      },
      async dispatchDue(tenant: TenantRef): Promise<void> {
        const sql = await storeFor(tenant)
        const due = await getScheduledDueNewsletters(sql)
        for (const nl of due) {
          // Scheduler-initiated dispatches have no HTTP context — mint a fresh UUID.
          const { randomUUID } = await import('node:crypto')
          const corrId = randomUUID()
          const kernel = createKernelClient({
            baseUrl: kernelBaseUrl,
            secret: secret ?? '',
            tenant,
            correlationId: corrId,
            // Tenancy D1 HARDENING-3: nothing host-shaped. This call site is the
            // reason the hardening exists — the scheduler has no inbound request,
            // so it could only ever have used a host some EARLIER request had
            // taught this process. It sends the tenant id, which it always has.
          })
          await dispatch(tenant, nl.id, 'scheduler', {
            sql,
            kernel,
            transport: kernelMailTransport(kernel),
            origin,
            allowLoopbackLinks,
            correlationId: corrId,
            tracer: makeTracer(corrId),
          }).catch((err) => {
            console.error(
              `[scheduler] dispatch failed newsletter #${nl.id} (${tenant.slug}):`,
              err instanceof Error ? err.message : String(err),
            )
          })
        }
      },
      async purgeTokens(tenant: TenantRef): Promise<void> {
        const sql = await storeFor(tenant)
        await purgeSendTokensOlderThan90Days(sql)
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
          '[newsletter] NATS broker close failed — the connection may be leaked until the process ' +
            `exits: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  if (!natsUrl) {
    console.warn('[newsletter] NATS_URL is unset — relay loop is OFF (staging-safe)')
  } else {
    const startRelay = async (): Promise<void> => {
        // WP-A: bind the NEWSLETTER stream explicitly by descriptor (behaviourally
        // identical to the pre-WP-A connect(url)/ensureStream() defaults) so every
        // leaf targets its domain's stream via the shared STREAMS topology.
        natsBroker = await NatsBroker.connect(natsUrl, STREAMS.NEWSLETTER.name)
        await natsBroker.ensureStream(STREAMS.NEWSLETTER.name, STREAMS.NEWSLETTER.subjects)
        const RELAY_INTERVAL_MS = 30_000
        console.log(`[newsletter] NATS relay connected — draining outbox every ${RELAY_INTERVAL_MS}ms`)

        relayTimer = setInterval(() => {
          void (async () => {
            try {
              const tenants = await listTenants()
              for (const tenant of tenants) {
                const sql = await storeFor(tenant)
                // F3: wire relay tracer (per-pass mint so relay spans are traceable).
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
      name: 'newsletter',
      start: startRelay,
      teardown: teardownRelay,
      isUnretryable: isRepointRefusal,
      onUnretryable: fatalBrokerFailure,
    })

    await relaySupervisor.start()
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // The drain is AWAITED inside the helper, bounded by the forced-exit timer.
  // Round 3 issued the evicted-pool drain fire-and-forget here and exited from the
  // server.close callback on the next tick, so sql.end() never finished and the
  // pools died by the TCP reset the drain existed to prevent. closeAllPools()
  // ends the LIVE tenant pools too, not only the capacity-evicted ones.
  const shutdown = createShutdown({
    name: 'newsletter',
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
  console.error('[newsletter] fatal boot error:', err)
  process.exit(1)
})
