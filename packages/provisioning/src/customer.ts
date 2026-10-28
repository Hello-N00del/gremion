// packages/provisioning/src/customer.ts — create, suspend, resume and inspect
// a customer (TASK-043 §5). Every function here is ORDER and POST-CONDITIONS
// over the ports; the phases map onto the containers and the host exactly as
// `gremion-tenant create` runs them:
//
//   phase A (container)  validate -> control row `provisioning` + primary host
//                        -> ledger opened -> realm_created -> database_created
//                        (ensureKernelDatabase, config.json, gremion-ui's
//                        runMigrations as the owner, seeds off, post-condition
//                        read from the database) -> domain_bound ->
//                        storage_prefix_reserved -> first_body_created ->
//                        broker_account_created (kernel only)
//   host                 gremion-vendor-mail realm-smtp --tenant, then
//                        recordHostStep (verifies the stamp over Keycloak)
//   phase B (container)  first_accounts_created -> per --enable: the
//                        operator's DPIA decision recorded, enableModule
//                        through the level-1 gate (TASK-044) -> broker users
//                        for the enabled modules -> active, setup_complete
//   host                 the router file (render-router + atomic write)
// Both phases first run the gate's pre-flight (TASK-044 lane note D2): the
// release tip, a current-tip isolation pass and a DPIA decision per --enable
// module, BEFORE the phase's first write.
import type { UnprovenEnablement } from '@gremion/tenant-store/lifecycle'
import { assertUuid, ProvisioningError } from './errors.ts'
import { doneKinds, latestStatus } from './ledger.ts'
import { openLedger, runPhase, type RunPhaseResult } from './machine.ts'
import { enableOne, preflightGate } from './module-gate.ts'
import { assertEnableList } from './operator-gate.ts'
import type { AdminSpec, ControlRow, CustomerRef, DpiaSpec, ProvisioningDeps } from './ports.ts'
import { assertCustomerSlug, principalFor, tokenFor } from './slug.ts'
import { EXECUTION_ORDER, isComplete, type StepKind, type StepStatus } from './steps.ts'

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export interface CreateSpec {
  slug: string
  host: string
  /** Operator --enable ids (validated against the catalogue, board denied). */
  enable: readonly string[]
  /** The ops-realm user id of the operator (actor_operator_id, enabled_by). */
  operatorId: string
  /** The first IT-administrator and council-administrator (PRD-IDN-005). */
  admins: readonly AdminSpec[]
  /**
   * TASK-044 (lane note D2): the operator's dated DPIA-applicability decision
   * per enabled module, recorded after phase A and before its enable. A module
   * without one (and none recorded for the customer) refuses NO_DPIA_DECISION
   * before any write.
   */
  dpia?: Readonly<Record<string, DpiaSpec>>
  /**
   * create-harden H3: phase B leaves the customer `provisioning`; the host
   * marks it active (activateCustomer) only after it has written the router,
   * so a router failure never leaves an active customer with no route.
   */
  deferActivation?: boolean
}

export function assertHost(host: string): string {
  if (typeof host !== 'string' || !HOST.test(host)) throw new ProvisioningError('INVALID_INPUT', `host ${JSON.stringify(host)} is not a canonical lowercase DNS name`)
  return host
}

export function assertAdmins(admins: readonly AdminSpec[]): AdminSpec[] {
  const roles = admins.map((a) => a.role).sort()
  if (JSON.stringify(roles) !== JSON.stringify(['council-admin', 'it-admin'])) {
    throw new ProvisioningError('INVALID_INPUT', 'exactly one it-admin and one council-admin are required (PRD-IDN-005)')
  }
  for (const a of admins) {
    if (typeof a.email !== 'string' || !EMAIL.test(a.email.toLowerCase())) throw new ProvisioningError('INVALID_INPUT', `admin email ${JSON.stringify(a.email)} is not an address`)
  }
  return admins.map((a) => ({ role: a.role, email: a.email.toLowerCase() }))
}

function refOf(row: ControlRow, host: string): CustomerRef {
  return { id: row.id, slug: row.slug, token: tokenFor(row.slug), realm: row.realm, host }
}

