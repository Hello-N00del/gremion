// Friendly, user-facing labels for Keycloak groups + realm roles.
//
// WI-4 Phase A "Keycloak/Mitglied de-leak": the plumbing identifiers
// (raw group ids like `mitglied`, infra realm roles like `offline_access`)
// must never surface to members as-is. This module is the
// single source of truth for turning those ids into friendly German labels
// and for the "hide the plumbing" rule. It is pure data (no I/O), so it is
// safe to import from both client components and server load functions.
//
// KERNEL SCOPE (open-core carve): this file is $lib/auth — governance kernel,
// always compiled in. It carries ONLY governance vocabulary. Feature-module
// group/role labels belong to that module's own manifest
// ($lib/modules/manifests/*), never here. Enforced by labels.test.ts and by
// no-hardcoded-groups.test.ts, which no longer exempts this file.
//
// It also backs the WI-4B Member data contract's `roles[]` / `scopes[]`
// friendly-label fields — resolve raw ids through here before they cross the
// wire to the member-management UI.

export type ScopeKind = 'admin' | 'member' | 'other'

export interface ScopeLabel {
  /** Friendly label shown to users. */
  label: string
  /** Visual category for chip styling (admin tinted, member/other neutral). */
  kind: ScopeKind
}

// Keycloak groups that are pure plumbing — every authenticated user is a
// `mitglied`, so it carries no information and is never shown as a scope.
const HIDDEN_GROUPS: ReadonlySet<string> = new Set(['mitglied'])

// Raw Keycloak group id → friendly scope label.
const GROUP_LABELS: Readonly<Record<string, ScopeLabel>> = {
  admin: { label: 'Administration', kind: 'admin' },
  'it-admin': { label: 'IT-Administration', kind: 'admin' },
}

// Realm roles that are Keycloak infrastructure, never shown to members.
const HIDDEN_ROLES: ReadonlySet<string> = new Set(['offline_access', 'uma_authorization'])

// Realm role id → friendly label (mirrors the Role enum in ./types plus the
// `admin` group-role that the users list treats as an admin tier).
const ROLE_LABELS: Readonly<Record<string, string>> = {
  guest: 'Gast',
  member: 'Mitglied',
  'council-admin': 'Gremienverwaltung',
  admin: 'Administration',
  'it-admin': 'IT-Administration',
}

/** True for groups that are pure plumbing and must not be shown to members. */
export function isHiddenGroup(group: string): boolean {
  return HIDDEN_GROUPS.has(group)
}

/** True for realm roles that are Keycloak infrastructure (offline_access, default-roles-*, …). */
export function isHiddenRole(role: string): boolean {
  return HIDDEN_ROLES.has(role) || role.startsWith('default-roles')
}

/**
 * Friendly scope label for a raw Keycloak group id, or `null` if the group is
 * hidden plumbing (e.g. `mitglied`). Unknown groups fall back to their raw id
 * with the neutral `other` kind so a newly-added group degrades visibly rather
 * than vanishing.
 */
export function scopeLabel(group: string): ScopeLabel | null {
  if (isHiddenGroup(group)) return null
  return GROUP_LABELS[group] ?? { label: group, kind: 'other' }
}

/** Friendly scope labels for a member's groups, with hidden plumbing dropped. */
export function scopeLabels(groups: readonly string[]): ScopeLabel[] {
  return groups
    .map((g) => scopeLabel(g))
    .filter((s): s is ScopeLabel => s !== null)
}

/**
 * Friendly label for a realm role id. Unknown, non-hidden roles fall back to
 * the raw id so a new role degrades visibly.
 */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

/** Friendly labels for a member's realm roles, with infrastructure roles dropped. */
export function roleLabels(roles: readonly string[]): string[] {
  return roles.filter((r) => !isHiddenRole(r)).map((r) => roleLabel(r))
}
