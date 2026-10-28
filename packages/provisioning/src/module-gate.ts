// packages/provisioning/src/module-gate.ts — TASK-044's library verbs over the
// level-1 enable gate (lifecycle/enable-gate in @gremion/tenant-store). One
// path enables a module for a customer, at create (createPhaseB) and later
// (enableCustomerModule): the deny list, the loaded catalogue version, the
// operator's dated DPIA decision recorded, then enableModule through the REAL
// gate, which refuses with EnableRefused {code, reason} before any write.
//
// The TASK-043 interim gate (operatorAllowGate over plt.operator_enable_attestation)
// is gone (lane note G10); the attestation table stays as history and
// attestedEnablements / regateEnablement re-gate what it let through.
//
// TASK-043d (the control panel's executor) codes against: enableCustomerModule,
// CreateSpec.dpia, EnableRefused, and the tenant-store verbs re-exported from
// the package index (recordDpiaDecision, recordIsolationResults,
// unprovenEnablements, regateEnablement).
import type { Sql } from '@gremion/db'
import {
  assertDpiaDecisionInput,
  assertIsolationProven,
  createEnableGate,
  EnableRefused,
  LifecycleError,
  latestDpiaDecision,
  recordDpiaDecision,
  unprovenEnablements,
  type DpiaDecisionInput,
} from '@gremion/tenant-store/lifecycle'
import { assertUuid, ProvisioningError } from './errors.ts'
import { assertEnableList } from './operator-gate.ts'
import type { ControlRow, CustomerRef, DpiaSpec, GatePort, ProvisioningDeps } from './ports.ts'
import { assertCustomerSlug, tokenFor } from './slug.ts'

/** Validates one module's DPIA decision as the create request carries it (lane note D2). */
export function assertDpiaSpec(moduleKey: string, spec: DpiaSpec, operatorId: string): DpiaDecisionInput {
  const input: DpiaDecisionInput = {
    // the customer id is not known before phase A: a placeholder v7 for the shape check only
    customerId: '00000000-0000-7000-8000-000000000000',
    moduleKey,
    requiresDpia: spec?.requiresDpia,
    reasonCodes: spec?.reasonCodes,
    documentRef: spec?.documentRef,
    decidedBy: { kind: 'operator', id: operatorId },
  }
  try {
    assertDpiaDecisionInput(input)
  } catch (err) {
    if (err instanceof LifecycleError) throw new ProvisioningError('INVALID_INPUT', `module ${moduleKey}: ${err.message}`, { cause: err })
    throw err
  }
  return input
}

/**
 * The gate's pre-flight for a create, BEFORE its first write (lane note D2):
 * the release tip and a current-tip isolation pass for every module to enable
 * (customer-independent), and a written DPIA decision for each -- carried by
 * the request (`dpia`) or, on a resume, already recorded for the customer. A
 * decision for a module not being enabled is refused too.
 */
export async function preflightGate(
  enable: readonly string[],
  dpia: Readonly<Record<string, DpiaSpec>> | undefined,
  customerId: string | null,
  operatorId: string,
  gate: GatePort,
): Promise<void> {
  for (const key of Object.keys(dpia ?? {})) {
    if (!enable.includes(key)) throw new ProvisioningError('INVALID_INPUT', `a DPIA decision is given for ${key}, which is not in the enable list (${enable.join(', ') || 'none'})`)
  }
  if (!enable.length) return
  await gate.assertIsolationProven(enable, customerId)
  for (const m of enable) {
    const given = dpia?.[m]
    if (given) {
      assertDpiaSpec(m, given, operatorId)
      continue
    }
    if (customerId !== null && (await gate.hasDpiaDecision(customerId, m))) continue
    throw new EnableRefused(
      'NO_DPIA_DECISION',
      `module ${m} for ${customerId === null ? 'a customer not created yet' : `customer ${customerId}`}: the request carries no DPIA-applicability decision for it and none is recorded (TRD-161); nothing was written`,
      m,
      customerId,
      gate.releaseTipSha,
    )
  }
}

/**
 * Enables ONE module for a known customer through the real gate: the given
 * DPIA decision is recorded first (an identical latest one is reused, so a
 * resume does not mint another), then enableModule. Callers have run the
 * deny list, the loaded-version check and the pre-flight.
 */
export async function enableOne(c: CustomerRef, moduleId: string, opts: { operatorId: string; dpia?: DpiaSpec | undefined }, deps: Pick<ProvisioningDeps, 'gate' | 'modules'>): Promise<{ noop: boolean; database: string | null }> {
  if (opts.dpia) await deps.gate.recordDpia(c.id, moduleId, opts.dpia, opts.operatorId)
  return deps.modules.enable(c, moduleId, deps.gate.enableGate, opts.operatorId)
}

export interface EnableCustomerModuleResult {
  customer: CustomerRef
  moduleKey: string
  noop: boolean
  database: string | null
  /** Every module now enabled for the customer (the broker's list). */
  enabled: string[]
  reloaded: boolean
}

/**
 * Lane note D3: enable one module for an existing customer (active or still
 * provisioning) -- the deny list (board, vault: refused by name, before any
 * read of the gate), the catalogue version `init` loaded, the gate's
 * pre-flight, the DPIA decision recorded, enableModule through the gate, then
 * the customer's broker users for the enabled set.
 */
