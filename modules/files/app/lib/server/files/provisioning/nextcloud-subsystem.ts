// src/lib/server/files/provisioning/nextcloud-subsystem.ts
// Civitas Session-A inversion A1: the Nextcloud provisioning adapter now lives
// with the files MODULE (which owns the Nextcloud client), not in the governance
// kernel. The governance orchestrator consumes it through the runtime-registry
// provisioning-subsystem seam — it no longer imports files.
import type { KeycloakAdminClient } from '../../keycloak-admin'
import type { NextcloudClient } from '../nextcloud-client'
import type { OrgUnit } from '../../governance/org-units-db'
import type { ProvisioningSubsystem } from '../../governance/provisioning/types'
import { unitGroupId, unitMountPoint } from '../namespace'

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
 * Nextcloud adapter — creates an NC group bound to a group folder (permission 31). The folder's mount
 * point and the group's id carry the customer's namespace key (../namespace.ts); the ledger's external
 * id "<folderId>:<groupId>" is what every later call goes by.
 *
 * Each member is pre-provisioned as a user_oidc account before being added to
 * the group: the OCS group-membership call 404s for a user that has no NC
 * account, and a member must not have to log into /cloud once before their
 * committee folder works. `providerId` is the numeric user_oidc provider id.
 */
export function createNextcloudSubsystem(
  deps: NextcloudDeps,
  providerId: number,
  /** `key`: the customer's namespace key (namespace.ts tenantKey), carried by every mount point and group id made
   *  here. A function is read when a folder is made, inside the customer's scope (the factory itself may be built
   *  outside one). */
  ns: { key: string | (() => string) },
): ProvisioningSubsystem {
  const { nc, kc } = deps
  const keyOf = (): string => (typeof ns.key === 'function' ? ns.key() : ns.key)

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

    async ensureResource(unit: OrgUnit, ctx, existing: string | null) {
      // What a folder made TODAY is called: the plain unit name plus this customer's key, in a group that
      // carries the key too. The Nextcloud is shared, so neither a mount point nor a group id may mean the
      // same thing in two customers.
      const key = keyOf()
      const mountPoint = unitMountPoint(key, unit.name)
      const groupId = unitGroupId(key, unit.id)

      // A recorded id is either a finished folder whose member sync failed, or the folder an earlier
      // attempt made and could not grant. Check it against Nextcloud and finish what is missing; it is
      // never taken on trust, because a returned id is marked ok and nobody would grant it after that.
      // The folder is found by the id the ledger holds and the group is the RECORDED one: a folder made
      // before the namespace existed keeps its plain group until the operator script moves it, and a
      // provisioning pass must never make a second, empty folder beside it.
      if (existing) {
        const recorded = decodeRef(existing)
        const folders = await nc.listGroupFolders()
        const folder = folders.find((f) => f.id === recorded.folderId)
        if (folder?.groups.includes(recorded.groupId)) {
          // The group is on the folder, but an earlier grant may have stopped between adding it and setting
          // its permissions. Finish that only when Nextcloud reports no bits at all: any other value is
          // what the unit's folder has been set to since, and is left as it is.
          if (folder.groupPermissions?.[recorded.groupId] === 0) await nc.setGroupFolderPermissions(folder.id, recorded.groupId, 31)
          return { externalId: existing }
        }
        if (folder && (folder.mountPoint === mountPoint || folder.mountPoint === unit.name) && folder.groups.length === 0) {
          // made by an earlier attempt that stopped before the grant: it bears this unit's name (with the
          // key, or plain when it was made before the namespace) and no group holds it
          await nc.createGroup(recorded.groupId)
          await nc.assignGroupFolderPermissions(folder.id, recorded.groupId, 31)
          return { externalId: encodeRef(folder.id, recorded.groupId) }
        }
        // The recorded folder is gone, belongs to another name, or carries only other groups (so it is not
        // this unit's): fall through and make a folder of its own.
      }

      await nc.createGroup(groupId)

      // Adopt an existing folder to prevent orphan folders on retry (e.g. folder
      // was created but external_id was never persisted). The folder list spans
      // the whole Nextcloud, shared by every customer on it, so a name alone is no
      // proof of ownership: adopt only a folder with THIS customer's mount point
      // that already carries THIS unit's group. Anything else (another customer's
      // folder, a folder nobody was granted on) is not ours.
      const allFolders = await nc.listGroupFolders()
      const matches = allFolders.filter((f) => f.mountPoint === mountPoint && f.groups.includes(groupId))
      let folderId: number
      if (matches.length > 1) {
        console.warn(
          `[nextcloud] unit "${unit.name}" matched ${matches.length} group folders (ids: ${matches.map((f) => f.id).join(', ')}); adopting lowest id`
        )
        folderId = Math.min(...matches.map((f) => f.id))
      } else if (matches.length === 1) {
        folderId = matches[0].id
      } else {
        const folder = await nc.createGroupFolder(mountPoint)
        folderId = folder.id
        // Record the new folder before it is granted: if the grant fails, the retry finds this folder
        // by its id and grants it instead of making another one of the same name.
        if (ctx.recordExternalId) {
          try {
            await ctx.recordExternalId(encodeRef(folderId, groupId))
          } catch (err) {
            // the id is not kept, so nothing would ever find this folder again: take it away
            await nc.deleteGroupFolder(folderId).catch(() => undefined)
            throw err
          }
        }
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
