import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'
// type-only: a VALUE import of NavItem would create an init cycle
// (nav-schema → registry → manifests → nav-schema); see handover.ts.
import type { NavItem } from '$lib/components/layout/nav-schema'

// Vault (per-org-unit secrets store) is a toggleable module owning the /vault
// page segment and its /vault + /api/vault route prefixes. It is the KERNEL half
// of the vault subsystem: the data plane (secret storage + reveal-audit) lives
// ENTIRELY in the vault leaf service, reached through VAULT_BACKEND=service via
// ServiceVaultClient — there is no in-process implementation. toggleable:true
// allows per-tenant disable; the flag defaults ON (defaultModulesConfig sources
// toggleable ids from MODULE_MANIFESTS and sets each true by default).
//
// No migrations/realm attribution: the vault owns no gremion-ui-side schema (its
// tables live in the leaf DB) and no Keycloak groups — access is org-unit scoped
// via the same governance org-unit membership the board uses, at Role.Member.
export const vaultManifest: ModuleManifest = {
  id: 'vault',
  // 115: between handover (110) and vaultwarden (120) — three modules landed the
  // same day; distinct orders keep the codegen sort deterministic.
  order: 115,
  toggleable: true,
  // services/vault/src/index.ts:30 — "storeFn ignores the tenant (single
  // VAULT_PG_URL database today)". There is no tenant-store.ts, and `vault_item`
  // carries no tenant column, so every tenant's SECRETS share one table with no
  // row-level scoping either. Defaults OFF until that is fixed; see
  // ModuleManifest.notTenantIsolated.
  notTenantIsolated: true,
  pages: [{ segment: 'vault', minRole: Role.Member }],
  routePrefixes: ['/vault', '/api/vault'],
  // #405 (design v11): the Verwaltung rail entry (chrome.jsx NAV_GROUPS: Tresor
  // sits between Übergabe and Systemstatus). Spliced in at baseNavSchema's vault
  // anchor by composeNavSchema; the moduleId tag makes the entry vanish on a
  // vault-OFF tenant (filterNavForSession module gate) — no dead rail.
  nav: [
    { kind: 'item', href: '/vault', label: 'Tresor', icon: 'lock', role: Role.Member, moduleId: 'vault' } satisfies NavItem,
  ],
}
