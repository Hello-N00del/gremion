// src/lib/server/messages/provisioning/matrix-subsystem.ts
// Civitas Session-A inversion A1: the Matrix provisioning adapter now lives with
// the messages MODULE (which owns the Matrix/Synapse clients), not in the
// governance kernel. The governance orchestrator consumes it through the
// runtime-registry provisioning-subsystem seam — it no longer imports messages.
import type { KeycloakAdminClient } from '../../keycloak-admin'
import type { OrgUnit } from '../../governance/org-units-db'
import type { ProvisioningSubsystem } from '../../governance/provisioning/types'

interface MatrixDeps {
  matrix: {
    createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string>
    getRoomIdByAlias(alias: string): Promise<string | null>
  }
  synapse: {
    createUser(localpart: string, displayName: string): Promise<void>
    forceJoinRoom(roomId: string, userId: string): Promise<void>
    kickFromRoom(roomId: string, userId: string, reason?: string): Promise<void>
    deleteRoom(roomId: string): Promise<void>
  }
  kc: Pick<KeycloakAdminClient, 'getUser'>
}

interface MatrixUserInfo {
  localpart: string
  displayName: string
  matrixId: string
}

/**
 * Derive the deterministic Matrix room-alias localpart for an org-unit.
 *
 * Keyed off the org-unit NAME, not the id: blueprint names are fixed, but the
 * org_unit UUID is regenerated whenever Postgres is wiped. Keying off the name
 * makes the alias STABLE ACROSS RESEEDS, so a reseed adopts the room a prior
 * seed created instead of minting a duplicate (the bug this fixes).
 *
 * The slug is lowercased, German umlauts/ß are transliterated (ä→ae, ö→oe,
 * ü→ue, ß→ss), any other non-[a-z0-9] run collapses to a single '-', and
 * leading/trailing '-' are trimmed. A `stura-` prefix namespaces the alias to
 * avoid collisions with unrelated rooms.
 */
export function aliasLocalpart(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip any remaining diacritics (é→e)
    .replace(/[^a-z0-9]+/g, '-') // any non-alphanumeric run → single '-'
    .replace(/^-+|-+$/g, '') // trim leading/trailing '-'
  return `stura-${slug}`
}

/**
 * Matrix adapter. `external_id` is the room id.
 * Matrix localpart = Keycloak username (Synapse jwt_config.subject_claim).
 */
export function createMatrixSubsystem(deps: MatrixDeps, serverName: string): ProvisioningSubsystem {
  async function resolveUser(userKeycloakId: string): Promise<MatrixUserInfo> {
    const user = await deps.kc.getUser(userKeycloakId)
    const localpart = user.username
    const displayName =
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : localpart
    return { localpart, displayName, matrixId: `@${localpart}:${serverName}` }
  }

  return {
    name: 'matrix',

    async ensureResource(unit: OrgUnit, _ctx, existing: string | null) {
      if (existing) return { externalId: existing } // ledger hit — reuse
      // The alias is derived once and used for BOTH the lookup and the create so
      // the adopted/created room are guaranteed to share the same canonical alias.
      const localpart = aliasLocalpart(unit.name)
      const alias = `#${localpart}:${serverName}`
      // Adopt a room a prior seed created before minting. A Postgres-only wipe
      // empties the ledger but leaves the Synapse room reachable by its alias;
      // adopting it instead of creating a new one is the cross-reseed dedupe.
      const adopted = await deps.matrix.getRoomIdByAlias(alias)
      if (adopted) return { externalId: adopted }
      const roomId = await deps.matrix.createRoom(unit.name, `Gruppenraum für ${unit.name}`, localpart)
      return { externalId: roomId }
    },

    async removeResource(externalId: string) {
      await deps.synapse.deleteRoom(externalId)
    },

    async addMember(externalId: string, userKeycloakId: string) {
      const { localpart, displayName, matrixId } = await resolveUser(userKeycloakId)
      await deps.synapse.createUser(localpart, displayName)
      await deps.synapse.forceJoinRoom(externalId, matrixId)
    },

    async removeMember(externalId: string, userKeycloakId: string) {
      const { matrixId } = await resolveUser(userKeycloakId)
      try {
        await deps.synapse.kickFromRoom(externalId, matrixId, 'Aus Gremium entfernt')
      } catch (err) {
        // Idempotent: Synapse errors if the user is not in the room. Honor the
        // types.ts:41 contract ("no-op if already absent") — mirror forceJoinRoom's
        // "already in the room" swallow in synapse-admin.ts.
        const status = (err as { status?: number })?.status
        if (status === 404 || (err instanceof Error && /not in the room|not a member/i.test(err.message))) return
        throw err
      }
    },

    async reconcileMembers(externalId: string, desiredUserIds: readonly string[]) {
      for (const id of desiredUserIds) {
        const { localpart, displayName, matrixId } = await resolveUser(id)
        await deps.synapse.createUser(localpart, displayName)
        await deps.synapse.forceJoinRoom(externalId, matrixId)
      }
    }
  }
}
