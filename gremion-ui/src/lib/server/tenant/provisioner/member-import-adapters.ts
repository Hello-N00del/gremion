// src/lib/server/tenant/provisioner/member-import-adapters.ts
// TASK-031: gremion-ui's implementations of @gremion/member-import's ports
// (the library is SvelteKit-free; this file may use $lib). Runs in the
// tenant-create one-shot, never in the app process.
//
//   * accounts: Keycloak through KcProvisionApi.ensureInvitedUser. D-5 (operator
//     2026-10-22): an imported member's required action is UPDATE_PASSWORD ONLY;
//     the TOTP is enrolled at the first step-up. The realm role is `member`
//     (the helper default is NOT a realm role: the capability table is data in
//     the vertical's roles.json, enforced by the later role catalogue).
//   * rows: the legacy org_unit_members / org_units / provisioning_resources
//     tables through the tenant's own getDb() (the app role's pooled runtime
//     URL inside inProvisioningContext). It opens no connection of its own.
//   * seed: org units created with their projection rows in ONE transaction
//     each; D-8 decides the matrix / Nextcloud rows (planSeed).
import {
  mergeTerms,
  planSeed,
  subsystemsFor,
  type AccountResult,
  type BodyRef,
  type ExistingMembership,
  type ExistingUnit,
  type MemberImportTarget,
  type Role,
  type SeedModules,
  type SeedOp,
  type Vertical,
} from '@gremion/member-import'
import { createOrgUnit, addOrgUnitMember } from '$lib/server/governance/org-units-db'
import { enqueueResources } from '$lib/server/governance/provisioning/ledger'
import { getDb } from '$lib/server/db'
import type { KcProvisionApi } from './kc-admin-api'

/** The realm role every imported account carries. */
export const IMPORT_REALM_ROLE = 'member'
/** D-5: the only action an imported member is asked for. */
export const IMPORT_REQUIRED_ACTIONS = ['UPDATE_PASSWORD'] as const

type KcAccounts = Pick<KcProvisionApi, 'ensureInvitedUser' | 'findUserIdByEmail'>

export function keycloakAccounts(kc: KcAccounts, realm: string): Pick<MemberImportTarget, 'findUserId' | 'ensureAccount'> {
  return {
    findUserId: (email) => kc.findUserIdByEmail(realm, email),
    async ensureAccount(a): Promise<AccountResult> {
      const r = await kc.ensureInvitedUser(realm, {
        email: a.email,
        realmRole: IMPORT_REALM_ROLE,
        requiredActions: IMPORT_REQUIRED_ACTIONS,
        firstName: a.firstName,
        lastName: a.lastName,
        skipIfHasCredential: true,
      })
      return { userId: r.id, created: r.created, invited: r.invited }
    },
  }
}

/** The org-unit side of the import and the seed, over the current tenant's database. */
export interface OrgStore {
  listBodies(): Promise<BodyRef[]>
  membership(bodyId: string, userId: string): Promise<ExistingMembership | null>
  addMembership(m: { bodyId: string; userId: string; role: Role }): Promise<void>
  rearm(bodyIds: readonly string[]): Promise<void>
  listUnits(): Promise<ExistingUnit[]>
  applySeed(ops: readonly SeedOp[]): Promise<{ created: number; adopted: number; present: number }>
}

export function memberImportTarget(accounts: Pick<MemberImportTarget, 'findUserId' | 'ensureAccount'>, store: OrgStore): MemberImportTarget {
  return {
    findUserId: accounts.findUserId,
    ensureAccount: accounts.ensureAccount,
    membership: (bodyId, userId) => store.membership(bodyId, userId),
    addMembership: (m) => store.addMembership(m),
    rearm: (ids) => store.rearm(ids),
  }
}

