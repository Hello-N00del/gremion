import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Board (the Deck-style task board) is a toggleable module that owns the /tasks
// page segment and its route prefixes. Split out of core.ts (T1 —
// board-service extraction) so the board data plane can be extracted to the
// services/board leaf behind BOARD_BACKEND. toggleable:true allows per-tenant
// board disable; the flag defaults ON (defaultModulesConfig sources toggleable
// ids from MODULE_MANIFESTS and sets each true by default).
//
// GUARD (R33 F6): gremion-ui/src/lib/modules/migration-ownership.ts crossCuttingViolations() fails if any manifest claims this file;
// gremion-ui/scripts/fresh-init-proof.sh --module-off board proves the OFF fresh init in a real Postgres.
// DELIBERATELY no schema-file attribution: 0034_deck_board.sql stays
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
  // No notTenantIsolated marker: the default (BOARD_BACKEND unset) serves the board in-process, and
  // every handle comes from getDb(), i.e. the requesting customer's own kernel database (migration
  // 0034), so the board is as separated as protocols and members. The module is selectable at
  // customer creation through the isolation gate (board wave, 2026-11-11); module.json declares no
  // database. The board_<slug> leaf catalogue (services/board, BOARD_BACKEND=service) is test
  // environment only and not what a created customer runs.
  pages: [{ segment: 'tasks', minRole: Role.Member }],
  routePrefixes: ['/tasks', '/api/board'],
}
