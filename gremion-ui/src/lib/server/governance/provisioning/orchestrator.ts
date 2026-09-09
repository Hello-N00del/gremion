// src/lib/server/governance/provisioning/orchestrator.ts
import { getDb } from '../../db'
import { getKeycloakAdminClientForCurrentTenant } from '../../keycloak-admin'
import { buildModuleProvisioningSubsystems } from '$lib/server/modules/runtime-registry'
import {
  getOrgUnit, listOrgUnitMembers,
  addOrgUnitMember, removeOrgUnitMember, getOrgUnitIdsForUser
} from '../org-units-db'
import type { MembershipType, OrgUnit } from '../org-units-db'
import {
  ensureResourceRow, getResource, getResources, markResourceOk, markResourceFailed
} from './ledger'
import type { ProvisioningResource } from './ledger'
import { enqueueMemberRemoveOps } from './member-ops'
import { withUnitLock } from './mutex'
import { createKeycloakSubsystem } from './subsystems/keycloak'
import type { Adapters, ProvisionContext, ProvisioningReport, SubsystemResult, Subsystem } from './types'

const OPTIONAL: Subsystem[] = ['matrix', 'nextcloud']

/** Keycloak always; matrix/nextcloud per wants_* flags. Single source for the inline provision
 *  loop AND the create-side atomic enqueue. */
