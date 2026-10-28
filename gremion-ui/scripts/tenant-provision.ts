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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import { handToReader } from './tenant-secret-file'
import {
  bootstrapPlatform,
  ensureExecutorRole,
  ensurePanelRequester,
  EXECUTOR_ROLE,
  PANEL_EXECUTES,
  PANEL_READS,
  createPhaseA,
  createPhaseB,
  loadModuleJsons,
  pgGate,
  pgLedger,
  pgModules,
  provisionalNote,
  provisioningStatus,
  ProvisioningError,
  recordHostStep,
  renderCustomerRouter,
  resumeCustomer,
  suspendCustomer,
  tokenFor,
  type AdminSpec,
  type CreateSpec,
  type DpiaSpec,
  type MailStampExpectation,
  type ProvisioningDeps,
} from '@gremion/provisioning'
import { assertPlatform, dropKernelDatabase, ensureKernelApiReader, KERNEL_API_READS, type LifecycleModule, type ModuleServer } from '@gremion/tenant-store/lifecycle'
import { MODULE_MANIFESTS } from '../src/lib/modules/registry'
import { dbNameForSlug, validateSlug } from '../src/lib/server/tenant/slug'
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
  parseMailSenderJson,
  type ReconcileReport,
  type FleetReport,
} from '../src/lib/server/tenant/provisioner/reconcile'
import { materializeConfig, assertBrandIdentityComplete } from '../src/lib/server/tenant/provisioner/materialize'
import { tlog } from '../src/lib/server/observability/tenant-log'
import { deleteTenant, type DeleteDeps, type LeafShredExecutor } from '../src/lib/server/tenant/provisioner/lifecycle'
import { requestVerb } from './tenant-provision-requests'
import { GATE_USAGE, GATE_VERBS, refusalLine, runGateVerb } from './tenant-provision-gate'
import { IMPORT_USAGE, IMPORT_VERBS, importVerb } from './tenant-provision-import'
import { PURGE_USAGE, PURGE_VERBS, purgeVerb } from './tenant-provision-purge'
import { parseDpiaMap, scratchFixturesAllowed } from './tenant-provision-scratch'

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

/**
 * TASK-075: the release this one-shot ships (compose passes the colour's
 * IMAGE_TAG), recorded as release_ref in every gremion_platform and
 * module-database ledger row init and phase B apply. Named, never defaulted.
 */
function releaseRef(): string {
  const v = reqEnv('GREMION_RELEASE_REF')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) throw new UsageError(`GREMION_RELEASE_REF ${JSON.stringify(v)} is not a release ref (1-64 of A-Z a-z 0-9 . _ -)`)
  return v
}

/**
 * TASK-044 (lane note D4): the release tip the level-1 enable gate compares
 * isolation evidence with. gremion-tenant derives it on the host from the
 * H10-authenticated release tree (`git rev-parse HEAD^{commit}`) and passes it
 * as GREMION_RELEASE_TIP; it is not GREMION_RELEASE_REF (the colour's
 * IMAGE_TAG). Unset or not 40/64 lowercase hex: null, never an exit here --
 * the gate then refuses every ENABLE with NO_RELEASE_TIP, and the verbs that
 * enable nothing (status, suspend, ...) are unaffected.
 */
function releaseTip(): string | null {
  const v = process.env.GREMION_RELEASE_TIP ?? ''
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v) ? v : null
}

/** Every variable phase A/B and init read, checked BEFORE anything connects. */
function assertCreateEnv(catalogue: readonly LifecycleModule[], opts: { needEdge: boolean }): void {
  directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL'))
  directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE'))
  for (const id of modulePostgresIds(catalogue)) {
    directPostgresUrl(`MODULE_PG_ADMIN_${envId(id)}_FILE`, reqFileEnv(`MODULE_PG_ADMIN_${envId(id)}_FILE`))
    reqFileEnv(`MODULE_APP_PASSWORD_${envId(id)}_FILE`)
  }
  reqEnv('TENANT_EXPORT_DIR')
  releaseRef()
  if (reqEnv('GREMION_DISABLE_SEEDS') !== 'true') throw new UsageError('GREMION_DISABLE_SEEDS must be "true" in tenant-create (the kernel migration must never apply a *_seed.sql file)')
  reqEnv('DOMAIN')
  reqEnv('DATABASE_URL')
  reqEnv('CONTROL_DATABASE_URL')
  reqEnv('NATS_URL')
  reqEnv('PLATFORM_DOMAIN')
  if (opts.needEdge) edgeAddresses()
  readProvisionerCreds()
}

