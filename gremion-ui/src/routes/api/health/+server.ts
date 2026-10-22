import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getBootStatus } from '../../../hooks.server'
import { readConfig } from '$lib/server/config'
import { getSetupHealthProbes } from '$lib/server/modules/runtime-registry'
import { collectModuleOutages, moduleProbeCache } from '$lib/server/tenant/health'

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
 *
 * F7: when boot is complete the body also carries `degraded: {name, errorClass, code}[]`,
 * the services of ENABLED feature modules (files -> nextcloud, messages -> matrix)
 * that fail their liveness probe. The status stays 200 and `status` stays 'ok'
 * (a feature-module outage must not restart or fail the kernel); a DISABLED
 * module's service is never probed or listed. Names only, no error detail.
 * Probe results are cached process-wide for 20 s and single-flighted
 * (`moduleProbeCache`): this endpoint is public, the probes call admin APIs.
 * `/api/health` is added to the hook's `publicPaths` allowlist so it is never
 * auth-gated once boot completes.
 */
export const GET: RequestHandler = async () => {
  const { complete } = getBootStatus()
  if (!complete) return json({ status: 'booting' }, { status: 503 })
  let degraded: { name: string; errorClass: string; code: string }[] = []
  try {
    const probes = getSetupHealthProbes().flatMap((p) =>
      p.moduleId
        ? [moduleProbeCache.wrap({ moduleId: p.moduleId, service: p.service, validate: p.validate })]
        : [],
    )
    degraded = (await collectModuleOutages(probes, readConfig().modules)).map((name) => ({
      name,
      errorClass: 'ModuleUnreachable',
      code: 'module-down',
    }))
  } catch {
    degraded = []
  }
  return json({ status: 'ok', degraded }, { status: 200 })
}
