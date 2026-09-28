// src/lib/server/env/platform-env.ts
//
// TASK-042 (Q4; TRD-075, PRD-PLAT-012): the ONE reader of deployment-global
// environment variables. The kernel boots with zero tenants: there is no
// env-derived `default` tenant any more, so a per-tenant value (a realm, an
// issuer, a config path, a LiveKit or Nextcloud endpoint) never comes from the
// process env. Every name the build-time env guard
// (scripts/check-tenant-env-guard.mjs) classes as per-tenant is refused here,
// and so is any name outside the closed list below.
//
// It reads `process.env` at call time (never `$env/dynamic/private`), so the
// seam survives a later SvelteKit major unchanged (R25-3).
// @ts-expect-error -- untyped standalone node script (it carries @ts-nocheck)
import { EXACT_VARS, PREFIX_VARS } from '../../../../scripts/check-tenant-env-guard.mjs'

/**
 * The closed list of deployment-global variables a caller may read.
 * TENANT_DATA_ROOT is the directory holding every tenant's `<slug>/config.json`
 * (default `/data`, the image's volume); it names no tenant, so it is platform.
 */
export const PLATFORM_ENV_NAMES: readonly string[] = ['NATS_URL', 'PLATFORM_DOMAIN', 'TENANT_DATA_ROOT']

function isPerTenant(name: string): boolean {
  return (EXACT_VARS as Set<string>).has(name) || (PREFIX_VARS as string[]).some((p) => name.startsWith(p))
}

/**
 * Read one deployment-global variable. Returns `undefined` when it is unset
 * (the caller supplies its own fallback). Throws on a per-tenant name, or on
 * any name outside PLATFORM_ENV_NAMES.
 */
export function platformEnv(name: string): string | undefined {
  if (isPerTenant(name)) {
    throw new Error(`platformEnv: ${name} is a per-tenant variable; read it from the resolved tenant, never from the process env`)
  }
  if (!PLATFORM_ENV_NAMES.includes(name)) {
    throw new Error(`platformEnv: ${name} is not a deployment-global variable (closed list: ${PLATFORM_ENV_NAMES.join(', ')})`)
  }
  return process.env[name]
}
