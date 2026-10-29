// packages/provisioning/src/ports.ts — one port per resource the customer
// lifecycle touches. The package holds no adapter for Keycloak, the control
// registry or the kernel data plane: gremion-ui's provisioner/** implements
// those (it owns $lib); this package holds the ORDER and the post-conditions.
//
// Rule for every port: a read never mutates, and a mutating call is made only
// when the read says it is needed -- so a rerun over a completed customer makes
// zero mutating calls (TDD 16, the recording adapters in the unit suite).
import type { LedgerPort } from './ledger.ts'

/** The customer as provisioning addresses it. */
export interface CustomerRef {
  /** control tenant.id = customer_id (Q1), a UUIDv7. */
  id: string
  slug: string
  /** slug with '-' -> '_' (the mail principal token). */
  token: string
  /** The Keycloak realm (= slug). */
  realm: string
  /** The primary host (tenant_domain, is_primary). */
  host: string
}

export type CustomerStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted'

export interface ControlRow {
  id: string
  slug: string
  status: CustomerStatus
  realm: string
  /** The primary tenant_domain host, or null when none is bound. */
  host: string | null
}

/** The control registry (control DB: tenant, tenant_domain). */
export interface ControlPort {
  getBySlug(slug: string): Promise<ControlRow | null>
  /**
   * Inserts the `provisioning` row and binds the primary host through
   * TASK-042's addTenantDomain (reserved-host refusal, owner pre-read,
   * eviction, one transaction). Only called when getBySlug found nothing.
   */
  registerProvisioning(input: { slug: string; host: string; realm: string }): Promise<ControlRow>
  /**
   * Binds the primary host (and the tenant's resource rows) of a row that has
   * none: the repair of a registerProvisioning that died between the tenant
   * insert and addTenantDomain. Idempotent.
   */
  bindPrimaryHost(id: string, host: string): Promise<void>
  /** Guarded status transition (suspend: active -> suspended; resume: suspended -> active; create: provisioning -> active). */
  setStatus(id: string, status: 'active' | 'suspended'): Promise<void>
}

/** The tenant's config file (/data/<slug>/config.json), written before the kernel migration (Q21). */
export interface ConfigPort {
  /** Writes the operator's --config (materialized, brand identity complete) when absent or different; returns whether it wrote. */
  ensure(c: CustomerRef): Promise<boolean>
  /** Reads setup_complete. */
  setupComplete(c: CustomerRef): Promise<boolean>
  /** Sets setup_complete:true (phase B end). */
  markSetupComplete(c: CustomerRef): Promise<void>
}

export interface SmtpReadBack {
  host: string | null
  port: string | null
  user: string | null
  from: string | null
  starttls: string | null
}

export interface RealmPort {
  /** realm_created: the realm with service accounts only and NO sender (the host phase stamps it). */
  ensureRealm(c: CustomerRef): Promise<void>
  /** The non-secret smtpServer fields, for the host phase's post-condition. */
  readSmtp(realm: string): Promise<SmtpReadBack>
  /** first_accounts_created: the IT- and council-administrator, execute-actions mail each; adopts a 409 and sends nothing then. */
  ensureAdmins(c: CustomerRef, admins: readonly AdminSpec[]): Promise<{ created: string[]; invited: string[] }>
  isEnabled(realm: string): Promise<boolean>
  /** false: enabled:false, notBefore now, logout all sessions. true: enabled:true. */
  setEnabled(realm: string, enabled: boolean): Promise<void>
}

export interface AdminSpec {
  email: string
  /** The realm role: it-admin or council-admin. */
  role: 'it-admin' | 'council-admin'
}

export interface KernelPostCondition {
  /** The ledger's columns, in order (gremion-ui's shape is filename, applied_at). */
  ledgerColumns: string[]
  seedRows: string[]
  orgUnits: number
  committees: number
}

export interface KernelDbPort {
  /** ensureKernelDatabase (G1) + the tenant's db secret file; never migrates. */
  ensureDatabase(c: CustomerRef): Promise<void>
  /** gremion-ui's db.ts runMigrations() in runWithTenant(provisioning ctx), as the owner, seeds off. */
  migrate(c: CustomerRef): Promise<void>
  /** Read from the database itself, never from a return code. */
  postCondition(c: CustomerRef): Promise<KernelPostCondition>
}

export interface DomainPort {
  /** The primary host is bound to this customer and resolves (checkTenantHostDns). */
  assertBound(c: CustomerRef): Promise<void>
}

