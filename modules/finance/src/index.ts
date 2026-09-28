// services/finance/src/index.ts
// Process entrypoint for the finance leaf service. Boots the HTTP server (the
// FinanceBackend route surface + the guard-exempt /healthz and /healthz/tenants
// probes) and — #383 Lane E1 — the org-unit mirror CONSUMER: when NATS_URL is set
// it connects a NatsBroker bound to the ORGUNIT stream and applies kernel org-unit
// change events to each tenant's finance.org_unit_mirror. Absent NATS_URL the
// consumer stays off (staging-safe until the cutover wires compose). Graceful
// shutdown on SIGTERM/SIGINT.

import { STREAMS } from '@gremion/ports/broker'
import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { storeFor, listTenants, closeAllPools } from './tenant-store.js'
import { createShutdown, resolveShutdownTimeoutMs } from './shutdown.js'
import {
  startOrgUnitConsumer,
  sqlOrgUnitMirrorStore,
  type LeafBroker,
  type OrgUnitConsumerHandle,
  type OrgUnitMirrorStore,
} from './org-unit-consumer.js'
import { createConsumerSupervisor, type ConsumerSupervisor } from './consumer-supervisor.js'
import { stopOrgUnitConsumer } from './stop-consumer.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
// 7s by default (compose's stop_grace_period is 10s, so a 10s timer raced the
// SIGKILL and the forced-exit log line lost). SHUTDOWN_TIMEOUT_MS overrides it —
// k8s gives this container 30s, compose gives it 10, and one constant cannot suit both.
const SHUTDOWN_TIMEOUT_MS = resolveShutdownTimeoutMs(process.env)

/**
 * End the process, naming the way out.
 *
 * Reached ONLY through `isRepointRefusal` — see below for why that is the one
 * class that may kill the leaf. The server's message is emitted verbatim
 * (paraphrasing it loses the stream name and the subject lists the operator
 * needs), followed by the command that fixes it.
 */
