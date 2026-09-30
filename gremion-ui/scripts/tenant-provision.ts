// gremion-ui/scripts/tenant-provision.ts
// The tenant-create one-shot's CLI (TASK-043: the container half of
// `gremion-tenant`, infra/host/bin/gremion-tenant). It DELEGATES: the order and
// the post-conditions are @gremion/provisioning's, the $lib adapters are
// src/lib/server/tenant/provisioner/customer-adapters.ts; this file assembles
// the live dependencies from the environment contract and dispatches.
//
//   init [--realm-only] [--panel-origin <origin>]   gremion_platform + catalogue rows + the ops realm (Q15, Q5)
//   phase-a <slug> <create flags>                   container phase A (realm .. broker account)
//   record-step <slug> mail_principal_issued --operator <uuid>
//                                                   the host phase's ledger step (verifies the stamp over Keycloak)
//   phase-b <slug> <create flags>                   first accounts, --enable modules, active
//   render-router <slug>                            the edge router document on STDOUT (Q17)
//   suspend <slug> --operator <uuid>                status, realm, broker (the host then revokes the principal)
//   resume <slug> --operator <uuid>                 stamp verified, realm, broker, status last
//   reconcile [--verify-only] <slug>|--all          the realm contract incl. smtp-server (repair: host)
//   status <slug>                                   provisioning status JSON on STDOUT
//   operator-add <email> [--no-mail]                an operator in the ops realm `platform` (Q5, Q23)
//   delete <slug>                                   crypto-shred delete (kernel database by tenant id)
//   bootstrap-provisioner                           the least-privilege Keycloak provisioner SA
//   materialize-config <slug> [--config <path>]     bake the effective tenant config
//   --help                                          usage (and proof that every adapter imports)
//
// <create flags>: --host <host> --config <file> --operator <uuid>
//                 --it-admin <email> --council-admin <email>
//                 [--enable a,b] [--body-name <name>]
//
// STDOUT carries only machine output (render-router, status, reconcile JSON,
// one-time secrets); every log line goes to STDERR. EXIT: 0 ok, 1 a failure,
// 2 usage or a precondition (a missing environment variable is always named).
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import {
  bootstrapPlatform,
  createPhaseA,
  createPhaseB,
  pgAttestations,
  pgLedger,
  pgModules,
  provisioningStatus,
  ProvisioningError,
  recordHostStep,
  renderCustomerRouter,
  resumeCustomer,
  suspendCustomer,
  tokenFor,
  type AdminSpec,
  type CreateSpec,
  type ProvisioningDeps,
} from '@gremion/provisioning'
import { assertPlatform, dropKernelDatabase, type LifecycleModule, type ModuleServer } from '@gremion/tenant-store/lifecycle'
import { MODULE_MANIFESTS } from '../src/lib/modules/registry'
import { validateSlug } from '../src/lib/server/tenant/slug'
import { normaliseHost } from '../src/lib/server/tenant/host'
import { isReservedPlatformHost } from '../src/lib/server/tenant/reserved-hosts'
import {
  getTenantBySlug,
  updateTenantStatus,
  markTenantResourceFailed,
  listTenants,
  evictTenantRuntime,
  listTenantDomains,
  primaryHostForTenant,
  configPathForTenant,
  type Tenant,
} from '../src/lib/server/tenant/registry'
import { KcProvisionApi, type KcTransport } from '../src/lib/server/tenant/provisioner/kc-admin-api'
import { customerAdapters, kernelServer } from '../src/lib/server/tenant/provisioner/customer-adapters'
import { fixtureIdentities } from '../src/lib/server/tenant/provisioner/fixture-identities'
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
const MIGRATIONS_DIR = join(repoRoot, 'gremion-ui', 'migrations')
const MODULES_DIR = join(repoRoot, 'modules')

const log = (line: string) => console.error(`[tenant-create] ${line}`)

/** A precondition the operator must fix: exit 2, the variable or flag named. */
class UsageError extends Error {}

// ── the environment contract (TASK-043 G3; each missing variable is a named exit-2 failure) ──
function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new UsageError(`required env ${name} is not set (tenant-create env contract, docs/ops/pooled-stack-layout.md)`)
  return v
}
/** A *_FILE variable: the file must exist and be non-empty; its content, trimmed. */
function reqFileEnv(name: string): string {
  const path = reqEnv(name)
  if (!existsSync(path)) throw new UsageError(`${name} names ${path}, which does not exist`)
  const v = readFileSync(path, 'utf-8').trim()
  if (!v) throw new UsageError(`${name} names ${path}, which is empty`)
  return v
}
function directPostgresUrl(name: string, value: string): string {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new UsageError(`${name} is not a URL`)
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new UsageError(`${name} is not a postgres:// URL`)
  // The one runner and ensure* refuse a pooler: never pgbouncer, never 6432.
  if (/pgbouncer/i.test(u.hostname) || u.port === '6432') throw new UsageError(`${name} points at the pooler (${u.hostname}:${u.port}); it must be the server itself`)
  return value
}

