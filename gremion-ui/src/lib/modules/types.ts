// Declarative per-module manifest (Pillar-1 P0.1 spine; seed of Pillar-3 #203).
// A module describes its own auth surface, owned routes, and toggle here —
// instead of being scattered across auth/index.ts, auth/capabilities.ts,
// hooks.server.ts, nav-schema.ts and realm-export.json.
import type { Role } from '$lib/auth/types'
import type { NavItem } from '$lib/components/layout/nav-schema'

export interface ModulePage {
  /** Top-level route segment, e.g. 'finance'. Becomes a PAGE_ACCESS key. */
  segment: string
  /** Minimum role to access the page. */
  minRole: Role
}

/** A Keycloak realm-export fragment a module owns (Pillar-1 P0.2). Injected
 *  into the generated realm-export only when the module is enabled. */
export interface ModuleRealmFragment {
  /** Realm groups this module owns (full KC group JSON: name + path). */
  groups: { name: string; path: string }[]
  /** Realm-roles this module owns (full KC realm-role JSON: name + description),
   *  so the generated realm-export keeps each role's exact description. */
  realmRoles?: { name: string; description?: string }[]
}

export interface ModuleManifest {
  /** Stable id. For toggleable modules this MUST equal the config.modules key. */
  id: string
  /** Registration rank (WP2-1). The build-time codegen
   *  (scripts/build-module-manifest.mjs) scans manifests/*.ts and emits the
   *  MODULE_MANIFESTS array sorted by this field — so the registered order is a
   *  per-manifest declaration, not a hand-written array literal. Lower = earlier;
   *  ordering defines moduleRoutePrefixes() sequence (pinned by registry.test.ts).
   *  Filename sort is NOT the registration order (content.ts < core.ts), hence an
   *  explicit `order` rather than relying on the scan's alphabetical filenames.
   *
   *  Optional on the TYPE so the throwaway mock manifests in the test suites
   *  (add-a-module.proof, config, module-migrations) — which are injected
   *  directly into pure seams, never through the codegen — need not declare it.
   *  REAL registered manifests MUST set it: the codegen exits 1 on any
   *  manifests/*.ts file without an `order:` field, so the live registry order
   *  stays codegen-enforced. */
  order?: number
  /** Whether config.modules[id] can disable this module (core modules: false). */
  toggleable: boolean
  /** Page segments this module owns (→ composed PAGE_ACCESS). */
  pages: ModulePage[]
  /** Route prefixes gated by the module toggle, e.g. ['/finance','/api/finance']. */
  routePrefixes: string[]
  /** Keycloak group literals this module owns (de-literalization). */
  groups?: Record<string, string>
  /** Capability-id → groups-that-grant-it (any-of). */
  capabilities?: Record<string, readonly string[]>
  /** Migration basenames (no .sql) this module owns; skipped on a fresh
   *  finance-OFF init and gated by the migration-ownership guard test (P0.2). */
  migrations?: string[]
  /** Keycloak realm objects this module owns (P0.2 realm generator). */
  realm?: ModuleRealmFragment
  /** How the Systemstatus module catalog presents this module. Optional: a
   *  manifest without it falls back to its `id`, which is honest (an unlabelled
   *  module is shown by the name it registers under) rather than invented. This
   *  is the ONLY source of that catalog — the page must not carry a hardcoded
   *  list of modules, because a hardcoded list survives the module being
   *  removed and then advertises a surface the instance does not have. */
  status?: {
    /** Display name, e.g. 'Finanzen'. */
    label: string
    /** The technical surface the module owns, e.g. 'finance.* · Postgres-Schema'. */
    service?: string
    /** One-line explanation shown on the module's card. */
    note?: string
  }
  /** Nav-rail fragments this module owns (P3-WP1). Woven back into the
   *  module-neutral baseNavSchema by composeNavSchema at each module's
   *  declared anchor slot; absent for modules with no rail entry. */
  nav?: NavItem[]
}