export interface StoragePort {
  reservePrefix(c: CustomerRef): Promise<void>
}

export interface FirstBodyPort {
  /** The council org_units row and its Keycloak group (projection, Q8); adopts what exists. */
  ensure(c: CustomerRef): Promise<{ created: boolean }>
}

export interface BrokerPort {
  /** @gremion/nats-auth ensureTenantAccount (kernel always added). */
  ensure(c: CustomerRef, modules: readonly string[]): Promise<{ accountRef: string; reloaded: boolean; createdUsers: string[]; removedUsers: string[] }>
}

export interface ModulesPort {
  /** Catalogue ids (loadCatalogue). */
  catalogueIds(): readonly string[]
  /**
   * The ids among `ids` with NO plt.module_version row for their catalogue
   * version (what `init` left undecided, Q20): enableModule would refuse them
   * MODULE_VERSION_UNKNOWN, so create refuses them before any write.
   */
  unloaded(ids: readonly string[]): Promise<string[]>
  /** enableModule with the given gate; returns whether it was a no-op. */
  enable(c: CustomerRef, moduleId: string, gate: import('@gremion/tenant-store/lifecycle').EnableGate, operatorId: string): Promise<{ noop: boolean; database: string | null }>
  /**
   * disableModule (TRD-424): the level-1 switch off, the module database
   * exported and verified, then dropped. A repeat on a disabled module is a no-op.
   */
  disable(c: CustomerRef, moduleId: string, operatorId: string): Promise<{ noop: boolean; dropped: boolean; database: string | null; export: { path: string; sha256: string; bytes: number } | null }>
  /** Module keys with an `enabled` plt.module_enablement row for the customer. */
  enabled(c: CustomerRef): Promise<string[]>
}

/** TASK-044 (lane note D2): one module's DPIA-applicability decision as a create or enable request carries it. */
export interface DpiaSpec {
  requiresDpia: import('@gremion/tenant-store/lifecycle').RequiresDpia
  /** 1-20 snake_case codes. */
  reasonCodes: readonly string[]
  /** The TOM-annex entry the written decision lives in; required for every value (brief Q3). */
  documentRef: string
}

/**
 * TASK-044: the level-1 enable gate and its records over gremion_platform
 * (lifecycle/enable-gate). Every refusal is an EnableRefused {code, reason}.
 */
export interface GatePort {
  /** The release tip the gate compares with (null: unset, every enable refuses NO_RELEASE_TIP). */
  readonly releaseTipSha: string | null
  /** The gate enableModule calls (createEnableGate). */
  enableGate: import('@gremion/tenant-store/lifecycle').EnableGate
  /** The customer-independent half, before any write: the tip and a current-tip pass per module. */
  assertIsolationProven(moduleKeys: readonly string[], customerId: string | null): Promise<void>
  /** A written DPIA decision is recorded for (customer, module). */
  hasDpiaDecision(customerId: string, moduleKey: string): Promise<boolean>
  /** Records the operator's dated decision; an identical latest one is reused. */
  recordDpia(customerId: string, moduleKey: string, decision: DpiaSpec, operatorId: string): Promise<{ dpiaDecisionId: string; created: boolean }>
  /** Enabled modules not proven on this release (Q8), for one customer or all. */
  unproven(customerId?: string): Promise<import('@gremion/tenant-store/lifecycle').UnprovenEnablement[]>
}

/**
 * PLAN-mail-transport M2: what the host's mail step stamped on a customer
 * realm, by deploy-time mail transport. Handed in by the host (`--sender-json`);
 * the container reads no mail.env. Absent = stalwart: the realm's own
 * kc-<token>@ principal. The relay carries NO password (the host holds it).
 */
export type MailStampExpectation =
  | { mode: 'stalwart' }
  | { mode: 'relay'; host: string; port: number; fromAddress: string; user: string }

export interface ProvisioningDeps {
  platformDomain: string
  /** The sender the host stamped (default stalwart). */
  mailSender?: MailStampExpectation
  ledger: LedgerPort
  control: ControlPort
  config: ConfigPort
  realm: RealmPort
  kernel: KernelDbPort
  domain: DomainPort
  storage: StoragePort
  firstBody: FirstBodyPort
  broker: BrokerPort
  modules: ModulesPort
  gate: GatePort
  log?: (line: string) => void
  hooks?: { afterStep?(kind: import('./steps.ts').StepKind): void | Promise<void> }
}