/** Postgres service ids the catalogue's modules run on (calendar-postgres -> calendar). */
function modulePostgresIds(catalogue: readonly LifecycleModule[]): string[] {
  const ids = new Set<string>()
  for (const m of catalogue) {
    const svc = m.moduleJson.runtime.database?.postgresService
    if (svc) ids.add(svc.replace(/-postgres$/, ''))
  }
  return [...ids].sort()
}
const envId = (id: string) => id.toUpperCase().replace(/-/g, '_')

/** Every variable phase A/B and init read, checked BEFORE anything connects. */
function assertCreateEnv(catalogue: readonly LifecycleModule[]): void {
  directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL'))
  directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE'))
  for (const id of modulePostgresIds(catalogue)) {
    directPostgresUrl(`MODULE_PG_ADMIN_${envId(id)}_FILE`, reqFileEnv(`MODULE_PG_ADMIN_${envId(id)}_FILE`))
    reqFileEnv(`MODULE_APP_PASSWORD_${envId(id)}_FILE`)
  }
  reqEnv('TENANT_EXPORT_DIR')
  if (reqEnv('GREMION_DISABLE_SEEDS') !== 'true') throw new UsageError('GREMION_DISABLE_SEEDS must be "true" in tenant-create (the kernel migration must never apply a *_seed.sql file)')
  reqEnv('DOMAIN')
  reqEnv('DATABASE_URL')
  reqEnv('CONTROL_DATABASE_URL')
  reqEnv('NATS_URL')
}

// ── the catalogue (modules/*/module.json, loadCatalogue's rule) ──────────────
function loadModules(): LifecycleModule[] {
  if (!existsSync(MODULES_DIR)) throw new UsageError(`${MODULES_DIR} is absent: the image carries no module catalogue`)
  return readdirSync(MODULES_DIR)
    .sort()
    .filter((id) => existsSync(join(MODULES_DIR, id, 'module.json')))
    .map((id) => ({ id, dir: join(MODULES_DIR, id), moduleJson: JSON.parse(readFileSync(join(MODULES_DIR, id, 'module.json'), 'utf-8')) as LifecycleModule['moduleJson'] }))
}

// ── secrets ─────────────────────────────────────────────────────────────────
function genSecret(): string {
  return randomBytes(32).toString('base64url')
}
/** 0600 host file; NTFS has no POSIX mode (D-SECMOUNT), which is said loudly. */
function writeSecretFile(hostPath: string, value: string): Promise<void> {
  mkdirSync(dirname(hostPath), { recursive: true })
  const tmp = `${hostPath}.tmp-${process.pid}`
  writeFileSync(tmp, value, { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, hostPath)
  try {
    chmodSync(hostPath, 0o600)
  } catch (err) {
    log(`WARNING: chmod 0600 ${hostPath} failed (${err instanceof Error ? err.message : err})`)
  }
  return Promise.resolve()
}
const tenantSecretsDir = () => process.env.TENANT_SECRETS_DIR ?? join(repoRoot, 'secrets', 'tenants')

/** The tenant's config.json, atomically (tmp + rename in the same directory). */
function writeConfigFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o640 })
  renameSync(tmp, path)
}

/** A 0700 directory (the customer's storage prefix). */
function makePrivateDir(dir: string): void {
  mkdirSync(dir, { mode: 0o700 })
}

// ── Keycloak (the §7.2 provisioner SA; admin only for the SA bootstrap and the SA-role grant) ──
const apexDomain = () => reqEnv('DOMAIN')
function loadBaseRealmDoc(): Record<string, unknown> {
  const raw = readFileSync(join(kcDir, 'realm-export.base.json'), 'utf-8')
  return JSON.parse(raw.split('__APEX_DOMAIN__').join(apexDomain())) as Record<string, unknown>
}
const kcAdminBase = () => process.env.KC_ADMIN_URL ?? `https://${apexDomain()}/auth`
const kcInternalBase = () => process.env.AUTH_KEYCLOAK_INTERNAL ?? 'https://keycloak:8443/auth'
const PROVISIONER_SECRET_FILE = process.env.TENANT_PROVISIONER_SECRET_FILE ?? join(repoRoot, 'secrets', 'tenant_provisioner')

