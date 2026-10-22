import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Messages + video (Matrix / LiveKit) module manifest. Split out of core.ts
// (T1 / #363) so the messages+video data plane can be routed to the
// messages-service leaf (the thin Matrix/LiveKit proxy) behind the
// MESSAGES_BACKEND flag — mirrors the files split (T1) and the calendar split
// (Task 0). This relocation is byte-identical: composePageAccess() still yields
// `messages: Role.Member` (moved from core.pages to here), and
// moduleRoutePrefixes() is unchanged because it emits prefixes only for
// toggleable modules.
//
// toggleable:true (R33 F5, operator ruling Q3 2026-10-21): messages is deselectable at RUNTIME per tenant AND
// at creation. With messages OFF /messages answers the styled "Modul nicht aktiv" surface, /api/messages and
// /api/video the bare 403, and both rail entries (Chat, Raeume) are dropped. Users keep their accounts.
// The MESSAGES_BACKEND inprocess->service cutover is an independent env flag, orthogonal to this.
export const messagesManifest: ModuleManifest = {
  id: 'messages',
  order: 90,
  toggleable: true,
  pages: [{ segment: 'messages', minRole: Role.Member }],
  routePrefixes: ['/messages', '/api/messages', '/api/video'],
  // TASK-009 lane B (row 17, FLOW-MSG-001 "Verwaltung -> Räume"): the admin
  // room-overview rail entry. CouncilAdmin-gated (ITAdmin inherits via the
  // role hierarchy, lib/auth/index.ts) — /messages/manage itself re-checks
  // this role in its own load (rows-plan.md S2.6), because the hooks-level
  // PAGE_ACCESS gate only sees the top-level 'messages' segment (Member).
  // TASK-209 (UX-071a AC-5): 'Räume' gets its own glyph — it shared 'chat'
  // with the /messages rail entry, and no two nav items may draw the same
  // icon (the rail shows the glyph alone; nav-icons.ts's duplicate-icon guard
  // now catches this).
  nav: [{ kind: 'item', href: '/messages/manage', label: 'Räume', icon: 'matrix', role: Role.CouncilAdmin, moduleId: 'messages' }],
}
