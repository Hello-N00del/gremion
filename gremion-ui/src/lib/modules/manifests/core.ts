import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Always-on segments that are not owned by a toggleable feature module.
export const coreManifest: ModuleManifest = {
  id: 'core',
  order: 10,
  toggleable: false,
  status: {
    label: 'Kern',
    service: 'Dashboard · Einstellungen · Systemstatus',
    note: 'Die Grundflächen jeder Instanz. Nicht abwählbar.',
  },
  // Platform-wide Keycloak group literals owned by the always-on core, not by any
  // toggleable feature module. PLATFORM_GROUPS ($lib/auth/capabilities) sources
  // admin/it-admin from here so the auth slice has no feature-module dependency.
  // These two ids are DUPLICATED in financeManifest.groups (the finance manifest
  // lists every group its capability map references, platform ones included); the
  // values are byte-identical and pinned by capabilities.test.ts + registry.test.ts.
  groups: { admin: 'admin', itAdmin: 'it-admin' },
  pages: [
    { segment: 'dashboard', minRole: Role.Guest },
    // #167: /settings is reachable by every signed-in member (Konto sections);
    // the Verwaltung/System sections are gated INSIDE the page by isITAdmin and
    // each /api/settings* endpoint keeps its own it-admin gate. hooks.server.ts
    // gates the whole /settings/* subtree on this single `settings` segment.
    { segment: 'settings', minRole: Role.Member },
    // #264 (HANDOVER-v8 Part C): the provisioning-convergence Systemstatus page
    // (shared control-plane vs silo data-plane + active-module catalog). Read-only
    // surface gated to it-admin; retry/repair actions gate further inside the page.
    { segment: 'systemstatus', minRole: Role.ITAdmin },
  ],
  routePrefixes: [],
}
