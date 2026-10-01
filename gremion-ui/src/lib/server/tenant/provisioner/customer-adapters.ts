// src/lib/server/tenant/provisioner/customer-adapters.ts
// TASK-043: gremion-ui's implementations of the @gremion/provisioning ports
// that need $lib -- the control registry, the tenant config file, Keycloak,
// the kernel data plane (gremion-ui's OWN migrator, Q3/Q21), the first body
// (the org-unit projection, Q8), the domain binding and the broker account.
// The order and the post-conditions live in the package; every function here
// reads before it writes, so a rerun over a completed customer mutates nothing.
//
// Runs in the tenant-create one-shot (scripts/tenant-provision.ts), never in
// the app process.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { checkTenantHostDns, type EdgeAddresses } from '@gremion/edge-routers'
import { ensureTenantAccount } from '@gremion/nats-auth'
import type { AdminSpec, ControlRow, CustomerRef, KernelPostCondition, ProvisioningDeps, SmtpReadBack } from '@gremion/provisioning'
import { ensureKernelDatabase, kernelDbName, kernelRoles, type ModuleServer } from '@gremion/tenant-store/lifecycle'
import type { ModuleManifest } from '$lib/modules/types'
import { runMigrations } from '$lib/server/db'
import { createOrgUnit, type OrgUnit } from '$lib/server/governance/org-units-db'
import { provisionOrgUnit } from '$lib/server/governance/provisioning/orchestrator'
import { DEFAULT_BLUEPRINT_REF } from '$lib/server/seed/blueprint-registry'
import { createKeycloakSubsystem } from '$lib/server/governance/provisioning/subsystems/keycloak'
import type { Adapters, ProvisioningSubsystem } from '$lib/server/governance/provisioning/types'
import { runWithTenant, getTenant } from '$lib/server/tenant/context'
import {
  addTenantDomain,
  configPathForTenant,
  contextForProvisioningTenant,
  ensureTenantResource,
  evictTenantRuntime,
  getTenantById,
  getTenantBySlug,
  markTenantResourceOk,
  primaryHostForTenant,
  registerTenant,
  resumeTenant,
  suspendTenant,
  updateTenantStatus,
  type Tenant,
  type TenantInput,
} from '$lib/server/tenant/registry'
import { getDb } from '$lib/server/db'
import { KcProvisionApi } from './kc-admin-api'
import { assertBrandIdentityComplete, materializeConfig } from './materialize'
import { ADMIN_CLIENT_ID, GREMION_ADMIN_SA_REALM_ROLES } from './pipeline'
import { buildTenantRealmDoc, issuerForTenant, kcInternalForTenant, PROVISIONER_SECRET_CLIENTS } from './realm-doc'

/** The container path per-tenant secrets live at (D-SECMOUNT). */
export const CONTAINER_SECRETS_PREFIX = '/run/secrets/tenants'

export interface CustomerAdapterOptions {
  /** DOMAIN: the apex the base realm template's exact URIs reference. */
  apexDomain: string
  /** AUTH_KEYCLOAK_INTERNAL-derived base for the realm's kc_internal. */
  kcInternalBase?: string
  /** Where this process writes the tenant secret files (TENANT_SECRETS_DIR). */
  tenantSecretsDir: string
  /** DATABASE_URL: the runtime pooler authority a tenant's db secret uses. */
  runtimeDatabaseUrl: string
  /** The kernel server's POSTGRES_USER, DIRECT (never the pooler). */
  kernelAdminUrl: string
  /** The operator's --config (the tenant's vertical config, brand identity included). */
  configFile: string
  /** The first body's display name (Q8). */
  bodyName: string
  /** The edge's public addresses for the DNS pre-flight; null = the operator switched it off. */
  edge: EdgeAddresses | null
  /** The storage root (<root>/<tenant id>/...), or null when this container mounts none. */
  storageRoot: string | null
  manifests: ModuleManifest[]
  loadBaseRealm(): Record<string, unknown>
  genSecret(): string
  writeSecretFile(hostPath: string, value: string): Promise<void>
  /** Writes the tenant's config.json atomically (the CLI's writer: this module
   *  holds no write-capable fs call, check-storage-seam s3). */
  writeConfigFile(path: string, text: string): void
  /** Creates a 0700 directory; the CLI's (same reason). */
  makePrivateDir(dir: string): void
  kc: KcProvisionApi
  /** Admin-assisted SA-role bootstrap (see pipeline.ts ProvisionDeps.adminKc). */
  adminKc?: Pick<KcProvisionApi, 'assignServiceAccountRealmRoles'>
  log?: (line: string) => void
}

