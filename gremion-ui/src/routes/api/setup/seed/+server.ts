import { json, error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { runSeed } from '$lib/server/seed/seed'
import { resolveBlueprint } from '$lib/server/seed/blueprint-registry'
import { getTenant } from '$lib/server/tenant/context'
import { getTenantBySlug } from '$lib/server/tenant/registry'
import { constantTimeEqual } from '$lib/server/internal-fetch'
import { requireSetupRateLimit } from '$lib/server/rate-limit'
import type { RequestHandler } from './$types'

// Best-effort IP extraction — mirrors routes/api/setup/config/+server.ts.
function clientIp(event: { getClientAddress?: () => string }): string {
  try {
    return event.getClientAddress?.() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * One-shot seed endpoint. Guarded by a static token AND an empty-database
 * check, so it is safe to leave deployed: it refuses on any seeded stack.
 *
 * P2.3 (#202): the seed runs in the REQUEST-scoped tenant context (resolved
 * from x-forwarded-host), so it feeds the CURRENT tenant ITS OWN blueprint —
 * resolved from the registry row's `blueprint_ref` — NOT a hardcoded StuRa one.
 * The default tenant carries `STURA_BLUEPRINT@1`, so it still seeds StuRa.
 */
export const POST: RequestHandler = async (event) => {
  const { request } = event
  // #257-4: cap brute-force against this unauthenticated, static-token gate,
  // matching the other setup-token routes. Rate-limit BEFORE the token compare
  // so wrong-token attempts still count.
  const limited = requireSetupRateLimit(clientIp(event))
  if (limited) return limited
  const token = request.headers.get('x-seed-token')
  // #257-4: constant-time compare (the project standard — internal-fetch.ts,
  // setup-token.ts) instead of a variable-time `!==` on a bearer-style token.
  if (!env.SEED_TOKEN || !constantTimeEqual(token ?? '', env.SEED_TOKEN)) {
    throw error(403, 'invalid or missing seed token')
  }
  if ((await listOrgUnits()).length > 0) {
    throw error(409, 'database already seeded — org_units is not empty')
  }
  // Select the blueprint by the resolved tenant's registry ref (resolveBlueprint
  // THROWS on an unknown ref — never silently seeds StuRa into another tenant).
  const slug = getTenant().slug
  const tenant = await getTenantBySlug(slug)
  if (!tenant) {
    throw error(409, `seed: tenant "${slug}" not found in the registry`)
  }
  const blueprint = resolveBlueprint(tenant.blueprintRef)
  try {
    const report = await runSeed(blueprint)
    return json(report)
  } catch (err) {
    console.error('[seed] runSeed failed:', err)
    throw error(500, 'seed failed — check the gremion-ui server logs for detail')
  }
}