/** Validation shared by every phase: the inputs, before any write. */
export function validateCreate(spec: CreateSpec, catalogueIds: readonly string[]): { slug: string; host: string; token: string; enable: string[]; admins: AdminSpec[] } {
  const slug = assertCustomerSlug(spec.slug)
  const token = tokenFor(slug)
  const host = assertHost(spec.host)
  assertUuid(spec.operatorId, 'operator id')
  const enable = assertEnableList(spec.enable, catalogueIds)
  const admins = assertAdmins(spec.admins)
  return { slug, host, token, enable, admins }
}

/**
 * Every --enable id must have the plt.module_version row `init` loads (Q20),
 * checked BEFORE any write (review B1, r2): otherwise enableModule refuses it
 * MODULE_VERSION_UNKNOWN in phase B, after the realm exists and both
 * administrators were invited, and the customer is stuck in `provisioning`.
 */
export async function assertEnableLoaded(enable: readonly string[], deps: Pick<ProvisioningDeps, 'modules'>): Promise<void> {
  if (!enable.length) return
  const missing = await deps.modules.unloaded(enable)
  if (missing.length) {
    throw new ProvisioningError(
      'MODULE_NOT_LOADED',
      `module(s) ${missing.join(', ')} cannot be enabled: gremion-tenant init loaded no plt.module_version for them (undecided under Q20, e.g. no retention profile declared); nothing was written`,
    )
  }
}

/** The control row for `slug`, created `provisioning` with its primary host if absent. */
async function ensureControlRow(deps: ProvisioningDeps, slug: string, host: string): Promise<{ row: ControlRow; created: boolean }> {
  const existing = await deps.control.getBySlug(slug)
  if (existing) {
    if (existing.status === 'deleted' || existing.status === 'deleting') {
      throw new ProvisioningError('CUSTOMER_STATE', `slug ${slug} is a tombstone (status ${existing.status}); identifiers are never reissued`)
    }
    if (existing.host !== null && existing.host !== host) {
      throw new ProvisioningError('CUSTOMER_STATE', `customer ${slug} is bound to ${existing.host}, not ${host}`)
    }
    if (existing.host === null) {
      // a crash between the tenant insert and addTenantDomain: bind the host now, or domain_bound fails forever
      await deps.control.bindPrimaryHost(existing.id, host)
      return { row: { ...existing, host }, created: false }
    }
    return { row: existing, created: false }
  }
  return { row: await deps.control.registerProvisioning({ slug, host, realm: slug }), created: true }
}

export interface PhaseOutcome {
  customer: CustomerRef
  run: RunPhaseResult
}

export async function createPhaseA(spec: CreateSpec, deps: ProvisioningDeps): Promise<PhaseOutcome & { registered: boolean }> {
  const v = validateCreate(spec, deps.modules.catalogueIds())
  await assertEnableLoaded(v.enable, deps)
  // TASK-044 D2: a stale tip, a missing pass or a missing DPIA decision fails before a realm exists
  await preflightGate(v.enable, spec.dpia, (await deps.control.getBySlug(v.slug))?.id ?? null, spec.operatorId, deps.gate)
  const { row, created } = await ensureControlRow(deps, v.slug, v.host)
  const c = refOf(row, v.host)
  await openLedger(deps.ledger, c.id, spec.operatorId)
  const run = await runPhase('a', {
    customerId: c.id,
    operatorId: spec.operatorId,
    ledger: deps.ledger,
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    steps: {
      realm_created: () => deps.realm.ensureRealm(c),
      database_created: async () => {
        await deps.kernel.ensureDatabase(c)
        await deps.config.ensure(c)
        await deps.kernel.migrate(c)
        const pc = await deps.kernel.postCondition(c)
        if (JSON.stringify(pc.ledgerColumns) !== JSON.stringify(['filename', 'applied_at'])) {
          throw new ProvisioningError('POSTCONDITION', `the kernel ledger has columns [${pc.ledgerColumns.join(', ')}], not gremion-ui's (filename, applied_at): it was not migrated by db.ts runMigrations (Q3)`)
        }
        if (pc.seedRows.length) throw new ProvisioningError('POSTCONDITION', `the kernel ledger records seed file(s) ${pc.seedRows.join(', ')}: GREMION_DISABLE_SEEDS was not "true"`)
        if (pc.committees !== 0) throw new ProvisioningError('POSTCONDITION', `the fresh kernel database holds ${pc.committees} committee(s), expected 0`)
        if (pc.orgUnits !== 0) throw new ProvisioningError('POSTCONDITION', `the fresh kernel database holds ${pc.orgUnits} org unit(s) before the first body, expected 0`)
      },
      domain_bound: () => deps.domain.assertBound(c),
      storage_prefix_reserved: () => deps.storage.reservePrefix(c),
      first_body_created: async () => {
        await deps.firstBody.ensure(c)
        const pc = await deps.kernel.postCondition(c)
        if (pc.orgUnits !== 1 || pc.committees !== 0) {
          throw new ProvisioningError('POSTCONDITION', `after the first body the kernel database holds ${pc.orgUnits} org unit(s) and ${pc.committees} committee(s), expected 1 and 0`)
        }
      },
      broker_account_created: async () => {
        await deps.broker.ensure(c, [])
      },
    },
  })
  return { customer: c, run, registered: created }
}