// ── the catalogue (modules/*/module.json, loadCatalogue's rule) ──────────────
function loadModules(): LifecycleModule[] {
  if (!existsSync(MODULES_DIR)) throw new UsageError(`${MODULES_DIR} is absent: the image carries no module catalogue`)
  // The one reader of the tree, shared with the provisioning tests (R29-LOW-07 L5).
  return loadModuleJsons(MODULES_DIR)
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
    log(`WARNING: chmod 0600 ${hostPath} failed (${err instanceof Error ? err.message : String(err)})`)
  }
  handToReader(hostPath, tenantSecretsDir())
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
    throw new UsageError(`provisioner credential file ${PROVISIONER_SECRET_FILE} (TENANT_PROVISIONER_SECRET_FILE) not found — run \`bootstrap-provisioner\` once first`)
  }
  const clientSecret = readFileSync(PROVISIONER_SECRET_FILE, 'utf-8').trim()
  if (!clientSecret) throw new UsageError(`provisioner credential file ${PROVISIONER_SECRET_FILE} (TENANT_PROVISIONER_SECRET_FILE) is empty`)
  return { clientId: process.env.TENANT_PROVISIONER_CLIENT_ID ?? 'tenant-provisioner', clientSecret }
}

async function kcToken(base: string, form: Record<string, string>): Promise<string> {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) {
    // The OAuth error fields carry no secret (invalid_client, unauthorized_client, ...)
    // and tell a wrong provisioner secret from a missing SA or a disabled client.
    let detail = ''
    try {
      const body = (await res.json()) as { error?: unknown; error_description?: unknown }
      detail = [body.error, body.error_description].filter((x) => typeof x === 'string' && x).join(': ')
    } catch {
      detail = 'no OAuth error body'
    }
    throw new Error(`Keycloak token fetch failed: ${res.status}${detail ? ` (${detail})` : ''}`)
  }
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

