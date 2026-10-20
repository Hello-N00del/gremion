// services/content/src/index.ts
// Process entrypoint for the content leaf service. Boots:
//   1. HTTP server (with all Task-21 API routes + /healthz/tenants).
//   2. Per-tenant scheduler tick (gated on SCHEDULER_ENABLED, default true).
//   3. NATS relay loop (gated on NATS_URL being set; absent → off + one boot log).
// Graceful shutdown (SIGTERM/SIGINT) stops all loops and the HTTP server.

import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { buildAdminRoutes } from './http/admin-routes.js'
import { storeFor, listTenants, closeAllPools } from './tenant-store.js'
import { createShutdown, resolveShutdownTimeoutMs } from './shutdown.js'
import { createRelaySupervisor, type RelaySupervisor } from './relay-supervisor.js'
import { startScheduler, dispatchDueChannels, resetStuckDispatches } from './scheduler.js'
import { purgeSendTokensOlderThan90Days } from './store/index.js'
import { resolveInstagramCredentials } from './instagram/credentials.js'
import { resolveContentLinkBase } from './link-base.js'
import { createKernelClient, type KernelClient } from './kernel-client.js'
import { NatsBroker } from './nats-broker.js'
import { runRelayPass } from './relay.js'
import { runRelayTick } from './relay-tick.js'
import { drainInstagramPublishOps } from './instagram/drain.js'
import type { DispatchDeps } from './dispatch.js'
import type { TenantRef, Sql } from './tenant-store.js'
import { makeLogTracer, noopTracer, type TracerPort } from '@gremion/ports/tracer'
import { STREAMS } from '@gremion/ports/broker'
import type { ChannelTransport } from './dispatch.js'

/**
 * Production email ChannelTransport: thin adapter over the per-tenant kernel
 * send-mail callback. The leaf owns ZERO SMTP transport resolution — it POSTs
 * the rendered message and the kernel resolves the per-tenant transport + sends.
 */
