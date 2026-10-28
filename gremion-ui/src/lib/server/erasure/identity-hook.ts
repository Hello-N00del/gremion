// TRD-196 — the explicit `identity` step of an erasure report: the subject's
// EXTERNAL identities (Keycloak/Matrix/Nextcloud group memberships and the
// Keycloak account). The kernel step only queues the group removals (durable
// provisioning_member_ops, drained by the reconcile worker); this step reports
// what is still outstanding and is NEVER `erased` while anything is:
//
//   1. it first runs the existing drain synchronously when one is injected
//      (service.ts wires the reconcile worker's drainDueMemberOps), so ops that
//      can be settled now are settled now; a throwing drain leaves them queued;
//   2. it then counts the subject's remove-ops that are not `ok`;
//   3. Keycloak ACCOUNT deletion is not performed by the erasure seam at all
//      (no kernel primitive does it today), so the step stays `skipped` with a
//      reason even at zero pending ops. That keeps the overall report honest:
//      `incomplete` until an operator has removed the account (named residual).
//
// The reason text carries counts only, never the subject id.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'

export const IDENTITY_MODULE_ID = 'identity'

export interface IdentityErasureOptions {
  /** Synchronously drain due remove-ops (best effort). */
  drain?: () => Promise<void>
}

export function createIdentityErasureHook(opts: IdentityErasureOptions = {}): ModuleErasureHook<Sql> {
  return {
    moduleId: IDENTITY_MODULE_ID,
    async erase({ db, subjectId }) {
      if (db === null) return { status: 'skipped', reason: 'no database connection' }
      let drainNote = ''
      if (opts.drain) {
        try {
          await opts.drain()
        } catch {
          drainNote = '; synchronous drain failed, the reconcile worker retries'
        }
      }
      const [{ n }] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM provisioning_member_ops
        WHERE user_keycloak_id = ${subjectId} AND status <> 'ok'`
      return {
        status: 'skipped',
        reason:
          `external identity removal pending: ${n} ops queued${drainNote}; ` +
          'Keycloak account deletion is not performed by the erasure seam (operator step)',
      }
    },
  }
}
