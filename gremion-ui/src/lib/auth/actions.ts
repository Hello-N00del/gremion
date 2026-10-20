// gremion-ui/src/lib/auth/actions.ts
// Declarative registry of protected actions (#203). Each action declares the
// capability that grants it AND its required Level of Assurance. This is the
// module-owned contract step-up enforcement reads from — modules register their
// actions here over time. The governance-only kernel ships no built-in actions;
// feature modules populate this registry when they are present (TASK-205c: the
// vault module's reveal policy, a carve-keep hunk re-applied with its module).
import type { CapabilityId } from './capabilities'
import { LOA } from './step-up'

export interface ActionPolicy {
  readonly id: string
  readonly module: string
  readonly anyCapability: readonly CapabilityId[]
  readonly requiredLoa: number
}

export const ACTIONS = {
  // #405 (design v11): ciphertext delivery — the server reveals a secret only
  // after a FRESH LoA 2. anyCapability is empty by design: vault access is
  // granted by ORG-UNIT SCOPE (resolveVaultOrgUnitScope), not by a capability;
  // this policy contributes only the LoA requirement.
  'vault.secret.reveal': {
    id: 'vault.secret.reveal', module: 'vault',
    anyCapability: [], requiredLoa: LOA.STEP_UP,
  },
} as const satisfies Record<string, ActionPolicy>

export type ActionId = keyof typeof ACTIONS
export function getActionPolicy(id: ActionId): ActionPolicy { return ACTIONS[id] }
