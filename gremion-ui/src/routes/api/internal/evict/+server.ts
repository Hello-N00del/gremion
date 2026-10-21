// /api/internal/evict — the target of gremion-switch's evict fan-out and
// gremion-deploy's write_evict_targets (containers labelled gremion.evict=true
// must answer 204). Server-to-server: /api/internal/ is on the boot-exempt list
// (lib/server/boot-exempt.ts), so a request naming no tenant skips the tenant
// resolver, Auth.js and the session guard (hooks.server.ts authGuard); this
// handler authenticates itself with the INTERNAL_PUSH_SECRET Bearer. POST only
// (SvelteKit answers 405 for anything else). Secret unset or shorter than
// MIN_SECRET_LEN is refused: fail closed.
import { env } from '$env/dynamic/private'
import { constantTimeEqual } from '$lib/server/internal-fetch'
import { evictAllTenantRuntimes } from '$lib/server/tenant/registry'
import type { RequestHandler } from './$types'

const MIN_SECRET_LEN = 16

export const POST: RequestHandler = ({ request }) => {
  const secret = env.INTERNAL_PUSH_SECRET ?? process.env.INTERNAL_PUSH_SECRET
  const got = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? ''
  if (!secret || secret.length < MIN_SECRET_LEN || !got || !constantTimeEqual(got, secret)) {
    return new Response(null, { status: 401 })
  }
  evictAllTenantRuntimes()
  return new Response(null, { status: 204 })
}
