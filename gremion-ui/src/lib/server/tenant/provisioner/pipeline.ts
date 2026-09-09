// src/lib/server/tenant/provisioner/pipeline.ts
// P2.1c (T10) — the idempotent, registry-row-driven provision pipeline (design
// §6-P2.1 item 7), carrying the §4 realm contract from day one. PURE
// orchestration over INJECTED dependencies (DB executor, KC Admin API, registry
// fns, secret-file writer) so the whole fail-closed ordering is unit-testable
// with a fully-mocked KC/DB; the CLI (scripts/tenant-provision.ts) supplies the
// live deps.
//
// Fail-closed ordering (review round 1; each step idempotent + ledger-marked):
//   (1) slug guard + D-WIZARD gate
//   (2) registry INSERT-FIRST with status='provisioning' (NEVER 'active' —
//       resolveTenantBySlug resolves only active rows, so a half-provisioned
//       tenant is structurally non-resolvable)
//   (3) DB: CREATE DATABASE t_<slug> + role (same SQL shape as init-databases.sh),
//       write the generated password to the HOST tenant-secrets dir (D-SECMOUNT)
//   (4) realm: composeRealm + per-tenant identity/issuer/exact-URIs/secrets +
//       sslRequired:'all' + #239 users assertion; POST /admin/realms (already
//       exists -> reconcile)
//   (5) step-up contract apply against the realm (§4-2, idempotent) + grant the
//       gremion-admin SA its realm-management role(s) (A — imports drop SA mappings)
//   (6) write back realm/issuer/client-id/secret-refs via updateTenantProvisioning
//       (registerTenant is ON CONFLICT DO NOTHING, so it cannot update)
//   (7) NC/Matrix = ledger rows left 'pending' (satellite spaces ride the
//       existing org-unit provisioning worker once the tenant is active)
//   (8) FINAL: flip status -> 'active' via updateTenantStatus (also evicts runtime)
import { validateSlug, dbNameForSlug } from '$lib/server/tenant/slug'
import { assertMultiTenantEnabled } from './wizard-gate'
import {
  buildTenantRealmDoc,
  issuerForTenant,
  kcInternalForTenant,
  PROVISIONER_SECRET_CLIENTS,
} from './realm-doc'
import type { ModuleManifest } from '$lib/modules/types'
import type { KcProvisionApi } from './kc-admin-api'
import type {
  Tenant,
  TenantInput,
  TenantSubsystem,
  TenantProvisioningPatch,
  TenantProvisioningResource,
} from '$lib/server/tenant/registry'

/** The UI client id is universal per-realm (D-UICLIENT — frozen, no column). */
const UI_CLIENT_ID = 'gremion-ui'
/** The KC-admin service-account client whose SA must hold realm-management roles. */
export const ADMIN_CLIENT_ID = 'gremion-admin'
/** (A) The realm-management client role(s) the gremion-admin SA must hold — exactly
 *  what the live `assign_realm_admin_to_sa` assigns (configure-keycloak-clients.sh
 *  :138-144). `realm-admin` is the composite that carries manage-users /
 *  manage-groups / view-realm, which governance sync, newsletter group resolution
 *  and #164 step-up freshness all need. Imports do NOT carry SA role mappings
 *  reliably in KC 26, so the provisioner grants them post-create. */
export const GREMION_ADMIN_SA_REALM_ROLES = ['realm-admin'] as const
/** The container path tenant secrets are bind-mounted at (D-SECMOUNT). */
const CONTAINER_SECRETS_PREFIX = '/run/secrets/tenants'

/** Host-side DB admin executor (CREATE DATABASE + role). Runs operator-side
 *  with a superuser/CREATEDB connection — NOT the per-tenant data-plane pool. */
export interface ProvisionDbExecutor {
  databaseExists(dbName: string): Promise<boolean>
  /** Same idempotent SQL shape as init-databases.sh create_db_and_user. */
  createDatabaseAndRole(dbName: string, roleName: string, password: string): Promise<void>
}

/** The KC Admin-API surface the pipeline needs (KcProvisionApi subset). */
export type ProvisionKc = Pick<
  KcProvisionApi,
  'realmExists' | 'createRealm' | 'configureStepupFlow' | 'assignServiceAccountRealmRoles'
>

/** The registry surface the pipeline needs (real registry.ts fns, or mocks). */
export interface ProvisionRegistry {
  getTenantBySlug(slug: string): Promise<Tenant | null>
  registerTenant(input: TenantInput): Promise<Tenant>
  updateTenantProvisioning(slug: string, patch: TenantProvisioningPatch): Promise<Tenant | null>
  updateTenantStatus(
    tenantId: string,
    status: 'active' | 'suspended' | 'deleting' | 'deleted',
  ): Promise<Tenant | null>
  ensureTenantResource(tenantId: string, subsystem: TenantSubsystem): Promise<void>
  markTenantResourceOk(tenantId: string, subsystem: TenantSubsystem, externalId: string): Promise<void>
  markTenantResourceFailed(tenantId: string, subsystem: TenantSubsystem, error: string): Promise<void>
  getTenantResources(
    tenantId: string,
  ): Promise<readonly Pick<TenantProvisioningResource, 'subsystem' | 'status'>[]>
}

