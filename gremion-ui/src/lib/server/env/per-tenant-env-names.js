// @ts-check
// src/lib/server/env/per-tenant-env-names.js
//
// TASK-042 (Q4) / R28: the ONE list of environment variable names that are
// PER-TENANT (a realm, an issuer, a config path, a data-plane URL, a LiveKit or
// Nextcloud endpoint). Runtime data, so it lives with the runtime:
//   - lib/server/env/platform-env.ts refuses every name classed here;
//   - scripts/check-tenant-env-guard.mjs (the build-time guard) fails the build
//     on a direct $env/dynamic/private read of one of them outside the resolver.
// Plain ESM JavaScript (JSDoc-typed) because the guard runs under plain `node`,
// which cannot import a .ts module; the server imports it like any module.

/**
 * Exact per-tenant names. (Task 23: NEWSLETTER_DB_PATH removed; the monolith
 * SQLite newsletter store was decommissioned.)
 * @type {ReadonlySet<string>}
 */
export const PER_TENANT_EXACT_VARS = new Set([
  'DATABASE_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_ADMIN_URL', 'MATRIX_URL',
  'SYNAPSE_SERVER_NAME', 'HELIOS_URL', 'CONFIG_PATH', 'CALDAV_SHARED_USER',
])

/**
 * Per-tenant name prefixes.
 * @type {readonly string[]}
 */
export const PER_TENANT_PREFIX_VARS = Object.freeze(['AUTH_KEYCLOAK_', 'HELIOS_SERVICE_', 'NEXTCLOUD_', 'LIVEKIT_'])

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isPerTenantEnvName(name) {
  return PER_TENANT_EXACT_VARS.has(name) || PER_TENANT_PREFIX_VARS.some((p) => name.startsWith(p))
}
