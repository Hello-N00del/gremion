import type { Role } from '$lib/auth/types'
import { MODULE_MANIFESTS } from './manifests'

// The registered module set + order now live in the manifests barrel
// (./manifests). Re-exported here so existing `import { MODULE_MANIFESTS } from
// './registry'` consumers (db.ts, the provisioner, realm.ts, tests) are
// unaffected. Order is irrelevant for PAGE_ACCESS (segments are unique) but DOES
// define moduleRoutePrefixes() ordering.
export { MODULE_MANIFESTS }

/**
 * True when a REGISTERED module owns this top-level route segment.
 *
 * The dashboard and the empty states use it to decide whether a link is real.
 * A kernel with no votes module must not offer a "Zu den Abstimmungen" link:
 * the route does not exist, so the link is a 404 dressed as navigation. Ask the
 * manifests, never a hardcoded list — a hardcoded list survives the module.
 */
export function moduleOwnsSegment(segment: string): boolean {
  return MODULE_MANIFESTS.some((m) => m.pages.some((p) => p.segment === segment))
}

/**
 * The href of a page a registered module owns — or null when no module owns it.
 *
 * Components link into modules THROUGH this, never with a hardcoded path: a
 * hardcoded path outlives the module and turns into a 404 the day the module is
 * carved out, which is exactly what happened to /votes and /finance/*. A null
 * return is a rendering decision ("do not offer this"), not an error.
 */
export function moduleHref(segment: string, subPath = ''): string | null {
  return moduleOwnsSegment(segment) ? `/${segment}${subPath}` : null
}

/**
 * Build the PAGE_ACCESS map from every manifest's pages. Throws on a dup segment.
 *
 * P2.2-auth A4 (D-CONST): `vocabulary` is the tenant's role vocabulary (the
 * D-VOCAB seam, $lib/server/tenant/role-vocabulary.ts). Composition is
 * vocabulary-INDEPENDENT today — manifest pages are static declarations and
 * per-tenant shaping (term-maps, hierarchy lattices) is P2.3 — the parameter
 * defines the seam so every per-tenant accessor (pageAccessForTenant) routes
 * through this ONE composition path. Absent = today's golden composition,
 * byte-identical (pinned by registry.test.ts, untouched).
 */
export function composePageAccess(vocabulary?: readonly string[]): Record<string, Role> {
  const access: Record<string, Role> = {}
  for (const m of MODULE_MANIFESTS) {
    for (const p of m.pages) {
      if (p.segment in access) {
        throw new Error(`Duplicate PAGE_ACCESS segment '${p.segment}' (module '${m.id}')`)
      }
      access[p.segment] = p.minRole
    }
  }
  return access
}

/** The module-disable route map consumed by hooks.server.ts. */
export function moduleRoutePrefixes(): { prefix: string; moduleId: string }[] {
  return MODULE_MANIFESTS
    .filter((m) => m.toggleable)
    .flatMap((m) => m.routePrefixes.map((prefix) => ({ prefix, moduleId: m.id })))
}

/**
 * Composed capability map (any module may contribute).
 *
 * P2.2-auth A4 (D-CONST): same vocabulary seam as composePageAccess above.
 * Capabilities are GROUP-keyed (Keycloak group ids), so a realm-ROLE
 * vocabulary has no defined projection onto them until P2.3 — the arg is
 * threading-only today (pinned by registry.vocabulary.test.ts); absent =
 * golden composition, byte-identical.
 */
export function composeCapabilities(vocabulary?: readonly string[]): Record<string, readonly string[]> {
  const caps: Record<string, readonly string[]> = {}
  for (const m of MODULE_MANIFESTS) {
    if (m.capabilities) Object.assign(caps, m.capabilities)
  }
  return caps
}