export interface ProvisionDeps {
  manifests: ModuleManifest[]
  /** The deployment apex domain (e.g. `council.example`) — issuer/host derivation. */
  apexDomain: string
  /** (A) #139/G-080: the in-cluster KC admin/OIDC base (scheme+authority+`/auth`,
   *  NO realm suffix) the provisioned tenant's admin client uses. MUST be the
   *  internal-TLS URL (`https://keycloak:8443/auth`) so it can reach a realm
   *  stamped `sslRequired:'all'`. Derived by the CLI from `AUTH_KEYCLOAK_INTERNAL`
   *  exactly like the default tenant (register-default.ts); omitted -> the TLS
   *  default in kcInternalForTenant. */
  kcInternalBase?: string
  /** The DEFAULT tenant's parsed config (D-WIZARD gate consumes deployment.mode). */
  loadDefaultConfig(): unknown
  /** The module-neutral base realm template (parsed realm-export.base.json). */
  loadBaseRealm(): Record<string, unknown>
  /** The tenant's vertical config (drives module deselection). */
  loadTenantConfig(configFile: string): { modules: Record<string, boolean> }
  /** Build the tenant's FULL runtime DB connection URL. resolveTenantBySlug reads
   *  the db secret AS the connection URL (mirroring the default tenant's
   *  env:DATABASE_URL) — NOT a bare password, so this must produce a complete URL.
   *  The CLI derives the host/port authority from the app's DATABASE_URL (pgbouncer
   *  in prod); tests supply a deterministic builder. */
  tenantDbUrl(role: string, password: string, dbName: string): string
  /** Generate a fresh client/db secret (crypto-random in the CLI). */
  genSecret(): string
  /** Write a generated secret to its HOST file (0600 + Windows no-op warning). */
  writeSecretFile(hostPath: string, value: string): Promise<void>
  db: ProvisionDbExecutor
  kc: ProvisionKc
  /** Admin-assisted SA-role bootstrap: an OPTIONAL admin-authenticated KC client
   *  used ONLY for assignServiceAccountRealmRoles. KC's cross-realm role-map
   *  protection forbids the least-privilege `create-realm` SA from granting a
   *  freshly-created realm's realm-management roles to that realm's gremion-admin SA
   *  (the SA can create + fully configure the realm, but not bootstrap ANOTHER
   *  SA's realm-management roles). When provided, that one grant runs as admin;
   *  every other KC op stays on the least-privilege `kc`. Omitted (tests /
   *  single-tenant) -> the grant falls back to `kc`. */
  adminKc?: Pick<ProvisionKc, 'assignServiceAccountRealmRoles'>
  registry: ProvisionRegistry
}

export interface ProvisionArgs {
  slug: string
  /** The KC realm name for this tenant (defaults to the slug if omitted). */
  realmName?: string
  configFile: string
  /** P2.3 (#202): the registry `blueprint_ref` to stamp on the tenant row — the
   *  per-tenant seed path (resolveBlueprint) reads it back to feed this tenant
   *  ITS OWN blueprint at seed time. Defaults to the StuRa ref so the default /
   *  existing provision path stays byte-identical. The CLI's `--blueprint` flag
   *  supplies e.g. `MUNICIPAL_BLUEPRINT@1` for a municipal tenant. */
  blueprintRef?: string
}

export interface ProvisionResult {
  slug: string
  realmName: string
  issuer: string
  /** Per-subsystem ledger status after the run. */
  resources: Record<string, string>
  /** True when this run created the realm; false on a reconcile/idempotent re-run. */
  realmCreated: boolean
}

/** The container secret ref for a per-tenant secret file name (D-SECMOUNT). */
function containerRef(name: string): string {
  return `file:${CONTAINER_SECRETS_PREFIX}/${name}`
}

/** Translate a container secret name to its host path under TENANT_SECRETS_DIR. */
function hostPathFor(name: string, tenantSecretsDir: string): string {
  return `${tenantSecretsDir.replace(/\/$/, '')}/${name}`
}

