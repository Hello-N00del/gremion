// Role lookup: who holds the realm roles that receive module notices.
//
// Interface I-1 for phase 2 of the module self-service work: the info mail on a
// module switch and its reminders go to the council admins and the Vorstand,
// one mail per person. Keycloak is the source of truth for realm roles, so the
// lookup asks Keycloak and never a local table.
import {
  getKeycloakAdminClient,
  type KeycloakAdminClient,
  type KcUser
} from '$lib/server/keycloak-admin'
import type { TenantContext } from '$lib/server/tenant/context'

/** Recipients of module info mail and reminders. */
export const NOTIFY_ROLES = ['council-admin', 'vorstand'] as const

export interface RoleHolder {
  userId: string
  /** Lower-cased and trimmed; never empty. */
  email: string
  displayName: string
  /** Every requested role this person holds, in the order the roles were asked for. */
  roles: readonly string[]
}

export interface RoleHolders {
  holders: RoleHolder[]
  /** People who hold a role but cannot be mailed; the caller reports them, never drops them silently. */
  skipped: { userId: string; reason: 'disabled' | 'no-email' }[]
}

function displayNameOf(u: KcUser): string {
  const full = [u.firstName, u.lastName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ')
  return full || (u.username ?? '').trim() || u.id
}

/**
 * The people holding any of `roles`, de-duplicated by Keycloak user id.
 *
 * Disabled users and users without a usable e-mail go to `skipped`, never to
 * `holders`. A Keycloak failure on ANY role THROWS: a mail run over a partial
 * list would silently leave some admins uninformed.
 */
export async function listRoleHolders(
  tenant: TenantContext,
  roles: readonly string[] = NOTIFY_ROLES,
  kc: Pick<KeycloakAdminClient, 'listRealmRoleMembers'> = getKeycloakAdminClient(tenant)
): Promise<RoleHolders> {
  const perRole = await Promise.all(roles.map(async (role) => ({ role, members: await kc.listRealmRoleMembers(role) })))

  const heldRoles = new Map<string, string[]>()
  const firstSeen = new Map<string, KcUser>()
  for (const { role, members } of perRole) {
    for (const u of members) {
      if (!firstSeen.has(u.id)) firstSeen.set(u.id, u)
      const list = heldRoles.get(u.id) ?? []
      if (!list.includes(role)) list.push(role)
      heldRoles.set(u.id, list)
    }
  }

  const holders: RoleHolder[] = []
  const skipped: RoleHolders['skipped'] = []
  for (const [userId, u] of firstSeen) {
    if (u.enabled === false) {
      skipped.push({ userId, reason: 'disabled' })
      continue
    }
    const email = (u.email ?? '').trim().toLowerCase()
    if (email === '') {
      skipped.push({ userId, reason: 'no-email' })
      continue
    }
    holders.push({ userId, email, displayName: displayNameOf(u), roles: heldRoles.get(userId) ?? [] })
  }
  return { holders, skipped }
}