function fatalBrokerFailure(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[finance] org-unit consumer failed to start: ${detail}`)
  console.error(
    '[finance] If that message is "[nats-broker] refusing to repoint stream …", the stream is still on the ' +
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
 * HTTP with the org-unit mirror silently frozen at whatever the kernel last
 * managed to publish.
 *
 * Everything ELSE a broker throws is transient by construction — the broker is
 * thirty seconds behind the leaves in a `compose up`, DNS is not up yet, the
 * broker restarted during a deploy. Round 2 exited on those too, and compose's
 * `restart: unless-stopped` then crash-looped this container against a NATS
 * that was about to come back on its own, taking the leaf's whole HTTP surface
 * with it. Those are retried, bounded, with the consumer OFF in between.
 */
function isRepointRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.name === 'StreamCoverError' ||
    err.message.includes('refusing to repoint stream') ||
    err.message.includes('does not cover subscription')
  )
}

// The backoff table and the attempt cap live in ./consumer-supervisor.ts, with
// the ladder that walks them. Round 3 kept them here beside a ladder that
// governed only the BOOT catch, while the mid-life path restarted immediately
// with the counter reset — the log line promised a bounded schedule the code did
// not have.

/**
 * Resolve the mirror store for an envelope's tenant UUID: the leaf's per-tenant
 * store → a sqlOrgUnitMirrorStore. An unknown tenant (not in the leaf catalog)
 * resolves to undefined → the consumer ack-skips it.
 */
async function resolveMirrorStore(tenantId: string): Promise<OrgUnitMirrorStore | undefined> {
  const tenant = (await listTenants()).find((t) => t.id === tenantId)
  if (tenant === undefined) return undefined
  return sqlOrgUnitMirrorStore(await storeFor(tenant))
}

function main(): void {
  const secret = process.env.INTERNAL_FINANCE_SECRET
  if (!secret) {
    console.warn('[finance] INTERNAL_FINANCE_SECRET is unset — all guarded routes will 403')
  }

  const storeFn = (tenant: Parameters<typeof storeFor>[0]) => storeFor(tenant)
  const server = createServer({
    secret,
    // All 52 FinanceBackend ops are LIVE (store-backed) — FIN-52's year-end closeBudget
    // port retired the last residual, so buildApiRoutes wires zero 501 locks.
    routes: buildApiRoutes(storeFn),
    healthz: {
      listTenants: () => listTenants(),
      storeFn,
    },
  })

  // #383 Lane E1 — org-unit mirror consumer (env-gated on NATS_URL; off in staging).
  const natsUrl = process.env.NATS_URL
  let orgUnitConsumer: OrgUnitConsumerHandle | null = null
  // The consumer connects asynchronously, so SIGTERM can land BEFORE it
  // resolves. This flag is what makes that case safe: a consumer that arrives
  // after the shutdown started is closed on arrival rather than left running on
  // a process that is already draining its pools. It is ALSO what stops a
  // `closed` rejection caused by our own close() from exiting non-zero.
  let stopped = false
  // Retained so the shutdown seam can cancel a PENDING restart: a retry timer
  // that survives before() re-opens a broker while closeAllPools() is draining.
  let consumerSupervisor: ConsumerSupervisor | null = null
  if (natsUrl) {
    // ONE ladder for BOTH failure paths. Round 3's boot catch backed off along
    // the delay table and gave up at the cap, but onFatal — the MID-LIFE death —
    // re-entered the ladder synchronously with the counter reset to 1, one
    // statement after logging "restarting on the bounded schedule". A broker that
    // drops the consumer as fast as it accepts one looped there without bound.
    consumerSupervisor = createConsumerSupervisor<OrgUnitConsumerHandle>({
      name: 'org-unit consumer',
      boot: (onMidLifeFault) =>
        startOrgUnitConsumer({
          connect: async (): Promise<LeafBroker> => {
            const { NatsBroker } = await import('./nats-broker.js')
            return NatsBroker.connect(natsUrl, STREAMS.ORGUNIT.name)
          },
          resolveStore: resolveMirrorStore,
          isStopped: () => stopped,
          // A subscription that dies MID-LIFE is not a reason to exit — a broker
          // that dropped the consumer is exactly the case a bounded restart is
          // for. Round 2 exited(1) here unconditionally.
          onFatal: onMidLifeFault,
        }),
      retain: (handle) => {
        orgUnitConsumer = handle
      },
      release: (handle) => handle.close(),
      isStopped: () => stopped,
      isUnretryable: isRepointRefusal,
      onUnretryable: fatalBrokerFailure,
      log: (msg) => console.info(`${msg}, subscribing ${STREAMS.ORGUNIT.subjects[0]}`),
    })

    void consumerSupervisor.start()
  } else {
    console.info('[finance] NATS_URL not set — org-unit consumer off')
  }

  server.listen(PORT, () => {
    console.log(`[finance] listening on :${PORT}`)
  })

  // The drain is AWAITED inside the helper, bounded by the forced-exit timer.
  // This leaf never called the pool drain at all before R4: drainEvictedPools()
  // was exported and never invoked, and process.exit() never emits 'beforeExit',
  // so the store's drain-on-exit hook was structurally unreachable here.
  // closeAllPools() ends the LIVE tenant pools too, not only the evicted ones.
  const shutdown = createShutdown({
    name: 'finance',
    server,
    drain: () => closeAllPools(),
    exit: (code) => process.exit(code),
    forceAfterMs: SHUTDOWN_TIMEOUT_MS,
    // The hook itself lives in stop-consumer.ts so it can be RUN by a test
    // through this same createShutdown, rather than grepped for in this file:
    // round 4's guard matched the call's source text, which a commented-out
    // call satisfies just as well as a live one.
    before: () =>
      stopOrgUnitConsumer({
        markStopped: () => {
          stopped = true
        },
        supervisor: () => consumerSupervisor,
        liveConsumer: () => orgUnitConsumer,
      }),
  })

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