export async function provisionTenant(
  args: ProvisionArgs,
  deps: ProvisionDeps,
  tenantSecretsDir = './secrets/tenants',
): Promise<ProvisionResult> {
  // (1) slug guard + D-WIZARD gate (before ANY write).
  const v = validateSlug(args.slug)
  if (!v.ok) throw new Error(`invalid slug "${args.slug}": ${v.reason}`)
  assertMultiTenantEnabled(deps.loadDefaultConfig())

  const slug = v.slug

  // (1a) §7.8 — identifier reuse is forbidden on delete (subdomain-takeover
  // defence): a deleted/deleting slug is a TOMBSTONE, never reassignable. Refuse
  // BEFORE any write. (registerTenant is ON CONFLICT (slug) DO NOTHING and would
  // otherwise silently return the tombstone row and provision over it.)
  const existing = await deps.registry.getTenantBySlug(slug)
  if (existing && (existing.status === 'deleted' || existing.status === 'deleting')) {
    throw new Error(
      `refusing to provision "${slug}": the slug is a tombstone (status="${existing.status}") — ` +
        'identifier reuse is forbidden on delete (§7.8)',
    )
  }
  const realmName = args.realmName ?? slug
  const tenantHost = `${slug}.${deps.apexDomain}`
  const issuer = issuerForTenant(slug, realmName, deps.apexDomain)
  // (A) #139/G-080: internal-TLS kcInternal so the admin client can reach a
  // realm stamped sslRequired:'all' (deps.kcInternalBase derived from
  // AUTH_KEYCLOAK_INTERNAL like the default tenant; TLS default otherwise).
  const kcInternal = kcInternalForTenant(realmName, deps.kcInternalBase)
  const dbName = dbNameForSlug(slug) // t_<slug>
  const dbRoleName = dbName // role shares the db name (init-databases.sh shape)

  // Deterministic per-tenant secret file names + their container refs.
  const dbSecretName = `tenant_${slug}_db`
  const adminClientSecretName = `tenant_${slug}_client_gremion-admin`
  const uiClientSecretName = `tenant_${slug}_client_${UI_CLIENT_ID}`
  const backupKeySecretName = `tenant_${slug}_backup_key` // §8.7 per-tenant backup key
  const dbConnRef = containerRef(dbSecretName)
  const kcClientRef = containerRef(adminClientSecretName) // gremion-admin (KC-admin client)
  const authClientRef = containerRef(uiClientSecretName) // gremion-ui (Auth.js UI client)
  const backupKeyRef = containerRef(backupKeySecretName)

  // (2) registry INSERT-FIRST as 'provisioning' (idempotent: ON CONFLICT (slug)
  // DO NOTHING). Known/placeholder refs go in at insert.
  const insert: TenantInput = {
    slug,
    status: 'provisioning',
    dbConnRef,
    realmName,
    issuer,
    kcInternal,
    kcClientId: 'gremion-admin',
    kcClientRef,
    authClientRef,
    ncTarget: {},
    matrixSpace: { aliasNamespace: `${slug}-` },
    domainProfile: { subdomain: slug, residencyZone: 'eu' },
    brandRef: `config:${slug}`,
    // P2.3 (#202): the per-tenant seed path resolves THIS ref back to the
    // tenant's own blueprint. Defaults to the StuRa ref (byte-identical to the
    // pre-T3 hardcode) when no --blueprint is supplied.
    blueprintRef: args.blueprintRef ?? 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 4, prepare: true },
    backupKeyRef,
    audiences: ['gremion-ui', 'gremion-mobile'],
  }
  const tenant = await deps.registry.registerTenant(insert)
  const tenantId = tenant.id

  // Open every ledger row up front (idempotent), so a retry sees prior state.
  for (const sub of ['db', 'realm', 'nextcloud', 'matrix'] as const) {
    await deps.registry.ensureTenantResource(tenantId, sub)
  }
  const ledger = async () => {
    const rs = await deps.registry.getTenantResources(tenantId)
    return new Map(rs.map((r) => [r.subsystem, r.status]))
  }

  // (3) DB — idempotent: skip when the resource is already ok OR the DB exists.
  if ((await ledger()).get('db') !== 'ok') {
    try {
      if (!(await deps.db.databaseExists(dbName))) {
        const dbPassword = deps.genSecret()
        await deps.db.createDatabaseAndRole(dbName, dbRoleName, dbPassword)
        // D-SECMOUNT: the FULL connection URL crosses to the container via the
        // tenant-secrets bind mount (resolveTenantBySlug reads this secret AS the
        // dbUrl, like the default's env:DATABASE_URL); the registry holds the
        // CONTAINER ref only. Writing a bare password here makes the resolver throw
        // "Invalid URL" — the tenant DB secret MUST be a complete connection URL.
        await deps.writeSecretFile(
          hostPathFor(dbSecretName, tenantSecretsDir),
          deps.tenantDbUrl(dbRoleName, dbPassword, dbName),
        )
        // §8.7: write the per-tenant backup KEY file on this CREATE path, exactly
        // like the DB password — backupKeyRef is recorded at INSERT but is a
        // phantom file until written. Without it, per-tenant backup is impossible
        // on a freshly provisioned tenant and crypto-shred-on-delete (lifecycle.ts)
        // targets a non-existent file. Guarded by the same !databaseExists CREATE
        // condition (mirrors the db/realm ledger guards), so a reconcile re-run
        // never re-generates it.
        const backupKey = deps.genSecret()
        await deps.writeSecretFile(hostPathFor(backupKeySecretName, tenantSecretsDir), backupKey)
      }
      await deps.registry.markTenantResourceOk(tenantId, 'db', dbName)
    } catch (err) {
      await deps.registry.markTenantResourceFailed(tenantId, 'db', String(err))
      throw err
    }
  }

  // (4)+(5) realm — idempotent: skip create when realm exists (reconcile path).
  let realmCreated = false
  if ((await ledger()).get('realm') !== 'ok') {
    try {
      const realmExists = await deps.kc.realmExists(realmName)
      if (!realmExists) {
        // Generate the confidential-client secrets; place literals into the
        // realm doc (KC import needs them) and write each to its host file.
        const clientSecrets: Record<string, string> = {}
        for (const client of PROVISIONER_SECRET_CLIENTS) {
          const secret = deps.genSecret()
          clientSecrets[client] = secret
          await deps.writeSecretFile(
            hostPathFor(`tenant_${slug}_client_${client}`, tenantSecretsDir),
            secret,
          )
        }
        const realmDoc = buildTenantRealmDoc({
          base: deps.loadBaseRealm() as never,
          manifests: deps.manifests,
          config: deps.loadTenantConfig(args.configFile),
          slug,
          realmName,
          tenantHost,
          apexDomain: deps.apexDomain,
          clientSecrets,
        })
        const res = await deps.kc.createRealm(realmDoc as Record<string, unknown>)
        realmCreated = !res.alreadyExisted
      }
      // (5) step-up contract apply (idempotent; drift-proof even on fresh import).
      await deps.kc.configureStepupFlow(realmName)
      // (A) grant the gremion-admin service account its realm-management role(s) —
      // KC 26 imports do NOT carry SA role mappings reliably, so without this the
      // tenant's gremion-admin client_credentials grant succeeds but every Admin REST
      // op 403s (governance sync, newsletter group resolution, #164 step-up
      // freshness all break). Idempotent: KC no-ops duplicate role-mappings, so a
      // reconcile re-run is safe. Ported from assign_realm_admin_to_sa.
      // Admin-assisted bootstrap: KC's cross-realm role-map protection forbids the
      // least-privilege `create-realm` SA from granting realm-management roles to
      // the new realm's gremion-admin SA, so this ONE grant runs as admin when an
      // adminKc is supplied (it falls back to `kc` in tests / when none is given).
      await (deps.adminKc ?? deps.kc).assignServiceAccountRealmRoles(
        realmName,
        ADMIN_CLIENT_ID,
        GREMION_ADMIN_SA_REALM_ROLES,
      )
      await deps.registry.markTenantResourceOk(tenantId, 'realm', realmName)
    } catch (err) {
      await deps.registry.markTenantResourceFailed(tenantId, 'realm', String(err))
      throw err
    }
  }

  // (6) write back the provisioner-owned columns (registerTenant is DO NOTHING,
  // so this explicit slug-guarded UPDATE is required). NOTE: kc_client_id is
  // deliberately OMITTED — it MUST stay at the INSERT value 'gremion-admin' (the
  // KC-admin service-account client that resolveTenantBySlug feeds into
  // getKeycloakAdminClient for the client_credentials grant). D-UICLIENT freezes
  // the UI client (authClientId) to 'gremion-ui' at registry.ts — NOT this admin
  // client. Overwriting kc_client_id with 'gremion-ui' here breaks EVERY KC Admin
  // REST op for the tenant (gremion-ui has no service account): governance sync,
  // newsletter group resolution, #164 hasOtpCredential step-up.
  await deps.registry.updateTenantProvisioning(slug, {
    realmName,
    issuer,
    kcInternal,
    kcClientRef,
    authClientRef,
    dbConnRef,
  })

  // (7) NC/Matrix space provisioning — left pending (satellite spaces ride the
  // existing org-unit provisioning worker once the tenant is active). No-op:
  // the ledger rows are already 'pending' from the ensure above; we do NOT mark
  // them ok here. (Recorded as a known S4/S5 manual step in the runbook.)

  // (8) FINAL: become resolvable. updateTenantStatus also evicts the runtime.
  await deps.registry.updateTenantStatus(tenantId, 'active')

  const finalLedger = await ledger()
  return {
    slug,
    realmName,
    issuer,
    resources: Object.fromEntries(finalLedger),
    realmCreated,
  }
}
