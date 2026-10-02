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
  // services/board/src/index.ts:24 — "storeFn ignores the tenant (single
  // BOARD_PG_URL database today)". No tenant-store.ts, and board/stack/card
  // carry no tenant column. Defaults OFF until that is fixed; see
  // ModuleManifest.notTenantIsolated.
  notTenantIsolated: true,
  pages: [{ segment: 'tasks', minRole: Role.Member }],
  routePrefixes: ['/tasks', '/api/board'],
}
