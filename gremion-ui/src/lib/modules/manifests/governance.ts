import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// The governance flagship. Always-on (toggleable:false) like core — the Gremion
// kernel IS a governance product, so these segments ship and cannot be disabled.
// Split out of the former `core` manifest during the open-core carve so `core`
// stays a minimal kernel shell (dashboard/settings/systemstatus) and the
// governance surface is an explicit, named module a vertical can reason about.
export const governanceManifest: ModuleManifest = {
  id: 'governance',
  order: 15,
  toggleable: false,
  status: {
    label: 'Gremien & Beschlüsse',
    service: 'governance.* · Postgres-Schema',
    note: 'Gremien, Mitglieder, Protokolle, Beschlüsse und das öffentliche Portal.',
  },
  pages: [
    { segment: 'members', minRole: Role.Member },
    // v4: the whole GREMIEN section is guest-visible (council structure is
    // transparent to any logged-in member), matching protokolle/beschluesse.
    { segment: 'committees', minRole: Role.Guest },
    { segment: 'portal', minRole: Role.CouncilAdmin },
    { segment: 'protokolle', minRole: Role.Guest },
    { segment: 'beschluesse', minRole: Role.Guest },
  ],
  routePrefixes: [],
}
