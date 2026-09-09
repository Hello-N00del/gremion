// src/lib/server/tenant/register-default.ts
// Register this deployment itself as the canonical `default` tenant #1: the
// EXISTING gremion DB + the realm the operator's auth env points at — no data
// move. Secret refs use the env: scheme so tenant #1's secrets stay in env.
//
// Tenant #1's identity is env, and ONLY env. There are deliberately no
// host-bearing defaults here: a deployment booted with AUTH_KEYCLOAK_ISSUER
// unset fails loudly rather than registering an issuer that points at somebody
// else's Keycloak. See resolveDefaultTenantEnv below.
//
// Registration is RECONCILE-on-boot, not write-once. Env is
// the default tenant's source of truth (standing rule: env fallbacks remain
// tenant #1's source of truth), so the upsert is `ON CONFLICT (slug) DO
// UPDATE` over the env-derived columns — issuer, kc_internal, realm_name,
// audiences, db_conn_ref, kc_client_ref, auth_client_ref — and any applied
// change is logged loudly as `[tenant-registry] env/registry drift:` with
// old -> new per column. The DO UPDATE carries an IS DISTINCT FROM guard so an
// unchanged env writes nothing (updated_at stays put). Values logged are refs
// and issuer URLs — never secret material.
import { env } from '$env/dynamic/private'
import { getControlDb } from './control-db'
import { getTenantBySlug, type Tenant } from './registry'
import { parseAudiences } from '$lib/auth/audience'

// The env-derived columns reconciled on boot, with their camelCase accessors
// (rendered for the drift log; audiences as JSON so old/new lists read well).
const ENV_DERIVED_COLUMNS: ReadonlyArray<{ column: string; pick: (t: Tenant) => string }> = [
  { column: 'issuer', pick: (t) => t.issuer },
  { column: 'kc_internal', pick: (t) => t.kcInternal },
  { column: 'realm_name', pick: (t) => t.realmName },
  { column: 'audiences', pick: (t) => JSON.stringify(t.audiences) },
  { column: 'db_conn_ref', pick: (t) => t.dbConnRef },
  { column: 'kc_client_ref', pick: (t) => t.kcClientRef },
  { column: 'auth_client_ref', pick: (t) => t.authClientRef },
]

/** The env-derived identity of tenant #1, resolved before anything is written. */
export interface DefaultTenantEnv {
  readonly issuer: string
  readonly kcInternal: string
  readonly realmName: string
  readonly audiences: readonly string[]
  readonly matrixSpace: Record<string, unknown>
}

/**
 * Resolve tenant #1's identity from env — the single place that decides what
 * the default row says about itself.
 *
 * Fails loudly rather than defaulting: an issuer is a real external identity
 * provider, and guessing one is worse than not booting. The realm name is
 * derived from the issuer (Keycloak issuers end in `/realms/<realm>`) so a
 * correct deployment needs one variable, not two; set KEYCLOAK_REALM to
 * override, or when the issuer is not Keycloak-shaped.
 */
export function resolveDefaultTenantEnv(): DefaultTenantEnv {
  const rawIssuer = env.AUTH_KEYCLOAK_ISSUER?.trim()
  if (!rawIssuer) {
    throw new Error(
      'registerDefaultTenant: AUTH_KEYCLOAK_ISSUER is not set. It is the OIDC issuer of the ' +
        'realm this deployment authenticates against, and there is no safe default for it — ' +
        'set it in .env (scripts/setup.sh writes a template) and boot again.',
    )
  }
  const issuer = rawIssuer.replace(/\/$/, '')
  const kcInternal = (env.AUTH_KEYCLOAK_INTERNAL?.trim() || issuer).replace(/\/$/, '')
  const realmName = env.KEYCLOAK_REALM?.trim() || realmFromIssuer(issuer)
  // Tenant #1's audiences track AUTH_JWT_AUDIENCES exactly like the global
  // verifyBearerJwt did — not a hardcoded literal. With AUTH_JWT_AUDIENCES
  // unset this yields DEFAULT_AUDIENCES (['gremion-ui','gremion-mobile']).
  const audiences = parseAudiences(env.AUTH_JWT_AUDIENCES)
  // matrix_space is a messaging-module field the governance kernel does not
  // own. With no messaging module configured it stays EMPTY — an absent field
  // means "env fallback at the consuming module" (see registry.ts), which is
  // the honest answer; a guessed server name is not.
  const serverName = env.SYNAPSE_SERVER_NAME?.trim()
  const matrixSpace: Record<string, unknown> = serverName ? { serverName } : {}
  return { issuer, kcInternal, realmName, audiences, matrixSpace }
}

