// gremion-ui/src/lib/server/boundary/rules.ts
// P0.4 boundary rules (design 2026-06-08 §3.1/§7). CHANGING THIS FILE — in
// particular adding allow entries — is a design decision: it must be visible
// in review and justified against the Pillar-1 boundary model. The engine
// flags UNUSED allow entries so stale exceptions cannot linger.
import type { FkAllowEntry } from './sql-fk-scan'
import type { ImportRule } from './import-scan'

/** Ratified cross-schema kernel FK allowlist. Carve note: the 3 finance→org_units
 *  FKs (migration 013) left with the finance module — that migration is deleted —
 *  so the allowlist is now empty. The sql-fk-scan engine flags any UNLISTED
 *  cross-schema FK in the (kernel) migrations, so this empty list still guards the
 *  governance-only migration set. Re-add a module's entries with the module. */
export const FK_ALLOWLIST: FkAllowEntry[] = []

// Composition roots: files sanctioned to wire modules together across service
// boundaries (they import a module's own entrypoint to compose the app).
// Session-A inversion A1: the GENERATED server-init barrel is a new
// composition root — it imports each module's register.server.ts FOR ITS SIDE
// EFFECTS (self-registration into the runtime-registry). That is the sanctioned
// place for the cross-boundary import; the kernel files (hooks.server.ts,
// tenant/registry.ts, the governance orchestrator) consume only the registry.
const COMPOSITION_ROOTS = ['src/hooks.server.ts', 'src/lib/server/modules/server-init.generated.ts']