async function requireCustomer(deps: ProvisioningDeps, slug: string): Promise<CustomerRef & { status: ControlRow['status'] }> {
  const s = assertCustomerSlug(slug)
  const row = await deps.control.getBySlug(s)
  if (!row) throw new ProvisioningError('NOT_FOUND', `no customer ${s}`)
  if (!row.host) throw new ProvisioningError('CUSTOMER_STATE', `customer ${s} has no primary host bound`)
  return { ...refOf(row, row.host), status: row.status }
}

/**
 * The host phase's ledger step: the host already ran
 * `gremion-vendor-mail realm-smtp --realm <r> --tenant <token>`; this verifies
 * the stamp over Keycloak (the post-condition, never the launcher's exit code)
 * and records mail_principal_issued.
 */
export async function recordHostStep(slug: string, kind: StepKind, operatorId: string, deps: ProvisioningDeps): Promise<PhaseOutcome> {
  if (kind !== 'mail_principal_issued') throw new ProvisioningError('INVALID_INPUT', `record-step accepts mail_principal_issued only, not ${kind}`)
  const c = await requireCustomer(deps, slug)
  const run = await runPhase('host', {
    customerId: c.id,
    operatorId,
    ledger: deps.ledger,
    ...(deps.log ? { log: deps.log } : {}),
    steps: { mail_principal_issued: () => assertSmtpStamped(c, deps) },
  })
  return { customer: c, run }
}

export async function assertSmtpStamped(c: CustomerRef, deps: ProvisioningDeps): Promise<void> {
  const got = await deps.realm.readSmtp(c.realm)
  const sender = deps.mailSender ?? { mode: 'stalwart' as const }
  if (sender.mode === 'relay') {
    // PLAN-mail-transport: one shared relay credential, no per-realm principal.
    // readSmtp reports a user only when a password is set, so an authenticating
    // relay needs a user read back; an IP-allow-listed one (user '') needs none.
    const problems: string[] = []
    if ((got.user ?? '').startsWith('kc-') || (got.from ?? '').startsWith('kc-')) {
      problems.push(`the realm carries the per-customer principal ${got.user ?? got.from} but MAIL_TRANSPORT is relay -- migration residue`)
    } else if ((got.user ?? '') !== sender.user) {
      problems.push(`user ${JSON.stringify(got.user)} (want ${JSON.stringify(sender.user === '' ? null : sender.user)})`)
    }
    if (got.from !== sender.fromAddress && !(got.from ?? '').startsWith('kc-')) problems.push(`from ${JSON.stringify(got.from)} (want ${sender.fromAddress})`)
    if (got.host !== sender.host) problems.push(`host ${JSON.stringify(got.host)} (want ${sender.host})`)
    if (got.port !== String(sender.port)) problems.push(`port ${JSON.stringify(got.port)} (want ${sender.port})`)
    const wantStarttls = sender.port === 465 ? 'false' : 'true'
    if (got.starttls !== wantStarttls) problems.push(`starttls ${JSON.stringify(got.starttls)} (want ${wantStarttls})`)
    if (problems.length) throw new ProvisioningError('POSTCONDITION', `realm ${c.realm} is not stamped with the relay sender: ${problems.join('; ')}`)
    return
  }
  const want = principalFor(c.token, deps.platformDomain)
  const problems: string[] = []
  if (got.user !== want) problems.push(`user ${JSON.stringify(got.user)} (want ${want})`)
  if (got.from !== want) problems.push(`from ${JSON.stringify(got.from)} (want ${want})`)
  if (got.host !== `mail.${deps.platformDomain}`) problems.push(`host ${JSON.stringify(got.host)} (want mail.${deps.platformDomain})`)
  if (got.port !== '587') problems.push(`port ${JSON.stringify(got.port)} (want 587)`)
  if (got.starttls !== 'true') problems.push(`starttls ${JSON.stringify(got.starttls)} (want true)`)
  if (problems.length) throw new ProvisioningError('POSTCONDITION', `realm ${c.realm} is not stamped with its own submission principal: ${problems.join('; ')}`)
}

