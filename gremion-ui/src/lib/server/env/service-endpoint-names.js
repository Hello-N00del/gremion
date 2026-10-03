// @ts-check
// src/lib/server/env/service-endpoint-names.js
//
// TASK-205 (Q5, verifier r1 MEDIUM): the ONE frozen list of SERVICE-ENDPOINT names serviceEnv
// (./service-env.ts) serves to the module in-process halves: the Matrix/Synapse, Helios, LiveKit and
// Nextcloud/CalDAV endpoints and their service credentials. Every name here is also classed per-tenant
// (per-tenant-env-names.js), so platformEnv refuses it; the reverse does NOT hold: DATABASE_URL,
// CONFIG_PATH, KEYCLOAK_REALM, KEYCLOAK_ADMIN_URL and AUTH_KEYCLOAK_* are per-tenant but resolved from the
// tenant only and are never served process-wide.
//
// Adding a name is a reviewed edit: it widens what a module half can read from the process. The list is
// the union of the literal serviceEnv('X') call sites under modules/*/app (service-env.test.ts proves it is
// not narrower than its callers). Plain ESM JavaScript (JSDoc-typed) because the build-time guard
// (scripts/check-tenant-env-guard.mjs) runs under plain `node` and reads the same list.

/** @type {readonly string[]} */
export const SERVICE_ENDPOINT_NAMES = Object.freeze([
  'MATRIX_URL',
  'SYNAPSE_SERVER_NAME',
  'HELIOS_URL',
  'HELIOS_SERVICE_EMAIL',
  'HELIOS_SERVICE_PASSWORD',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'NEXTCLOUD_URL',
  'NEXTCLOUD_ADMIN_USER',
  'NEXTCLOUD_ADMIN_PASSWORD',
  'NEXTCLOUD_OIDC_PROVIDER_ID',
  'NEXTCLOUD_USER_TOKENS',
  'NEXTCLOUD_CALDAV_USER_TOKENS',
  'CALDAV_SHARED_USER',
])

// Module-private lookup: a frozen array cannot grow, and nothing outside this module holds the Set.
const LOOKUP = new Set(SERVICE_ENDPOINT_NAMES)

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isServiceEndpointName(name) {
  return LOOKUP.has(name)
}