export const IMPORT_RULES: ImportRule[] = [
  {
    id: 'no-governance-to-finance',
    description:
      'Kernel ownership direction (fixed in P0.1): governance must never import finance. ' +
      'finance→governance (createSubOrg atomic seam) is the sanctioned direction.',
    sourceDirs: ['src/lib/server/governance'],
    sourceExempt: [],
    forbiddenTargets: ['src/lib/server/finance'],
    allow: [],
  },
  {
    id: 'newsletter-imports-no-domain-internals',
    description:
      'P1 extraction leaf: the surviving newsletter server dir is the backend ' +
      'port + the HTTP ACL service client (Task 23 removed the SQLite store); it ' +
      'must stay domain-clean.',
    sourceDirs: ['src/lib/server/newsletter'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/governance', 'src/lib/server/elections',
    ],
    allow: [],
  },
  {
    id: 'elections-imports-no-domain-internals',
    description: 'Phase-2 extraction candidate: elections server code must stay domain-clean.',
    sourceDirs: ['src/lib/server/elections'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/governance', 'src/lib/server/newsletter',
    ],
    allow: [],
  },
  {
    id: 'no-deep-import-into-newsletter',
    description: 'Newsletter internals are service-private (lib + own routes/UI + composition root).',
    sourceDirs: ['src'],
    // src/routes/newsletter = the service's own UI composition (mirrors the elections rule);
    // src/lib/server/seed = seed composition root (seed-newsletter.ts), grep-verified 2026-06-10.
    // src/routes/api/internal/newsletter = Task-11 kernel resolver callbacks (the ACL's kernel
    // face — render/resolve-group/send-mail). These are the newsletter service's own HTTP boundary;
    // they import collabora-convert + keycloak-admin to serve the leaf's callbacks. Treated as
    // part of the newsletter service boundary (mirrors the src/routes/api/newsletter exemption).
    sourceExempt: ['src/lib/server/newsletter', 'src/routes/newsletter', 'src/routes/api/newsletter', 'src/routes/api/internal/newsletter', 'src/lib/server/seed', ...COMPOSITION_ROOTS],
    forbiddenTargets: ['src/lib/server/newsletter'],
    // Carve note: the sole external consumer (routes/news/[id]/edit) was git-rm'd
    // with the news/content surface, so the allow entry is gone. The rule stays as
    // a no-op guard (newsletter dir is deleted) that reds if it is re-introduced.
    allow: [],
  },
  {
    id: 'no-deep-import-into-elections',
    description: 'Elections internals are service-private (lib + own routes/votes UI + composition root).',
    sourceDirs: ['src'],
    sourceExempt: [
      'src/lib/server/elections', 'src/routes/api/elections', 'src/routes/elections',
      'src/routes/votes', 'src/lib/votes',
      // src/lib/server/seed = seed composition root (seed-elections.ts:7 imports election-db),
      // grep-verified 2026-06-10 — mirrors the newsletter seed exemption.
      'src/lib/server/seed',
      ...COMPOSITION_ROOTS,
    ],
    forbiddenTargets: ['src/lib/server/elections'],
    // Carve note: the sole external consumers were the finance Helios adapter +
    // hooks, which left with the finance module, so the allow entries are gone.
    // The rule stays as a no-op guard (elections dir is deleted) that reds if it
    // is re-introduced.
    allow: [],
  },
  {
    id: 'no-protocols-to-files',
    description:
      'boundary rule A3a-2: the protocol server code + its API routes must never import ' +
      'the files module ($lib/server/files). The Nextcloud document ops they drive ' +
      'were re-homed into the files module behind a ProtocolDocumentPort (registered ' +
      'in runtime-registry), and the Collabora converters into documents/collabora-convert. ' +
      'The protocol routes now depend only on those seams. This guard regression-protects ' +
      'the inversion — a production protocols→files import is a violation. (The scanner ' +
      'skips *.test.ts, so test-side cleanliness is held by the protocol route tests ' +
      'registering a fake ProtocolDocumentPort instead of importing files internals.)',
    // src (not just src/lib/server/protocols) so the protocol API routes are
    // covered too; sourceDirs is narrowed to exactly the three protocol surfaces.
    sourceDirs: [
      'src/lib/server/protocols',
      'src/routes/api/protocols',
      'src/routes/api/public/protocols',
    ],
    sourceExempt: [],
    forbiddenTargets: ['src/lib/server/files'],
    // No allow needed: after the inversion zero protocol files import files/*.
    allow: [],
  },
  {
    id: 'no-auth-to-feature-module',
    description:
      'Session-A inversion A2 (B4): kernel auth must never import a feature ' +
      'module. capabilities.ts now sources PLATFORM_GROUPS from coreManifest + the ' +
      'generic composeCapabilities (CapabilityId widened to string); FINANCE_GROUPS + ' +
      'the concrete finance CapabilityId union live in the finance module. This guard ' +
      'regression-protects the inversion — before A2 there was NO rule with src/lib/auth ' +
      'as a source, so an auth→feature import was undetectable.',
    sourceDirs: ['src/lib/auth'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/elections', 'src/lib/server/content',
      'src/lib/server/newsletter', 'src/lib/server/calendar', 'src/lib/server/files',
      'src/lib/server/messages',
      'src/lib/modules/finance',
      'src/lib/modules/manifests/finance', 'src/lib/modules/manifests/elections',
      'src/lib/modules/manifests/content', 'src/lib/modules/manifests/newsletter',
      'src/lib/modules/manifests/users',
    ],
    // No allow needed: production auth imports zero feature modules. (capabilities.test.ts
    // imports the re-homed FINANCE_GROUPS from the finance module to assert the B4 move,
    // but the scanner excludes *.test.ts — engine.isLintableTs — so it is not flagged.)
    allow: [],
  },
  {
    id: 'no-settings-to-feature-module',
    description:
      'boundary rule A3c S1: the kernel settings layout must never import a feature module. ' +
      'The #164 step-up master switch (was a $lib/server/finance/finance-flags import) ' +
      'is now a finance data provider on the runtime-registry — the layout reads it via ' +
      "getDataProvider('finance:step-up-enforced'). This guard regression-protects the " +
      'inversion: a settings-layout→feature import is a violation.',
    sourceDirs: ['src/routes/settings'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/messages',
      'src/lib/server/files', 'src/lib/server/elections',
    ],
    // No allow needed: after the inversion the settings routes import zero feature modules.
    allow: [],
  },
  {
    id: 'no-setup-health-to-feature-module',
    description:
      'boundary rule A3c S2: the setup-wizard health route must never import a feature ' +
      "module. The Synapse + Nextcloud credential probes (were $lib/server/messages/" +
      'synapse-admin + $lib/server/files/nextcloud-client imports) are now module-' +
      'contributed setup-health probes on the runtime-registry — the route iterates ' +
      'getSetupHealthProbes(). This guard regression-protects the inversion: a setup-' +
      'health→feature import is a violation.',
    sourceDirs: ['src/routes/api/setup/health'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/messages',
      'src/lib/server/files', 'src/lib/server/elections',
    ],
    // No allow needed: after the inversion the setup-health route imports zero feature modules.
    allow: [],
  },
]
