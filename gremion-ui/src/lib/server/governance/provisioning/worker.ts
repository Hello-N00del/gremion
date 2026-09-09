// src/lib/server/governance/provisioning/worker.ts
import cron from 'node-cron'
import { listDueOrgUnitIds, getResource } from './ledger'
import { listDueMemberOps, markMemberOpOk, markMemberOpFailed } from './member-ops'
import { provisionOrgUnit, defaultAdapters } from './orchestrator'
import { withUnitLock } from './mutex'
import { isMemberOf } from '../org-units-db'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import type { Adapters } from './types'

function isNotFound(err: unknown): boolean {
  const s = err as { status?: number; statusCode?: number; response?: { status?: number } }
  const code = s?.status ?? s?.statusCode ?? s?.response?.status
  if (code === 404) return true
  const msg = String((err as Error)?.message ?? '')
  // Infra/transport/misconfig failures must NEVER be classified as "already gone":
  // ENOTFOUND/EAI_AGAIN etc. contain "notfound"-ish substrings; KC's "Realm not found."
  // means misconfiguration, not a deleted membership.
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|realm/i.test(msg)) return false
  // \b prevents matching inside single-word codes like ENOTFOUND (reviewer-verified).
  return /\bnot[ _-]?found\b/i.test(msg) || /already (gone|absent)/i.test(msg)
}

/** Drain due membership-remove ops (P0.3a). Idempotent + 404-tolerant; the ONLY
 *  caller of markMemberOpOk. Per-unit lock serializes against inline removeMember
 *  and provisionOrgUnit (the worker's add-only reconcileMembers must never
 *  interleave with a drain for the same unit).
 *
 *  Gate is on external_id alone: a null row (cascade-deleted unit) or missing
 *  external_id (never provisioned) means nothing external exists → ok without call.
 *  A 'failed' row that still has an external_id retains a live external resource
 *  and MUST have removeMember attempted.
 *
 *  P2.1b T4: the cron tick wraps provisionDuePending per tenant via
 *  forEachActiveTenant — that covers this entrypoint; a standalone invocation
 *  must establish its own runWithTenant scope. */
export async function drainDueMemberOps(adapters: Adapters = defaultAdapters()): Promise<void> {
  for (const op of await listDueMemberOps()) {
    await withUnitLock(op.org_unit_id, async () => {
      try {
        // Supersession check: if the membership row for (unit, user) was re-inserted
        // after the remove-op was enqueued, a later legitimate re-add superseded this
        // remove intent. The enqueue tx hard-deleted the row, so existence here is proof
        // of a re-add. Mark ok without calling the adapter to avoid removing a live member.
        if (await isMemberOf(op.org_unit_id, op.user_keycloak_id)) {
          await markMemberOpOk(op.id)
          return
        }
        const res = await getResource(op.org_unit_id, op.subsystem)
        if (res?.external_id) await adapters[op.subsystem].removeMember(res.external_id, op.user_keycloak_id)
        await markMemberOpOk(op.id)
      } catch (err) {
        if (isNotFound(err)) { await markMemberOpOk(op.id); return }
        await markMemberOpFailed(op.id, err instanceof Error ? err.message : String(err))
      }
    })
  }
}

/**
 * Drain the provisioning queue once: reconcile every org-unit with a non-ok,
 * due resource. Safe to call directly from tests and admin tooling.
 */
export async function provisionDuePending(adapters: Adapters = defaultAdapters()): Promise<void> {
  for (const unitId of await listDueOrgUnitIds()) {
    try {
      await provisionOrgUnit(unitId, adapters)
    } catch (err) {
      console.error(`[provisioning-worker] ${unitId} failed:`, err)
    }
  }
  await drainDueMemberOps(adapters)
}

let _started = false

/** Start the once-a-minute reconcile sweep. Call once from hooks.server.ts. */
export function startProvisioningWorker(): void {
  if (_started) return
  _started = true
  // P2.1b T4: every tick iterates the ACTIVE tenant fleet — BOTH drivers (the
  // org-unit reconcile loop AND P0.3a's drainDueMemberOps) run inside each
  // tenant's explicit runWithTenant scope via provisionDuePending. The
  // per-(worker, tenant) single-flight in forEachActiveTenant replaces the old
  // process-global `_running` boolean: an overlapping tick skips only the
  // still-running tenant, and one tenant's failure never stops the rest
  // (per-tenant try/catch + structured log live in the helper). defaultAdapters()
  // is evaluated per tenant inside the ALS scope, so the KC-admin lookup
  // resolves THAT tenant's client.
  cron.schedule('* * * * *', () =>
    forEachActiveTenant('provisioning-worker', () => provisionDuePending()),
  )
}
