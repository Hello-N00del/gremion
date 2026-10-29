// services/kernel-api/src/app/deps.ts — everything buildApp needs from the
// outside world, as interfaces. buildApp itself imports no database driver,
// no JWKS client and no secret: main.ts wires the real ones (wire.ts), the
// tests wire fakes or a scratch stack, and routes:check boots with
// unwiredDeps() (C18: construct without a database, a secret or a network;
// fail on USE, never at construction).
import type { Sql } from '@gremion/db'
import type { HostRejectionLog } from '@gremion/tenancy-core'
import { denyAll, type WriteAuthorizer } from '../bodies/authz.ts'
import type { ModuleRuntimeDecl } from '../registry/declarations.ts'

/** Control tenant status vocabulary (migrations-control 001). */
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted'

/** One customer as the control registry holds it (Q1: control tenant / tenant_domain, read-only). */
export interface TenantRow {
  customerId: string
  slug: string
  status: TenantStatus
  realm: string
  issuer: string
  /** The realm's base URL on the internal network (JWKS: <kcInternal>/protocol/openid-connect/certs). */
  kcInternal: string
  /** Secret ref of the customer's kernel database URL (file:/run/secrets/... ; env: in tests). */
  dbConnRef: string
}

export interface TenancyStore {
  /** ONE lookup of the WHOLE host (TRD-082 pinned exemption 1); null = no tenant_domain row. */
  lookupHost(host: string): Promise<TenantRow | null>
  /** A module caller's asserted customer, by id (customer-scoped). */
  lookupId(customerId: string): Promise<TenantRow | null>
  /**
   * Every `active` customer (TRD-082 pinned exemption 4: the event relay's tenant
   * iteration, like the migrate job's): the relay supervisor starts one relay per
   * customer whose database the gate calls current.
   */
  listActive(): Promise<TenantRow[]>
}

export interface EnabledModuleRow {
  moduleKey: string
  semver: string
}

export interface RegistryStore {
  /** Exactly the customer's plt.module_enablement rows in state 'enabled', with the enabled version. */
  listEnabled(customerId: string): Promise<EnabledModuleRow[]>
  /** Is `moduleKey` enabled for the customer (a module caller's fourth clause)? */
  isEnabled(customerId: string, moduleKey: string): Promise<boolean>
}

export interface TokenVerifier {
  /**
   * Resolves when `token` is an access token of `tenant`'s realm the kernel API
   * accepts (Q7: exact iss, aud contains gremion-kernel-api, RS256, exp/nbf);
   * rejects otherwise. Never consults another customer's keys.
   */
  verify(token: string, tenant: TenantRow): Promise<Record<string, unknown>>
}

export type GateVerdict = { ok: true } | { ok: false; reason: 'behind' | 'diverged' | 'unavailable' | 'ahead' | 'current'; retryAfterSeconds: number }

export interface CustomerGate {
  /**
   * Is THIS customer's kernel database at the kernel-api manifest (B21: the
   * service never migrates; a database behind answers 503 for that customer
   * only)? No verdict is cached (Q9): every request is judged afresh.
   */
  check(tenant: TenantRow): Promise<GateVerdict>
}

/**
 * The customer's own kernel database, as the app-role pool the identity domain
 * runs on (TASK-080-a). The pool is the customer's alone (tenant-store, the
 * target resolved from the request's own control row, never the environment);
 * a failure to open it answers 503 for that customer only.
 */
export interface TenantDb {
  sqlFor(tenant: TenantRow): Promise<Sql>
}

export interface ModuleDeclarations {
  /** The runtime block of modules/<key>/module.json this image carries, or undefined. */
  get(moduleKey: string): ModuleRuntimeDecl | undefined
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface KernelApiDeps {
  /** Q8: required for every tenant-resolved request; unset = nothing is served (503). */
  proxySecret: string | undefined
  /** PLATFORM_DOMAIN: the nine reserved names never resolve. */
  platformDomain: string | undefined
  /** Q8: module key -> its KERNEL_API_MODULE_SECRET_<ID>. */
  moduleSecrets: ReadonlyMap<string, string>
  tenancy: TenancyStore
  registry: RegistryStore
  tokens: TokenVerifier
  gate: CustomerGate
  declarations: ModuleDeclarations
  /** The customer's kernel database for the identity reads and the own-preference write. */
  tenantDb: TenantDb
  /** Who may write through the HTTP API. Shipped: denyAll (Q4) until TASK-081 binds the PDP. */
  authorizer: WriteAuthorizer
  log: Logger
  /** The bounded tenant.host.rejected emitter (TRD-076, G6). */
  hostRejection: HostRejectionLog
}

export class NotWiredError extends Error {
  override name = 'NotWiredError'
  constructor(what: string) {
    super(`kernel-api: ${what} is not wired (buildApp was built without deps)`)
  }
}

const notWired = (what: string) => async (): Promise<never> => {
  throw new NotWiredError(what)
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** Deps for a boot with no environment (routes:check): every use fails, nothing is served. */
export function unwiredDeps(): KernelApiDeps {
  const hostRejection = (() => {}) as unknown as HostRejectionLog
  hostRejection.size = () => 0
  return {
    proxySecret: undefined,
    platformDomain: undefined,
    moduleSecrets: new Map(),
    tenancy: { lookupHost: notWired('the control registry'), lookupId: notWired('the control registry'), listActive: notWired('the control registry') },
    registry: { listEnabled: notWired('the module registry'), isEnabled: notWired('the module registry') },
    tokens: { verify: notWired('token verification') },
    gate: { check: notWired('the schema gate') },
    declarations: { get: () => undefined },
    tenantDb: { sqlFor: notWired('the tenant database') },
    authorizer: denyAll,
    log: silent,
    hostRejection,
  }
}