/** `https://host/auth/realms/<realm>` -> `<realm>`. */
function realmFromIssuer(issuer: string): string {
  const m = /\/realms\/([^/?#]+)/.exec(issuer)
  if (!m) {
    throw new Error(
      'registerDefaultTenant: could not derive the realm from AUTH_KEYCLOAK_ISSUER (no ' +
        '`/realms/<name>` segment). Set KEYCLOAK_REALM explicitly.',
    )
  }
  return decodeURIComponent(m[1])
}

export async function registerDefaultTenant(): Promise<Tenant> {
  const { issuer, kcInternal, realmName, audiences, matrixSpace } = resolveDefaultTenantEnv()
  // The UI-client secret (Auth.js provider) — env:AUTH_KEYCLOAK_SECRET maps
  // tenant #1's UI login onto the same variable auth.ts reads.
  const authClientRef = 'env:AUTH_KEYCLOAK_SECRET'

  // (open-core carve) nc_target held the files module's Nextcloud URL (from
  // env.NEXTCLOUD_URL). That satellite is carved out of the governance kernel, so
  // this registry column stays empty; a re-added files module repopulates it.
  const ncTarget = { url: '' }

  const before = await getTenantBySlug('default')
  const sql = getControlDb()
  // Same column list as registry.ts registerTenant's INSERT (kept local on
  // purpose: registerTenant stays DO NOTHING for provisioned tenants — only
  // the DEFAULT tenant tracks env). JSONB writes use the sql.json house style.
  await sql`
    INSERT INTO tenant
      (slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id,
       kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile, brand_ref,
       blueprint_ref, conn_profile, backup_key_ref, audiences)
    VALUES
      ('default', 'active', 'env:DATABASE_URL', ${realmName},
       ${issuer}, ${kcInternal}, 'gremion-admin',
       'env:KEYCLOAK_ADMIN_CLIENT_SECRET', ${authClientRef},
       ${sql.json(ncTarget as never) as never},
       ${sql.json(matrixSpace as never) as never},
       ${sql.json({ subdomain: 'default', residencyZone: 'eu' } as never) as never},
       'config:default', 'STURA_BLUEPRINT@1',
       ${sql.json({ perTenantMax: 4, prepare: true } as never) as never},
       'env:BACKUP_KEY', ${audiences})
    ON CONFLICT (slug) DO UPDATE SET
      issuer = EXCLUDED.issuer,
      kc_internal = EXCLUDED.kc_internal,
      realm_name = EXCLUDED.realm_name,
      audiences = EXCLUDED.audiences,
      db_conn_ref = EXCLUDED.db_conn_ref,
      kc_client_ref = EXCLUDED.kc_client_ref,
      auth_client_ref = EXCLUDED.auth_client_ref,
      updated_at = now()
    WHERE
      (tenant.issuer, tenant.kc_internal, tenant.realm_name, tenant.audiences,
       tenant.db_conn_ref, tenant.kc_client_ref, tenant.auth_client_ref)
      IS DISTINCT FROM
      (EXCLUDED.issuer, EXCLUDED.kc_internal, EXCLUDED.realm_name, EXCLUDED.audiences,
       EXCLUDED.db_conn_ref, EXCLUDED.kc_client_ref, EXCLUDED.auth_client_ref)`
  const after = await getTenantBySlug('default')
  if (!after) throw new Error('registerDefaultTenant: row vanished after upsert for default')

  if (before) {
    const drift = ENV_DERIVED_COLUMNS
      .map(({ column, pick }) => ({ column, from: pick(before), to: pick(after) }))
      .filter((d) => d.from !== d.to)
    if (drift.length > 0) {
      console.warn(
        `[tenant-registry] env/registry drift: ${drift
          .map((d) => `${d.column} ${d.from} -> ${d.to}`)
          .join('; ')} — env reconciled into the default tenant row on boot`,
      )
    }
  }
  return after
}
