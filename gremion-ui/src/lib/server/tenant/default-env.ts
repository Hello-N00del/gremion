import { env } from '$env/dynamic/private'

/**
 * P2.1c (T14, §7.7): the SINGLE allowlisted seam for per-tenant env reads that are
 * NOT routed through a per-tenant registry accessor.
 *
 * Two legitimate kinds of read flow through here:
 *   1. The DEFAULT tenant's fallback branch of a per-tenant accessor — e.g.
 *      `livekitServerUrl`/`getMatrixClient`/`heliosBase` keep the byte-identical
 *      pre-tenancy `env.<VAR> ?? <default>` for `slug === 'default'`. (The
 *      newsletter SQLite path that also used this seam was removed in Task 23.)
 *   2. Genuinely deployment-global service URLs/creds for single-instance shared
 *      backends (Nextcloud, Matrix/Synapse, Helios, the Keycloak admin URL, the
 *      external Keycloak issuer) that are NOT yet per-tenant — per-tenant deployment
 *      of those services is the O4 decision, not a runtime split.
 *
 * Because this module lives under `lib/server/tenant/`, the build-time env guard
 * (`scripts/check-tenant-env-guard.mjs`, allowlist segment `lib/server/tenant`) exempts
 * it — so the `--enforce` flip can fail the build on EVERY OTHER inline per-tenant read.
 * Callers MUST supply their own fallback (`?? '...'`): this returns `undefined` when the
 * var is unset, exactly like a direct `env.<VAR>` read, so behavior is byte-identical.
 *
 * The dynamic `env[name]` read (variable, not a literal) is invisible to the guard regex
 * — it matches only `env.<LITERAL>` / `env['<LITERAL>']` — but this file is allowlisted
 * regardless, so the seam is single-sourced rather than relying on the regex shape.
 */
export function defaultTenantEnv(name: string): string | undefined {
  return env[name]
}
