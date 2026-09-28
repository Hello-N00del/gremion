import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Content Engine L1 module manifest. Mirrors finance.ts shape: a toggleable
// feature module that owns a top-level page segment, its route prefixes, a
// capability map, and the migration that creates its per-tenant `content`
// named schema (migration 044). View access matches finance/elections
// (Role.Member reaches the authoring surface); write/publish stays
// capability-gated below.
//
// content.publish.instagram is DEFINED here but intentionally UNGRANTED (empty
// grant list) in L1 — the Instagram publish path is wired in L3, which fills
// the granting groups then. Keeping the capability id declared now pins the
// contract so L3 is a grant-only edit.
const G = {
  admin:   'admin',
  itAdmin: 'it-admin',
} as const

export const contentManifest: ModuleManifest = {
  id: 'content',
  order: 40,
  toggleable: true,
  // Authoring surface view gate matches finance/elections: a basic Mitglied
  // reaches /content; write/publish is capability-gated (below).
  pages: [{ segment: 'content', minRole: Role.Member }],
  routePrefixes: ['/content', '/api/content'],
  groups: { ...G },
  capabilities: {
    'content.author':            [G.admin, G.itAdmin],
    'content.publish':           [G.admin, G.itAdmin],
    // L3 wires the Instagram publish path; the grant list stays empty until then.
    'content.publish.instagram': [],
  },
  // Migration basenames this module owns. Source of truth for the migration
  // skip-filter; completeness enforced by the migration-ownership guard test.
  migrations: ['044_content_schema', '045_content_publish', '046_content_publish_ops'],
  // NOTE: no `nav` fragment in L1. composeNavSchema only weaves a manifest's
  // nav at a matching `{ slot:'module', moduleId }` anchor in baseNavSchema;
  // there is no 'content' anchor yet, so a nav fragment here would be dead
  // config. The rail entry + its base-template anchor are a later
  // Claude-Design handover (the authoring UI is reached directly via /content).
}
