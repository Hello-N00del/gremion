// gremion-ui/scripts/tenant-provision.ts
// P2.1c (T10) — the operator provisioning CLI (D-PROVSCRIPT: Node/tsx, not bash
// — it reuses composeRealm, the registry modules, the slug guard and the secret
// resolver, and is unit-testable via the pure modules in
// src/lib/server/tenant/provisioner/*). Runs OPERATOR-SIDE
// (`pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts <subcommand> …`), NOT
// in the app container, so the §7.2 least-privilege provisioner credential is
// never reachable from any tenant data-plane.
//
// Subcommands:
//   provision <slug> --config <file> [--realm <name>] [--blueprint <ref>]
//                                                        — idempotent DB/realm/registry pipeline
//                                                          (--blueprint stamps the row's blueprint_ref;
//                                                           default STURA_BLUEPRINT@1)
//   suspend <slug>                                       — status -> suspended (evicts runtime)
//   resume <slug>                                        — status -> active (evicts runtime)
//   delete <slug>                                        — status -> deleting (crypto-shred wiring is T17)
//   bootstrap-provisioner                                — one-shot: create the §7.2 SA, print the statement
//   reconcile [--verify-only] <slug>|--all               — the R5 drift guard (implemented in T11)
//   materialize-config [<slug>] [--config <path>]        — bake the fully-merged effective config back to the tenant config.json (T15)
//
// Live wiring only — the testable logic lives in the pure modules. The KC token
// + transport, the host-side DB-admin connection, and the 0600 secret-file
// writer (a loud no-op warning on Windows/NTFS, D-SECMOUNT) are assembled here.
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import { MODULE_MANIFESTS } from '../src/lib/modules/registry'
import { validateSlug, dbNameForSlug } from '../src/lib/server/tenant/slug'
import {
  getTenantBySlug,
  registerTenant,
  updateTenantProvisioning,
  updateTenantStatus,
  ensureTenantResource,
  markTenantResourceOk,
  markTenantResourceFailed,
  getTenantResources,
  getTenantStatusBySlug,
  listTenants,
  evictTenantRuntime,
  resumeTenant,
  suspendTenant,
  type Tenant,
} from '../src/lib/server/tenant/registry'
import { KcProvisionApi, type KcTransport } from '../src/lib/server/tenant/provisioner/kc-admin-api'
import { provisionTenant, type ProvisionDeps } from '../src/lib/server/tenant/provisioner/pipeline'
import {
  reconcileRealm,
  reconcileFleet,
  type ReconcileReport,
  type FleetReport,
} from '../src/lib/server/tenant/provisioner/reconcile'
import { materializeConfig, assertBrandIdentityComplete } from '../src/lib/server/tenant/provisioner/materialize'
import { tlog } from '../src/lib/server/observability/tenant-log'
import { deleteTenant, type DeleteDeps, type LeafShredExecutor } from '../src/lib/server/tenant/provisioner/lifecycle'

const repoRoot = join(import.meta.dirname, '..', '..')
const kcDir = join(repoRoot, 'docker', 'keycloak')

// ── env helpers (operator-side; the env-guard scans src/ only, not scripts/) ──
function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`required env ${name} is not set`)
  return v
}
const apexDomain = () => reqEnv('DOMAIN')
/** The base realm template ships the deployment apex host as the
 *  `__APEX_DOMAIN__` sentinel rather than a literal, so the public repo trusts
 *  no host the deployer does not own. The Keycloak container resolves it at boot
 *  via docker/keycloak/substitute-realm-secrets.sh; this is the SAME resolution
 *  for the provisioner, which reads the template directly. It must happen before
 *  the doc reaches realm-doc.ts: swapHost matches the apex authority literally,
 *  and restrictClientUris drops every URI whose host is not the tenant's, so an
 *  unresolved sentinel would silently strip every redirect URI from the
 *  provisioned realm. */
function loadBaseRealmDoc(): Record<string, unknown> {
  const raw = readFileSync(join(kcDir, 'realm-export.base.json'), 'utf-8')
  return JSON.parse(raw.split('__APEX_DOMAIN__').join(apexDomain())) as Record<string, unknown>
}
const tenantSecretsDir = () => process.env.TENANT_SECRETS_DIR ?? join(repoRoot, 'secrets', 'tenants')
/** The KC admin REST base (operator-reachable). Default to the public edge. */
const kcAdminBase = () => process.env.KC_ADMIN_URL ?? `https://${apexDomain()}/auth`
/** (A) #139/G-080: the IN-CLUSTER KC admin/OIDC base persisted as the tenant's
 *  kc_internal — derived from AUTH_KEYCLOAK_INTERNAL exactly like the default
 *  tenant (register-default.ts), defaulting to the live internal-TLS posture
 *  (docker-compose.yml `https://keycloak:8443/auth`). kcInternalForTenant strips
 *  any realm suffix, so a realm-scoped AUTH_KEYCLOAK_INTERNAL also works. */
