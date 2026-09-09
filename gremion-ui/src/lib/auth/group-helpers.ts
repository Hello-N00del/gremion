// Group-based capability helpers. These centralise the finer-grained
// Keycloak-group checks (admin / it-admin and any module-contributed groups)
// that the role-enum machinery in ./index.ts cannot express.
//
// Carve note: the finance-specific helpers (canApproveAny / canEditBudget / …)
// look up capability ids that the finance FEATURE MODULE contributes
// (`finance.*`). In the governance-only kernel those ids are absent from the
// composed CAPABILITIES map, so each helper degrades to `false` (the capability
// is simply ungranted) rather than crashing on an undefined group list. They
// light back up automatically when the finance module is present.

import { CAPABILITIES, type CapabilityId } from './capabilities';

/** Minimal structural session shape — only `groups` is read. Accepts the full
 *  SessionUser as well as the lighter `{ user: { groups } }` used in tests. */
export type AuthSession = {
  user: { groups: readonly string[] };
};

export type AuthHelpers = {
  hasGroup: (g: string) => boolean;
  hasAny: (...gs: string[]) => boolean;
  canApproveAny: () => boolean;
  canEditBudget: () => boolean;
  canApproveBudget: () => boolean;
  canConfigureFints: () => boolean;
  canManageSubOrgs: () => boolean;
};

/**
 * P2.2-auth A4 (D-CONST): `capabilities` lets a tenant-aware caller (the nav
 * filter in +layout.server.ts) pass capabilitiesForTenant(tenant); the default
 * is the golden CAPABILITIES, keeping every existing 1-arg call site
 * byte-identical (the default tenant's accessor returns this same object).
 */
export function makeAuthHelpers(
  session: AuthSession,
  capabilities: Record<CapabilityId, readonly string[]> = CAPABILITIES,
): AuthHelpers {
  const groups = new Set(session.user.groups);
  const hasGroup = (g: string) => groups.has(g);
  const hasAny = (...gs: string[]) => gs.some(hasGroup);
  // Look up a capability's group set, tolerating an absent id (a capability
  // contributed by a feature module that is not present in this build) — an
  // absent capability grants nothing, so the helper is `false` rather than
  // throwing on a spread of `undefined`.
  const hasCapability = (id: CapabilityId) => hasAny(...(capabilities[id] ?? []));
  return {
    hasGroup,
    hasAny,
    canApproveAny:     () => hasCapability('finance.approve.any'),
    canEditBudget:     () => hasCapability('finance.budget.edit'),
    canApproveBudget:  () => hasCapability('finance.budget.approve'),
    canConfigureFints: () => hasCapability('finance.fints.configure'),
    canManageSubOrgs:  () => hasCapability('finance.suborgs.manage'),
  };
}
