import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Content Engine L1 module manifest. Mirrors finance.ts shape: a toggleable
// feature module that owns a top-level page segment, its route prefixes, a
// capability map, and the kernel-database migrations it owns (the news_posts
// chain in modules/content/app/migrations; the content schema itself lives in
// the leaf database). View access matches finance/elections
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
  // Display name: the Systemstatus catalog reads it (never the raw id).
  status: { label: 'Inhalte', note: 'Beiträge für E-Mail, Portal und Instagram.' },
  order: 40,
  toggleable: true,
  // Authoring surface view gate matches finance/elections: a basic Mitglied
  // reaches /content; write/publish is capability-gated (below).
  // /news is the portal-news editor of the same module (routes/news, routes/api/news): CouncilAdmin only,
  // as its loaders and handlers check, and gated by the module toggle with the rest of the surface.
  pages: [
    { segment: 'content', minRole: Role.Member },
    { segment: 'news', minRole: Role.CouncilAdmin },
  ],
  routePrefixes: ['/content', '/api/content', '/news', '/api/news'],
  groups: { ...G },
  capabilities: {
    'content.author':            [G.admin, G.itAdmin],
    'content.publish':           [G.admin, G.itAdmin],
    // L3 wires the Instagram publish path; the grant list stays empty until then.
    'content.publish.instagram': [],
  },
  // Migration basenames this module owns: the files of modules/content/app/migrations, which the image
  // prebuild copies into gremion-ui/migrations. Source of truth for the migration skip-filter; the
  // migration-ownership guard test fails a name that matches no file (044-046 did, after the schema moved
  // to the leaf database).
  migrations: ['1200_content_news_posts', '1201_news_posts_public_reader_columns', '1202_news_posts_publish_origin'],
  // NOTE: no `nav` fragment. The rail entry (/content, "Inhalte") is an inline item of baseNavSchema
  // (nav-schema.ts) carrying moduleId 'content', like calendar and tasks, so it hides when the module is off.
}