function provisionerKc(creds: { clientId: string; clientSecret: string } = readProvisionerCreds()): KcProvisionApi {
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

/** TASK-044 D2: --dpia-json <file> carries the operator's DPIA decision per --enable module. */
function dpiaFromFlag(): { dpia?: Record<string, DpiaSpec> } {
  const path = flag('--dpia-json')
  if (!path) return {}
  try {
    return { dpia: parseDpiaMap(readFileSync(path, 'utf-8')) }
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)} (${path})`)
  }
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
    ...dpiaFromFlag(),
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
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch((e: unknown) => log(`WARNING: a module server pool did not close: ${e instanceof Error ? e.message : String(e)}`))))
    },
  }
}

/**
 * Every environment value, file and credential the live verbs read, resolved
 * WITHOUT connecting to anything (review B2-HIGH, r2): a missing one is a named
 * exit-2 failure before the platform pool exists, so no open socket can keep
 * the one-shot alive after the error. `needEdge`: only phase A binds a domain
 * (the DNS pre-flight); suspend/resume/record-step never read EDGE_BIND_IP.
 */
function resolveLiveEnv(needEdge: boolean) {
  return {
    platformUrl: directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL')),
    platformDomain: reqEnv('PLATFORM_DOMAIN'),
    apexDomain: apexDomain(),
    runtimeDatabaseUrl: reqEnv('DATABASE_URL'),
    kernelAdminUrl: directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE')),
    exportDir: reqEnv('TENANT_EXPORT_DIR'),
    releaseRef: releaseRef(),
    edge: needEdge ? edgeAddresses() : null,
    creds: readProvisionerCreds(),
  }
}

/** PLAN-mail-transport M2: the sender the host stamped, from its `--sender-json`
 *  descriptor (absent = stalwart). The container reads no mail.env. */
function mailStampExpectation(): MailStampExpectation {
  const s = parseMailSenderJson(flag('--sender-json'), reqEnv('PLATFORM_DOMAIN'), 'unused')
  return s.mode === 'relay' ? { mode: 'relay', host: s.host, port: s.port, fromAddress: s.fromAddress, user: s.user } : { mode: 'stalwart' }
}

async function liveDeps(opts: { configFile?: string; bodyName?: string; needEdge?: boolean } = {}): Promise<Live> {
  const catalogue = loadModules()
  const env = resolveLiveEnv(opts.needEdge ?? false)
  const kc = provisionerKc(env.creds)
  const adminKc = adminKcOrUndefined()
  const servers = new Map<string, ReturnType<typeof moduleServerFor>>()
  // Opened only after every value above resolved; ended on ANY later throw.
  const platform = postgres(env.platformUrl, { max: 3, onnotice: () => {}, connect_timeout: 15 })
  const close = async () => {
    await Promise.all([...servers.values()].map((s) => s.close()))
    await platform.end({ timeout: 5 })
  }
  try {
    await assertPlatform(platform)
    const serviceId = (service: string) => service.replace(/-postgres$/, '')
    const adapters = customerAdapters({
      apexDomain: env.apexDomain,
      kcInternalBase: kcInternalBase(),
      tenantSecretsDir: tenantSecretsDir(),
      runtimeDatabaseUrl: env.runtimeDatabaseUrl,
      kernelAdminUrl: env.kernelAdminUrl,
      configFile: opts.configFile ?? '/nonexistent',
      bodyName: opts.bodyName ?? 'Rat',
      edge: env.edge,
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
      platformDomain: env.platformDomain,
      mailSender: mailStampExpectation(),
      ledger: pgLedger(platform),
      // TASK-044: the level-1 gate over gremion_platform, on the host's derived release tip
      gate: pgGate(platform, { releaseTipSha: releaseTip(), allowFixtureEvidence: scratchFixturesAllowed(process.env.GREMION_SCRATCH_FIXTURES, process.env.PLATFORM_DATABASE_URL, process.env.GREMION_PRODUCTION_STACK) }),
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
          exportDir: env.exportDir,
          releaseRef: env.releaseRef,
          log,
        },
      }),
      ...adapters,
      log,
    }
    return { deps, close }
  } catch (err) {
    await close().catch((e: unknown) => log(`WARNING: closing the pools after a failed start also failed: ${e instanceof Error ? e.message : String(e)}`))
    throw err
  }
}

async function withLive<T>(opts: { configFile?: string; bodyName?: string; needEdge?: boolean }, fn: (deps: ProvisioningDeps) => Promise<T>): Promise<T> {
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
    if (have === fingerprint) {
      // Idempotent and re-asserted on every init (review B2, r2): a step-up
      // setup that failed after createRealm must not stay missing because the
      // fingerprint (imported with the realm) already matches.
      await kc.configureStepupFlow(OPS_REALM)
      return { created: false }
    }
    throw new ProvisioningError('PRECONDITION', `realm ${OPS_REALM} exists but differs from realm-export.ops.json for panel origin ${origin} (fingerprint ${have ?? 'absent'}): refusing to overwrite an ops realm by hand`)
  }
  const secretPath = process.env.OPS_CLIENT_SECRET_FILE ?? join(tenantSecretsDir(), 'platform_client_control-panel')
  const secret = genSecret()
  const doc = JSON.parse(templateText.split('__CONTROL_PANEL_OIDC_CLIENT_SECRET__').join(secret)) as Record<string, unknown> & {
    clients: Array<Record<string, unknown>>
    attributes?: Record<string, string>
  }
  const client = doc.clients.find((c) => c.clientId === 'control-panel')
  if (!client) throw new ProvisioningError('PRECONDITION', 'realm-export.ops.json carries no control-panel client')
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
  assertCreateEnv(catalogue, { needEdge: false })
  const platformUrl = new URL(reqEnv('PLATFORM_DATABASE_URL'))
  const kernelAdminUrl = directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE'))
  // r3 verifier MEDIUM #70: the panel's read-only role -- every input read
  // BEFORE the first connection (a missing one is a named exit 2).
  const panelRole = reqEnv('PANEL_DB_USER')
  const panelPassword = reqEnv('PANEL_DB_PASSWORD')
  const kernelApiRole = reqEnv('KERNEL_API_DB_USER')
  const kernelApiPassword = reqEnv('KERNEL_API_DB_PASSWORD')
  const release = releaseRef()
  const controlDatabase = decodeURIComponent(new URL(reqEnv('CONTROL_DATABASE_URL')).pathname.replace(/^\//, ''))
  const kernelAdmin = postgres(kernelAdminUrl, { max: 2, onnotice: () => {}, connect_timeout: 15 })
  // the per-database admin connection both reader roles are granted through
  const openAdminOn = (db: string) => {
    const u = new URL(kernelAdminUrl)
    u.pathname = `/${encodeURIComponent(db)}`
    return postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 15 })
  }
  try {
    const r = await bootstrapPlatform({
      kernelAdmin,
      openPlatform: () => postgres(platformUrl.toString(), { max: 2, onnotice: () => {}, connect_timeout: 15 }),
      owner: decodeURIComponent(platformUrl.username),
      ownerPassword: decodeURIComponent(platformUrl.password),
      catalogue,
      releaseRef: release,
      opsRealm: { ensure: () => ensureOpsRealm(kc, rawProvisionerTransport()) },
      log,
    })
    log(`init: gremion_platform ${r.platformCreated ? 'created' : 'present'}; ${r.applied.length} migration(s) applied; catalogue rows: +${r.catalogue.insertedModules.length} module(s), +${r.catalogue.insertedVersions.length} version(s); ops realm ${r.opsRealm?.created ? 'created' : 'present'}`)
    for (const u of r.catalogue.undecided) log(`init: ${u.moduleKey} not loaded (${u.reason})`)
    for (const row of r.catalogue.load) if (row.provisional) log(`init: ${provisionalNote(row)}`)
    const panel = await ensurePanelRequester({ kernelAdmin, openAdminOn, role: panelRole, password: panelPassword, controlDatabase })
    log(`init: control-panel role ${panelRole} ${panel.created ? 'created' : 'present'} (SELECT on ${[...PANEL_READS.control, ...PANEL_READS.platform].join(', ')}; EXECUTE on ${PANEL_EXECUTES.join(', ')} only)`)
    // TASK-043d: the host-side executor's role (no password: the state server's local socket only)
    const executor = await ensureExecutorRole({ kernelAdmin, openAdminOn })
    log(`init: executor role ${EXECUTOR_ROLE} ${executor.created ? 'created' : 'present'} (EXECUTE on the request functions only)`)
    // TASK-077: the kernel API's SELECT-only role, which deploy step 7
    // (kernel-api-migrate) and the kernel-api service connect as; nothing else
    // creates it.
    const kernelApi = await ensureKernelApiReader({
      kernelAdmin,
      openAdminOn,
      role: kernelApiRole,
      password: kernelApiPassword,
      controlDatabase,
    })
    log(`init: kernel API reader ${kernelApiRole} ${kernelApi.created ? 'created' : 'present'} (SELECT on ${[...KERNEL_API_READS.control, ...KERNEL_API_READS.platform].join(', ')} only)`)
  } finally {
    await kernelAdmin.end({ timeout: 5 })
  }
}

// ── create phases, host step, router, suspend/resume, status ───────────────
async function cmdPhase(which: 'a' | 'b'): Promise<void> {
  const slug = slugArg(`phase-${which}`)
  const spec = createSpec(slug)
  assertCreateEnv(loadModules(), { needEdge: true })
  // domain_bound (phase A) runs the DNS pre-flight: both create phases resolve EDGE_BIND_IP.
  await withLive({ configFile: spec.configFile, bodyName: spec.bodyName, needEdge: true }, async (deps) => {
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
  // The actor is validated and named on every line (review B2: presence-only
  // before, the value discarded). The ledger has no suspend kind (SCHEMA §0.1),
  // so the attribution is the stderr log line and the JSON result; a status
  // audit row is TASK-079's (the event). STDOUT stays machine output only.
  const operatorId = reqFlag('--operator')
  if (!UUID_RE.test(operatorId)) throw new UsageError(`--operator must be the operator's ops-realm user id (a uuid), not ${JSON.stringify(operatorId)}`)
  await withLive({}, async (deps) => {
    const r = which === 'suspend' ? await suspendCustomer(slug, deps) : await resumeCustomer(slug, deps)
    log(`${which} ${slug} by operator ${operatorId}: ${r.changed ? 'changed' : 'nothing to do'}`)
    console.log(JSON.stringify({ verb: which, slug, operatorId, changed: r.changed }))
  })
}

