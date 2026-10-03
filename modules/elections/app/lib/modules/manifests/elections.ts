import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

export const electionsManifest: ModuleManifest = {
  id: 'elections',
  order: 30,
  toggleable: true,
  // DELIBERATELY no `migrations` key (#371 review): committee_elections
  // (migrations/0004_committee_elections.sql) stays KERNEL-applied.
  // 0010_org_units.sql is a cross-cutting kernel migration (attributed to no
  // manifest, therefore always applied) that UNCONDITIONALLY runs
  // `ALTER TABLE committee_elections RENAME COLUMN committee_id TO org_unit_id`,
  // so gating 004 behind the elections toggle breaks a FRESH elections-OFF init
  // (relation "committee_elections" does not exist → migration txn aborts → the
  // stack cannot boot). committee_elections is governance-scoped kernel data —
  // consistent with the votes-leaf Option-A exemption keeping election-db
  // kernel-side. Re-gating is pinned OFF by module-migrations.test.ts and
  // migration-ownership.test.ts.
  // TASK-205b (TASK-058 Q10): the StuRa manifest owned /elections, /polls and /votes together. After the
  // module split elections owns /elections only; /votes, /polls and the merged rail entry belong to the votes
  // module (manifests/votes.ts), which hides Helios items while this module is off.
  pages: [{ segment: 'elections', minRole: Role.Member }],
  routePrefixes: ['/elections', '/api/elections'],
}