export async function enableCustomerModule(slug: string, moduleId: string, opts: { operatorId: string; dpia?: DpiaSpec }, deps: ProvisioningDeps): Promise<EnableCustomerModuleResult> {
  const s = assertCustomerSlug(slug)
  assertUuid(opts.operatorId, 'operator id')
  const [m] = assertEnableList([moduleId], deps.modules.catalogueIds())
  if (!m) throw new ProvisioningError('INVALID_INPUT', 'no module given')
  const missing = await deps.modules.unloaded([m])
  if (missing.length) throw new ProvisioningError('MODULE_NOT_LOADED', `module ${m} cannot be enabled: init loaded no plt.module_version for it (Q20); nothing was written`)
  const row = await deps.control.getBySlug(s)
  if (!row) throw new ProvisioningError('NOT_FOUND', `no customer ${s}`)
  if (row.status !== 'active' && row.status !== 'provisioning') throw new ProvisioningError('CUSTOMER_STATE', `customer ${s} is ${row.status}; a module is enabled only for an active (or provisioning) customer`)
  if (!row.host) throw new ProvisioningError('CUSTOMER_STATE', `customer ${s} has no primary host bound`)
  const c = refOf(row, row.host)
  await preflightGate([m], opts.dpia ? { [m]: opts.dpia } : undefined, c.id, opts.operatorId, deps.gate)
  const r = await enableOne(c, m, opts, deps)
  const enabled = (await deps.modules.enabled(c)).sort()
  const broker = await deps.broker.ensure(c, enabled)
  return { customer: c, moduleKey: m, noop: r.noop, database: r.database, enabled, reloaded: broker.reloaded }
}

export interface DisableCustomerModuleResult {
  customer: CustomerRef
  moduleKey: string
  noop: boolean
  dropped: boolean
  database: string | null
  export: { path: string; sha256: string; bytes: number } | null
  /** Every module still enabled for the customer (the broker's list). */
  enabled: string[]
  reloaded: boolean
}

/**
 * TRD-044: disable one module for an existing customer -- the catalogue id,
 * the customer (active or provisioning), disableModule (switch off, export and
 * verify, then drop), then the broker users for what is still enabled. Every
 * step is repeatable: a module already disabled is a no-op that still converges
 * the broker.
 */
export async function disableCustomerModule(slug: string, moduleId: string, opts: { operatorId: string }, deps: ProvisioningDeps): Promise<DisableCustomerModuleResult> {
  const s = assertCustomerSlug(slug)
  assertUuid(opts.operatorId, 'operator id')
  if (!deps.modules.catalogueIds().includes(moduleId)) throw new ProvisioningError('MODULE_UNKNOWN', `module ${moduleId} is not in the catalogue`)
  const row = await deps.control.getBySlug(s)
  if (!row) throw new ProvisioningError('NOT_FOUND', `no customer ${s}`)
  if (row.status !== 'active' && row.status !== 'provisioning') throw new ProvisioningError('CUSTOMER_STATE', `customer ${s} is ${row.status}; a module is disabled only for an active (or provisioning) customer`)
  if (!row.host) throw new ProvisioningError('CUSTOMER_STATE', `customer ${s} has no primary host bound`)
  const c = refOf(row, row.host)
  const r = await deps.modules.disable(c, moduleId, opts.operatorId)
  const enabled = (await deps.modules.enabled(c)).sort()
  const broker = await deps.broker.ensure(c, enabled)
  return { customer: c, moduleKey: moduleId, noop: r.noop, dropped: r.dropped, database: r.database, export: r.export, enabled, reloaded: broker.reloaded }
}

function refOf(row: ControlRow, host: string): CustomerRef {
  return { id: row.id, slug: row.slug, token: tokenFor(row.slug), realm: row.realm, host }
}

/**
 * The GatePort over gremion_platform: createEnableGate with the release tip
 * (GREMION_RELEASE_TIP, derived on the host from the authenticated release
 * tree; never a request field, lane note A6).
 */
export function pgGate(platform: Sql, opts: { releaseTipSha: string | null; allowFixtureEvidence?: boolean }): GatePort {
  const gateOpts = { platform, releaseTipSha: opts.releaseTipSha, ...(opts.allowFixtureEvidence ? { allowFixtureEvidence: true } : {}) }
  return {
    releaseTipSha: opts.releaseTipSha,
    enableGate: createEnableGate(gateOpts),
    assertIsolationProven: (moduleKeys, customerId) => assertIsolationProven(gateOpts, moduleKeys, customerId),
    async hasDpiaDecision(customerId, moduleKey) {
      assertUuid(customerId, 'customer id')
      const d = await latestDpiaDecision(platform, customerId, moduleKey)
      return d !== null && d.documentRef !== null
    },
    async recordDpia(customerId, moduleKey, decision, operatorId) {
      const input = { ...assertDpiaSpec(moduleKey, decision, operatorId), customerId }
      return recordDpiaDecision(platform, input, { reuseIdentical: true })
    },
    unproven: (customerId) => unprovenEnablements({ ...gateOpts, ...(customerId !== undefined ? { customerId } : {}) }),
  }
}