function readProvisionerCreds(): { clientId: string; clientSecret: string } {
  if (!existsSync(PROVISIONER_SECRET_FILE)) {
    throw new UsageError(`provisioner credential file ${PROVISIONER_SECRET_FILE} not found — run \`bootstrap-provisioner\` once first`)
  }
  return { clientId: process.env.TENANT_PROVISIONER_CLIENT_ID ?? 'tenant-provisioner', clientSecret: readFileSync(PROVISIONER_SECRET_FILE, 'utf-8').trim() }
}

async function kcToken(base: string, form: Record<string, string>): Promise<string> {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) throw new Error(`Keycloak token fetch failed: ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

function transport(base: string, token: () => Promise<string>, refreshOnDenied: boolean): KcTransport {
  let cached: string | null = null
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cached}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  return async (method, path, body) => {
    cached ??= await token()
    let res = await send(method, path, body)
    // A create-realm SA only gains <realm>-realm admin AFTER it creates the
    // realm: refresh the token once and retry.
    if (refreshOnDenied && (res.status === 401 || res.status === 403)) {
      cached = await token()
      res = await send(method, path, body)
    }
    if (!res.ok) throw new Error(`Keycloak Admin API error: ${res.status} on ${method} ${path}: ${await res.text()}`)
    if (res.status === 204) return undefined
    const text = await res.text()
    return text ? JSON.parse(text) : undefined
  }
}

function provisionerKc(): KcProvisionApi {
  const creds = readProvisionerCreds()
  return new KcProvisionApi(transport(kcAdminBase(), () => kcToken(kcAdminBase(), { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }), true))
}
function adminKcOrUndefined(): KcProvisionApi | undefined {
  const user = process.env.KEYCLOAK_ADMIN
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD
  if (!user || !password) return undefined
  return new KcProvisionApi(transport(kcAdminBase(), () => kcToken(kcAdminBase(), { grant_type: 'password', client_id: 'admin-cli', username: user, password }), false))
}

// ── flags ───────────────────────────────────────────────────────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} requires a value`)
  return v
}
function reqFlag(name: string): string {
  const v = flag(name)
  if (!v) throw new UsageError(`${name} is required`)
  return v
}
/** Flags that take no value; every other --flag consumes the next argument. */
const BOOLEAN_FLAGS = new Set(['--verify-only', '--all', '--realm-only', '--no-mail'])
function positional(index = 0): string | undefined {
  const out: string[] = []
  const args = process.argv.slice(3)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(a)) i++
      continue
    }
    out.push(a)
  }
  return out[index]
}

function createSpec(slug: string): CreateSpec & { configFile: string; bodyName: string } {
  const admins: AdminSpec[] = [
    { role: 'it-admin', email: reqFlag('--it-admin') },
    { role: 'council-admin', email: reqFlag('--council-admin') },
  ]
  const enable = (flag('--enable') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    slug,
    host: reqFlag('--host'),
    enable,
    operatorId: reqFlag('--operator'),
    admins,
    configFile: reqFlag('--config'),
    bodyName: flag('--body-name') ?? 'Rat',
  }
}

// ── the live dependency set ──────────────────────────────────────────────────
interface Live {
  deps: ProvisioningDeps
  close(): Promise<void>
}