const kcInternalBase = () => process.env.AUTH_KEYCLOAK_INTERNAL ?? 'https://keycloak:8443/auth'

/** Build a tenant's runtime DB connection URL by reusing the app's DATABASE_URL
 *  scheme + host:port authority (pgbouncer:6432 in prod) with THIS tenant's role,
 *  password and database. resolveTenantBySlug reads the db secret AS this URL
 *  (mirrors the default tenant's env:DATABASE_URL), so it must be a complete URL. */
function tenantDbUrl(role: string, password: string, dbName: string): string {
  const template = reqEnv('DATABASE_URL')
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(template)
  if (!m) throw new Error('tenantDbUrl: cannot parse scheme+authority from DATABASE_URL')
  const query = template.includes('?') ? template.slice(template.indexOf('?')) : ''
  return `${m[1]}://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${m[2]}/${dbName}${query}`
}

function genSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** Write a generated secret to a HOST file with 0600. NTFS has no POSIX mode —
 *  chmod is a no-op there, so we WARN loudly instead of failing (D-SECMOUNT). */
function writeSecretFile(hostPath: string, value: string): Promise<void> {
  mkdirSync(dirname(hostPath), { recursive: true })
  writeFileSync(hostPath, value, { encoding: 'utf-8' })
  try {
    chmodSync(hostPath, 0o600)
  } catch (err) {
    console.warn(
      `[tenant-provision] WARNING: chmod 0600 ${hostPath} failed (${err instanceof Error ? err.message : err}) — ` +
        'on Windows/NTFS this is expected (no POSIX mode). Ensure the file is operator-only via NTFS ACLs.',
    )
  }
  if (process.platform === 'win32') {
    console.warn(
      `[tenant-provision] WARNING: ${hostPath} written without a POSIX 0600 mode (Windows host). ` +
        'Tighten its ACLs before this directory is bind-mounted into the container.',
    )
  }
  return Promise.resolve()
}

// ── KC token + transport (client-credentials with the §7.2 provisioner SA) ────
const PROVISIONER_SECRET_FILE =
  process.env.TENANT_PROVISIONER_SECRET_FILE ?? join(repoRoot, 'secrets', 'tenant_provisioner')

interface ProvisionerCreds {
  clientId: string
  clientSecret: string
}

/** Read the §7.2 least-privilege provisioner credential from its HOST file —
 *  deliberately OUTSIDE the D-SECMOUNT secrets/tenants/ dir so the gremion-ui
 *  container can never see it through the bind mount. */
function readProvisionerCreds(): ProvisionerCreds {
  if (!existsSync(PROVISIONER_SECRET_FILE)) {
    throw new Error(
      `provisioner credential file ${PROVISIONER_SECRET_FILE} not found — run \`bootstrap-provisioner\` once first`,
    )
  }
  const clientSecret = readFileSync(PROVISIONER_SECRET_FILE, 'utf-8').trim()
  return { clientId: process.env.TENANT_PROVISIONER_CLIENT_ID ?? 'tenant-provisioner', clientSecret }
}

