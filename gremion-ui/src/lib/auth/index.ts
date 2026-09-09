import { Role, type SessionUser, type TenantVocabularySource } from './types'
import { composePageAccess } from '$lib/modules/registry'

export { Role }
export type { SessionUser, TenantVocabularySource }

// Role hierarchy: it-admin > council-admin > member > guest
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [Role.ITAdmin]: [Role.ITAdmin, Role.CouncilAdmin, Role.Member, Role.Guest],
  [Role.CouncilAdmin]: [Role.CouncilAdmin, Role.Member, Role.Guest],
  [Role.Member]: [Role.Member, Role.Guest],
  [Role.Guest]: [Role.Guest]
}

/** Returns true if the user's roles include the required role (respects hierarchy). */
export function hasRole(userRoles: Role[], required: Role): boolean {
  return userRoles.some(
    (r) => ROLE_HIERARCHY[r]?.includes(required) ?? false
  )
}

/**
 * Map of page keys to minimum required role — composed from the per-module
 * manifests (Pillar-1 P0.1). Each segment is now declared by its owning module
 * under $lib/modules/manifests/*, where the per-segment rationale also lives
 * (e.g. #194 files guest-gating + v6 finance read-only in core/finance). The
 * composed map is pinned byte-identical to the legacy literal by
 * src/lib/modules/registry.test.ts.
 */
export const PAGE_ACCESS: Record<string, Role> = composePageAccess()

/**
 * P2.2-auth A4 (D-CONST): the tenant-aware PAGE_ACCESS accessor — what
 * canAccess/nav/guards consume going forward. The DEFAULT tenant (no
 * `config.roles` override — every existing config, pinned by
 * role-vocabulary.test.ts) resolves to the SAME golden PAGE_ACCESS object
 * composed above (referential, tenant #1 byte-identical); an override tenant
 * delegates to the vocabulary-arg compose seam. Composition is
 * vocabulary-independent until P2.3 supplies per-tenant shaping, so override
 * output is content-identical today — the accessor exists so consumption is
 * already tenant-routed when that lands. Absent-vs-present semantics mirror
 * roleVocabularyForTenant ($lib/server/tenant/role-vocabulary): only an
 * ABSENT override means default; an explicit [] is a narrowing override
 * (agreement-guarded in tenant-accessors.test.ts).
 */
export function pageAccessForTenant(ctx: TenantVocabularySource): Record<string, Role> {
  const override = ctx.config.roles
  return override === undefined ? PAGE_ACCESS : composePageAccess(override)
}

/**
 * Top-level path segments that are intentionally NOT in PAGE_ACCESS.
 *
 * These are either:
 *  - public routes (auth/legal/setup): the
 *    `publicPaths` check in hooks.server.ts short-circuits them before
 *    `canAccess` is consulted, so they don't need a PAGE_ACCESS entry;
 *  - non-page surfaces (api): API routes have their own per-handler auth,
 *    hooks.server.ts skips the page-level `canAccess` check for /api/*.
 *
 * The build-time coverage test (`page-access-coverage.test.ts`) uses this
 * set to decide which top-level route directories are allowed to lack a
 * PAGE_ACCESS entry.
 */
export const PAGE_ACCESS_PUBLIC_SEGMENTS: ReadonlySet<string> = new Set([
  'auth',
  'legal',
  'setup',
  'api',
])

/**
 * Returns true if the user can access the given page.
 *
 * G-072: in development mode, an unknown page segment indicates that a new
 * top-level route directory was added without a matching PAGE_ACCESS entry.
 * Without this guard, `canAccess` would silently return `false`, producing
 * a confusing redirect loop in hooks.server.ts. The build-time coverage test
 * (`page-access-coverage.test.ts`) catches this at CI time; the dev-only
 * throw is the runtime backstop so a developer running `pnpm dev` sees a
 * screaming error instead of a silent forbidden-redirect.
 *
 * In production we deliberately preserve the silent-deny semantics:
 * `canAccess` is occasionally called for non-route strings (e.g. probe
 * paths), and changing runtime behaviour everywhere would broaden the blast
 * radius beyond what this gap warrants. The build-time test is the
 * load-bearing change.
 *
 * P2.2-auth A4 (D-CONST): `pageAccess` lets the hooks guard pass the CURRENT
 * tenant's map (pageAccessForTenant(event.locals.tenant)); the default keeps
 * every existing 2-arg call site byte-identical (golden suites untouched).
 */
export function canAccess(
  userRoles: Role[],
  page: string,
  pageAccess: Record<string, Role> = PAGE_ACCESS,
): boolean {
  const required = pageAccess[page]
  if (required === undefined) {
    if (import.meta.env.DEV) {
      throw new Error(
        `PAGE_ACCESS missing for: ${page} — add an entry in gremion-ui/src/lib/auth/index.ts ` +
          `(or add the segment to PAGE_ACCESS_PUBLIC_SEGMENTS if it's intentionally public).`,
      )
    }
    return false
  }
  return hasRole(userRoles, required)
}
