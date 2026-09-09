// src/lib/server/modules/runtime-registry.ts
// Session-A inversion A1/A3a — the runtime-registry seam (dependency-direction
// inversion). A module's server code SELF-REGISTERS four kinds of contribution
// here at import time, and the kernel composition roots invoke the aggregate:
//
//   1. server-init hooks      — boot-time workers (schedulers, consumers, drains).
//                               hooks.server.ts runs them via runServerInitHooks().
//   2. tenant-evict hooks     — per-tenant runtime handles a module caches.
//                               tenant/registry.ts runs them via runTenantEvictHooks().
//   3. provisioning subsystems — the Matrix/Nextcloud adapter factories.
//                               the governance orchestrator builds them via
//                               buildModuleProvisioningSubsystems().
//   4. data providers         — request-time read functions the kernel shell/
//                               dashboard/committees route loads invoke by key
//                               (A3a). getDataProvider(key)?.(args) returns the
//                               module's data, or undefined when the module is
//                               absent (the caller degrades to its empty state).
//
// The point of the seam: hooks.server.ts / tenant/registry.ts / the governance
// orchestrator / the kernel route loads no longer statically import any module's
// server internals ($lib/server/{calendar,content,events,messages,files,elections,
// finance}/*). They depend ONLY on this registry; the modules depend on it too and
// register into it. The register.server.ts files are loaded for their side effects
// by the generated server-init barrel (scripts/build-module-server-init.mjs).
//
// Pure in-memory module state (no I/O). Registration is process-global and
// idempotent enough for module re-import; _resetRuntimeRegistryForTests() clears
// it between unit tests.
import type { KeycloakAdminClient } from '$lib/server/keycloak-admin'
import type { ProvisioningSubsystem, Subsystem } from '$lib/server/governance/provisioning/types'

// ── 1. Server-init (boot) hooks ─────────────────────────────────────────────
/** A boot-time side-effect a module runs once at server cold start. May be async. */
export type ServerInitHook = () => void | Promise<void>

const _serverInitHooks: ServerInitHook[] = []

/** Register a boot hook. Invoked once (in registration order) by runServerInitHooks(). */
export function registerServerInitHook(hook: ServerInitHook): void {
  _serverInitHooks.push(hook)
}

/**
 * Run every registered boot hook, sequentially and in registration order,
 * awaiting each. Called once from hooks.server.ts boot(). Each hook owns its own
 * error handling (the previous inline starters each had their own try/catch), so
 * this runner does not swallow throws — a hook that must be non-fatal catches
 * internally, exactly as the inline boot code did.
 */
export async function runServerInitHooks(): Promise<void> {
  for (const hook of _serverInitHooks) {
    await hook()
  }
}

// ── 2. Tenant-evict hooks ───────────────────────────────────────────────────
/** Drop one tenant's per-tenant runtime handle (a per-tenant singleton evictor). */
export type TenantEvictHook = (tenantId: string) => void

const _tenantEvictHooks: TenantEvictHook[] = []

/** Register a per-tenant eviction hook. Invoked by runTenantEvictHooks(tenantId). */
export function registerTenantEvictHook(hook: TenantEvictHook): void {
  _tenantEvictHooks.push(hook)
}

/**
 * Run every registered eviction hook with `tenantId`. Called from
 * tenant/registry.ts evictTenantRuntime() AFTER the kernel evictors, so a
 * module's Matrix/Synapse/Helios/LiveKit per-tenant handle is dropped on the
 * SAME lifecycle seam as the kernel pool/JWKS/KC-admin handles.
 */
export function runTenantEvictHooks(tenantId: string): void {
  for (const hook of _tenantEvictHooks) {
    hook(tenantId)
  }
}

// ── 3. Provisioning subsystem factories ─────────────────────────────────────
/** Build a module's provisioning adapter, capturing the module's own service
 *  clients via closure and receiving the per-tenant KC-admin client. */
export type ProvisioningSubsystemFactory = (kc: KeycloakAdminClient) => ProvisioningSubsystem

const _provisioningFactories = new Map<Subsystem, ProvisioningSubsystemFactory>()

/**
 * Register a provisioning subsystem factory under its subsystem name. A module
 * (messages → matrix, files → nextcloud) registers here so the governance
 * orchestrator never imports the module's client/subsystem code. A repeat
 * registration under the same name replaces the prior factory (a module module
 * re-import is a no-op, not a duplicate).
 */
export function registerProvisioningSubsystem(
  name: Subsystem,
  factory: ProvisioningSubsystemFactory,
): void {
  _provisioningFactories.set(name, factory)
}

/**
 * Build every registered module provisioning subsystem from its factory, keyed
 * by subsystem name. Called by the orchestrator's defaultAdapters() (which adds
 * the kernel `keycloak` subsystem directly). Insertion order is preserved.
 */
