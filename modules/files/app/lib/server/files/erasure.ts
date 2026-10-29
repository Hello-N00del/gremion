// TRD-196 / PRD-OPS-005 — the files module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// The files module has no database of its own (RC-FIL-BIND / RC-FIL-COPY are
// module-level records, not personal data of a person). What it fronts is
// Nextcloud: the subject's account (the Nextcloud user id IS the Keycloak id,
// see nextcloud-subsystem.provisionMember) with its personal files, shares and
// per-user app state.
//
// Policy:
//   deleted  the subject's Nextcloud account (OCS DELETE users/<id>) via the
//            module's existing admin client. Nextcloud removes the account's
//            personal files and its group memberships (apps cleaning their own
//            per-user rows on that event is Nextcloud's behaviour, not verified here).
//   kept     the council's group-folder content (shared files are not owned by
//            the account; their lifecycle is the file store operator's, see the
//            retention catalogue 7.6)
//
// Idempotent: an account that is already gone is `erased` with a zero count.
// Without a configured admin credential the module cannot reach Nextcloud and
// reports `skipped` instead of claiming an erasure.
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import { serviceEnv } from '$lib/server/env/service-env'
import { createNextcloudClient } from './nextcloud-client'

export interface FilesErasureDeps {
  nc(): { deleteUser(userId: string): Promise<boolean> }
  /** False when the Nextcloud admin credential is not configured. */
  adminConfigured?(): boolean
}

export function createFilesErasureHook(deps: FilesErasureDeps): ModuleErasureHook {
  return {
    moduleId: 'files',
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
          reason: 'Nextcloud admin credential (NEXTCLOUD_ADMIN_PASSWORD) is not configured; the account cannot be reached',
        }
      }
      const deleted = await deps.nc().deleteUser(subjectId)
      return { status: 'erased', counts: { nextcloud_accounts: deleted ? 1 : 0 } }
    },
  }
}

export const filesErasureHook = createFilesErasureHook({
  nc: () => createNextcloudClient(),
  adminConfigured: () => (serviceEnv('NEXTCLOUD_ADMIN_PASSWORD') ?? '') !== '',
})
