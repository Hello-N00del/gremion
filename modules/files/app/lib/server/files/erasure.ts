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
    async erase({ subjectId }) {
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