function edgeAddresses(): { ipv4: string[]; ipv6: string[] } | null {
  if (process.env.TENANT_DNS_PREFLIGHT === 'off') return null
  const v4 = (process.env.EDGE_BIND_IP ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const v6 = (process.env.EDGE_BIND_IP6 ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!v4.length) throw new UsageError('EDGE_BIND_IP is not set: the DNS pre-flight needs the edge address (or set TENANT_DNS_PREFLIGHT=off explicitly on a scratch stack)')
  return { ipv4: v4, ipv6: v6 }
}

function moduleServerFor(adminUrl: string): ModuleServer & { close(): Promise<void> } {
  const admin = postgres(adminUrl, { max: 2, onnotice: () => {}, connect_timeout: 15 })
  const pools: postgres.Sql[] = []
  return {
    admin,
    open(database, options) {
      const u = new URL(adminUrl)
      u.pathname = `/${database}`
      const sql = postgres(u.toString(), {
        max: 2,
        onnotice: () => {},
        connect_timeout: 15,
        ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : {}),
      })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

async function liveDeps(opts: { configFile?: string; bodyName?: string } = {}): Promise<Live> {
  const catalogue = loadModules()
  const platform = postgres(directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL')), { max: 3, onnotice: () => {}, connect_timeout: 15 })
  await assertPlatform(platform)
  const servers = new Map<string, ReturnType<typeof moduleServerFor>>()
  const serviceId = (service: string) => service.replace(/-postgres$/, '')
  const kc = provisionerKc()
  const adminKc = adminKcOrUndefined()
  const adapters = customerAdapters({
    apexDomain: apexDomain(),
    kcInternalBase: kcInternalBase(),
    tenantSecretsDir: tenantSecretsDir(),
    runtimeDatabaseUrl: reqEnv('DATABASE_URL'),
    kernelAdminUrl: directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE')),
    configFile: opts.configFile ?? '/nonexistent',
    bodyName: opts.bodyName ?? 'Rat',
    edge: edgeAddresses(),
    storageRoot: process.env.GREMION_STORAGE_ROOT ?? null,
    manifests: MODULE_MANIFESTS,
    loadBaseRealm: loadBaseRealmDoc,
    genSecret,
    writeSecretFile,
    writeConfigFile,
    makePrivateDir,
    kc,
    ...(adminKc ? { adminKc } : {}),
    log,
  })
  const deps: ProvisioningDeps = {
    platformDomain: reqEnv('PLATFORM_DOMAIN'),
    ledger: pgLedger(platform),
    attestations: pgAttestations(platform),
    modules: pgModules({
      platform,
      catalogue,
      lifecycle: {
        server: (service) => {
          const id = serviceId(service)
          let s = servers.get(id)
          if (!s) {
            s = moduleServerFor(directPostgresUrl(`MODULE_PG_ADMIN_${envId(id)}_FILE`, reqFileEnv(`MODULE_PG_ADMIN_${envId(id)}_FILE`)))
            servers.set(id, s)
          }
          return s
        },
        secrets: {
          appPassword: (moduleId) => {
            const m = catalogue.find((x) => x.id === moduleId)
            const svc = m?.moduleJson.runtime.database?.postgresService
            if (!svc) throw new Error(`module ${moduleId} declares no database`)
            return reqFileEnv(`MODULE_APP_PASSWORD_${envId(serviceId(svc))}_FILE`)
          },
        },
        exporter: {
          dump: () => Promise.reject(new Error('tenant-create never disables a module (disable is not a create verb)')),
          list: () => Promise.reject(new Error('tenant-create never disables a module')),
        },
        exportDir: reqEnv('TENANT_EXPORT_DIR'),
        log,
      },
    }),
    ...adapters,
    log,
  }
  return {
    deps,
    async close() {
      await Promise.all([...servers.values()].map((s) => s.close()))
      await platform.end({ timeout: 5 })
    },
  }
}

async function withLive<T>(opts: { configFile?: string; bodyName?: string }, fn: (deps: ProvisioningDeps) => Promise<T>): Promise<T> {
  const live = await liveDeps(opts)
  try {
    return await fn(live.deps)
  } finally {
    await live.close()
  }
}

function slugArg(verb: string): string {
  const s = positional(0)
  if (!s) throw new UsageError(`${verb} requires <slug>`)
  return s
}

// ── init (Q15) and the ops realm (Q5) ──────────────────────────────────────
const OPS_REALM = 'platform'
const OPS_FINGERPRINT_ATTR = 'gremion.ops-realm.sha256'

function panelOrigin(): string {
  const o = flag('--panel-origin') ?? 'http://127.0.0.1:3043'
  let u: URL
  try {
    u = new URL(o)
  } catch {
    throw new UsageError(`--panel-origin ${o} is not an origin`)
  }
  if (u.origin !== o || o.includes('*') || !/^https?:$/.test(u.protocol)) throw new UsageError(`--panel-origin must be an exact origin (scheme://host[:port]), no path and no wildcard: ${o}`)
  if (u.protocol === 'http:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new UsageError('--panel-origin over plain http is allowed on the loopback only (the ssh -L access path)')
  return o
}

/**
 * The ops realm: create when absent, skip when equal (the template fingerprint
 * stored on the realm matches), fail when different. The control-panel client
 * secret goes to a 0600 file, never to stdout.
 */
async function ensureOpsRealm(kc: KcProvisionApi, raw: KcTransport): Promise<{ created: boolean }> {
  const origin = panelOrigin()
  const templateText = readFileSync(join(kcDir, 'realm-export.ops.json'), 'utf-8')
  const fingerprint = createHash('sha256').update(templateText).update('\n').update(origin).digest('hex')
  if (await kc.realmExists(OPS_REALM)) {
    const rep = (await raw('GET', `/admin/realms/${OPS_REALM}`)) as { attributes?: Record<string, string> }
    const have = rep?.attributes?.[OPS_FINGERPRINT_ATTR]
    if (have === fingerprint) return { created: false }
    throw new ProvisioningError('PRECONDITION', `realm ${OPS_REALM} exists but differs from realm-export.ops.json for panel origin ${origin} (fingerprint ${have ?? 'absent'}): refusing to overwrite an ops realm by hand`)
  }
  const secretPath = process.env.OPS_CLIENT_SECRET_FILE ?? join(tenantSecretsDir(), 'platform_client_control-panel')
  const secret = genSecret()
  const doc = JSON.parse(templateText.split('__CONTROL_PANEL_OIDC_CLIENT_SECRET__').join(secret)) as Record<string, unknown> & {
    clients: Array<Record<string, unknown>>
    attributes?: Record<string, string>
  }
  const client = doc.clients.find((c) => c.clientId === 'control-panel')!
  client.redirectUris = [`${origin}/*`]
  client.webOrigins = [origin]
  client.attributes = { ...(client.attributes as Record<string, string>), 'post.logout.redirect.uris': `${origin}/*` }
  doc.attributes = { ...doc.attributes, [OPS_FINGERPRINT_ATTR]: fingerprint }
  await writeSecretFile(secretPath, secret)
  await kc.createRealm(doc)
  await kc.configureStepupFlow(OPS_REALM)
  log(`ops realm ${OPS_REALM} created; the control-panel client secret is in ${secretPath} (0600)`)
  return { created: true }
}

function rawProvisionerTransport(): KcTransport {
  const creds = readProvisionerCreds()
  return transport(kcAdminBase(), () => kcToken(kcAdminBase(), { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }), true)
}

async function cmdInit(): Promise<void> {
  const kc = provisionerKc()
  if (process.argv.includes('--realm-only')) {
    const r = await ensureOpsRealm(kc, rawProvisionerTransport())
    log(`init --realm-only: ops realm ${r.created ? 'created' : 'present and equal'}`)
    return
  }
  const catalogue = loadModules()
  assertCreateEnv(catalogue)
  const platformUrl = new URL(reqEnv('PLATFORM_DATABASE_URL'))
  const kernelAdminUrl = directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE'))
  const kernelAdmin = postgres(kernelAdminUrl, { max: 2, onnotice: () => {}, connect_timeout: 15 })
  try {
    const r = await bootstrapPlatform({
      kernelAdmin,
      openPlatform: () => postgres(platformUrl.toString(), { max: 2, onnotice: () => {}, connect_timeout: 15 }),
      owner: decodeURIComponent(platformUrl.username),
      ownerPassword: decodeURIComponent(platformUrl.password),
      catalogue,
      opsRealm: { ensure: () => ensureOpsRealm(kc, rawProvisionerTransport()) },
      log,
    })
    log(`init: gremion_platform ${r.platformCreated ? 'created' : 'present'}; ${r.applied.length} migration(s) applied; catalogue rows: +${r.catalogue.insertedModules.length} module(s), +${r.catalogue.insertedVersions.length} version(s); ops realm ${r.opsRealm?.created ? 'created' : 'present'}`)
    for (const u of r.catalogue.undecided) log(`init: ${u.moduleKey} not loaded (${u.reason})`)
  } finally {
    await kernelAdmin.end({ timeout: 5 })
  }
}

// ── create phases, host step, router, suspend/resume, status ───────────────
async function cmdPhase(which: 'a' | 'b'): Promise<void> {
  const slug = slugArg(`phase-${which}`)
  const spec = createSpec(slug)
  assertCreateEnv(loadModules())
  await withLive({ configFile: spec.configFile, bodyName: spec.bodyName }, async (deps) => {
    if (which === 'a') {
      const r = await createPhaseA(spec, deps)
      log(`phase A ${slug}: ran [${r.run.ran.join(', ')}], skipped [${r.run.skipped.join(', ')}]${r.registered ? ' (control row registered)' : ''}`)
      console.log(JSON.stringify({ phase: 'a', slug, customerId: r.customer.id, token: r.customer.token, ran: r.run.ran }))
    } else {
      const r = await createPhaseB(spec, deps)
      log(`phase B ${slug}: ran [${r.run.ran.join(', ')}]; enabled [${r.enabled.join(', ')}]; broker ${r.reloaded ? 'reloaded' : 'unchanged'}; ${r.activated ? 'activated' : 'already active'}`)
      console.log(JSON.stringify({ phase: 'b', slug, enabled: r.enabled, reloaded: r.reloaded, activated: r.activated, ran: r.run.ran }))
    }
  })
}

async function cmdRecordStep(): Promise<void> {
  const slug = slugArg('record-step')
  const kind = positional(1)
  if (kind !== 'mail_principal_issued') throw new UsageError('record-step <slug> mail_principal_issued --operator <uuid>')
  await withLive({}, async (deps) => {
    const r = await recordHostStep(slug, kind, reqFlag('--operator'), deps)
    log(`record-step ${slug} ${kind}: ${r.run.ran.length ? 'recorded' : 'already done'}`)
  })
}

async function cmdRenderRouter(): Promise<void> {
  const v = validateSlug(slugArg('render-router'))
  if (!v.ok) throw new UsageError(`invalid slug: ${v.reason}`)
  const tenant = await getTenantBySlug(v.slug)
  if (!tenant) throw new UsageError(`unknown tenant ${v.slug}`)
  const primary = await primaryHostForTenant(tenant.id)
  if (!primary) throw new UsageError(`${v.slug} has no primary host`)
  const platformDomain = reqEnv('PLATFORM_DOMAIN')
  const yaml = renderCustomerRouter({
    slug: v.slug,
    hosts: (await listTenantDomains(tenant.id)).map((d) => d.host),
    primaryHost: primary,
    certResolver: reqEnv('TRAEFIK_CERT_RESOLVER'),
    normaliseHost: (h) => normaliseHost(h),
    isReservedHost: (h) => isReservedPlatformHost(h, platformDomain),
  })
  process.stdout.write(yaml)
}

async function cmdSuspendResume(which: 'suspend' | 'resume'): Promise<void> {
  const slug = slugArg(which)
  reqFlag('--operator')
  await withLive({}, async (deps) => {
    const r = which === 'suspend' ? await suspendCustomer(slug, deps) : await resumeCustomer(slug, deps)
    log(`${which} ${slug}: ${r.changed ? 'changed' : 'nothing to do'}`)
    console.log(JSON.stringify({ verb: which, slug, changed: r.changed }))
  })
}

async function cmdStatus(): Promise<void> {
  const slug = slugArg('status')
  const platform = postgres(directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL')), { max: 2, onnotice: () => {} })
  try {
    await assertPlatform(platform)
    const adapters = customerAdapters({
      apexDomain: apexDomain(),
      tenantSecretsDir: tenantSecretsDir(),
      runtimeDatabaseUrl: reqEnv('DATABASE_URL'),
      kernelAdminUrl: 'postgres://unused@127.0.0.1/unused',
      configFile: '/nonexistent',
      bodyName: 'Rat',
      edge: null,
      storageRoot: null,
      manifests: MODULE_MANIFESTS,
      loadBaseRealm: loadBaseRealmDoc,
      genSecret,
      writeSecretFile,
      writeConfigFile,
      makePrivateDir,
      kc: new KcProvisionApi(async () => {
        throw new Error('status reads no Keycloak')
      }),
    })
    const s = await provisioningStatus(slug, { control: adapters.control, ledger: pgLedger(platform), attestations: pgAttestations(platform) })
    console.log(JSON.stringify(s))
  } finally {
    await platform.end({ timeout: 5 })
  }
}

// ── operator add (Q5, Q23) ─────────────────────────────────────────────────
async function cmdOperatorAdd(): Promise<void> {
  const email = positional(0)
  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new UsageError('operator-add <email> [--no-mail]')
  const kc = provisionerKc()
  if (!(await kc.realmExists(OPS_REALM))) throw new UsageError(`the ops realm ${OPS_REALM} does not exist: run init (or init --realm-only) first`)
  if (!process.argv.includes('--no-mail')) {
    const r = await kc.ensureInvitedUser(OPS_REALM, { email, realmRole: 'operator' })
    log(`operator ${email}: ${r.created ? 'created' : 'present'}; ${r.invited ? 'execute-actions mail sent' : 'already invited'}`)
    return
  }
  // Q23: a host without vendor mail (the netcup test env). The user is created
  // with a generated TEMPORARY password (UPDATE_PASSWORD + CONFIGURE_TOTP stay
  // required), handed to Keycloak in the request body, printed ONCE on stdout.
  const raw = rawProvisionerTransport()
  const found = ((await raw('GET', `/admin/realms/${OPS_REALM}/users?email=${encodeURIComponent(email.toLowerCase())}&exact=true`)) as Array<{ id: string }>) ?? []
  if (found.length) {
    log(`operator ${email} already exists: no password is set or printed`)
    return
  }
  const temporary = randomBytes(18).toString('base64url')
  await raw('POST', `/admin/realms/${OPS_REALM}/users`, {
    username: email.toLowerCase(),
    email: email.toLowerCase(),
    enabled: true,
    emailVerified: true,
    requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    credentials: [{ type: 'password', value: temporary, temporary: true }],
  })
  const [user] = ((await raw('GET', `/admin/realms/${OPS_REALM}/users?email=${encodeURIComponent(email.toLowerCase())}&exact=true`)) as Array<{ id: string }>) ?? []
  if (!user?.id) throw new Error(`operator ${email} is absent after create`)
  const role = await raw('GET', `/admin/realms/${OPS_REALM}/roles/operator`)
  await raw('POST', `/admin/realms/${OPS_REALM}/users/${user.id}/role-mappings/realm`, [role])
  log(`operator ${email} created with a temporary password (Q23: no vendor mail on this host); it must be changed and TOTP configured at first sign-in`)
  process.stdout.write(`TEMPORARY-PASSWORD: ${temporary}\n`)
}

// ── reconcile (with the TASK-043 sender and fixture checks) ─────────────────
function tenantHostFromIssuer(issuer: string): string {
  return new URL(issuer).host
}
function printReport(report: ReconcileReport): void {
  console.error(`\n[tenant-create] reconcile realm "${report.realm}" — ${report.ok ? 'PASS' : 'FAIL'}`)
  for (const c of report.checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  — ${c.detail}`}`)
  if (report.applied.length > 0) console.error(`  applied repairs: ${report.applied.join(', ')}`)
  if (report.repairHost.length > 0) console.error(`  repair: host -> ${report.repairHost.join(', ')}`)
  console.log(JSON.stringify(report))
}
async function reconcileOne(tenant: Tenant, base: Record<string, unknown>, verifyOnly: boolean): Promise<ReconcileReport> {
  return reconcileRealm(rawProvisionerTransport(), {
    realm: tenant.realmName,
    tenantHost: tenantHostFromIssuer(tenant.issuer),
    apexDomain: apexDomain(),
    base,
    verifyOnly,
    sender: { platformDomain: reqEnv('PLATFORM_DOMAIN'), token: tokenFor(tenant.slug) },
    fixtures: fixtureIdentities(MIGRATIONS_DIR),
  })
}
function printFleetSummary(fleet: FleetReport): void {
  console.error('\n[tenant-create] reconcile --all summary:')
  for (const r of fleet.rows) {
    if (r.outcome === 'skipped') console.error(`  skip  ${r.slug} (realm=${r.realm}) — status=${r.skippedStatus} carries no realm`)
    else if (r.outcome === 'error') console.error(`  ERR   ${r.slug} (realm=${r.realm}) — ${r.error}`)
    else console.error(`  ${r.report?.ok ? 'pass' : 'FAIL'}  ${r.slug} (realm=${r.realm})`)
  }
}
async function cmdReconcile(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify-only')
  const base = loadBaseRealmDoc()
  if (process.argv.includes('--all')) {
    const tenants = [...(await listTenants())]
    if (tenants.length === 0) throw new UsageError('reconcile --all: no tenants registered')
    const fleet = await reconcileFleet(tenants, async (t) => {
      const report = await reconcileOne(t, base, verifyOnly)
      printReport(report)
      return report
    })
    printFleetSummary(fleet)
    if (fleet.anyFailed) process.exitCode = 1
    return
  }
  const v = validateSlug(slugArg('reconcile'))
  if (!v.ok) throw new UsageError(`invalid slug: ${v.reason}`)
  const tenant = await getTenantBySlug(v.slug)
  if (!tenant) throw new UsageError(`unknown tenant "${v.slug}"`)
  const report = await reconcileOne(tenant, base, verifyOnly)
  printReport(report)
  if (!report.ok) process.exitCode = 1
}

// ── delete, bootstrap-provisioner, materialize-config ───────────────────────
function makeLeafShredExecutor(): LeafShredExecutor | null {
  const leafUrl = process.env.NEWSLETTER_PG_URL
  if (!leafUrl) return null
  const leafSql = postgres(leafUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
  return {
    async dropNewsletterDb(slug: string): Promise<void> {
      try {
        await leafSql.unsafe(`DROP DATABASE IF EXISTS "newsletter_${slug}"`)
      } catch (err) {
        await leafSql.end({ timeout: 5 }).catch(() => undefined)
        throw err
      }
    },
    async deleteCatalogRow(tenantId: string): Promise<void> {
      try {
        await leafSql`DELETE FROM tenant_catalog WHERE tenant_id = ${tenantId}::uuid`
      } finally {
        await leafSql.end({ timeout: 5 })
      }
    },
  }
}

async function cmdDelete(): Promise<void> {
  const slug = slugArg('delete')
  const kc = provisionerKc()
  const server = kernelServer(directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE')))
  const leaf = makeLeafShredExecutor()
  const deps: DeleteDeps = {
    shredSecretFiles: (paths) => {
      for (const p of paths) if (existsSync(p)) rmSync(p, { force: true })
      return Promise.resolve()
    },
    db: {
      dropKernelDatabase: async (tenantId) => {
        await dropKernelDatabase(server, tenantId)
      },
    },
    kc: { deleteRealm: (realm) => kc.deleteRealm(realm) },
    registry: { getTenantBySlug, updateTenantStatus, markTenantResourceFailed, evictTenantRuntime },
    tenantSecretsDir: tenantSecretsDir(),
    ...(leaf ? { leaf } : {}),
  }
  try {
    const result = await deleteTenant(slug, deps)
    log(result.shredded ? `${slug} DELETED (${result.shreddedPaths.length} secret file(s) shredded, kernel database and realm dropped, row tombstoned)` : `${slug} is already a tombstone`)
  } finally {
    await server.close()
  }
}

async function cmdBootstrapProvisioner(): Promise<void> {
  const kc = adminKcOrUndefined()
  if (!kc) throw new UsageError('bootstrap-provisioner needs KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD')
  const clientId = process.env.TENANT_PROVISIONER_CLIENT_ID ?? 'tenant-provisioner'
  const { clientSecret, created } = await kc.createProvisionerServiceAccount('master', clientId, ['create-realm'])
  await writeSecretFile(PROVISIONER_SECRET_FILE, clientSecret)
  log(`bootstrap-provisioner: master-realm SA "${clientId}" ${created ? 'CREATED' : 'already present'} with ONLY [create-realm]; secret written to ${PROVISIONER_SECRET_FILE}`)
}

function cmdMaterializeConfig(): void {
  const v = validateSlug(slugArg('materialize-config'))
  if (!v.ok) throw new UsageError(`invalid slug: ${v.reason}`)
  const path = flag('--config') || configPathForTenant(v.slug)
  const rawStored: unknown = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as unknown) : {}
  const merged = materializeConfig(rawStored)
  assertBrandIdentityComplete(merged, v.slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(merged, null, 2))
  renameSync(`${path}.tmp`, path)
  log(`materialize-config: wrote the effective config for "${v.slug}" to ${path}`)
}

const USAGE = `usage: tenant-create <verb> ...
  init [--realm-only] [--panel-origin <origin>]
  phase-a <slug> --host <host> --config <file> --operator <uuid> --it-admin <email> --council-admin <email> [--enable a,b] [--body-name <name>]
  record-step <slug> mail_principal_issued --operator <uuid>
  phase-b <slug> (the phase-a flags)
  render-router <slug>
  suspend <slug> --operator <uuid> | resume <slug> --operator <uuid>
  reconcile [--verify-only] <slug>|--all
  status <slug>
  operator-add <email> [--no-mail]
  delete <slug> | bootstrap-provisioner | materialize-config <slug> [--config <path>]`

async function main(): Promise<void> {
  const verb = process.argv[2]
  switch (verb) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      // Reaching here proves every adapter module resolved and imported (TDD 19).
      console.log(USAGE)
      if (verb === undefined) process.exitCode = 2
      return
    case 'init':
      return cmdInit()
    case 'phase-a':
      return cmdPhase('a')
    case 'phase-b':
      return cmdPhase('b')
    case 'record-step':
      return cmdRecordStep()
    case 'render-router':
      return cmdRenderRouter()
    case 'suspend':
    case 'resume':
      return cmdSuspendResume(verb)
    case 'status':
      return cmdStatus()
    case 'operator-add':
      return cmdOperatorAdd()
    case 'reconcile':
      return cmdReconcile()
    case 'delete':
      return cmdDelete()
    case 'bootstrap-provisioner':
      return cmdBootstrapProvisioner()
    case 'materialize-config':
      return cmdMaterializeConfig()
    case 'provision':
      throw new UsageError('provision is retired (TASK-043): a customer is created by `gremion-tenant create` (phase-a, the host mail step, record-step, phase-b, the router)')
    default:
      throw new UsageError(`unknown verb ${verb}\n${USAGE}`)
  }
}

main().catch((err) => {
  const usage = err instanceof UsageError || (err instanceof ProvisioningError && ['INVALID_INPUT', 'MODULE_UNKNOWN', 'MODULE_DENIED', 'PRECONDITION', 'NOT_FOUND'].includes(err.code))
  tlog('error', '[tenant-create] FAILED', { err: err instanceof Error ? err.message : String(err) })
  console.error(`[tenant-create] ${usage ? 'USAGE' : 'FAILED'}: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = usage ? 2 : 1
})