export function buildModuleProvisioningSubsystems(
  kc: KeycloakAdminClient,
): Partial<Record<Subsystem, ProvisioningSubsystem>> {
  const built: Partial<Record<Subsystem, ProvisioningSubsystem>> = {}
  for (const [name, factory] of _provisioningFactories) {
    built[name] = factory(kc)
  }
  return built
}

// ── 4. Request-time data providers ──────────────────────────────────────────
// A keyed registry of read functions a feature module contributes for the kernel
// shell/dashboard/committees route loads (A3a). The KERNEL route depends only on
// this registry; the module registers its provider in register.server.ts. This
// inverts the prior static imports ($lib/server/{calendar,finance,messages}/*)
// the kernel route loads used to carry.
//
// The provider VALUE types below are KERNEL-OWNED structural projections (exactly
// what the kernel consumers read) — this file imports NO module internals, so the
// kernel stays decoupled. Each module maps its own domain types onto these at
// registration time. A key whose module is OFF is simply unregistered; the caller
// reads `getDataProvider(key)?.(...) ?? <empty>` and degrades to its empty state.

/** One upcoming calendar event, projected for the dashboard's loadCommon. */
export interface UpcomingEventRow {
  id: string
  startAt: Date
  title: string
  location: string | null
  committeeIds: string[]
}

/** One dashboard "Auf deine Freigabe" row (the finance my-approvals projection). */
export interface DashApprovalRow {
  type: 'expense' | 'project' | 'budget'
  approvable_id: number
  amount_cents: number | null
  created_at: string | null
  signers: { role: string; state: 'approved' | 'pending' | 'rejected' }[]
}

/** Caller-supplied eligibility context for the finance my-approvals provider. */
export interface DashApprovalsContext {
  fetch: typeof fetch
  currentUserId: string | null
  isAdmin: boolean
  groups: string[]
}

/** The finance my-approvals provider result (display rows + eligible total). */
export interface DashApprovalsResult {
  myApprovals: DashApprovalRow[]
  myApprovalsCount: number
}

/** Dashboard budget-summary KPI card (total/free/spent, integer cents). */
export interface DashBudgetSummary {
  totalCents: number
  freeCents: number
  spentCents: number
}

/**
 * The typed data-provider contract: each key maps to the provider signature its
 * registered module must satisfy. registerDataProvider/getDataProvider are
 * generic over K so both ends are type-checked against this single map.
 */
export interface DataProviderContract {
  /** Calendar: upcoming events in [from, to) (dashboard loadCommon). */
  'calendar:upcoming-events': (range: { from: Date; to: Date }) => Promise<UpcomingEventRow[]>
  /** Finance: GLOBAL pending-approval COUNT for the sidebar badge (layout loadCounts). */
  'finance:pending-approvals-count': () => Promise<number>
  /** Finance: planned EXPENSE budget (integer cents) per org-unit id (committees tree). */
  'finance:committee-expense-budgets': () => Promise<Map<string, number>>
  /** Finance: the rows awaiting THIS user's signature (dashboard my-approvals card). */
  'finance:dashboard-my-approvals': (ctx: DashApprovalsContext) => Promise<DashApprovalsResult>
  /** Finance: budget summary for the dashboard KPI card (gremion#22 finding 2 —
   *  was a hardcoded fetch('/api/finance/summary') that 404s once finance is
   *  carved out of the kernel; a module now owns the request-scoped fetch). */
  'finance:dashboard-summary': (ctx: { fetch: typeof fetch }) => Promise<DashBudgetSummary | null>
  /** Finance: #164 step-up master switch — whether real step-up is enforced on
   *  Vier-Augen actions. A SYNC boolean read (the settings layout's 2FA-chip
   *  gate); absent provider reads as `false`. */
  'finance:step-up-enforced': () => boolean
  /** Messages: Matrix unread total for the shell bell/sidebar badge (layout loadUnread). */
  'messages:unread-count': (accessToken: string | null) => Promise<number>
}

const _dataProviders = new Map<keyof DataProviderContract, DataProviderContract[keyof DataProviderContract]>()

/**
 * Register a module's request-time data provider under its contract key. A repeat
 * registration under the same key replaces the prior provider (a module re-import
 * is a no-op, not a duplicate).
 */
export function registerDataProvider<K extends keyof DataProviderContract>(
  key: K,
  provider: DataProviderContract[K],
): void {
  _dataProviders.set(key, provider)
}

/**
 * Look up the data provider registered under `key`, or undefined when no module
 * registered it (the kernel caller then degrades to its empty state). The return
 * type is narrowed to the contract signature for that key.
 */
