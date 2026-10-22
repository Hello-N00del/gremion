import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Files (Nextcloud documents) module manifest. Split out of core.ts (T1) so the
// files browser data plane can be routed to the files-service leaf (the thin
// Nextcloud WebDAV proxy) behind the FILES_BACKEND flag — mirrors the calendar
// split (Task 0). This relocation is byte-identical: composePageAccess() still
// yields `files: Role.Member` (moved from core.pages to here), and
// moduleRoutePrefixes() is unchanged because it emits prefixes only for
// toggleable modules.
//
// toggleable:true (R33 F5, operator ruling Q3 2026-10-21): files is deselectable at RUNTIME per tenant AND at
// creation (tenant create --enable). With files OFF the /files page answers the styled "Modul nicht aktiv"
// surface, /api/files the bare 403, and the Dokumente rail entry is dropped (nav-schema moduleId tag). Users
// keep their accounts; only the surface is gated. The FILES_BACKEND inprocess->service cutover is an
// independent env flag, orthogonal to this.
export const filesManifest: ModuleManifest = {
  id: 'files',
  order: 80,
  toggleable: true,
  // #194: /files is member-gated — guests get no Nextcloud account, so every
  // WebDAV call on their bearer 404s. The /api/files handler also 403s guests
  // (defense in depth).
  pages: [{ segment: 'files', minRole: Role.Member }],
  routePrefixes: ['/files', '/api/files'],
}
