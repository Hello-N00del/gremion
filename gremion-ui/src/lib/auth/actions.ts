// gremion-ui/src/lib/auth/actions.ts
// Declarative registry of protected actions (#203). Each action declares the
// capability that grants it AND its required Level of Assurance. This is the
// module-owned contract step-up enforcement reads from — modules register their
// actions here over time. The governance-only kernel ships no built-in actions;
// feature modules populate this registry when they are present.
import type { CapabilityId } from './capabilities'

export interface ActionPolicy {
  readonly id: string
  readonly module: string
  readonly anyCapability: readonly CapabilityId[]
  readonly requiredLoa: number
}

export const ACTIONS = {} as const satisfies Record<string, ActionPolicy>

export type ActionId = keyof typeof ACTIONS
export function getActionPolicy(id: ActionId): ActionPolicy { return ACTIONS[id] }
