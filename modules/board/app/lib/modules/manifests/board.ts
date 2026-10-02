import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Board (the Deck-style task board) is a toggleable module that owns the /tasks
// page segment and its route prefixes. Split out of core.ts (T1 —
// board-service extraction) so the board data plane can be extracted to the
// services/board leaf behind BOARD_BACKEND. toggleable:true allows per-tenant
// board disable; the flag defaults ON (defaultModulesConfig sources toggleable
// ids from MODULE_MANIFESTS and sets each true by default).
//
// DELIBERATELY no schema-file attribution: 034_deck_board.sql stays
// KERNEL-applied. Its DDL CREATEs board/stack/card with cross-DB FKs to
// org_units(id) AND protocol_action_items(id) — both governance-scoped kernel
// tables — so the board schema is governance-coupled kernel data, exactly the
// Option-A exemption reasoning the elections manifest documents for
// committee_elections. Gating 034 behind the board toggle would break a fresh
// board-OFF init (the FK targets are kernel-owned, and the shipped-kernel schema
// is byte-identical whether the module is on or off). This omission is pinned by
// the module migration-ownership guards.
export const boardManifest: ModuleManifest = {
  id: 'board',
  order: 100,
  toggleable: true,
  // No notTenantIsolated marker: the board leaf keeps one database per tenant,
  // board_<slug>, catalogued in board_control (services/board/src/tenant-store.ts),
  // with the (id, slug) pair bound on every call. Marker removed for this
  // vertical's test environment under R29-I1 (leaf per-tenant store plus a leaf-level,
  // shared-secret isolation pass). This is not the TRD-060 pass and does not
  // satisfy TRD-064; the kernel keeps the board off (R29-BOARD-STORE-K §3.4,
  // TASK-058).
  pages: [{ segment: 'tasks', minRole: Role.Member }],
  routePrefixes: ['/tasks', '/api/board'],
}