export async function createPhaseB(spec: CreateSpec, deps: ProvisioningDeps): Promise<PhaseOutcome & { enabled: string[]; reloaded: boolean; activated: boolean }> {
  const v = validateCreate(spec, deps.modules.catalogueIds())
  await assertEnableLoaded(v.enable, deps)
  const c = await requireCustomer(deps, v.slug)
  if (c.host !== v.host) throw new ProvisioningError('CUSTOMER_STATE', `customer ${v.slug} is bound to ${c.host}, not ${v.host}`)
  if (c.status !== 'provisioning' && c.status !== 'active') throw new ProvisioningError('CUSTOMER_STATE', `customer ${v.slug} is ${c.status}; resume it instead`)
  // TASK-044 D2: re-checked before the accounts step (the tip or a result may have moved since phase A)
  await preflightGate(v.enable, spec.dpia, c.id, spec.operatorId, deps.gate)
  const run = await runPhase('b', {
    customerId: c.id,
    operatorId: spec.operatorId,
    ledger: deps.ledger,
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    steps: {
      first_accounts_created: async () => {
        await assertSmtpStamped(c, deps)
        await deps.realm.ensureAdmins(c, v.admins)
      },
    },
  })
  // TASK-044: the same path as a later enable (module-gate.ts): the DPIA
  // decision recorded (reused on a resume), then enableModule through the gate.
  for (const moduleId of v.enable) {
    await enableOne(c, moduleId, { operatorId: spec.operatorId, dpia: spec.dpia?.[moduleId] }, deps)
  }
  const enabled = (await deps.modules.enabled(c)).sort()
  const broker = await deps.broker.ensure(c, enabled)
  const activated = spec.deferActivation ? false : (await activateCustomer(c, deps)).activated
  if (!(await deps.config.setupComplete(c))) await deps.config.markSetupComplete(c)
  return { customer: c, run, enabled, reloaded: broker.reloaded, activated }
}

/**
 * The last create step (create-harden H3): `provisioning` -> `active`, once the
 * ledger is complete. Re-runnable: an active customer is left as it is.
 */
export async function activateCustomer(c: CustomerRef & { status: ControlRow['status'] }, deps: ProvisioningDeps): Promise<{ customer: CustomerRef; activated: boolean }> {
  if (c.status === 'active') return { customer: c, activated: false }
  if (c.status !== 'provisioning') throw new ProvisioningError('CUSTOMER_STATE', `customer ${c.slug} is ${c.status}; only a provisioning customer is activated`)
  const done = doneKinds(await deps.ledger.rows(c.id))
  if (!isComplete(done)) throw new ProvisioningError('STEP_OUT_OF_ORDER', `customer ${c.slug} is not complete (missing ${EXECUTION_ORDER.filter((k) => !done.has(k)).join(', ')})`)
  await deps.control.setStatus(c.id, 'active')
  return { customer: c, activated: true }
}

