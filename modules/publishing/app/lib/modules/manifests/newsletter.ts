import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Newsletter is NOT in config.modules today (it has no toggle); the page is
// finance-gated. toggleable:false keeps it always-mounted. Task 23: the
// newsletter is now served entirely by the extracted leaf service (the monolith
// SQLite path was decommissioned); the kernel routes proxy to it via the backend
// port. A dedicated per-tenant service toggle can be added later if needed.
export const newsletterManifest: ModuleManifest = {
  id: 'newsletter',
  order: 50,
  toggleable: false,
  pages: [{ segment: 'newsletter', minRole: Role.Finance }],
  routePrefixes: [],
}
