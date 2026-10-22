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
  /** OPTIONAL per-tenant display labels for the KV/HV approval-stage roles
   *  (additive). Kernel callers thread financeRoleLabelsForTenant(tenant) from
   *  $lib/server/tenant/role-vocabulary; absent = the provider's own 'KV'/'HV'
   *  defaults, byte-identical to today. */
  financeRoleLabels?: { kv: string; hv: string }
}

/** The finance my-approvals provider result (display rows + eligible total). */
export interface DashApprovalsResult {
  myApprovals: DashApprovalRow[]
  myApprovalsCount: number
}

/** The finance module's handover facts core for an org-unit scope (the
 *  handover kernel adds orgUnitScope + retention around it). TASK-009 verifier
 *  FIX 2: inverted out of handover-modules.ts, which used to import finance. */
export interface HandoverFinanceFactsCore {
  financeUnitCount: number
  budgetTitel: Array<{
    titelNr: string | null
    titelName: string
    plannedCents: number
    bookedCents: number
    remainingCents: number
  }>
  openBookings: number
  pendingVierAugen: number
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
  /** Finance: #369 org-unit ↔ finance referential guard — whether the finance
   *  domain still holds rows referencing an org unit (which blocks its deletion,
   *  the app-level replacement for the 3 cross-DB org_units RESTRICT FKs). The
   *  committees DELETE route consults it before deprovision/delete; an absent
   *  provider (finance module off) reads as not-referenced. */
  'finance:org-unit-refs': (orgUnitId: string) => Promise<{ referenced: boolean; counts: Record<string, number> }>
  /** Finance: the tenant's Finanzordnung retention for the handover (Art. 17(3)
   *  horizon + live facts). null = no profile to report (the handover kernel
   *  uses its canonical default); a rejection propagates. Absent provider
   *  (finance module off) = the kernel default. */
  'finance:handover-retention': () => Promise<{ years: number; from: string } | null>
  /** Finance: the handover facts core for an org-unit scope (budget Titel,
   *  open bookings, pending Vier-Augen). null = finance cannot report them
   *  (e.g. FINANCE_BACKEND=service, a named residual); the handover kernel then
   *  renders the empty-facts shape. Absent provider = empty facts too. */
  'finance:handover-facts': (orgUnitKeys: string[]) => Promise<HandoverFinanceFactsCore | null>
  /** Messages: Matrix unread total for the shell bell/sidebar badge (layout loadUnread). */
  'messages:unread-count': (accessToken: string | null) => Promise<number>
  /** Messages: rooms with unread>0 (name + count + last activity) for the D11
   *  notification popover's chat rows (GET /api/notifications). Absent module →
   *  no chat rows. lastTs = origin_server_ts (ms) of the latest synced message,
   *  or null when the timeline carried none. */
  'messages:unread-rooms': (
    accessToken: string | null,
  ) => Promise<{ roomId: string; name: string; unread: number; lastTs: number | null }[]>
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
  /** Undo publishFile: move the ODT back to its draft path (compensation when publish fails after the move). */
  restoreDraftFile?(draftPath: string, publishedDir: string): Promise<void>
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
// A3c S2: each feature module that owns an admin client (messages →
// synapse-admin, files → nextcloud-client) self-registers ONE named credential
// probe here in its register.server.ts. A list (not a keyed map) preserving
// registration order; an unregistered module simply contributes no probe.
//
// No reader since TASK-042: the setup-wizard health route (/api/setup/health)
// that was meant to iterate getSetupHealthProbes() is deleted with the wizard
// (Q1). The API stays (TASK-042 Q10): it is a published module seam with
// callers in the out-of-tree module repo and the pilot app, and removing it is a major change
// (SemVer 2.0 §8). Residual for TASK-043: its pre-provision credential checks
// consume these probes, or the seam is retired in a major release.

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

// ── 7. Role-assignment group grants ──────────────────────────────────────────
// #410 FIN-2 (B2): a module can declare that holders of a governance ROLE need
// extra FLAT Keycloak groups (finance: Finanzvorstand → ref-finanzen + -hv, …).
// Provisioning only creates/joins the per-org-unit groups named by display name,
// so module authz that keys on flat groups needs this seam. The finance module
// registers its resolver in register.server.ts; the kernel role-assign route
// unions every resolver's grants for the assigned role's name and adds the
// assignee to those KC groups. A resolver returns [] for role names it does not
// map — the kernel never learns any module's group literals.
export type RoleGroupGrantResolver = (roleName: string) => readonly string[]

const _roleGroupGrantResolvers: RoleGroupGrantResolver[] = []

/** Register a module's role → flat-group grant resolver. */
export function registerRoleGroupGrantResolver(resolver: RoleGroupGrantResolver): void {
  _roleGroupGrantResolvers.push(resolver)
}

/** A flat group name a resolver may grant: non-empty, no path separator, no
 *  surrounding whitespace (TASK-206-0: a resolver cannot reach a Keycloak group
 *  path or a blank name through this seam). */
const FLAT_GROUP_NAME = /^[^/\s](?:[^/]*[^/\s])?$/

/** Union of every registered resolver's flat-group names for `roleName`
 *  (deduplicated; [] when no module maps the role). A name that is not a plain
 *  flat group name is dropped and reported, never granted. */
export function resolveRoleGroupGrants(roleName: string): readonly string[] {
  const names = new Set<string>()
  for (const resolver of _roleGroupGrantResolvers) {
    for (const name of resolver(roleName)) {
      if (typeof name === 'string' && FLAT_GROUP_NAME.test(name)) names.add(name)
      else console.error(`[runtime-registry] role-group grant for '${roleName}' dropped: not a flat group name`, name)
    }
  }
  return [...names]
}

// ── 8. Decision-rule strategies ──────────────────────────────────────────────
// Governance Core INV-5 extension seam: a resolution class's decision rule is
// resolved BY ID from a strategy registry (the kernel's core rules live in
// $lib/server/governance/decision-rule.ts and consult this registry for
// non-core ids). A module may contribute NEW rule ids here at import time
// (register.server.ts), so the kernel never imports a module's voting
// semantics. Resolution is FAIL-CLOSED — an id neither core nor registered
// throws in decision-rule.ts, it NEVER falls back to 'simple'. The core rule
// ids are reserved: registering over one is refused, so no module can silently
// redefine the kernel's shipped voting semantics.

/** The tally a decision-rule strategy judges. Kernel-owned structural shape —
 *  every strategy (core or module) receives exactly these six keys. */
export interface DecisionRuleContext {
  /** Votes cast in favour. */
  yes: number
  /** Votes cast against. */
  no: number
  /** Abstentions (never count toward a majority). */
  abstain: number
  /** ALL eligible voting members of the body. */
  eligible: number
  /** Members present at the vote. */
  present: number
  /** The resolution class's declared decision_rule_params (JSON), or null. */
  params: Readonly<Record<string, unknown>> | null
}

/** One decision-rule strategy: a pure tally → passed judgement. May throw a
 *  typed error on invalid `params`; must not have side effects. */
export type DecisionRuleStrategy = (ctx: DecisionRuleContext) => boolean

/** The kernel-shipped rule ids. Reserved — module registration over them is
 *  refused (the single source of truth decision-rule.ts also keys off). */
export const CORE_DECISION_RULE_IDS = Object.freeze([
  'simple',
  'two_thirds',
  'absolute',
  'consent',
  'support_threshold',
] as const)

/** Thrown when a module attempts to register a strategy over a core rule id. */
export class ReservedDecisionRuleIdError extends Error {
  readonly ruleId: string
  constructor(ruleId: string) {
    super(`decision rule id '${ruleId}' is a core rule and cannot be overridden`)
    this.name = 'ReservedDecisionRuleIdError'
    this.ruleId = ruleId
  }
}

const _decisionRuleStrategies = new Map<string, DecisionRuleStrategy>()

/**
 * Register a module's decision-rule strategy under its rule id. Core rule ids
 * are refused (throws ReservedDecisionRuleIdError) — a module EXTENDS the rule
 * vocabulary, it never redefines the kernel's. A repeat registration under the
 * same id replaces the prior strategy (a module re-import is a no-op, not a
 * duplicate).
 */
export function registerDecisionRule(ruleId: string, strategy: DecisionRuleStrategy): void {
  if ((CORE_DECISION_RULE_IDS as readonly string[]).includes(ruleId)) {
    throw new ReservedDecisionRuleIdError(ruleId)
  }
  _decisionRuleStrategies.set(ruleId, strategy)
}

/**
 * The module strategy registered under `ruleId`, or undefined. Consulted by
 * resolveDecisionRule() (decision-rule.ts) AFTER the core rules; that caller —
 * not this registry — owns the fail-closed throw on a fully unknown id.
 */
export function getModuleDecisionRule(ruleId: string): DecisionRuleStrategy | undefined {
  return _decisionRuleStrategies.get(ruleId)
}

// ── 9. Second-locus strategies ───────────────────────────────────────────────
// Governance charter Slot B (resource-commitment guard): no actor unilaterally
// commits collective resources as sole decider — a commitment is staged through
// a SECOND locus distinct from its initiator. HOW that second locus is staged
// (ex-ante co-signature à la Vier-Augen, M-of-N, review-window, …) is a
// pluggable strategy resolved BY ID, mirroring the decision-rule seam (§8): the
// kernel resolver lives in $lib/server/governance/second-locus.ts and consults
// this registry; a module contributes strategies at import time (its own
// module graph / register.server.ts), so the kernel never imports a module's
// commitment vocabulary. Resolution is FAIL-CLOSED — an unregistered id throws
// in second-locus.ts, it NEVER falls back to a permissive no-guard result.
//
// Unlike the decision-rule seam (§8), the kernel reserves NO placeholder ids
// for this seam: verticals OWN their strategy ids (finance ships 'vier-augen').
// Registration is therefore unconditional — a repeat under the same id replaces
// (a module re-import is a no-op, not a duplicate).
//
// The contract types below are KERNEL-OWNED structural shapes derived from the
// finance Vier-Augen workflow's actual usage (approval-stages.ts buildStages/
// resolveTier + approval-workflow.ts #assertSignerEligible) — this file imports
// NO module internals; a module maps its own domain types onto these at
// registration time.

/** One configured signer stage, as the governing profile declares it (the
 *  shape finanzordnung_profile.signer_stages rows already carry). */
export interface SecondLocusSignerStageDef {
  role: string
  required_group: string
  certifies: string[]
}

/** One decision-authority tier. `max_amount_cents === null` is the open-top
 *  tier (matches any amount). */
export interface SecondLocusAuthorityTier {
  max_amount_cents: number | null
  required_group: string
}

/** The staging question a strategy answers: which ordered co-signature stages
 *  guard a commitment of `amountCents` under this signer/tier configuration?
 *  `amountCents === null` = the approvable carries no amount snapshot. */
export interface SecondLocusStageInput {
  signerStages: readonly SecondLocusSignerStageDef[]
  decisionAuthorityTiers: readonly SecondLocusAuthorityTier[]
  amountCents: number | null
}

/** One described stage row (the approval-stages BuiltStage shape — the
 *  insertable camelCase projection the calling module persists). */
export interface SecondLocusBuiltStage {
  stageIndex: number
  role: string
  requiredGroup: string
  certifies: string[]
}

/** The signer attempting to act on the current stage. */
export interface SecondLocusActor {
  userId: string
  groups: readonly string[]
}

/** The approval under signature, projected to what distinctness needs. */
export interface SecondLocusApprovalMeta {
  createdBy: string
}

/** One persisted stage's signature state: stable identity (the distinct-
 *  signers guard compares by it), required group, and who signed it (null =
 *  not yet acted). */
export interface SecondLocusStageState {
  id: number
  requiredGroup: string
  signerUserId: string | null
}

/** Distinctness verdict: ok, or WHICH guard failed — discriminated by the
 *  three guards in #assertSignerEligible order (group eligibility →
 *  no-self-approval → distinct signers). */
export type SecondLocusDistinctnessResult =
  | { ok: true }
  | { ok: false; violation: 'group-ineligible' | 'self-approval' | 'duplicate-signer' }

/** One second-locus strategy: pure config → stage rows + signer-distinctness
 *  judgement. No side effects — persistence and the typed-error mapping stay
 *  with the calling module. */
export interface SecondLocusStrategy {
  /** Describe the ordered co-signature stages guarding a commitment. */
  describeStages(input: SecondLocusStageInput): SecondLocusBuiltStage[]
  /** Judge whether `actor` may sign `currentStage` of `approval`. */
  validateDistinctness(
    stages: readonly SecondLocusStageState[],
    actor: SecondLocusActor,
    approval: SecondLocusApprovalMeta,
    currentStage: SecondLocusStageState,
  ): SecondLocusDistinctnessResult
}

const _secondLocusStrategies = new Map<string, SecondLocusStrategy>()

/**
 * Register a module's second-locus strategy under its id. The kernel reserves
 * NO ids for this seam — a module OWNS its strategy ids (registration is
 * unconditional). A repeat registration under the same id replaces the prior
 * strategy (a module re-import is a no-op, not a duplicate).
 */
export function registerSecondLocusStrategy(strategyId: string, strategy: SecondLocusStrategy): void {
  _secondLocusStrategies.set(strategyId, strategy)
}

/**
 * The module strategy registered under `strategyId`, or undefined. Consulted
 * by resolveSecondLocusStrategy() (second-locus.ts) AFTER the core strategies;
 * that caller — not this registry — owns the fail-closed throw on a fully
 * unknown id.
 */
export function getModuleSecondLocusStrategy(strategyId: string): SecondLocusStrategy | undefined {
  return _secondLocusStrategies.get(strategyId)
}

/** Test-only: clear all registries so a unit test starts from empty. */
export function _resetRuntimeRegistryForTests(): void {
  _serverInitHooks.length = 0
  _tenantEvictHooks.length = 0
  _provisioningFactories.clear()
  _dataProviders.clear()
  _protocolDocumentPort = undefined
  _setupHealthProbes.length = 0
  _roleGroupGrantResolvers.length = 0
  _decisionRuleStrategies.clear()
  _secondLocusStrategies.clear()
}
