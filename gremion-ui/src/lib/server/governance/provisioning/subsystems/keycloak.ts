// src/lib/server/governance/provisioning/subsystems/keycloak.ts
import type { KeycloakAdminClient } from '../../../keycloak-admin'
import type { OrgUnit } from '../../org-units-db'
import type { ProvisioningSubsystem, ProvisionContext } from '../types'

/** Keycloak adapter — the membership backbone. `external_id` is the KC group id. */
export function createKeycloakSubsystem(kc: KeycloakAdminClient): ProvisioningSubsystem {
  return {
    name: 'keycloak',

    async ensureResource(unit: OrgUnit, ctx: ProvisionContext, existing: string | null) {
      if (existing) {
        try {
          await kc.getGroup(existing)
          return { externalId: existing } // still exists — reuse
        } catch {
          // fall through and recreate
        }
      }
      const parentId = unit.parent_id ? requireParent(ctx) : null
      // Adopt an existing same-name group before creating. A prior seed's groups
      // survive an app-DB-only wipe, so a blind create would 409. Re-provisioning
      // must be idempotent against leftover Keycloak state.
      const siblings = parentId ? await kc.listSubGroups(parentId) : await kc.listGroups()
      const match = siblings.find((g) => g.name === unit.name)
      if (match) return { externalId: match.id }
      const groupId = parentId
        ? await kc.createSubgroup(parentId, unit.name)
        : await kc.createGroup(unit.name)
      return { externalId: groupId }
    },

    async removeResource(externalId: string) {
      await kc.deleteGroup(externalId)
    },

    async addMember(externalId: string, userKeycloakId: string) {
      await kc.addUserToGroup(userKeycloakId, externalId)
    },

    async removeMember(externalId: string, userKeycloakId: string) {
      await kc.removeUserFromGroup(userKeycloakId, externalId)
    },

    async reconcileMembers(externalId: string, desiredUserIds: readonly string[]) {
      const current = new Set((await kc.listGroupMembers(externalId)).map((m) => m.id))
      for (const id of desiredUserIds) {
        if (!current.has(id)) await kc.addUserToGroup(id, externalId)
      }
    }
  }
}

function requireParent(ctx: ProvisionContext): string {
  if (!ctx.parentKeycloakGroupId) {
    throw new Error('parent org-unit is not provisioned in Keycloak yet')
  }
  return ctx.parentKeycloakGroupId
}
