import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getBootStatus } from '../../../hooks.server'
import { degradedWorkers } from '$lib/server/events/consumer-state'

/**
 * PUBLIC (unauthenticated) boot-status probe.
 *
 * Distinct from `/api/setup/health` (a token-gated setup-wizard probe that
 * checks downstream service reachability): this endpoint reports only THIS
 * process's boot state, so a container healthcheck / the P0.2 deselection
 * boot-smoke can tell "app finished booting" from "app is still migrating".
 *
 * 200 {status:'ok'}      — boot completed (migrations + workers ran)
 * 503 {status:'booting'} — boot still running, or boot failed
 *
 * The public body intentionally OMITS any internal boot-error detail: this is an
 * unauthenticated endpoint, so echoing `error.message` would be a (latent) info
 * leak if guard ordering ever changes. The boot error is already logged
 * server-side (hooks.server.ts); the public probe reports only the coarse state.
 *
 * Note: `authGuard` in hooks.server.ts short-circuits ALL requests with a bare
 * 503 ("booting"/"boot failed") while `_bootComplete` is false — so a caller
 * only ever reaches this handler once boot is complete, where it answers 200.
 * The 503 branch here is the contract-correct response for the (unreachable-
 * via-the-guard but defensively-handled) booting state, and keeps this route a
 * faithful, self-contained boot probe even if the guard ordering ever changes.
 * `/api/health` is added to the hook's `publicPaths` allowlist so it is never
 * auth-gated once boot completes.
 */
export const GET: RequestHandler = () => {
  const { complete } = getBootStatus()
  // The background event workers (today: the org-unit relay) are deliberately
  // NON-FATAL: a NATS that is down must not stop the app serving everything that
  // has nothing to do with it. That is why `status` stays 'ok' and this stays a
  // 200 - but before this list existed, "non-fatal" also meant invisible: a
  // process whose org-unit mirror had stopped answered exactly the same confident
  // 200 as a healthy one. `degraded` is that difference.
  //
  // Only the worker NAME, the error CLASS and a stable CODE are exposed - never
  // the broker's own message. This endpoint is unauthenticated, and a broker
  // message is not safe to publish from one: a repoint refusal carries both
  // subject filters (the deployment's wire root and its stream topology), a
  // connect failure carries host:port, and a client error can carry whatever it
  // was configured with. The code is what an operator routes on; the full
  // message is in the container log, which is already authenticated by being on
  // the host.
  //
  // `degraded` is an OPERATOR surface, NOT the container healthcheck. The compose
  // probe for gremion-ui fetches `http://127.0.0.1:3000/` and stays there on
  // purpose: these workers are non-fatal by design, so marking the container
  // unhealthy because a worker died would make Traefik v3 silently drop this
  // service's routers - turning a stopped mirror into a full outage, a strictly
  // worse failure than the one being reported. How to read this list is
  // documented in docs/OPERATIONS.md, which carries the same tenant headers the
  // probe does, because the fail-closed tenant resolver runs before this route.
  const degraded = degradedWorkers().map((w) => ({
    name: w.name,
    errorClass: w.errorClass,
    code: w.code,
    attempts: w.attempts,
  }))
  return json(
    { status: complete ? 'ok' : 'booting', degraded },
    { status: complete ? 200 : 503 },
  )
}
