// src/lib/server/tenant/slug.ts
// P2.1a — tenant slug validate-and-prefix guard (spec §3.1, §7.8). The slug is
// the leftmost subdomain label AND the seed for the physical DB name t_<slug>.
// Validating ^[a-z0-9-]{1,30}$ AND prefixing t_ guarantees a slug can never
// collide with the shared-infra DB names from docker/postgres/init-databases.sh
// (gremion/keycloak/nextcloud/helios). Pure: no I/O.

export const SLUG_PATTERN = /^[a-z0-9-]{1,30}$/

// Grounded against docker/postgres/init-databases.sh (nextcloud/keycloak/helios/gremion)
// + the postgres defaults (postgres/template0/template1) + the control DB. Complete as
// of this baseline. The t_<slug> DB-name prefix already prevents physical collisions;
// this list additionally reserves the subdomain labels.
//
// EDGE-OWNED SUBDOMAIN LABELS (must stay reserved): a tenant slug is ALSO the leftmost
// subdomain label of its host (<slug>.${DOMAIN}). Some labels are already owned by
// SATELLITE edge routers whose host has a HIGHER routing priority than the tenant
// wildcard, so a tenant provisioned on one of these labels would be status=active yet
// every request to its host routes AWAY from gremion-ui (login/OIDC + UI silently
// unreachable) — and the migration-003 realm/issuer uniqueness guard does NOT catch a
// shadowed host. SOURCE OF TRUTH for these labels (keep this list in sync with them):
//   - `public`    — gremion-public  Host(`public.${DOMAIN}`)             docker-compose.yml router
//   - `cloud`     — Nextcloud      Host(`cloud.…`) priority 20          k8s/base/traefik/ingressroutes.yaml
//   - `matrix`    — Synapse/Matrix Host(`matrix.…`) priority 20         k8s/base/traefik/ingressroutes.yaml
//   - `elections` — Helios         Host(`elections.…`) priority 20      k8s/base/traefik/ingressroutes.yaml
// (the tenant wildcard router is priority 10 — strictly lower — so the satellites win.)
// ANY future satellite subdomain label MUST be added here when its edge router lands,
// or a tenant could be provisioned onto a host shadowed by another router.
export const RESERVED_SLUGS: readonly string[] = [
  // `gremion` is the shared-infra app DB (#396 renamed it from `stura`); `stura`
  // stays reserved because it is the default tenant's own slug and because
  // un-reserving a label would let a new tenant claim it.
  'gremion', 'stura', 'keycloak', 'nextcloud', 'helios',
  'postgres', 'control', 'template0', 'template1',
  // edge-owned satellite subdomain labels (see the comment block above):
  'public', 'cloud', 'matrix', 'elections',
]

export type SlugResult = { ok: true; slug: string } | { ok: false; reason: string }

export function validateSlug(input: string): SlugResult {
  if (!SLUG_PATTERN.test(input)) return { ok: false, reason: 'slug must match ^[a-z0-9-]{1,30}$' }
  if (RESERVED_SLUGS.includes(input)) return { ok: false, reason: `slug "${input}" is reserved` }
  return { ok: true, slug: input }
}

export function dbNameForSlug(slug: string): string {
  const r = validateSlug(slug)
  if (!r.ok) throw new Error(`invalid slug "${slug}": ${r.reason}`)
  return `t_${r.slug}`
}
