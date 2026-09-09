import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getBootStatus } from '../../../hooks.server'

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
  return json(
    { status: complete ? 'ok' : 'booting' },
    { status: complete ? 200 : 503 },
  )
}
