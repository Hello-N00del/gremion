// TRD-196 / PRD-OPS-005 — the messaging module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// Chat data lives in Synapse (own Postgres, not reachable from the kernel), so the
// hook goes through the module's existing Synapse admin client.
//
// Policy (retention catalogue 7.7 / section 9):
//   erased         the subject's Matrix account: deactivated with the erase flag
//                  (display name, avatar, third-party ids removed, no further
//                  login, events hidden from users who join a room later)
//   kept           message events in shared rooms: they are the other
//                  participants' conversation too; room lifecycle (RC-MSG-ROOM) is
//                  the room owner's, and archiving a room is not erasure (section 9)
//
// The Matrix localpart is the Keycloak username (Synapse jwt_config
// subject_claim), so the hook resolves it from the subject's Keycloak account.
// If that account no longer exists the Matrix id cannot be derived and the module
// reports `skipped` with that reason rather than guess.
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { getSynapseAdmin } from './synapse-admin'

export interface MessagingErasureDeps {
  /** The Matrix localpart of a Keycloak user id, or null when the account is gone. */
  resolveLocalpart(subjectId: string): Promise<string | null>
  synapse(): { eraseUser(localpart: string): Promise<boolean> }
}

export function createMessagingErasureHook(deps: MessagingErasureDeps): ModuleErasureHook {
  return {
    moduleId: 'messaging',
    requiresConnection: false,
    async erase({ subjectId }) {
      const localpart = await deps.resolveLocalpart(subjectId)
      if (localpart === null) {
        return {
          status: 'skipped',
          reason: 'the subject\'s Keycloak account no longer exists, so the Matrix localpart (= Keycloak username) cannot be derived',
        }
      }
      const erased = await deps.synapse().eraseUser(localpart)
      return { status: 'erased', counts: { matrix_accounts: erased ? 1 : 0 } }
    },
  }
}

export const messagingErasureHook = createMessagingErasureHook({
  async resolveLocalpart(subjectId) {
    try {
      const user = await getKeycloakAdminClientForCurrentTenant().getUser(subjectId)
      return user.username || null
    } catch (err) {
      // KeycloakAdminClient.getUser maps a 404 to exactly this message.
      if (err instanceof Error && err.message === 'User not found') return null
      throw err
    }
  },
  synapse: () => getSynapseAdmin(),
})
