// src/lib/server/files/provisioning/nextcloud-subsystem.ts
// Civitas Session-A inversion A1: the Nextcloud provisioning adapter now lives
// with the files MODULE (which owns the Nextcloud client), not in the governance
// kernel. The governance orchestrator consumes it through the runtime-registry
// provisioning-subsystem seam — it no longer imports files.
import type { KeycloakAdminClient } from '../../keycloak-admin'
import type { NextcloudClient } from '../nextcloud-client'
import type { OrgUnit } from '../../governance/org-units-db'
import type { ProvisioningSubsystem } from '../../governance/provisioning/types'

interface NextcloudDeps {
  nc: NextcloudClient
  /** Used to resolve a member's display name and email for the user_oidc account. */
  kc: Pick<KeycloakAdminClient, 'getUser'>
}

/** external_id encoding: "<folderId>:<groupId>". */
function encodeRef(folderId: number, groupId: string): string {
  return `${folderId}:${groupId}`
}
function decodeRef(externalId: string): { folderId: number; groupId: string } {
  const idx = externalId.indexOf(':')
  return { folderId: Number(externalId.slice(0, idx)), groupId: externalId.slice(idx + 1) }
}

/**
 * Nextcloud adapter — creates an NC group bound to a group folder (permission 31).
 *
 * Each member is pre-provisioned as a user_oidc account before being added to
 * the group: the OCS group-membership call 404s for a user that has no NC
 * account, and a member must not have to log into /cloud once before their
 * committee folder works. `providerId` is the numeric user_oidc provider id.
 */
export function createNextcloudSubsystem(deps: NextcloudDeps, providerId: number): ProvisioningSubsystem {
  const { nc, kc } = deps

  /** Create (or refresh) the member's Nextcloud account. Idempotent. */
  async function provisionMember(userKeycloakId: string): Promise<void> {
    const user = await kc.getUser(userKeycloakId)
    const fullName = `${user.firstName} ${user.lastName}`.trim()
    await nc.provisionOidcUser({
      providerId,
      userId: userKeycloakId,
      displayName: fullName || user.username,
      email: user.email
    })
  }

  return {
    name: 'nextcloud',

    async ensureResource(unit: OrgUnit, _ctx, existing: string | null) {
      if (existing) return { externalId: existing }
      const groupId = `ou-${unit.id}`
      await nc.createGroup(groupId)

      // Adopt an existing folder by mount-point to prevent orphan folders on
      // retry (e.g. folder was created but external_id was never persisted).
      const allFolders = await nc.listGroupFolders()
      const matches = allFolders.filter((f) => f.mountPoint === unit.name)
      let folderId: number
      if (matches.length > 1) {
        console.warn(
          `[nextcloud] unit "${unit.name}" matched ${matches.length} group folders (ids: ${matches.map((f) => f.id).join(', ')}); adopting lowest id`
        )
        folderId = Math.min(...matches.map((f) => f.id))
      } else if (matches.length === 1) {
        folderId = matches[0].id
      } else {
        const folder = await nc.createGroupFolder(unit.name)
        folderId = folder.id
      }

      await nc.assignGroupFolderPermissions(folderId, groupId, 31)
      return { externalId: encodeRef(folderId, groupId) }
    },

    async removeResource(externalId: string) {
      const { folderId, groupId } = decodeRef(externalId)
      await nc.deleteGroupFolder(folderId)
      await nc.deleteGroup(groupId)
    },

    async addMember(externalId: string, userKeycloakId: string) {
      await provisionMember(userKeycloakId)
      await nc.addUserToGroup(userKeycloakId, decodeRef(externalId).groupId)
    },

    async removeMember(externalId: string, userKeycloakId: string) {
      await nc.removeUserFromGroup(userKeycloakId, decodeRef(externalId).groupId)
    },

    async reconcileMembers(externalId: string, desiredUserIds: readonly string[]) {
      const { groupId } = decodeRef(externalId)
      for (const id of desiredUserIds) {
        await provisionMember(id)
        await nc.addUserToGroup(id, groupId)
      }
    }
  }
}
