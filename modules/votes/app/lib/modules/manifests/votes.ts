import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'
// type-only: a VALUE import of NavItem would create an init cycle
// (nav-schema → registry → manifests → nav-schema). NavItem is an interface, so
// `import type` erases at runtime and breaks that edge (registry.test.ts cycle smoke).
import type { NavItem } from '$lib/components/layout/nav-schema'

// Votes module manifest (TASK-205b; split out of the StuRa `elections` manifest, which owned /elections,
// /polls and /votes together). TASK-058 Q10: votes owns /votes and /polls; elections owns /elections only.
// The votes landing page merges open polls with the tracked elections' Helios ballots, and it hides every
// Helios item while the elections module is off for the tenant (routes/votes/+page.server.ts), so a tenant
// with votes on and elections off sees polls only and never a ballot entry.
//
// toggleable:true: a tenant can switch the votes module off; /votes, /polls and their api prefix then answer
// the module-disabled surface. Its default is ON (the votes profile is part of the pilot default set).
export const votesManifest: ModuleManifest = {
  id: 'votes',
  order: 31,
  toggleable: true,
  pages: [
    { segment: 'polls', minRole: Role.Member },
    { segment: 'votes', minRole: Role.Member },
  ],
  routePrefixes: ['/votes', '/polls', '/api/polls'],
  // The merged rail entry: /polls and /elections still exist as routes; the rail collapses Abstimmungen +
  // Umfragen + Wahlen into this single /votes item, woven into the Gremien section by composeNavSchema
  // (anchor: 'elections'). It belongs to votes now, so it survives elections being off.
  nav: [
    { kind: 'item', href: '/votes', label: 'Abstimmungen & Wahlen', icon: 'vote', role: Role.Member, badge: 'live', moduleId: 'votes' } satisfies NavItem,
  ],
}
