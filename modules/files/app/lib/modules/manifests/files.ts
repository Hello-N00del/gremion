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
// toggleable:false — /files stays ALWAYS-ON exactly as it was in core (every
// member is provisioned a Nextcloud account; #194 gates guests at Role.Member).
// It is NOT a per-tenant disable-able feature, so it carries no routePrefixes:
// the /files + /api/files surfaces are governed by the page-access minRole
// (Role.Member) below, not by the module-disable gate. The FILES_BACKEND
// inprocess→service cutover is an independent env flag, orthogonal to this.
export const filesManifest: ModuleManifest = {
  id: 'files',
  order: 80,
  toggleable: false,
  // #194: /files is member-gated — guests get no Nextcloud account, so every
  // WebDAV call on their bearer 404s. The /api/files handler also 403s guests
  // (defense in depth).
  pages: [{ segment: 'files', minRole: Role.Member }],
  routePrefixes: [],
}