const secretName = {
  db: (slug: string) => `tenant_${slug}_db`,
  backupKey: (slug: string) => `tenant_${slug}_backup_key`,
  client: (slug: string, client: string) => `tenant_${slug}_client_${client}`,
}
const containerRef = (name: string) => `file:${CONTAINER_SECRETS_PREFIX}/${name}`

/** scheme://authority and ?query of a postgres url, with the credentials dropped. */
function authorityOf(url: string, what: string): { scheme: string; hostPort: string; query: string } {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]+)[^?#]*(\?[^#]*)?/i.exec(url)
  if (!m) throw new Error(`${what}: cannot parse scheme and authority`)
  return { scheme: m[1]!, hostPort: m[2]!, query: m[3] ?? '' }
}

/** The runtime DATABASE_URL goes through PgBouncer (the pooled stack: pgbouncer-<stack>:6432). */
function isPooled(runtimeDatabaseUrl: string): boolean {
  const hostPort = authorityOf(runtimeDatabaseUrl, 'DATABASE_URL').hostPort
  return /pgbouncer/i.test(hostPort) || hostPort.endsWith(':6432')
}

function dbUrl(base: string, user: string, password: string, db: string, extraQuery = ''): string {
  const a = authorityOf(base, 'database url')
  const q = [a.query.replace(/^\?/, ''), extraQuery].filter(Boolean).join('&')
  return `${a.scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${a.hostPort}/${db}${q ? `?${q}` : ''}`
}

