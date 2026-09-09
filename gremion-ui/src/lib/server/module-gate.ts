// src/lib/server/module-gate.ts
// #256-1: the module-disable gate, extracted from hooks.server.ts so EVERY
// auth method enforces it. The cookie-session path always had this check; the
// Bearer branch used to `return resolve(event)` before reaching it, leaving a
// disabled module's /api prefix reachable to token clients — undermining
// per-tenant module deselection (a load-bearing primitive of the governance
// framework). Server helper by design (NOT lib/modules/registry.ts): the gate
// reads the CURRENT tenant's live config via readConfig(), which resolves the
// ALS tenant scope — registry.ts stays a pure manifest composition layer.
import { readConfig, type GremionConfig } from '$lib/server/config'
import { moduleRoutePrefixes } from '$lib/modules/registry'

/**
 * The id of the toggleable module that owns `pathname` AND is DISABLED in the
 * (current tenant's) config — null otherwise. Route map is composed from the
 * module manifests (P0.1). Shared by the machine-readable gate
 * (moduleGateResponse) and the styled page surface (#290): hooks.server.ts
 * renders the "Modul nicht aktiv" surface for a disabled-module PAGE deep link
 * by naming this module, while /api/* prefixes keep the bare 403.
 */
export function disabledModuleForPath(
  pathname: string,
  config: GremionConfig = readConfig(),
): string | null {
  for (const { prefix, moduleId } of moduleRoutePrefixes()) {
    // WP3-modules-dynamic: config.modules is now Record<string, boolean>, so the
    // string moduleId indexes directly — no `as keyof …` cast needed.
    // Segment-boundary match (design v11): a prefix owns exactly itself and its
    // sub-paths. A naive startsWith would let e.g. a '/finance' gate swallow a
    // sibling module's '/financex' prefix — 403ing a path no module toggle was
    // meant to cover (and, symmetrically, letting a disabled '/finance' escape
    // via a lookalike prefix on a future module).
    if ((pathname === prefix || pathname.startsWith(prefix + '/')) && !config.modules[moduleId]) {
      return moduleId
    }
  }
  return null
}

/**
 * Returns the route-prefix 403 when `pathname` belongs to a toggleable module
 * that is DISABLED in the (current tenant's) config — null otherwise. The gate
 * semantics (route-prefix 403, body 'Module disabled') are unchanged from the
 * original hooks.server.ts inline loop; this is the machine-readable path
 * (every /api/* caller, plus Bearer clients).
 */
export function moduleGateResponse(
  pathname: string,
  config: GremionConfig = readConfig(),
): Response | null {
  return disabledModuleForPath(pathname, config)
    ? new Response('Module disabled', { status: 403 })
    : null
}