async function kcToken(base: string, realm: string, creds: ProvisionerCreds): Promise<string> {
  const res = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  })
  if (!res.ok) throw new Error(`Keycloak token fetch failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

/** A live KC admin transport authenticated as the provisioner SA against the
 *  master realm (where the create-realm role lives). */
function makeKcTransport(base: string, creds: ProvisionerCreds): KcTransport {
  let token: string | null = null
  const send = (method: string, path: string, body: unknown): Promise<Response> => {
    return fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }
  return async (method, path, body) => {
    token ??= await kcToken(base, 'master', creds)
    let res = await send(method, path, body)
    // create-realm SA token-refresh: a least-privilege `create-realm` SA only
    // gains `<realm>-realm` admin AFTER it creates the realm, so the cached token
    // (fetched before createRealm) lacks those mappings and the FIRST post-create
    // admin op 401/403s. Refresh the token ONCE and retry so the just-granted
    // per-realm admin roles take effect. (The admin-superuser path never hit this.)
    if (res.status === 401 || res.status === 403) {
      token = await kcToken(base, 'master', creds)
      res = await send(method, path, body)
    }
    if (!res.ok) throw new Error(`Keycloak Admin API error: ${res.status} on ${method} ${path}: ${await res.text()}`)
    if (res.status === 204) return undefined
    const text = await res.text()
    return text ? JSON.parse(text) : undefined
  }
}

/** A one-shot admin transport: password grant on master/admin-cli. Used ONLY by
 *  `bootstrap-provisioner` to mint the §7.2 SA — NEVER for tenant data-plane ops.
 *  The admin superuser is used exactly once, here, to create the least-privilege SA. */
function makeAdminKcTransport(base: string, adminUser: string, adminPassword: string): KcTransport {
  let token: string | null = null
  const getToken = async (): Promise<string> => {
    const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: adminUser,
        password: adminPassword,
      }).toString(),
    })
    if (!res.ok) throw new Error(`Keycloak admin token fetch failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { access_token: string }).access_token
  }
  return async (method, path, body) => {
    token ??= await getToken()
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`Keycloak Admin API error: ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined
    const text = await res.text()
    return text ? JSON.parse(text) : undefined
  }
}

// ── host-side DB-admin executor (CREATE DATABASE + role; init-databases.sh shape) ──
/** A superuser/CREATEDB postgres connection to the cluster (NOT the per-tenant
 *  data-plane pool, NOT the control pool). ADMIN_DATABASE_URL points at the
 *  postgres superuser. */
function adminDb(): ReturnType<typeof postgres> {
  return postgres(reqEnv('ADMIN_DATABASE_URL'), { max: 1, idle_timeout: 5, connect_timeout: 10 })
}

// (B) Provisioner input hardening. The DB-admin executor builds CREATE/DROP USER
// statements that interpolate roleName + password as $r$-dollar-quoted literals
// (a DO block body cannot carry bound parameters, so %I/%L-via-bind is not
// available here — init-databases.sh gets %I/%L only because psql `\gexec`
// substitutes -v variables, which has no postgres.js analogue inside a DO block).
// We therefore assert a STRICT charset on both before any unsafe interpolation:
// a value containing `$r$`, a quote, a backslash or whitespace is rejected loudly
// rather than reaching the SQL string. This PINS the generator contract:
// genSecret() = randomBytes(32).toString('base64url'), whose alphabet is exactly
// [A-Za-z0-9_-]; roleName is the slug-derived `t_<slug>` (validateSlug's
// ^[a-z0-9-]{1,30}$ + the `t_` prefix). If a future generator/slug change ever
// widens the charset, this assertion fails loudly at provision time instead of
// silently opening a SQLi seam. dbName stays "<id>"-quoted (already slug-derived).
const SAFE_SQL_TOKEN = /^[A-Za-z0-9_-]+$/
function assertSafeSqlToken(label: string, value: string): void {
  if (!SAFE_SQL_TOKEN.test(value)) {
    throw new Error(
      `[tenant-provision] refusing to interpolate unsafe ${label} into a DB-admin statement: ` +
        `must match ${SAFE_SQL_TOKEN} (genSecret base64url + t_<slug> contract). ` +
        'If the secret generator or slug rule changed, update this guard deliberately.',
    )
  }
}

function makeDbExecutor() {
  const sql = adminDb()
  return {
    async databaseExists(dbName: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`
      return rows.length > 0
    },
    // Same idempotent %I/%L shape as init-databases.sh create_db_and_user.
    async createDatabaseAndRole(dbName: string, roleName: string, password: string): Promise<void> {
      // (B) fail loudly before any $r$-literal interpolation (see assertSafeSqlToken).
      assertSafeSqlToken('roleName', roleName)
      assertSafeSqlToken('password', password)
      await sql.unsafe(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = $r$${roleName}$r$) THEN
             EXECUTE format('CREATE USER %I WITH PASSWORD %L', $r$${roleName}$r$, $r$${password}$r$);
           END IF;
         END $$;`,
      )
      // CREATE DATABASE cannot run inside a transaction/DO block.
      const exists = await sql<{ one: number }[]>`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`
      if (exists.length === 0) {
        await sql.unsafe(`CREATE DATABASE "${dbName}" OWNER "${roleName}"`)
      }
      await sql.unsafe(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${roleName}"`)
      const tenantSql = postgres(reqEnv('ADMIN_DATABASE_URL').replace(/\/[^/]+$/, `/${dbName}`), { max: 1 })
      try {
        await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO "${roleName}"`)
        // pgbouncer auth_query enablement (docker/pgbouncer/pgbouncer-auth.sql,
        // runbook pgbouncer.md): pgbouncer logs into the TARGET database as
        // pgbouncer_auth and resolves each role's SCRAM verifier via
        // pgbouncer.get_auth, so EVERY per-tenant DB needs the schema+function+grants
        // or the app's pgbouncer:6432 connection to a fresh tenant DB fails SCRAM.
        // (pg_shadow is cluster-wide; the function just has to exist in this DB.)
        await tenantSql.unsafe(
          `CREATE SCHEMA IF NOT EXISTS pgbouncer;
           CREATE OR REPLACE FUNCTION pgbouncer.get_auth(uname text)
             RETURNS TABLE (usename name, passwd text)
             LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
             AS $func$ SELECT usename, passwd FROM pg_catalog.pg_shadow WHERE usename = uname $func$;
           REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
           GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
           GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;`,
        )
      } finally {
        await tenantSql.end({ timeout: 5 })
      }
    },
    // T17 (§8.7) — the inverse of createDatabaseAndRole, idempotent: DROP DATABASE
    // WITH FORCE (terminates any lingering backend so the drop never blocks behind
    // a stale connection) IF EXISTS, then DROP ROLE IF EXISTS. dbName/roleName are
    // slug-derived (validateSlug ^[a-z0-9-]{1,30}$ + the t_ prefix), so the
    // identifier interpolation is safe — same shape as createDatabaseAndRole.
    async dropDatabaseAndRole(dbName: string, roleName: string): Promise<void> {
      // (B) fail loudly before any $r$-literal interpolation (see assertSafeSqlToken).
      assertSafeSqlToken('roleName', roleName)
      // DROP DATABASE cannot run inside a transaction/DO block.
      await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await sql.unsafe(
        `DO $$ BEGIN
           IF EXISTS (SELECT FROM pg_roles WHERE rolname = $r$${roleName}$r$) THEN
             EXECUTE format('DROP ROLE %I', $r$${roleName}$r$);
           END IF;
         END $$;`,
      )
    },
    end: () => sql.end({ timeout: 5 }),
  }
}

// ── deps assembly ─────────────────────────────────────────────────────────────
function liveDeps(): { deps: ProvisionDeps; cleanup: () => Promise<void> } {
  const creds = readProvisionerCreds()
  const kc = new KcProvisionApi(makeKcTransport(kcAdminBase(), creds))
  // Admin-assisted SA-role bootstrap (§7.2): the least-privilege `create-realm` SA
  // can create + configure a realm but KC forbids it from granting the new realm's
  // realm-management roles to that realm's gremion-admin SA. So when admin creds are
  // present, supply an admin-authenticated KC client used ONLY for that one grant
  // (mirrors bootstrap-provisioner: admin touches only the per-realm SA-role seed).
  const adminKc =
    process.env.KEYCLOAK_ADMIN && process.env.KEYCLOAK_ADMIN_PASSWORD
      ? new KcProvisionApi(
          makeAdminKcTransport(kcAdminBase(), process.env.KEYCLOAK_ADMIN, process.env.KEYCLOAK_ADMIN_PASSWORD),
        )
      : undefined
  const db = makeDbExecutor()
  const deps: ProvisionDeps = {
    manifests: MODULE_MANIFESTS,
    apexDomain: apexDomain(),
    kcInternalBase: kcInternalBase(),
    adminKc,
    loadDefaultConfig: () => {
      const p = process.env.CONFIG_PATH ?? join(repoRoot, 'config', 'config.json')
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {}
    },
    loadBaseRealm: () => loadBaseRealmDoc(),
    loadTenantConfig: (configFile: string) => JSON.parse(readFileSync(configFile, 'utf-8')),
    tenantDbUrl,
    genSecret,
    writeSecretFile,
    db,
    kc,
    registry: {
      getTenantBySlug,
      registerTenant,
      updateTenantProvisioning,
      updateTenantStatus,
      ensureTenantResource,
      markTenantResourceOk,
      markTenantResourceFailed,
      getTenantResources,
    },
  }
  return { deps, cleanup: () => db.end() }
}

// ── subcommands ───────────────────────────────────────────────────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function cmdProvision(slug: string): Promise<void> {
  const configFile = flag('--config')
  if (!configFile) throw new Error('provision requires --config <file>')
  // (C) The explicit --realm flag is interpolated UNENCODED into KC Admin-API
  // paths (/admin/realms/${realm}…), so it MUST pass the same slug guard as the
  // slug fallback (which pipeline.provisionTenant already validates). Validate
  // here, before any use, and throw loudly on an invalid realm name.
  const realmFlag = flag('--realm')
  if (realmFlag !== undefined) {
    const rv = validateSlug(realmFlag)
    if (!rv.ok) throw new Error(`invalid --realm "${realmFlag}": ${rv.reason}`)
  }
  const realmName = realmFlag ?? slug
  // P2.3 (#202): optional --blueprint stamps the registry row's blueprint_ref so
  // the per-tenant seed path (resolveBlueprint) feeds this tenant ITS OWN
  // blueprint (e.g. `--blueprint MUNICIPAL_BLUEPRINT@1` for a municipal tenant).
  // Omitted → the pipeline default `STURA_BLUEPRINT@1` (byte-identical).
  const blueprintRef = flag('--blueprint')
  const { deps, cleanup } = liveDeps()
  try {
    const result = await provisionTenant(
      { slug, realmName, configFile, ...(blueprintRef ? { blueprintRef } : {}) },
      deps,
      tenantSecretsDir(),
    )
    console.log(`[tenant-provision] ${slug} provisioned (realm=${result.realmName}, issuer=${result.issuer}).`)
    console.log(`[tenant-provision] ledger: ${JSON.stringify(result.resources)}`)
    console.log(
      '[tenant-provision] NC/Matrix spaces are left PENDING — they ride the org-unit ' +
        'provisioning worker once the tenant is active (S4/S5 manual step, see the runbook).',
    )
  } finally {
    await cleanup()
  }
}

async function cmdStatusFlip(slug: string, status: 'suspended' | 'active'): Promise<void> {
  // suspend/resume — the trivial status flips that route through the ONE lifecycle
  // seam (updateTenantStatus → evictTenantRuntime, P2.1b T8): a suspended tenant
  // stops resolving IMMEDIATELY, and the T6 page serves the 503 from the
  // control-row status alone (no data-plane touch). DELETE is cmdDelete (T17).
  //
  // FIX2-LIFECYCLE (§7.8): these flips are a GUARDED state machine, NOT a bare
  // UPDATE. resumeTenant/suspendTenant read the CURRENT status and refuse any
  // illegal source — `resume <deleted-slug>` would otherwise resurrect a
  // crypto-shredded tombstone back to `active` (resolveTenantBySlug filters only
  // on status!=='active', so it would then resolve LIVE again, defeating the
  // tombstone-is-terminal / subdomain-takeover defence), and would also promote a
  // half-provisioned `provisioning` row straight to active. Resume is legal ONLY
  // from `suspended`; suspend ONLY from `active`. The slug guard + unknown-tenant
  // check + eviction all live in those registry fns now.
  const tenant = status === 'active' ? await resumeTenant(slug) : await suspendTenant(slug)
  console.log(`[tenant-provision] ${tenant.slug} status -> ${tenant.status} (runtime evicted).`)
}

// T21 (§8.7) — build a live LeafShredExecutor against the newsletter leaf PG.
// Uses NEWSLETTER_PG_URL (the leaf newsletter-postgres admin URL). Returns null if
// NEWSLETTER_PG_URL is unset (leaf not configured — cmdDelete still proceeds
// without the leaf step, leaving the leaf cleanup for a later manual / re-run).
function makeLeafShredExecutor(): LeafShredExecutor | null {
  const leafUrl = process.env.NEWSLETTER_PG_URL
  if (!leafUrl) return null
  const leafSql = postgres(leafUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
  return {
    async dropNewsletterDb(slug: string): Promise<void> {
      // DROP DATABASE cannot run inside a transaction. Use unsafe to interpolate the
      // slug-derived name; the slug is already validated by lifecycle.deleteTenant
      // (^[a-z0-9-]{1,30}$), so `newsletter_<slug>` is safe to interpolate.
      // F-3: if this throws, lifecycle.ts now propagates the error (no try/catch),
      // so deleteCatalogRow will NOT be called. Close the connection in a finally
      // block here so the PG connection is never leaked on a dropNewsletterDb failure.
      try {
        await leafSql.unsafe(`DROP DATABASE IF EXISTS "newsletter_${slug}"`)
        console.log(`[tenant-provision] leaf: dropped newsletter_${slug} (IF EXISTS)`)
      } catch (err) {
        await leafSql.end({ timeout: 5 }).catch(() => undefined)
        throw err
      }
    },
    async deleteCatalogRow(tenantId: string): Promise<void> {
      // F-3: always close the connection whether the DELETE succeeds or throws.
      try {
        await leafSql`DELETE FROM tenant_catalog WHERE tenant_id = ${tenantId}::uuid`
        console.log(`[tenant-provision] leaf: deleted tenant_catalog row for ${tenantId}`)
      } finally {
        await leafSql.end({ timeout: 5 })
      }
    },
  }
}

// T17 (§8.7) — assemble the live crypto-shred-on-delete deps and run the pipeline.
// The pure ordering (key shred → DB drop → realm delete → tombstone) lives in
// lifecycle.deleteTenant; this only supplies the live shredder, DB-drop executor,
// KC realm-delete, and the registry fns.
async function cmdDelete(slug: string): Promise<void> {
  const creds = readProvisionerCreds()
  const kc = new KcProvisionApi(makeKcTransport(kcAdminBase(), creds))
  const db = makeDbExecutor()
  const leaf = makeLeafShredExecutor()
  if (!leaf) {
    console.log(
      '[tenant-provision] NEWSLETTER_PG_URL not set — leaf shred step skipped ' +
        '(newsletter_<slug> DB + catalog row will not be removed from the leaf PG).',
    )
  }
  const deps: DeleteDeps = {
    // Crypto-shred = remove the host secret files (the per-tenant backup key is
    // the §7.9 exactly-one location, so its removal voids ALL the tenant's
    // backups). rmSync force:true is idempotent — a missing path is a no-op, so a
    // re-run after a partial shred is terminal-safe.
    shredSecretFiles: (paths) => {
      for (const p of paths) {
        if (existsSync(p)) {
          rmSync(p, { force: true })
          console.log(`[tenant-provision] crypto-shred: removed ${p}`)
        } else {
          console.log(`[tenant-provision] crypto-shred: ${p} already gone (no-op)`)
        }
      }
      return Promise.resolve()
    },
    db: { dropDatabaseAndRole: (dbName, roleName) => db.dropDatabaseAndRole(dbName, roleName) },
    kc: { deleteRealm: (realm) => kc.deleteRealm(realm) },
    registry: { getTenantBySlug, updateTenantStatus, markTenantResourceFailed, evictTenantRuntime },
    tenantSecretsDir: tenantSecretsDir(),
    ...(leaf ? { leaf } : {}),
  }
  try {
    const result = await deleteTenant(slug, deps)
    if (result.shredded) {
      console.log(
        `[tenant-provision] ${slug} DELETED — backup key + ${result.shreddedPaths.length} secret file(s) ` +
          'crypto-shredded, DB + realm dropped, row tombstoned (status=deleted; the slug is NEVER reusable, §7.8).',
      )
      console.log(
        '[tenant-provision] NOTE: Nextcloud + Matrix spaces are silo satellites this script cannot reach — ' +
          'they are flagged for MANUAL teardown in the ledger (see the runbook).',
      )
    } else {
      console.log(`[tenant-provision] ${slug} is already a tombstone (status=deleted) — nothing to do.`)
    }
  } finally {
    await db.end()
  }
}

async function cmdBootstrapProvisioner(): Promise<void> {
  // §7.2: mint the DEDICATED master-realm service-account `tenant-provisioner`
  // holding ONLY `create-realm` (KC grants the creator per-realm admin on realms it
  // creates) — NEVER the `admin` superuser, NEVER a tenant data-plane credential.
  // The admin creds are used EXACTLY ONCE, here, to create the SA; thereafter the
  // provisioner authenticates as the SA (makeKcTransport, client_credentials). The
  // SA secret is written to the host file OUTSIDE the D-SECMOUNT tenants dir so the
  // gremion-ui container can never see it through the bind mount. Idempotent — a
  // re-run reuses the existing SA and re-reads its secret.
  const adminUser = reqEnv('KEYCLOAK_ADMIN')
  const adminPassword = reqEnv('KEYCLOAK_ADMIN_PASSWORD')
  const clientId = process.env.TENANT_PROVISIONER_CLIENT_ID ?? 'tenant-provisioner'
  const kc = new KcProvisionApi(makeAdminKcTransport(kcAdminBase(), adminUser, adminPassword))
  const { clientSecret, created } = await kc.createProvisionerServiceAccount('master', clientId, ['create-realm'])
  await writeSecretFile(PROVISIONER_SECRET_FILE, clientSecret)
  console.log(
    `[tenant-provision] bootstrap-provisioner: master-realm SA "${clientId}" ${created ? 'CREATED' : 'already present'} ` +
      `with ONLY [create-realm]; secret written to ${PROVISIONER_SECRET_FILE} ` +
      `(outside the bind-mounted ${join('secrets', 'tenants')} dir). The provisioner now authenticates as this SA, ` +
      'never the admin superuser.',
  )
}

// ── reconcile (the R5 drift guard, T11) ────────────────────────────────────────
/** Derive a tenant's external host from its issuer URL (the authority is the
 *  per-tenant host the §4-4 exact URIs reference; for `default` this is the apex). */
function tenantHostFromIssuer(issuer: string): string {
  return new URL(issuer).host
}

/** Render a reconcile report as a human table to stderr + machine JSON to stdout. */
function printReport(report: ReconcileReport): void {
  console.error(`\n[tenant-provision] reconcile realm "${report.realm}" — ${report.ok ? 'PASS' : 'FAIL'}`)
  for (const c of report.checks) {
    console.error(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  — ${c.detail}`}`)
  }
  if (report.applied.length > 0) {
    console.error(`  applied repairs: ${report.applied.join(', ')}`)
  }
  console.log(JSON.stringify(report))
}

async function reconcileOne(tenant: Tenant, base: Record<string, unknown>, verifyOnly: boolean): Promise<ReconcileReport> {
  const creds = readProvisionerCreds()
  const transport = makeKcTransport(kcAdminBase(), creds)
  return reconcileRealm(transport, {
    realm: tenant.realmName,
    tenantHost: tenantHostFromIssuer(tenant.issuer),
    apexDomain: apexDomain(),
    base,
    // (B) the DEFAULT realm legitimately keeps its localhost dev URIs (the live
    // `sturaos` realm carries them) — flag it so the URI checks don't false-fail.
    isDefault: tenant.slug === 'default',
    verifyOnly,
  })
}

/** Render the per-tenant outcome lines of a `--all` fleet pass to stderr (the
 *  individual §4 reports are already printed by reconcileOne via printReport). */
function printFleetSummary(fleet: FleetReport): void {
  console.error('\n[tenant-provision] reconcile --all summary:')
  for (const r of fleet.rows) {
    if (r.outcome === 'skipped') {
      console.error(`  skip  ${r.slug} (realm=${r.realm}) — status=${r.skippedStatus} carries no realm`)
    } else if (r.outcome === 'error') {
      console.error(`  ERR   ${r.slug} (realm=${r.realm}) — ${r.error}`)
    } else {
      console.error(`  ${r.report?.ok ? 'pass' : 'FAIL'}  ${r.slug} (realm=${r.realm})`)
    }
  }
}

async function cmdReconcile(positional: string | undefined): Promise<void> {
  const verifyOnly = process.argv.includes('--verify-only')
  const all = process.argv.includes('--all')
  if (!all && !positional) throw new Error('reconcile requires <slug> or --all')

  const base = loadBaseRealmDoc()

  if (all) {
    const tenants = [...(await listTenants())]
    if (tenants.length === 0) throw new Error('reconcile --all: no tenants registered')
    // (C) SKIP non-realm-bearing tenants (deleted/deleting/provisioning) and
    // try/catch each realm-bearing reconcile, so one tombstone (or one tenant's
    // Admin-API throw) can never abort the whole fleet pass. reconcileFleet prints
    // each tenant's §4 report as it lands; anyFailed still drives exit 1 on any
    // genuine failure (a failed check OR a thrown error — never a skip).
    const fleet = await reconcileFleet(tenants, async (t) => {
      const report = await reconcileOne(t, base, verifyOnly)
      printReport(report)
      return report
    })
    printFleetSummary(fleet)
    if (fleet.anyFailed) process.exitCode = 1
    return
  }

  const v = validateSlug(positional!)
  if (!v.ok) throw new Error(`invalid slug "${positional}": ${v.reason}`)
  const tenant = await getTenantBySlug(v.slug)
  if (!tenant) throw new Error(`unknown tenant "${v.slug}"`)
  const report = await reconcileOne(tenant, base, verifyOnly)
  printReport(report)
  // --verify-only exits 1 on ANY failed check (named in the table above); apply
  // mode also exits 1 if drift remains after the repairable replays (e.g. a
  // wildcard URI the §4-2 sequence cannot mechanically fix — re-import needed).
  if (!report.ok) process.exitCode = 1
}

// ── materialize-config (T15) ───────────────────────────────────────────────
/** The on-disk config path for a slug — mirrors registry.ts configPathForTenant
 *  (D-CONFIGPATH): `default` → the CONFIG_PATH env (same fallback as
 *  loadDefaultConfig); any other slug → /data/<slug>/config.json. An explicit
 *  `--config <path>` overrides it (for a smoke-stack/S4 copy, per the plan). */
function configPathForSlug(slug: string): string {
  const override = flag('--config')
  if (override) return override
  if (slug === 'default') return process.env.CONFIG_PATH ?? join(repoRoot, 'config', 'config.json')
  return `/data/${slug}/config.json`
}

/**
 * materialize-config <slug> (default slug: `default`) — read the tenant's stored
 * config.json, run it through `materializeConfig` (defaults + stored, fully
 * merged), enforce the §6-P2.2 brand-identity guard, and write the complete
 * config back atomically. After T15 the source DEFAULT_CONFIG brand/legal block
 * is NEUTRAL, so an institution's real identity must already be present in the
 * stored file (Setup wizard / Settings); materialization bakes the effective
 * defaults in so the resolved config is self-contained and source carries no
 * institution literal. The guard REFUSES (loud, non-zero exit) a still-blank
 * brand — no silent blank render.
 */
function cmdMaterializeConfig(positional: string | undefined): void {
  const slug = positional ?? 'default'
  const v = validateSlug(slug)
  if (!v.ok) throw new Error(`invalid slug "${slug}": ${v.reason}`)
  const path = configPathForSlug(v.slug)

  const rawStored: unknown = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as unknown)
    : {}
  if (!existsSync(path)) {
    console.warn(
      `[tenant-provision] materialize-config: ${path} does not exist — materializing from neutral defaults. ` +
        'The brand-identity guard will refuse to write a blank identity.',
    )
  }

  // parseConfig (inside materializeConfig) THROWS loudly on a malformed stored
  // file rather than silently defaulting.
  const merged = materializeConfig(rawStored)
  // §6-P2.2 boot guard: no silent blank / no missing institution identity.
  assertBrandIdentityComplete(merged, v.slug)

  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify(merged, null, 2))
  renameSync(tmp, path)
  console.log(
    `[tenant-provision] materialize-config: wrote fully-merged effective config for "${v.slug}" to ${path} ` +
      `(brand: product="${merged.brand.product}", org_short="${merged.brand.org_short}").`,
  )
}

async function main(): Promise<void> {
  const [, , subcommand, positional] = process.argv
  switch (subcommand) {
    case 'provision':
      if (!positional) throw new Error('provision requires <slug>')
      await cmdProvision(positional)
      break
    case 'suspend':
      // (B) require the positional slug for the slug-taking lifecycle subcommands
      // (mirrors the provision guard above): without it cmdStatusFlip/cmdDelete
      // would forward an undefined into validateSlug/the registry and fail with an
      // opaque error instead of a clear `<cmd> requires <slug>`.
      if (!positional) throw new Error('suspend requires <slug>')
      await cmdStatusFlip(positional, 'suspended')
      break
    case 'resume':
      if (!positional) throw new Error('resume requires <slug>')
      await cmdStatusFlip(positional, 'active')
      break
    case 'delete':
      if (!positional) throw new Error('delete requires <slug>')
      await cmdDelete(positional)
      break
    case 'bootstrap-provisioner':
      await cmdBootstrapProvisioner()
      break
    case 'reconcile':
      // The positional <slug> is the first non-flag arg after the subcommand
      // (so `reconcile --verify-only t2` and `reconcile t2 --verify-only` both work).
      await cmdReconcile(process.argv.slice(3).find((a) => !a.startsWith('--')))
      break
    case 'materialize-config':
      cmdMaterializeConfig(positional)
      break
    default:
      console.error(
        'usage: tenant-provision <provision|suspend|resume|delete|bootstrap-provisioner|reconcile|materialize-config> …',
      )
      process.exitCode = 1
  }
}

// Touch getTenantStatusBySlug + dbNameForSlug so the imports are not flagged
// dead by the type-checker; they document the resolution invariants the script
// relies on (status-only lookup, t_<slug> physical name) for future subcommands.
void getTenantStatusBySlug
void dbNameForSlug

main().catch((err) => {
  tlog('error', '[tenant-provision] FAILED', {
    err: err instanceof Error ? err.message : String(err),
  })
  process.exitCode = 1
})