/** The kernel server behind KERNEL_PG_ADMIN (ModuleServer shape, for ensureKernelDatabase). */
export function kernelServer(adminUrl: string): ModuleServer & { close(): Promise<void> } {
  const admin = postgres(adminUrl, { max: 2, onnotice: () => {}, connect_timeout: 15 })
  const pools: postgres.Sql[] = []
  return {
    admin,
    open(database) {
      const u = new URL(adminUrl)
      u.pathname = `/${database}`
      const sql = postgres(u.toString(), { max: 2, onnotice: () => {}, connect_timeout: 15 })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

async function tenantOf(c: CustomerRef): Promise<Tenant> {
  const t = await getTenantById(c.id)
  if (!t) throw new Error(`customer ${c.slug} (${c.id}) has no control row`)
  return t
}

async function inProvisioningContext<T>(c: CustomerRef, fn: () => Promise<T>, opts: { dbUrl?: string } = {}): Promise<T> {
  const tenant = await tenantOf(c)
  // Pools are keyed by tenant id: drop any pool opened for another url first,
  // and drop this one after, so the owner-role migration pool never serves
  // anything else in this process.
  evictTenantRuntime(c.id)
  try {
    const ctx = await contextForProvisioningTenant(tenant, opts)
    return await runWithTenant(ctx, fn)
  } finally {
    evictTenantRuntime(c.id)
  }
}

/**
 * The adapters of the first-body projection (Q8): Keycloak only. The body is
 * created with wantsMatrixRoom and wantsNextcloudFolder false, so the
 * orchestrator never calls the other two; should it ever, they refuse BY NAME
 * instead of failing on an undefined adapter (review B2, r2).
 */
export function firstBodyAdapters(keycloak: ProvisioningSubsystem): Adapters {
  const notWanted = (name: 'matrix' | 'nextcloud'): ProvisioningSubsystem => {
    const refuse = (): Promise<never> => Promise.reject(new Error(`the first body wants no ${name} resource: the ${name} adapter must not be called`))
    return { name, ensureResource: refuse, removeResource: refuse, addMember: refuse, removeMember: refuse, reconcileMembers: refuse }
  }
  return { keycloak, matrix: notWanted('matrix'), nextcloud: notWanted('nextcloud') }
}

export function customerAdapters(o: CustomerAdapterOptions): Pick<ProvisioningDeps, 'control' | 'config' | 'realm' | 'kernel' | 'domain' | 'storage' | 'firstBody' | 'broker'> {
  const log = o.log ?? (() => {})
  const hostPath = (name: string) => `${o.tenantSecretsDir.replace(/\/$/, '')}/${name}`
  const readSecretFile = (name: string): string | null => (existsSync(hostPath(name)) ? readFileSync(hostPath(name), 'utf-8').trim() : null)

  /**
   * TASK-043b F3: the gremion-admin SA's realm-management roles, read first.
   * A realm this provisioner creates carries them in the realm document it POSTs
   * (buildTenantRealmDoc), so nothing is granted. Only a realm without them (one
   * created before that document carried them, or drift) is granted -- through
   * adminKc when the caller supplied one, else the provisioner, which
   * Keycloak refuses for realm-admin (403, measured on 26.6.1): that is a named
   * failure whose remedy is the admin console (`gremion-tenant create` passes the
   * one-shot no master-admin credential), never a silent pass. The post-condition is the
   * read-back, never the grant's exit.
   */
  async function ensureAdminSaRoles(realm: string): Promise<void> {
    const missingOf = (held: readonly string[]) => GREMION_ADMIN_SA_REALM_ROLES.filter((r) => !held.includes(r))
    const missing = missingOf(await o.kc.getServiceAccountRealmRoleNames(realm, ADMIN_CLIENT_ID))
    if (missing.length === 0) return
    try {
      await (o.adminKc ?? o.kc).assignServiceAccountRealmRoles(realm, ADMIN_CLIENT_ID, GREMION_ADMIN_SA_REALM_ROLES)
    } catch (err) {
      throw new Error(
        `the ${ADMIN_CLIENT_ID} service account of realm ${realm} lacks [${missing.join(', ')}] and the grant failed (${err instanceof Error ? err.message : String(err)}). ` +
          'A realm created by tenant-create carries these roles in the realm document it POSTs (TASK-043b); a realm created before needs them granted once by a Keycloak master admin in the admin console ' +
          `(realm ${realm} > Users > service-account-${ADMIN_CLIENT_ID} > Role mapping > Assign role > client realm-management: ${missing.join(', ')}), then rerun the verb`,
        { cause: err },
      )
    }
    const still = missingOf(await o.kc.getServiceAccountRealmRoleNames(realm, ADMIN_CLIENT_ID))
    if (still.length) throw new Error(`the ${ADMIN_CLIENT_ID} service account of realm ${realm} still lacks [${still.join(', ')}] after the grant`)
  }

  async function toRow(t: Tenant): Promise<ControlRow> {
    return { id: t.id, slug: t.slug, status: t.status, realm: t.realmName, host: await primaryHostForTenant(t.id) }
  }

  return {
    control: {
      async getBySlug(slug) {
        const t = await getTenantBySlug(slug)
        return t ? toRow(t) : null
      },
      async registerProvisioning({ slug, host, realm }) {
        const insert: TenantInput = {
          slug,
          status: 'provisioning',
          dbConnRef: containerRef(secretName.db(slug)),
          realmName: realm,
          issuer: issuerForTenant(host, realm),
          kcInternal: kcInternalForTenant(realm, o.kcInternalBase),
          kcClientId: ADMIN_CLIENT_ID,
          kcClientRef: containerRef(secretName.client(slug, ADMIN_CLIENT_ID)),
          authClientRef: containerRef(secretName.client(slug, 'gremion-ui')),
          ncTarget: {},
          matrixSpace: { aliasNamespace: `${slug}-` },
          domainProfile: { residencyZone: 'eu' },
          brandRef: `config:${slug}`,
          // The registry's default, not a second literal (review r4 LOW): a
          // customer is made with GREMION_DISABLE_SEEDS, so no blueprint seeds
          // it; the old --blueprint option is gone (residual for the seed/
          // owner: blueprint-registry.ts:4 still names it).
          blueprintRef: DEFAULT_BLUEPRINT_REF,
          connProfile: { perTenantMax: 4, prepare: true },
          backupKeyRef: containerRef(secretName.backupKey(slug)),
          audiences: ['gremion-ui', 'gremion-mobile'],
        }
        const t = await registerTenant(insert)
        // TASK-042's one path for a primary host: reserved-host refusal, owner
        // pre-read, eviction, one transaction. Never a second insert path.
        await addTenantDomain(t.id, host, { isPrimary: true })
        for (const sub of ['db', 'realm', 'nextcloud', 'matrix'] as const) await ensureTenantResource(t.id, sub)
        return toRow(t)
      },
      async setStatus(id, status) {
        const t = await getTenantById(id)
        if (!t) throw new Error(`no control row ${id}`)
        if (t.status === status) return
        if (status === 'suspended') await suspendTenant(t.slug)
        else if (t.status === 'suspended') await resumeTenant(t.slug)
        else if (t.status === 'provisioning') await updateTenantStatus(id, 'active')
        else throw new Error(`refusing ${t.slug} ${t.status} -> ${status}`)
      },
    },

    config: {
      async ensure(c) {
        const path = configPathForTenant(c.slug)
        if (existsSync(path)) return false
        const merged = materializeConfig(JSON.parse(readFileSync(o.configFile, 'utf-8')) as unknown)
        assertBrandIdentityComplete(merged, c.slug)
        o.writeConfigFile(path, `${JSON.stringify({ ...merged, setup_complete: false }, null, 2)}\n`)
        return true
      },
      async setupComplete(c) {
        const path = configPathForTenant(c.slug)
        return existsSync(path) && (JSON.parse(readFileSync(path, 'utf-8')) as { setup_complete?: unknown }).setup_complete === true
      },
      async markSetupComplete(c) {
        const path = configPathForTenant(c.slug)
        const cur = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
        o.writeConfigFile(path, `${JSON.stringify({ ...cur, setup_complete: true }, null, 2)}\n`)
      },
    },

    realm: {
      async ensureRealm(c) {
        if (!(await o.kc.realmExists(c.realm))) {
          const clientSecrets: Record<string, string> = {}
          for (const client of PROVISIONER_SECRET_CLIENTS) {
            clientSecrets[client] = o.genSecret()
            await o.writeSecretFile(hostPath(secretName.client(c.slug, client)), clientSecrets[client]!)
          }
          const doc = buildTenantRealmDoc({
            base: o.loadBaseRealm() as never,
            manifests: o.manifests,
            config: { modules: {} },
            slug: c.slug,
            realmName: c.realm,
            tenantHost: c.host,
            apexDomain: o.apexDomain,
            clientSecrets,
            smtp: null,
          })
          await o.kc.createRealm(doc as Record<string, unknown>)
        }
        await o.kc.configureStepupFlow(c.realm)
        await ensureAdminSaRoles(c.realm)
        await markTenantResourceOk(c.id, 'realm', c.realm)
      },
      async readSmtp(realm): Promise<SmtpReadBack> {
        const s = await o.kc.getRealmSmtp(realm)
        return { host: s.host, port: s.port, user: s.passwordSet ? s.user : null, from: s.from, starttls: s.starttls }
      },
      async ensureAdmins(c, admins: readonly AdminSpec[]) {
        const created: string[] = []
        const invited: string[] = []
        for (const a of admins) {
          const r = await o.kc.ensureInvitedUser(c.realm, { email: a.email, realmRole: a.role })
          if (r.created) created.push(a.email)
          if (r.invited) invited.push(a.email)
        }
        return { created, invited }
      },
      isEnabled: (realm) => o.kc.isRealmEnabled(realm),
      setEnabled: (realm, enabled) => o.kc.setRealmEnabled(realm, enabled),
    },

    kernel: {
      async ensureDatabase(c) {
        const dbSecret = readSecretFile(secretName.db(c.slug))
        const appPassword = dbSecret ? decodeURIComponent(new URL(dbSecret).password) : o.genSecret()
        const server = kernelServer(o.kernelAdminUrl)
        try {
          const r = await ensureKernelDatabase(server, c.id, appPassword)
          // Behind PgBouncer the tenant's app role is resolved through
          // pgbouncer.get_auth as pgbouncer_auth; without that role every pooled
          // connection fails at runtime, far from here. Fail the step instead
          // (the ledger keeps it not-done, so a rerun re-applies the grants).
          if (r.pgbouncerGrant !== 'applied') {
            if (isPooled(o.runtimeDatabaseUrl)) {
              throw new Error(
                `the kernel server has no pgbouncer_auth role, so PgBouncer cannot resolve ${r.app} for ${r.dbName}: create it (docs/runbooks/pgbouncer.md) and rerun create`,
              )
            }
            log(`kernel database ${r.dbName}: no pgbouncer_auth role on the kernel server (the runtime DATABASE_URL is direct, so none is needed)`)
          }
          if (!dbSecret) {
            await o.writeSecretFile(hostPath(secretName.db(c.slug)), dbUrl(o.runtimeDatabaseUrl, r.app, appPassword, r.dbName))
          }
          if (readSecretFile(secretName.backupKey(c.slug)) === null) {
            await o.writeSecretFile(hostPath(secretName.backupKey(c.slug)), o.genSecret())
          }
          await markTenantResourceOk(c.id, 'db', r.dbName)
          log(`kernel database ${r.dbName} ${r.created ? 'created' : 'present'}`)
        } finally {
          await server.close()
        }
      },
      async migrate(c) {
        if (process.env.GREMION_DISABLE_SEEDS !== 'true') {
          throw new Error('GREMION_DISABLE_SEEDS is not "true" in this container: the kernel migration would apply the dev *_seed.sql files (TDD 6)')
        }
        const dbSecret = readSecretFile(secretName.db(c.slug))
        if (!dbSecret) throw new Error(`the db secret of ${c.slug} is missing: database_created has not run`)
        const app = new URL(dbSecret)
        const { owner } = kernelRoles(c.id)
        // DIRECT to the kernel server (never the pooler), as the app role with
        // its session role set to the OWNER (Q3), so every object is the owner's.
        const direct = dbUrl(o.kernelAdminUrl, decodeURIComponent(app.username), decodeURIComponent(app.password), kernelDbName(c.id), `options=${encodeURIComponent(`-c role=${owner}`)}`)
        await inProvisioningContext(c, () => runMigrations(), { dbUrl: direct })
      },
      async postCondition(c): Promise<KernelPostCondition> {
        const u = new URL(o.kernelAdminUrl)
        u.pathname = `/${kernelDbName(c.id)}`
        const sql = postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 15 })
        try {
          const cols = await sql<{ c: string }[]>`
            SELECT column_name AS c FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'schema_migrations' ORDER BY ordinal_position`
          const has = async (t: string) => ((await sql<{ p: boolean }[]>`SELECT to_regclass(${`public.${t}`}) IS NOT NULL AS p`)[0]?.p ?? false)
          const seedRows = cols.length
            ? (await sql<{ f: string }[]>`SELECT filename AS f FROM public.schema_migrations WHERE filename ~ '_seed\\.sql$' ORDER BY 1`).map((r) => r.f)
            : []
          const count = async (t: string) => (await has(t) ? Number((await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${t}`))[0]?.n ?? 0) : 0)
          return { ledgerColumns: cols.map((r) => r.c), seedRows, orgUnits: await count('org_units'), committees: await count('committees') }
        } finally {
          await sql.end({ timeout: 5 })
        }
      },
    },

    domain: {
      async assertBound(c) {
        const primary = await primaryHostForTenant(c.id)
        if (primary !== c.host) throw new Error(`the primary tenant_domain of ${c.slug} is ${primary ?? 'absent'}, not ${c.host}`)
        if (o.edge === null) {
          log(`WARNING: the DNS pre-flight for ${c.host} is switched off by the operator (TENANT_DNS_PREFLIGHT=off)`)
          return
        }
        const r = await checkTenantHostDns(c.host, { edge: o.edge })
        if (!r.ok) throw new Error(`${c.host} does not resolve to this edge: ${r.problems.map((p) => `${p.code} ${p.detail}`).join('; ')}`)
      },
    },

    storage: {
      async reservePrefix(c) {
        // The storage key space is <root>/<tenant id>/... (@gremion/storage);
        // the tenant id is a fresh UUIDv7, so the prefix is unique by
        // construction. Where the root is mounted, the directory is created
        // 0700 and must be empty (a leftover would be another tenant's data).
        if (o.storageRoot === null) {
          log(`storage prefix ${c.id}/ reserved by id (no storage root is mounted in this container)`)
          return
        }
        const dir = join(o.storageRoot, c.id)
        if (existsSync(dir)) {
          if (!statSync(dir).isDirectory() || readdirSync(dir).length > 0) throw new Error(`storage prefix ${dir} exists and is not an empty directory`)
          return
        }
        o.makePrivateDir(dir)
      },
    },

    firstBody: {
      async ensure(c) {
        return inProvisioningContext(c, async () => {
          const ctx = getTenant()
          const existing = await getDb()<OrgUnit[]>`SELECT * FROM org_units WHERE parent_id IS NULL ORDER BY created_at LIMIT 2`
          if (existing.length > 1) throw new Error(`customer ${c.slug} already holds ${existing.length} top-level bodies`)
          const unit =
            existing[0] ??
            (await createOrgUnit({
              name: o.bodyName,
              description: null,
              parentId: null,
              kind: 'council',
              visibility: 'all_members',
              wantsMatrixRoom: false,
              wantsNextcloudFolder: false,
            }))
          // Q8: the Keycloak group through the org-unit projection (the same
          // ledger + adapter the provisioning worker uses), never KC Organizations.
          const report = await provisionOrgUnit(unit.id, firstBodyAdapters(createKeycloakSubsystem(ctx.kcAdminClient)))
          if (report.overall === 'failed') {
            throw new Error(`the Keycloak group of ${unit.name} was not provisioned: ${report.subsystems.map((s) => `${s.subsystem}=${s.status}${s.error ? ` (${s.error})` : ''}`).join(', ')}`)
          }
          return { created: existing.length === 0 }
        })
      },
    },

    broker: {
      async ensure(c, modules) {
        return ensureTenantAccount({ tenant: c.slug, modules })
      },
    },
  }
}