export function getDataProvider<K extends keyof DataProviderContract>(
  key: K,
): DataProviderContract[K] | undefined {
  return _dataProviders.get(key) as DataProviderContract[K] | undefined
}

// ── 5. Protocol document port ───────────────────────────────────────────────
// A3a-2: the Nextcloud document operations the protocol routes drive (create the
// draft .odt, mint a Collabora WOPI editor URL, download the draft, move it to
// published, push/pull the rendered PDF, delete the draft) live in the FILES
// module — they legitimately hold the Nextcloud client + WebDAV-path helpers. The
// files module self-registers ONE implementation here (files/register.server.ts);
// the protocol routes depend only on this seam and read getProtocolDocumentPort(),
// so they no longer statically import $lib/server/files. A single port, not a
// keyed map — there is exactly one document backend. When the files module is OFF
// the port is undefined and the caller degrades to a 'service unavailable' status.

/** The Nextcloud-backed document operations the protocol routes drive. */
export interface ProtocolDocumentPort {
  /** Create the blank draft .odt for a protocol; returns its NC-relative path. */
  createDraftFile(protocolId: string): Promise<string>
  /** Mint a Collabora WOPI editor URL + token TTL for the draft. */
  getDraftWopiToken(draftPath: string): Promise<{ editorUrl: string; tokenTtl: number }>
  /** Download the draft .odt bytes (throws if the NC download is not ok). */
  downloadDraft(draftPath: string): Promise<Buffer>
  /** Move the draft .odt into the published dir; returns the published dir path. */
  publishFile(protocolId: string, draftPath: string): Promise<string>
  /** Upload the rendered PDF into the published dir; returns its NC-relative path. */
  uploadPublishedPdf(publishedDir: string, pdfBuffer: Buffer): Promise<string>
  /** Download a validated published PDF (returns the raw NC Response). */
  downloadPublishedPdf(pdfNcPath: string): Promise<Response>
  /** Best-effort delete of a draft .odt (never throws). */
  deleteDraftFile(draftPath: string): Promise<void>
}

let _protocolDocumentPort: ProtocolDocumentPort | undefined

/**
 * Register the files module's protocol document port. A repeat registration
 * replaces the prior one (a module re-import is a no-op, not a duplicate).
 */
export function registerProtocolDocumentPort(port: ProtocolDocumentPort): void {
  _protocolDocumentPort = port
}

/**
 * The registered protocol document port, or undefined when the files module is
 * absent (the protocol route then degrades to a 'service unavailable' status).
 */
export function getProtocolDocumentPort(): ProtocolDocumentPort | undefined {
  return _protocolDocumentPort
}

// ── 6. Setup-wizard health probes ────────────────────────────────────────────
// A3c S2: the setup-wizard health route (/api/setup/health) credential-probes
// each module's admin client to predict provisioning success (#191). Those
// clients live in the FEATURE modules (messages → synapse-admin, files →
// nextcloud-client), so the route used to statically import them. Each such
// module now self-registers ONE named credential probe here (in its
// register.server.ts); the route iterates getSetupHealthProbes() and reports
// each result under its `service` key, so it imports no module internals. The
// KERNEL admin clients (keycloak-admin) stay inline in the route — only the
// feature-module clients are inverted. A list (not a keyed map) preserving
// registration order; an unregistered module simply contributes no probe (the
// route's credential check for that service degrades to "invalid", matching the
// other absent-module seams).

/** One module's setup-wizard credential probe, reported under `service`. */
export interface SetupHealthProbe {
  /** The credential-map key the route reports this probe's result under (e.g.
   *  'synapse', 'nextcloud'). */
  service: string
  /** Validate the module's admin credentials. Swallows its own errors and
   *  returns a boolean (the route never throws out of the health endpoint). */
  validate: () => Promise<boolean>
}

const _setupHealthProbes: SetupHealthProbe[] = []

/** Register a module's setup-wizard credential probe (in registration order). */
export function registerSetupHealthProbe(probe: SetupHealthProbe): void {
  _setupHealthProbes.push(probe)
}

/**
 * Every registered setup-health probe, in registration order. The setup-health
 * route iterates this to run each module's credential probe; an empty list
 * (no module registered) means the route runs only its kernel probes.
 */
export function getSetupHealthProbes(): readonly SetupHealthProbe[] {
  return _setupHealthProbes
}

/** Test-only: clear all registries so a unit test starts from empty. */
export function _resetRuntimeRegistryForTests(): void {
  _serverInitHooks.length = 0
  _tenantEvictHooks.length = 0
  _provisioningFactories.clear()
  _dataProviders.clear()
  _protocolDocumentPort = undefined
  _setupHealthProbes.length = 0
}
