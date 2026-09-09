// Manifest-driven Keycloak realm composition (Pillar-1 P0.2). Starts from a
// base realm (module-neutral) and injects each ENABLED toggleable module's realm
// fragment (groups + realm-roles). A disabled module contributes nothing — so a
// finance-OFF vertical's realm never carries ref-finanzen*/the finance role.
// PURE: takes parsed JSON in, returns parsed JSON out (the CLI does the IO).
import type { ModuleManifest } from './types'

type ScopeMapping = { client?: string; clientScope?: string; roles: string[] }
type RealmJson = {
  groups: { name: string; path: string }[]
  roles: { realm: { name: string; description?: string }[]; [k: string]: unknown }
  scopeMappings?: ScopeMapping[]
  [k: string]: unknown
}
type ModulesConfig = { modules?: Record<string, boolean> }

function moduleEnabled(m: ModuleManifest, config: ModulesConfig): boolean {
  // #262 D4: guard the lookup so a config that omits the `modules` key (legal —
  // the schema is `.partial()` and runtime readConfig back-fills an all-enabled
  // default) no longer throws "Cannot read properties of undefined". A missing
  // key resolves to `undefined !== false` → enabled, matching the runtime
  // DEFAULT_CONFIG.modules semantics where an absent toggle means "on".
  return !m.toggleable || config.modules?.[m.id] !== false
}

export function composeRealm(base: RealmJson, manifests: ModuleManifest[], config: ModulesConfig): RealmJson {
  const groups = [...base.groups]
  const realmRoles = [...base.roles.realm]
  const moduleRoleNames: string[] = []
  for (const m of manifests) {
    if (!m.realm || !moduleEnabled(m, config)) continue
    for (const g of m.realm.groups) groups.push(g)
    for (const role of m.realm.realmRoles ?? []) {
      realmRoles.push(role)
      moduleRoleNames.push(role.name)
    }
  }
  // #254: clients run with fullScopeAllowed:false, so realm roles reach tokens
  // only via explicit scope mappings. Every CLIENT scopeMappings entry in the
  // base template (gremion-ui, gremion-mobile — the first-party clients whose
  // tokens auth.ts / hooks.server.ts decode realm_access.roles from) also
  // receives each enabled module's realm roles; a disabled module's roles
  // exist nowhere, so the mapping stays import-consistent in both states.
  const scopeMappings = (base.scopeMappings ?? []).map((sm) =>
    sm.client ? { ...sm, roles: [...sm.roles, ...moduleRoleNames] } : sm
  )
  return {
    ...base,
    groups,
    roles: { ...base.roles, realm: realmRoles },
    ...(base.scopeMappings ? { scopeMappings } : {}),
  }
}