/** The SQL store. Must be called inside the tenant's context (inProvisioningContext). */
export function sqlOrgStore(): OrgStore {
  return {
    async listBodies() {
      return getDb()<BodyRef[]>`SELECT id::text AS id, name FROM org_units ORDER BY created_at, id`
    },
    async membership(bodyId, userId) {
      const rows = await getDb()<Array<{ membership_type: string; voting: boolean }>>`
        SELECT membership_type, voting FROM org_unit_members WHERE org_unit_id = ${bodyId} AND user_keycloak_id = ${userId}`
      const r = rows[0]
      return r ? { membershipType: r.membership_type, voting: r.voting } : null
    },
    async addMembership({ bodyId, userId, role }) {
      // one transaction per membership; the migration's UNIQUE (org_unit_id, user_keycloak_id) makes it idempotent
      await getDb().begin(async (tx) => {
        await addOrgUnitMember(tx, {
          orgUnitId: bodyId,
          userKeycloakId: userId,
          membershipType: role.membership_type,
          termStart: null,
          termEnd: null,
          voting: role.voting,
        })
      })
    },
    async rearm(bodyIds) {
      // a 'ok' row goes back to 'pending' (immediately due) so the worker re-adopts its external_id and reconciles members
      await getDb()`
        UPDATE provisioning_resources SET status = 'pending', next_attempt_at = NULL, updated_at = now()
         WHERE status = 'ok' AND org_unit_id IN ${getDb()(bodyIds as string[])}`
    },
    async listUnits() {
      const rows = await getDb()<
        Array<{ id: string; parent_id: string | null; name: string; child_term: string | null; wants_matrix_room: boolean; wants_nextcloud_folder: boolean }>
      >`SELECT id::text AS id, parent_id::text AS parent_id, name, child_term, wants_matrix_room, wants_nextcloud_folder FROM org_units ORDER BY created_at, id`
      return rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        childTerm: r.child_term,
        wantsMatrixRoom: r.wants_matrix_room,
        wantsNextcloudFolder: r.wants_nextcloud_folder,
      }))
    },
    async applySeed(ops) {
      const ids = new Map<string, string>()
      let created = 0
      let adopted = 0
      let present = 0
      for (const op of ops) {
        if (op.type === 'present') {
          ids.set(op.key, op.id)
          present++
          continue
        }
        if (op.type === 'adopt-root') {
          await getDb().begin(async (tx) => {
            await tx`
              UPDATE org_units SET child_term = ${op.patch.childTerm}, wants_matrix_room = ${op.patch.wantsMatrixRoom},
                     wants_nextcloud_folder = ${op.patch.wantsNextcloudFolder}
               WHERE id = ${op.id}`
            await enqueueResources(tx, op.id, subsystemsFor(op.patch))
          })
          ids.set(op.key, op.id)
          adopted++
          continue
        }
        const parentId = op.parentKey === null ? null : (ids.get(op.parentKey) ?? null)
        if (op.parentKey !== null && parentId === null) throw new Error(`seed: parent ${op.parentKey} of ${op.key} was not placed`)
        const id = await getDb().begin(async (tx) => {
          const unit = await createOrgUnit(tx, {
            name: op.data.name,
            description: op.data.description,
            parentId,
            kind: op.data.kind,
            visibility: op.data.visibility,
            wantsMatrixRoom: op.data.wantsMatrixRoom,
            wantsNextcloudFolder: op.data.wantsNextcloudFolder,
            childTerm: op.data.childTerm,
            kindLabel: op.data.kindLabel,
            authority: op.data.authority,
          })
          await enqueueResources(tx, unit.id, subsystemsFor(op.data))
          return unit.id
        })
        ids.set(op.key, id)
        created++
      }
      return { created, adopted, present }
    },
  }
}

/** The tenant config text with a vertical's wording merged into `terms` (an operator's own term wins). */
export function configWithTerms(configText: string, wording: Record<string, string>): { text: string; changed: boolean } {
  const doc = JSON.parse(configText) as Record<string, unknown>
  const current = (typeof doc.terms === 'object' && doc.terms !== null ? doc.terms : {}) as Record<string, string>
  const merged = mergeTerms(current, wording)
  const changed = JSON.stringify(merged) !== JSON.stringify(current)
  if (!changed) return { text: configText, changed: false }
  return { text: `${JSON.stringify({ ...doc, terms: merged }, null, 2)}\n`, changed: true }
}

export interface SeedPorts {
  store: OrgStore
  modules: SeedModules
  readConfig(): string
  writeConfig(text: string): void
}

export interface SeedReport {
  status: 'applied'
  units: { created: number; adopted: number; present: number }
  terms_written: boolean
}

/** Seeds a vertical onto the customer's tree and merges its wording. Idempotent. */
export async function seedVertical(vertical: Vertical, ports: SeedPorts): Promise<SeedReport> {
  const existing = await ports.store.listUnits()
  const ops = planSeed(vertical.blueprint, existing, ports.modules)
  const units = await ports.store.applySeed(ops)
  const merged = configWithTerms(ports.readConfig(), vertical.wording)
  if (merged.changed) ports.writeConfig(merged.text)
  return { status: 'applied', units, terms_written: merged.changed }
}
