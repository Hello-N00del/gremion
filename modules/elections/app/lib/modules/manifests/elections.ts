import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'
// type-only: a VALUE import of NavItem would create an init cycle
// (nav-schema → registry → manifests → nav-schema). NavItem is an interface, so
// `import type` erases at runtime and breaks that edge (registry.test.ts cycle smoke).
import type { NavItem } from '$lib/components/layout/nav-schema'

export const electionsManifest: ModuleManifest = {
  id: 'elections',
  order: 30,
  toggleable: true,
  // DELIBERATELY no `migrations` key (#371 review): committee_elections
  // (migrations/004_committee_elections.sql) stays KERNEL-applied.
  // 010_org_units.sql is a cross-cutting kernel migration (attributed to no
  // manifest, therefore always applied) that UNCONDITIONALLY runs
  // `ALTER TABLE committee_elections RENAME COLUMN committee_id TO org_unit_id`,
  // so gating 004 behind the elections toggle breaks a FRESH elections-OFF init
  // (relation "committee_elections" does not exist → migration txn aborts → the
  // stack cannot boot). committee_elections is governance-scoped kernel data —
  // consistent with the votes-leaf Option-A exemption keeping election-db
  // kernel-side. Re-gating is pinned OFF by module-migrations.test.ts and
  // migration-ownership.test.ts.
  pages: [
    { segment: 'elections', minRole: Role.Member },
    { segment: 'polls', minRole: Role.Member },
    { segment: 'votes', minRole: Role.Member },
  ],
  routePrefixes: ['/elections', '/api/elections', '/polls', '/api/polls'],
  // Merged rail entry: /polls and /elections still exist as routes; the rail
  // collapses Abstimmungen + Umfragen + Wahlen into this single /votes item,
  // woven into the Gremien section by composeNavSchema (anchor: 'elections').
  nav: [
    { kind: 'item', href: '/votes', label: 'Abstimmungen & Wahlen', icon: 'vote', role: Role.Member, badge: 'live', moduleId: 'elections' } satisfies NavItem,
  ],
}