/** A direct pool to gremion_platform (status and TASK-044's gate verbs); the caller ends it. */
function openPlatformPool(): postgres.Sql {
  return postgres(directPostgresUrl('PLATFORM_DATABASE_URL', reqEnv('PLATFORM_DATABASE_URL')), { max: 2, onnotice: () => {} })
}

async function cmdStatus(): Promise<void> {
  const slug = slugArg('status')
  const platform = openPlatformPool()
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
    const s = await provisioningStatus(slug, { control: adapters.control, ledger: pgLedger(platform), gate: pgGate(platform, { releaseTipSha: releaseTip() }) })
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
  const found = ((await raw('GET', `/admin/realms/${OPS_REALM}/users?email=${encodeURIComponent(email.toLowerCase())}&exact=true`)) as Array<{ id: string; requiredActions?: string[] }>) ?? []
  if (found.length) {
    // A rerun re-asserts the role (idempotent) -- a first run that died after
    // the create left a user without it (review B2, r2) -- and never exits 0
    // for a user nobody can sign in as: a pending UPDATE_PASSWORD means the
    // printed temporary password may be lost.
    const role = await raw('GET', `/admin/realms/${OPS_REALM}/roles/operator`)
    await raw('POST', `/admin/realms/${OPS_REALM}/users/${found[0]!.id}/role-mappings/realm`, [role])
    if ((found[0]!.requiredActions ?? []).includes('UPDATE_PASSWORD')) {
      throw new Error(
        `operator ${email} exists (operator role re-asserted) but has never set a password: if the temporary password was not received, reset it in Keycloak (Credentials, temporary) or delete the user and rerun operator-add`,
      )
    }
    log(`operator ${email} already exists: the operator role is held; no password is set or printed`)
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
    // PLAN-mail-transport M1: the host (which owns mail.env) hands the sender
    // descriptor of its deploy-time mail transport; absent = stalwart (legacy).
    sender: parseMailSenderJson(flag('--sender-json'), reqEnv('PLATFORM_DOMAIN'), tokenFor(tenant.slug)),
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
  // Never report DELETED while the customer's data survives (review B2, r2).
  // Refused BEFORE anything is shredded: a pre-TASK-043 t_<slug> database
  // (dropKernelDatabase only knows t_<hex32>__kernel), and live per-customer
  // module databases (delete has no module drop yet: the disable verb is
  // TASK-044/077's). Both are named residuals, never silent.
  const tenant = await getTenantBySlug(slug)
  if (tenant && tenant.status !== 'deleted') {
    try {
      const legacy = dbNameForSlug(slug)
      if ((await server.admin`SELECT 1 FROM pg_database WHERE datname = ${legacy}`).length) {
        throw new UsageError(`${slug} still has the pre-TASK-043 database ${legacy}; delete does not drop it -- drop it (and its role) by hand first, then rerun delete`)
      }
      const platformUrl = process.env.PLATFORM_DATABASE_URL
      if (!platformUrl) throw new UsageError('delete needs PLATFORM_DATABASE_URL to prove the customer has no enabled module database left')
      const platform = postgres(directPostgresUrl('PLATFORM_DATABASE_URL', platformUrl), { max: 1, onnotice: () => {}, connect_timeout: 15 })
      try {
        const live = await platform<{ module_key: string }[]>`
          SELECT m.module_key FROM plt.module_database d JOIN plt.module m USING (module_id)
           WHERE d.customer_id = ${tenant.id} AND d.state <> 'dropped' ORDER BY 1`
        if (live.length) {
          throw new UsageError(`${slug} has module(s) ${live.map((r) => r.module_key).join(', ')} enabled with their own databases; delete does not drop module databases yet -- disable them first (TASK-044/077), then rerun delete`)
        }
      } finally {
        await platform.end({ timeout: 5 })
      }
    } catch (err) {
      await server.close()
      throw err
    }
  }
  const leaf = makeLeafShredExecutor()
  const kernelDb: { dropped: boolean | null } = { dropped: null }
  const deps: DeleteDeps = {
    shredSecretFiles: (paths) => {
      for (const p of paths) if (existsSync(p)) rmSync(p, { force: true })
      return Promise.resolve()
    },
    db: {
      dropKernelDatabase: async (tenantId) => {
        kernelDb.dropped = (await dropKernelDatabase(server, tenantId)).dropped
      },
    },
    kc: { deleteRealm: (realm) => kc.deleteRealm(realm) },
    registry: { getTenantBySlug, updateTenantStatus, markTenantResourceFailed, evictTenantRuntime },
    tenantSecretsDir: tenantSecretsDir(),
    ...(leaf ? { leaf } : {}),
  }
  try {
    const result = await deleteTenant(slug, deps)
    const kernel = kernelDb.dropped === true ? 'kernel database dropped' : kernelDb.dropped === false ? 'no kernel database was present' : 'kernel database not touched'
    log(result.shredded ? `${slug} DELETED (${result.shreddedPaths.length} secret file(s) shredded, ${kernel}, realm dropped, row tombstoned)` : `${slug} is already a tombstone`)
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
  record-step <slug> mail_principal_issued --operator <uuid> [--sender-json <json>]
  phase-b <slug> (the phase-a flags)
  render-router <slug>
  suspend <slug> --operator <uuid> | resume <slug> --operator <uuid>
  reconcile [--verify-only] <slug>|--all [--sender-json <json>]
  status <slug>
  operator-add <email> [--no-mail]
  delete <slug> | bootstrap-provisioner | materialize-config <slug> [--config <path>]
  request-verify <request-id>   (TASK-043d: the executor's trusted-layer verdict, one JSON line)
${GATE_USAGE}
${IMPORT_USAGE}
${PURGE_USAGE}`

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
    case 'request-verify':
      return requestVerb(verb, { args: process.argv.slice(3), reqEnv, directPostgresUrl, loadModules, modulesDir: MODULES_DIR, kcInternalBase, provisionerTransport: rawProvisionerTransport, usage: (m) => new UsageError(m), log })
    case 'provision':
      throw new UsageError('provision is retired (TASK-043): a customer is created from the control panel ("Neuer Mandant"), which the host-side executor runs (phase-a, the host mail step, record-step, phase-b, the router; TASK-043d)')
    // TASK-044: the level-1 gate's verbs (tenant-provision-gate.ts)
    case 'enable-module':
    case 'dpia-record':
    case 'isolation-record':
    case 'gate-status':
    case 'regate':
      if (!GATE_VERBS.has(verb)) throw new UsageError(`unknown verb ${verb}`)
      return runGateVerb(verb, {
        releaseTip,
        withLive,
        openPlatform: openPlatformPool,
        customerIdForSlug: async (s) => (await getTenantBySlug(s))?.id ?? null,
        flag,
        reqFlag,
        positional,
        usage: (m) => new UsageError(m),
        log,
      })
    // TASK-031: member import + vertical seed (tenant-provision-import.ts); the list arrives on STDIN, never argv or env
    case 'import-validate':
    case 'import-apply':
    case 'seed-vertical':
      if (!IMPORT_VERBS.has(verb)) throw new UsageError(`unknown verb ${verb}`)
      return importVerb(verb, {
        withLive,
        provisionerKc: () => provisionerKc(),
        writeConfigFile,
        readStdin: () => readFileSync(0, 'utf8'),
        // renews the host executor's lease (record_stream reads the marker off stderr)
        heartbeat: () => process.stderr.write('@@executor-step import-apply\n'),
        flag,
        reqFlag,
        positional,
        usage: (m) => new UsageError(m),
        log,
      })
    // TRD-144/145: the scheduled purge (tenant-provision-purge.ts), run by the host's gremion-purge.timer
    case 'purge-run':
      if (!PURGE_VERBS.has(verb)) throw new UsageError(`unknown verb ${verb}`)
      return purgeVerb(verb, {
        args: process.argv.slice(3),
        openPlatform: openPlatformPool,
        openKernelServer: () => kernelServer(directPostgresUrl('KERNEL_PG_ADMIN_FILE', reqFileEnv('KERNEL_PG_ADMIN_FILE'))),
        usage: (m) => new UsageError(m),
        log,
      })
    default:
      throw new UsageError(`unknown verb ${verb}\n${USAGE}`)
  }
}

/**
 * A one-shot ends with its exit code, always (review B2-HIGH, r2): a handle
 * something leaked (a pool socket, a timer) must never turn a named exit 2
 * into a container that hangs until the socket's max_lifetime. stdout and
 * stderr are flushed first, so machine output is never cut short.
 */
function exitWithCode(): void {
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0
  let pending = 2
  const done = () => {
    if (--pending === 0) process.exit(code)
  }
  process.stdout.write('', done)
  process.stderr.write('', done)
}

main()
  .catch((err) => {
    // TASK-044: a gate refusal is exit 1 with its code and reason on stderr (a refusal, not a usage error)
    const refused = refusalLine(err)
    if (refused) {
      tlog('error', '[tenant-create] REFUSED', { err: refused })
      console.error(`[tenant-create] ${refused}`)
      process.exitCode = 1
      return
    }
    const usage = err instanceof UsageError || (err instanceof ProvisioningError && ['INVALID_INPUT', 'MODULE_UNKNOWN', 'MODULE_DENIED', 'MODULE_NOT_LOADED', 'PRECONDITION', 'NOT_FOUND'].includes(err.code))
    tlog('error', '[tenant-create] FAILED', { err: err instanceof Error ? err.message : String(err) })
    console.error(`[tenant-create] ${usage ? 'USAGE' : 'FAILED'}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = usage ? 2 : 1
  })
  .finally(exitWithCode)