export function wantedSubsystems(
  unit: Pick<OrgUnit, 'wants_matrix_room' | 'wants_nextcloud_folder'>
): Subsystem[] {
  const subs: Subsystem[] = ['keycloak']
  if (unit.wants_matrix_room) subs.push('matrix')
  if (unit.wants_nextcloud_folder) subs.push('nextcloud')
  return subs
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Build the real adapter registry from the app's service clients. */
export function defaultAdapters(): Adapters {
  // P2.1b T4: defaultAdapters() runs from the out-of-request provisioning
  // worker, whose tick IS wrapped in an explicit per-tenant scope by
  // worker-fleet.ts (forEachActiveTenant → runWithTenant) — so the fail-closed
  // KC admin lookup below resolves the ticking tenant's context.
  // (Request-scoped seed callers already have ALS from the resolution seam.)
  const kc = getKeycloakAdminClientForCurrentTenant()
  // Session-A inversion A1: the keycloak subsystem is the kernel/core
  // provisioning backbone (always present) and stays a direct construction. The
  // matrix + nextcloud subsystems are MODULE-owned — the messages/files modules
  // registered their factories via the runtime-registry, so the orchestrator
  // builds them through that seam instead of importing the modules' client and
  // subsystem code. The generated server-init barrel (imported by hooks.server.ts
  // at boot) runs those registrations.
  return {
    keycloak: createKeycloakSubsystem(kc),
    ...buildModuleProvisioningSubsystems(kc),
  } as Adapters
}

function buildReport(orgUnitId: string, results: SubsystemResult[]): ProvisioningReport {
  const kc = results.find((r) => r.subsystem === 'keycloak')
  const overall: ProvisioningReport['overall'] = kc?.status === 'failed'
    ? 'failed'
    : results.some((r) => r.status === 'failed') ? 'degraded' : 'ok'
  return { orgUnitId, overall, subsystems: results }
}

/** Reconcile one subsystem's resource. Records the outcome in the ledger. */
async function ensureOne(
  unitId: string, subsystem: Subsystem, adapters: Adapters, ctx: ProvisionContext
): Promise<SubsystemResult> {
  await ensureResourceRow(unitId, subsystem)
  const existing = await getResource(unitId, subsystem)
  if (existing?.status === 'ok' && existing.external_id) {
    return { subsystem, status: 'ok', willRetry: false }
  }
  const unit = (await getOrgUnit(unitId))!
  try {
    const { externalId } = await adapters[subsystem].ensureResource(
      unit, ctx, existing?.external_id ?? null
    )
    await markResourceOk(unitId, subsystem, externalId)
    return { subsystem, status: 'ok', willRetry: false }
  } catch (err) {
    const msg = errMsg(err)
    await markResourceFailed(unitId, subsystem, msg)
    return { subsystem, status: 'failed', error: msg, willRetry: true }
  }
}

/**
 * Idempotent reconcile of one org-unit across all desired subsystems.
 * Keycloak first (it is the backbone and the parent dependency); Matrix and
 * Nextcloud independently. Every failure is recorded in the ledger AND returned.
 * Wrapped by the per-unit mutex so concurrent callers serialize.
 */
export async function provisionOrgUnit(
  unitId: string, adapters: Adapters = defaultAdapters()
): Promise<ProvisioningReport> {
  return withUnitLock(unitId, () => provisionOrgUnitLocked(unitId, adapters))
}

async function provisionOrgUnitLocked(
  unitId: string, adapters: Adapters
): Promise<ProvisioningReport> {
  const unit = await getOrgUnit(unitId)
  if (!unit) throw new Error(`org_unit not found: ${unitId}`)

  // Resolve the parent's Keycloak group id for subgroup creation.
  let parentKeycloakGroupId: string | null = null
  if (unit.parent_id) {
    const parentKc = await getResource(unit.parent_id, 'keycloak')
    parentKeycloakGroupId = parentKc?.status === 'ok' ? parentKc.external_id : null
  }
  const ctx: ProvisionContext = { parentKeycloakGroupId }

  const results: SubsystemResult[] = []
  results.push(await ensureOne(unitId, 'keycloak', adapters, ctx))

  for (const sub of OPTIONAL) {
    const wanted = wantedSubsystems(unit).includes(sub)
    if (!wanted) {
      results.push({ subsystem: sub, status: 'skipped', willRetry: false })
      continue
    }
    results.push(await ensureOne(unitId, sub, adapters, ctx))
  }

  // Member fan-out for every resource that is now ok.
  const memberIds = (await listOrgUnitMembers(unitId)).map((m) => m.user_keycloak_id)
  for (const r of results) {
    if (r.status !== 'ok') continue
    const res = await getResource(unitId, r.subsystem)
    if (!res?.external_id) continue
    try {
      await adapters[r.subsystem].reconcileMembers(res.external_id, memberIds)
    } catch (err) {
      const msg = errMsg(err)
      await markResourceFailed(unitId, r.subsystem, `member sync: ${msg}`)
      r.status = 'failed'
      r.error = msg
      r.willRetry = true
    }
  }

  return buildReport(unitId, results)
}

/** Children first; Keycloak is the parent identity (Matrix/NC group-membership
 *  semantics hang off it), so it must be removed LAST. */
const TEARDOWN_ORDER: Subsystem[] = ['nextcloud', 'matrix', 'keycloak']

/** Tear down every provisioned resource for an org-unit. */
export async function deprovisionOrgUnit(
  unitId: string, adapters: Adapters = defaultAdapters()
): Promise<ProvisioningReport> {
  const resources = await getResources(unitId)
  const bySubsystem = new Map(resources.map((r) => [r.subsystem, r]))
  const results: SubsystemResult[] = []
  for (const subsystem of TEARDOWN_ORDER) {
    const r = bySubsystem.get(subsystem)
    if (!r) continue
    if (!r.external_id) {
      results.push({ subsystem: r.subsystem, status: 'ok', willRetry: false })
      continue
    }
    try {
      await adapters[r.subsystem].removeResource(r.external_id)
      results.push({ subsystem: r.subsystem, status: 'ok', willRetry: false })
    } catch (err) {
      results.push({ subsystem: r.subsystem, status: 'failed', error: errMsg(err), willRetry: false })
    }
  }
  return buildReport(unitId, results)
}

/** Apply one membership operation across every ok resource of an org-unit. */
async function fanOut(
  unitId: string, userId: string, op: 'add' | 'remove', adapters: Adapters
): Promise<SubsystemResult[]> {
  // Hoist the infra read out of the loop expression so a DB blip cannot escape the
  // function entirely.  On failure the persisted intent (membership row / member-op)
  // keeps the unit due → the worker re-drives reconcileMembers and converges.
  let resources: readonly ProvisioningResource[] = []
  try {
    resources = await getResources(unitId)
  } catch (err) {
    console.error(`[provisioning] fanOut: failed to read resources for ${unitId}:`, err)
    // Best-effort: mark the unit's keycloak resource failed so it becomes due and the
    // worker re-drives reconcileMembers. Swallowed — the return [] below is the contract.
    try { await markResourceFailed(unitId, 'keycloak', `fanOut: resource read failed: ${String(err)}`) } catch { /* best-effort: leaves the unit due */ }
    return [] // a read failure must not escape: the persisted intent (membership row / member-op)
              // stays, and the unit's non-ok resource keeps it due → worker re-drives.
  }
  const results: SubsystemResult[] = []
  for (const r of resources) {
    if (r.status !== 'ok' || !r.external_id) continue
    try {
      if (op === 'add') await adapters[r.subsystem].addMember(r.external_id, userId)
      else await adapters[r.subsystem].removeMember(r.external_id, userId)
      results.push({ subsystem: r.subsystem, status: 'ok', willRetry: false })
    } catch (err) {
      const msg = errMsg(err)
      await markResourceFailed(unitId, r.subsystem, `member ${op}: ${msg}`)
      results.push({ subsystem: r.subsystem, status: 'failed', error: msg, willRetry: true })
    }
  }
  return results
}

/** Add a member to an org-unit and fan the change out to all subsystems. */
export async function addMember(
  unitId: string, userId: string, membershipType: MembershipType,
  termStart: string | null, termEnd: string | null,
  adapters: Adapters = defaultAdapters()
): Promise<ProvisioningReport> {
  await addOrgUnitMember({ orgUnitId: unitId, userKeycloakId: userId, membershipType, termStart, termEnd })
  return buildReport(unitId, await fanOut(unitId, userId, 'add', adapters))
}

/** Remove a member from an org-unit and fan the change out to all subsystems.
 *  Enqueues a durable remove-op AND hard-deletes the membership in ONE tx before
 *  the fan-out, so an adapter throw can never silently strand the external membership
 *  (fix for #185). The worker drains pending ops idempotently (Task 8).
 *
 *  The unit lock serializes this call against the reconcile worker's add-only
 *  reconcileMembers, closing the gather-vs-worker-flip window where the worker
 *  could re-join a user that was just removed (inverse race).
 *
 *  The returned report reflects the IMMEDIATE propagation outcome: failed/degraded
 *  subsystems mean the durable member-ops outbox will converge them via the worker.
 *  The audit entry written by the caller (members/[userId] DELETE) records this
 *  truthful outcome rather than a constant 'ok'. */
export async function removeMember(
  unitId: string, userId: string, adapters: Adapters = defaultAdapters()
): Promise<ProvisioningReport> {
  return withUnitLock(unitId, async () => {
    // any status: a transiently-failed row still holds a live external resource (the drain is 404-tolerant for the rest)
    const subs = (await getResources(unitId))
      .filter((r) => r.external_id != null)
      .map((r) => r.subsystem)
    await getDb().begin(async (tx) => {
      await enqueueMemberRemoveOps(tx, unitId, userId, subs)
      await removeOrgUnitMember(tx, unitId, userId)
    })
    // fanOut catches per-adapter throws internally (willRetry entries); the outer
    // .catch only guards infra failures — no throw-on-failure is reintroduced.
    const results = await fanOut(unitId, userId, 'remove', adapters).catch(() => [] as SubsystemResult[])
    return buildReport(unitId, results)
  })
}

/**
 * GDPR right-to-erasure primitive: remove a user from every org-unit's
 * subsystems and delete their membership and role-assignment rows.
 * Enqueues durable remove-ops, hard-deletes all memberships, and pseudonymizes
 * role-assignment history in ONE atomic tx before the fan-out (GDPR-atomic, #185).
 */
export async function removeUserEverywhere(
  userId: string, adapters: Adapters = defaultAdapters()
): Promise<void> {
  const unitIds = await getOrgUnitIdsForUser(userId)
  const subsByUnit = new Map<string, Subsystem[]>()
  for (const unitId of unitIds) {
    subsByUnit.set(
      unitId,
      // any status: a transiently-failed row still holds a live external resource (the drain is 404-tolerant for the rest)
      (await getResources(unitId)).filter((r) => r.external_id != null).map((r) => r.subsystem)
    )
  }
  await getDb().begin(async (tx) => {
    for (const unitId of unitIds) {
      await enqueueMemberRemoveOps(tx, unitId, userId, subsByUnit.get(unitId) ?? [])
      await removeOrgUnitMember(tx, unitId, userId)
    }
    await tx`DELETE FROM role_assignments WHERE user_keycloak_id = ${userId}`
    // History rows are kept as a governance record (who held which office and when)
    // but pseudonymized — the identifier is blanked so the erased person cannot be
    // re-identified from archived role data (GDPR Art. 17).
    await tx`UPDATE role_assignment_history SET user_keycloak_id = NULL WHERE user_keycloak_id = ${userId}`
  })
  for (const unitId of unitIds) {
    await fanOut(unitId, userId, 'remove', adapters).catch(() => undefined)
  }
}