function kernelEmailTransport(kernel: KernelClient): ChannelTransport {
  return {
    send: (msg) =>
      kernel.sendMail({
        to: msg.to ?? '',
        subject: msg.subject ?? '',
        html: msg.html ?? '',
      }).then((r) => ({ id: r.messageId })),
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
 * is indistinguishable from healthy until someone notices events stopped. The
 * one failure an operator hits on the wire-root gitlink bump is
 * `ensureStream()` refusing to repoint a stream still on the retired root; its
 * message is emitted verbatim, because paraphrasing it loses the stream name
 * and both subject lists — the only things that say which stream to drain.
 */
function fatalBrokerFailure(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[content] NATS relay failed to start: ${detail}`)
  console.error(
    '[content] If that message is "[nats-broker] refusing to repoint stream …", the stream is still on the ' +
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
//
// PUBLIC_BASE_URL is still read below for `origin` — that is a rendering
// concern (link building), not a tenant selector, and is unchanged.

async function main(): Promise<void> {
  const secret = process.env.INTERNAL_CONTENT_SECRET
  if (!secret) {
    console.warn('[content] INTERNAL_CONTENT_SECRET is unset — all guarded routes will 403')
  }

  const kernelBaseUrl = process.env.KERNEL_BASE_URL ?? ''
  if (!kernelBaseUrl) {
    console.warn('[content] KERNEL_BASE_URL is unset — dispatch will fail at publish step')
  }

  // K5#8 / K5#33: the unsubscribe link base. No localhost default any more: an
  // unusable value is reported ONCE at boot and every email publish then fails
  // closed (publishChannel/dispatch re-check it) instead of mailing dead links.
  const linkBaseRaw = process.env.PUBLIC_BASE_URL ?? ''
  const allowLoopbackLinks = process.env.CONTENT_ALLOW_LOOPBACK_LINKS === '1'
  const linkBase = resolveContentLinkBase(process.env)
  if (linkBase.usable) {
    console.log(`[content] unsubscribe links use ${linkBase.base}`)
  } else {
    console.error(
      `[content] ${linkBase.reason} — every EMAIL publish will fail until PUBLIC_BASE_URL is this ` +
        `deployment's public origin (e.g. https://example.org). Portal and Instagram are unaffected.`,
    )
  }

  // F3: TRACE_EXPORTER — 'log' activates logTracer; anything else → noopTracer.
  const traceExporter = process.env.TRACE_EXPORTER ?? 'log'
  function makeTracer(correlationId: string): TracerPort {
    return traceExporter === 'log' ? makeLogTracer(correlationId) : noopTracer
  }

  // ── API routes ───────────────────────────────────────────────────────────────
  const routes = buildApiRoutes(
    (tenant) => storeFor(tenant),
    {
      dispatchDeps: (tenant: TenantRef, sql: Sql, correlationId: string): DispatchDeps => {
        const kernel = createKernelClient({
          baseUrl: kernelBaseUrl,
          secret: secret ?? '',
          tenant,
          correlationId,
        })
        // Production channels: email via kernel (Option B2). Portal + instagram
        // via kernel.portalPublish / dispatch internals. Channel transports are
        // NO-OP placeholders for portal/instagram (dispatch wires the real call).
        const portalTransport: ChannelTransport = { send: async () => ({ id: '' }) }
        const channels = new Map<'email' | 'portal' | 'instagram', ChannelTransport>([
          ['email', kernelEmailTransport(kernel)],
          ['portal', portalTransport],
          // Instagram disabled-by-default: not in channels map until credentials
          // are explicitly provisioned (activation is separately ticketed).
        ])
        return {
          sql,
          kernel,
          channels,
          origin: linkBaseRaw,
          allowLoopbackLinks,
          correlationId,
          tracer: makeTracer(correlationId),
        }
      },
    },
  )

  // ── Admin routes (secret-only, no tenant headers — tenant teardown) ─────────
  const adminRoutes = buildAdminRoutes({
    secret,
    pgUrl: process.env.CONTENT_PG_URL,
  })

  // ── HTTP server ──────────────────────────────────────────────────────────────
  const server = createServer({
    secret,
    routes,
    adminRoutes,
    healthz: {
      listTenants: () => listTenants(),
      storeFn: (tenant) => storeFor(tenant),
    },
  })

  server.listen(PORT, () => {
    console.log(`[content] listening on :${PORT}`)
  })

  // ── Scheduler ────────────────────────────────────────────────────────────────
  // Gated on SCHEDULER_ENABLED (default true).
  // Per-tenant work: resetStuck → dispatchDue → drainPublishOps → purgeTokens.
  const schedulerHandle = startScheduler({
    listTenants: () => listTenants(),
    work: {
      async resetStuck(tenant: TenantRef): Promise<void> {
        // K5#6: a whole-post dispatch that died mid-flight no longer pins its
        // post in 'sending' forever.
        await resetStuckDispatches(tenant, await storeFor(tenant))
      },
      async dispatchDue(tenant: TenantRef): Promise<void> {
        const sql = await storeFor(tenant)
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
        // A1: publish every DUE scheduled post_channel (email/portal), keyed off
        // content.post_channels — NOT content.posts.status. publishChannel advances
        // each channel's status. Instagram stays disabled-by-default until its
        // credentials are provisioned.
        await dispatchDueChannels(tenant, {
          sql,
          kernel,
          emailTransport: kernelEmailTransport(kernel),
          origin: linkBaseRaw,
          allowLoopbackLinks,
          instagramConfigured: resolveInstagramCredentials() != null,
          tracer: makeTracer(corrId),
        })
      },
      async drainPublishOps(tenant: TenantRef): Promise<void> {
        const sql = await storeFor(tenant)
        // Instagram drain (disabled-by-default — NotConfigured seam marks ops failed).
        await drainInstagramPublishOps(sql).catch((err) => {
          console.error(
            `[scheduler] IG drain failed (${tenant.slug}):`,
            err instanceof Error ? err.message : String(err),
          )
        })
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
          '[content] NATS broker close failed — the connection may be leaked until the process ' +
            `exits: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  if (!natsUrl) {
    console.warn('[content] NATS_URL is unset — relay loop is OFF (staging-safe)')
  } else {
    const startRelay = async (): Promise<void> => {
        // WP-A: publish content events to the CONTENT stream (not the NEWSLETTER
        // default) so the leaf's gremion.<t>.content.> subjects land in a matching
        // stream and the relay does not hit "no stream matches subject" at boot.
        natsBroker = await NatsBroker.connect(natsUrl, STREAMS.CONTENT.name)
        await natsBroker.ensureStream(STREAMS.CONTENT.name, STREAMS.CONTENT.subjects)
        const RELAY_INTERVAL_MS = 30_000
        console.log(`[content] NATS relay connected — draining outbox every ${RELAY_INTERVAL_MS}ms`)

        relayTimer = setInterval(() => {
          void (async () => {
            try {
              // Per-tenant isolation lives in runRelayTick: one tenant's store refusal
              // (TenantIdentityMismatchError, ...) skips that tenant only.
              await runRelayTick({
                listTenants: () => listTenants(),
                storeFn: (tenant) => storeFor(tenant),
                pass: async (sql, tenant) => {
                  const { randomUUID: relayUUID } = await import('node:crypto')
                  const relayTracer = makeTracer(relayUUID())
                  await runRelayPass(sql, tenant.id, natsBroker!, { tracer: relayTracer }).catch((err) => {
                    console.error(
                      `[relay] pass failed tenant ${tenant.slug}:`,
                      err instanceof Error ? err.message : String(err),
                    )
                  })
                },
              })
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
      name: 'content',
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
    name: 'content',
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
  console.error('[content] fatal boot error:', err)
  process.exit(1)
})