export async function activateBySlug(slug: string, deps: ProvisioningDeps): Promise<{ customer: CustomerRef; activated: boolean }> {
  return activateCustomer(await requireCustomer(deps, slug), deps)
}

/**
 * Suspend (§5): status `suspended` FIRST (the app serves the branded 503 and
 * resolves nothing), then the realm disabled with notBefore and every session
 * logged out, then every module user evicted from the broker (kernel stays).
 * The host then revokes the mail principal (gremion-vendor-mail --revoke).
 */
export async function suspendCustomer(slug: string, deps: ProvisioningDeps): Promise<{ customer: CustomerRef; changed: boolean }> {
  const c = await requireCustomer(deps, slug)
  if (c.status !== 'active' && c.status !== 'suspended') throw new ProvisioningError('CUSTOMER_STATE', `customer ${c.slug} is ${c.status}; only an active customer is suspended`)
  let changed = false
  if (c.status === 'active') {
    await deps.control.setStatus(c.id, 'suspended')
    changed = true
  }
  // Always asserted, never skipped on "already disabled": the disable and the logout-all are two calls
  // (setRealmEnabled), and a rerun after a failed logout must still log every session out.
  if (await deps.realm.isEnabled(c.realm)) changed = true
  await deps.realm.setEnabled(c.realm, false)
  const r = await deps.broker.ensure(c, [])
  return { customer: c, changed: changed || r.reloaded }
}

/**
 * Resume: the host has re-issued a FRESH principal and stamped it (never
 * --rotate after a revoke); this verifies the stamp, enables the realm,
 * restores the enabled modules' broker users, and sets `active` LAST.
 */
export async function resumeCustomer(slug: string, deps: ProvisioningDeps): Promise<{ customer: CustomerRef; changed: boolean }> {
  const c = await requireCustomer(deps, slug)
  if (c.status !== 'suspended' && c.status !== 'active') throw new ProvisioningError('CUSTOMER_STATE', `customer ${c.slug} is ${c.status}; only a suspended customer is resumed`)
  await assertSmtpStamped(c, deps)
  let changed = false
  if (!(await deps.realm.isEnabled(c.realm))) {
    await deps.realm.setEnabled(c.realm, true)
    changed = true
  }
  const r = await deps.broker.ensure(c, (await deps.modules.enabled(c)).sort())
  if (c.status === 'suspended') {
    await deps.control.setStatus(c.id, 'active')
    changed = true
  }
  return { customer: c, changed: changed || r.reloaded }
}

export interface ProvisioningStatus {
  slug: string
  customerId: string
  status: ControlRow['status']
  host: string | null
  complete: boolean
  steps: { kind: StepKind; status: StepStatus | 'absent' }[]
  /**
   * TASK-044 (Q8): the customer's enabled modules that are not proven on this
   * release (no current-tip pass, a stale or interim reference, no written
   * DPIA decision). Empty before go-live (TASK-038).
   */
  unprovenEnablements: Pick<UnprovenEnablement, 'moduleKey' | 'codes' | 'reason'>[]
}

export async function provisioningStatus(slug: string, deps: Pick<ProvisioningDeps, 'control' | 'ledger' | 'gate'>): Promise<ProvisioningStatus> {
  const s = assertCustomerSlug(slug)
  const row = await deps.control.getBySlug(s)
  if (!row) throw new ProvisioningError('NOT_FOUND', `no customer ${s}`)
  const rows = await deps.ledger.rows(row.id)
  const latest = latestStatus(rows)
  const done = doneKinds(rows)
  return {
    slug: row.slug,
    customerId: row.id,
    status: row.status,
    host: row.host,
    complete: isComplete(done),
    steps: EXECUTION_ORDER.map((kind) => ({ kind, status: latest.get(kind) ?? 'absent' })),
    unprovenEnablements: (await deps.gate.unproven(row.id)).map((u) => ({ moduleKey: u.moduleKey, codes: u.codes, reason: u.reason })),
  }
}
