// TRD-196 / PRD-OPS-005 — the votes module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// The votes module owns no database table. What it fronts:
//   - quick polls in Nextcloud Polls: every vote, comment and share is attributed
//     to the voter's Nextcloud account (account id = Keycloak id, user_oidc
//     --unique-uid=0). Polls removes its per-account rows when Nextcloud deletes
//     the account (Nextcloud's user-deleted event; that behaviour is Nextcloud's
//     and is not verified here).
//   - Helios ballots: the elections module's concern (see elections/erasure.ts).
//     Ballots are anonymous by Helios design and the tally is the election record.
//
// Policy:
//   deleted  the subject's Nextcloud account, through the same admin credential
//            the polls client already uses (NEXTCLOUD_ADMIN_*). Idempotent: an
//            account already gone is `erased` with a zero count.
//   kept     poll definitions and tallies owned by other people; Helios tallies
//
// The Nextcloud account also carries the subject's personal files; the files
// module's hook deletes the same account, so the two are order-independent.
// Without an admin credential the module cannot reach Nextcloud and reports
// `skipped` rather than claim an erasure.
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import { serviceEnv } from '$lib/server/env/service-env'

export interface NextcloudAdminConfig {
  readonly baseUrl: string
  readonly adminUser: string
  readonly adminPassword: string
}

/** Delete one Nextcloud account via the OCS provisioning API. true = deleted,
 *  false = there was no such account (OCS v2: 404). Never deletes the admin. */
export async function deleteNextcloudAccount(userId: string, cfg: NextcloudAdminConfig): Promise<boolean> {
  if (userId.trim() === '') throw new Error('deleteNextcloudAccount: empty user id')
  if (userId === cfg.adminUser) throw new Error('deleteNextcloudAccount: refusing to delete the Nextcloud admin account')
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/ocs/v2.php/cloud/users/${encodeURIComponent(userId)}?format=json`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.adminUser}:${cfg.adminPassword}`).toString('base64')}`,
      'OCS-APIRequest': 'true',
      Accept: 'application/json',
    },
  })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Nextcloud DELETE cloud/users → ${res.status}`)
  return true
}

export interface VotesErasureDeps {
  deleteAccount(userId: string): Promise<boolean>
  /** False when the Nextcloud admin credential is not configured. */
  adminConfigured?(): boolean
}

export function createVotesErasureHook(deps: VotesErasureDeps): ModuleErasureHook {
  return {
    moduleId: 'votes',
    requiresConnection: false,
    async erase({ subjectId, subject }) {
      // R33f HIGH: the Nextcloud behind this hook serves EVERY tenant and its account ids are
      // the Keycloak ids of every realm. Act only on an id the orchestrator verified for this tenant.
      if (!subject || subject.id !== subjectId) {
        return { status: 'skipped', reason: 'the subject was not verified as a user of this tenant; the shared Nextcloud was not called' }
      }
      // A null username means the realm no longer holds the account: the id was accepted on tenant
      // database evidence alone, which an IT admin can plant for a foreign id (committee members
      // accept any id). That proves nothing about who owns the Nextcloud account, so do not act.
      if (subject.username === null) {
        return {
          status: 'skipped',
          reason:
            'the realm of this tenant no longer holds the account, so its ownership of the shared Nextcloud account cannot be verified; the shared Nextcloud was not called',
        }
      }
      if (deps.adminConfigured && !deps.adminConfigured()) {
        return {
          status: 'skipped',
          reason: 'Nextcloud admin credential (NEXTCLOUD_ADMIN_PASSWORD) is not configured; poll data cannot be reached',
        }
      }
      const deleted = await deps.deleteAccount(subjectId)
      return { status: 'erased', counts: { nextcloud_accounts: deleted ? 1 : 0 } }
    },
  }
}

export const votesErasureHook = createVotesErasureHook({
  deleteAccount: (userId) =>
    deleteNextcloudAccount(userId, {
      baseUrl: serviceEnv('NEXTCLOUD_URL') ?? 'http://nextcloud',
      adminUser: serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin',
      adminPassword: serviceEnv('NEXTCLOUD_ADMIN_PASSWORD') ?? '',
    }),
  adminConfigured: () => (serviceEnv('NEXTCLOUD_ADMIN_PASSWORD') ?? '') !== '',
})
