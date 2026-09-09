import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { z } from 'zod'
import { requireTenant } from '$lib/server/tenant/context'
// WP3-modules-dynamic: the registered module set is the single source of the
// toggleable module ids that seed defaultModulesConfig(). Cycle-safe — registry
// → manifests barrel → manifest files only import $lib/auth/types + a type-only
// NavItem; none import this config module (verified), so this static edge has no
// init cycle (registry.test.ts carries the cycle smoke).
import { MODULE_MANIFESTS } from '$lib/modules/registry'
// gremion#22: read-time mapping of the DEPRECATED freeform brand.accent onto
// the curated palette registry (pure, client-safe module — no cycle:
// instance-theme imports nothing).
import { legacyAccentToPalette } from '$lib/theme/instance-theme'

/** The narrow slice of TenantContext this module consumes. */
export interface ConfigTenant {
  id: string
  configPath: string
}

export interface GremionConfig {
  setup_complete: boolean
  wizard_steps: {
    health_check: 'pending' | 'complete'
    org_info: 'pending' | 'complete'
    admin_accounts: 'pending' | 'complete'
    smtp: 'pending' | 'complete'
  }
  org: {
    name: string
    domain: string
    logo_path: string | null
    portal_sections: Record<string, boolean>
  }
  // Tenant branding — the single source for institution-specific UI strings
  // (v4 re-audit slice 10). `org.name`/`org.domain` already carry the long
  // name + domain; these complete the handoff BRAND model. P2.1c (T15,
  // §6-P2.2): the DEFAULT_CONFIG values below are NEUTRAL placeholders — the
  // real per-tenant identity lives only in each tenant's materialized
  // config.json (the default tenant's is written by
  // `tenant-provision materialize-config`). resolveBrand()/requireBrand() read
  // them; no institution literal is hardcoded in source.
  brand: {
    product: string           // e.g. 'Musterrat' (per-tenant; neutral default)
    logo_letter: string       // e.g. 'S'
    org_short: string         // per-tenant; neutral default
    term: string              // e.g. 'SoSe 26'
    version: string           // e.g. 'v2.4'
    // per-tenant accent color + logo, shipped through the existing
    // config→brand→layout SSR path. NULL (the default — StuRa tenant #1 and
    // every existing config file) = today's rendering: app.css tokens + the
    // logo_letter mark, byte-identical.
    // gremion#22 (theming parity, supersedes the #288 freeform `accent`
    // field): the per-tenant CURATED palette id, shipped through the existing
    // config→brand→layout SSR path. NULL (the default — every existing config
    // file) = today's rendering: app.css tokens + the logo_letter mark,
    // byte-identical. Structural gate only (string) — registry validation
    // lives in lib/server/brand.ts brandFromConfig (resolvePaletteId).
    // Unknown values resolve to null with a server log. The pre-#288-followup
    // freeform `accent` key (a bare OKLCH hue or oklch()/hsl() string) is
    // DEPRECATED: it stays in brandSchema below (not in this type) purely so
    // mergeStoredBrand can migrate a stored legacy value onto `palette` on
    // read (legacyAccentToPalette) — see $lib/theme/instance-theme.
    palette: string | null    // curated palette id (NOT a raw hex/hue)
    logo_url: string | null   // logo image URL; null = letter mark
  }
  // P2.2-data (design §3.5(e)): per-tenant DISPLAY-LABEL overrides keyed by
  // stable internal IDs (e.g. 'role.council-admin' → 'Bürgermeister').
  // Optional — omitted means no overrides (StuRa tenant #1: internal IDs are
  // stable, labels fall back via $lib/terms.termFor). Consumption at the
  // role-filter sites rides P2.2-auth (after the P2.1b merge).
  terms?: Record<string, string>
  // P2.2-auth (D-VOCAB): per-tenant role-vocabulary override — the tenant's
  // valid realm-role keys. Optional — omitted (EVERY existing config, pinned)
  // means the default vocabulary `Object.values(Role)`, byte-identical to
  // today. Consumed via $lib/server/tenant/role-vocabulary.ts; P2.3's
  // municipal blueprint supplies real overrides. No storage change.
  roles?: string[]
  // P2.1c (D-WIZARD/D2): deployment mode chosen in the setup wizard. `single` =
  // this deployment serves one organisation; `multi` = it hosts multiple
  // tenants. Default `'single'`, back-filled by mergeStored so every config
  // persisted before T12 surfaces `single` on read (byte-identical rendering).
  // The provisioning script (T10 D-WIZARD gate) REFUSES to provision a second
  // tenant while the default tenant's config says `single`. Tenant creation
  // stays an operator command — this toggle is the only self-serve wizard add.
  deployment: { mode: 'single' | 'multi' }
  admin_accounts: { it_admin_created: boolean; council_admin_created: boolean }
  smtp: { configured: boolean; host: string; port: number; from_address: string; from_name: string }
  // WP3-modules-dynamic: a DYNAMIC open record so a net-new toggleable module
  // needs ZERO edits here — its id flows in from MODULE_MANIFESTS via
  // defaultModulesConfig(). The core/required set (REQUIRED_MODULES) is the
  // runtime source of truth: writeConfig's force-pin loop re-pins every required
  // key to `true` at write time, so a config can never persist a disabled core
  // module even though the type no longer encodes the literal `true`.
  modules: Record<string, boolean>
  legal: { datenschutz_html: string; impressum_html: string; barrierefreiheit_html: string }
  backups: { retention_days: number; last_backup_at: string | null; encryption_key_path: string }
  retention: {
    access_logs_days: number          // Tier 1 default 14, hard cap 30 (BayLDA)
    app_logs_days: number             // Tier 2 default 30, hard cap 90
    security_logs_days: number        // Tier 3 default 90, hard cap 180 (BSI Mindeststandard v2.1)
    security_nopii_logs_days: number  // Tier 4 default 90, hard cap 365
  }
  compliance: {
    dpo_name: string
    dpo_email: string
    controller_name: string
    controller_address: string
    purpose_description: string
  }
}

// WP3-modules-dynamic: the core/always-on modules. Now that
// GremionConfig.modules is a Record<string, boolean> there is no literal-`true`
// key type to derive from — these ids are typed as a plain readonly string[].
// They stay the runtime source of truth: writeConfig force-pins each to `true`.
// The governance-only kernel ships no always-on feature modules — feature
// modules contribute their own required ids when present.
const REQUIRED_MODULES: readonly string[] = []

/**
 * WP3-modules-dynamic: the derived default module-toggle map. Every core
 * (REQUIRED_MODULES) id AND every toggleable manifest id (sourced from
 * MODULE_MANIFESTS) defaults to `true`. A net-new toggleable module is force-on
 * by default with ZERO edits to this file — its id flows in from its manifest.
 *
 * In the governance-only kernel there are no always-on (REQUIRED_MODULES) ids
 * and the kept manifests (core, governance) are non-toggleable, so this is `{}`
 * by default — pinned by the WP3 suite in config.test.ts.
 */
export function defaultModulesConfig(): Record<string, boolean> {
  const modules: Record<string, boolean> = {}
  for (const id of REQUIRED_MODULES) modules[id] = true
  for (const m of MODULE_MANIFESTS) {
    if (m.toggleable) modules[m.id] = true
  }
  return modules
}

// v5 Task 4.7 — default statutory copy so the /legal/* pages are non-empty out
// of the box. P2.1c (T15 / §6-P2.2): these defaults are now institution-NEUTRAL
// placeholders carrying a `<!-- per-tenant: set via config -->` marker — the
// real, institution-specific legal copy lives only in each tenant's
// materialized config.json (`config.legal.*_html`), edited by it-admins via
// Settings → Rechtliches. The LegalDoc page always renders the
// "Entwurf — juristisch zu prüfen" notice above it, so an un-materialized
// tenant shows a clearly-provisional placeholder, never one institution's text.
// t291-setup-brand-legal: EXPORTED so the go-live readiness predicate
// ($lib/server/setup-readiness.isGoLiveReady) and its test share this one
// source of the marker — a legal text still carrying it means the per-tenant
// Rechtstext is an un-edited placeholder and the tenant is not go-live ready.
export const PLACEHOLDER_MARKER = '<!-- per-tenant: set via config -->'

const DEFAULT_IMPRESSUM_HTML = `${PLACEHOLDER_MARKER}
<h3>Impressum</h3>
<p>Für dieses Portal ist noch kein Impressum hinterlegt. Die verantwortliche Stelle hinterlegt die Pflichtangaben (§ 5 DDG, § 18 Abs. 2 MStV) unter <em>Einstellungen → Rechtliches</em>.</p>`

const DEFAULT_DATENSCHUTZ_HTML = `${PLACEHOLDER_MARKER}
<h3>Datenschutzerklärung</h3>
<p>Für dieses Portal ist noch keine Datenschutzerklärung hinterlegt. Die verantwortliche Stelle hinterlegt die Angaben gemäß Art. 13/14 DSGVO unter <em>Einstellungen → Rechtliches</em>.</p>`

const DEFAULT_BARRIEREFREIHEIT_HTML = `${PLACEHOLDER_MARKER}
<h3>Erklärung zur Barrierefreiheit</h3>
<p>Für dieses Portal ist noch keine Erklärung zur Barrierefreiheit hinterlegt. Die verantwortliche Stelle hinterlegt die Angaben gemäß BITV 2.0 / § 12b BGG unter <em>Einstellungen → Rechtliches</em>.</p>`

const DEFAULT_CONFIG: GremionConfig = {
  setup_complete: false,
  wizard_steps: {
    health_check: 'pending',
    org_info: 'pending',
    admin_accounts: 'pending',
    smtp: 'pending',
  },
  org: {
    name: '',
    domain: '',
    logo_path: null,
    portal_sections: {
      news: true,
      board: true,
      committees: true,
      votes: false,
      meetings: true,
      budget: false,
      antrag: true,
    },
  },
  // P2.1c (T15 / §6-P2.2): NEUTRAL defaults — institution identity is per-tenant
  // and lives only in the materialized config.json (`materialize-config`), never
  // inline. `product`/`org_short` default to empty so an un-materialized config
  // resolves to the DEFAULT_BRAND placeholders via resolveBrand/brandFromConfig
  // rather than silently rendering one institution. `logo_letter`/`term`/
  // `version` keep institution-NEUTRAL placeholders.
  brand: {
    product: '',
    logo_letter: 'P',
    org_short: '',
    term: '—',
    version: 'v0',
    palette: null,
    logo_url: null,
  },
  deployment: { mode: 'single' },
  admin_accounts: { it_admin_created: false, council_admin_created: false },
  smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
  // WP3-modules-dynamic: derive the default toggle map from the manifests so a
  // net-new toggleable module is on-by-default with zero edits here.
  modules: defaultModulesConfig(),
  legal: {
    datenschutz_html: DEFAULT_DATENSCHUTZ_HTML,
    impressum_html: DEFAULT_IMPRESSUM_HTML,
    barrierefreiheit_html: DEFAULT_BARRIEREFREIHEIT_HTML,
  },
  backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '/app/config/backup.key' },
  retention: {
    access_logs_days: 14,
    app_logs_days: 30,
    security_logs_days: 90,
    security_nopii_logs_days: 90,
  },
  compliance: {
    dpo_name: '',
    dpo_email: '',
    controller_name: '',
    controller_address: '',
    purpose_description: '',
  },
}

// ── Zod schemas (G-067, G-074, G-098) ────────────────────────────────────
//
// G-067: `readConfig()` previously parsed `JSON.parse` straight into
// `Partial<GremionConfig>` via an unsound `as` cast — a hand-edited config
// file with `setup_complete: "yes"` (string) instead of `boolean` would
// be silently accepted and propagate through the rest of the system. We
// now validate the parsed object against `gremionConfigSchema.partial()`
// and fall back to defaults on shape mismatch (same recovery path G-016
// added for JSON.parse errors).
//
// G-074 + G-098: both route handlers (`/api/setup/config`, `/api/settings`)
// and `writeConfig()` itself now run incoming bodies through
// `configUpdateSchema` (`.strict()` — unknown top-level keys are rejected).
// Previously `/api/setup/config` accepted arbitrary keys and silently
// merged them, and `/api/settings` validated some shapes but not all.
// `writeConfig()` is the load-bearing chokepoint — even direct internal
// callers can no longer slip past validation.
//
// Schema is intentionally permissive on nested types where the JSON
// container already constrains the type (e.g. portal_sections is
// `Record<string, boolean>`). The route-level `settingsPatchSchema` adds
// tighter per-field constraints (length caps, email format) on top of
// this baseline; this schema is just the structural gate.

const wizardStepStatus = z.enum(['pending', 'complete'])

const portalSectionsSchema = z.record(z.string(), z.boolean())

const orgSchema = z
  .object({
    name: z.string(),
    domain: z.string(),
    logo_path: z.string().nullable(),
    portal_sections: portalSectionsSchema,
  })
  .partial()

const brandSchema = z
  .object({
    product: z.string(),
    logo_letter: z.string(),
    org_short: z.string(),
    term: z.string(),
    version: z.string(),
    // gremion#22: nullable curated palette id. `.optional()` is implied by
    // `.partial()` but kept explicit — absent keys are normalized to null in
    // mergeStoredBrand's back-fill. Structural gate only (string); registry
    // validation lives in lib/server/brand.ts brandFromConfig.
    palette: z.string().nullable().optional(),
    // DEPRECATED — the pre-#288-followup freeform accent. It MUST stay in
    // this schema (zod strips unknown keys) so mergeStoredBrand can still SEE
    // a stored legacy value and map it onto `palette` on read
    // (legacyAccentToPalette); GremionConfig no longer carries the key, so the
    // next writeConfig persists palette-only.
    accent: z.string().nullable().optional(),
    logo_url: z.string().nullable().optional(),
  })
  .partial()

const wizardStepsSchema = z
  .object({
    health_check: wizardStepStatus,
    org_info: wizardStepStatus,
    admin_accounts: wizardStepStatus,
    smtp: wizardStepStatus,
  })
  .partial()

// P2.1c (D-WIZARD/D2): deployment mode is a closed two-value enum — `single`
// (the default) or `multi`. `.partial()` keeps the whole `deployment` object
// optional for back-fill, but a present `mode` MUST be one of the two values
// (the validator rejects e.g. `'cluster'`), so a hand-edited or drifted config
// falls back to defaults via readConfig's safeParse path.
const deploymentSchema = z
  .object({
    mode: z.enum(['single', 'multi']),
  })
  .partial()

const adminAccountsSchema = z
  .object({
    it_admin_created: z.boolean(),
    council_admin_created: z.boolean(),
  })
  .partial()

const smtpSchema = z
  .object({
    configured: z.boolean(),
    host: z.string(),
    port: z.number().int(),
    from_address: z.string(),
    from_name: z.string(),
  })
  .partial()

// WP3-modules-dynamic: an OPEN string→boolean record (mirrors
// portalSectionsSchema) so a net-new toggleable module's id validates with zero
// schema edits. The four core modules are no longer pinned as literal `true`
// here — writeConfig's force-pin loop is the runtime guarantee that core
// modules can never persist disabled (and REQUIRED_MODULES is its source).
const modulesSchema = z.record(z.string(), z.boolean())

const legalSchema = z
  .object({
    datenschutz_html: z.string(),
    impressum_html: z.string(),
    barrierefreiheit_html: z.string(),
  })
  .partial()

const backupsSchema = z
  .object({
    retention_days: z.number(),
    last_backup_at: z.string().nullable(),
    encryption_key_path: z.string(),
  })
  .partial()

const retentionSchema = z
  .object({
    access_logs_days: z.number(),
    app_logs_days: z.number(),
    security_logs_days: z.number(),
    security_nopii_logs_days: z.number(),
  })
  .partial()

const complianceSchema = z
  .object({
    dpo_name: z.string(),
    dpo_email: z.string(),
    controller_name: z.string(),
    controller_address: z.string(),
    purpose_description: z.string(),
  })
  .partial()

/**
 * G-067: structural validator for a parsed config.json. Used by
 * `readConfig()` to reject malformed-typed values (e.g.
 * `setup_complete: "yes"`) and fall back to defaults rather than
 * propagating an unsound cast.
 */
export const gremionConfigSchema = z
  .object({
    setup_complete: z.boolean(),
    wizard_steps: wizardStepsSchema,
    org: orgSchema,
    brand: brandSchema,
    // P2.2-data: tenant term-map — flat string→string record of display-label
    // overrides. Lives in BOTH this schema and the derived `configUpdateSchema`
    // (`.strict()` below keeps rejecting unknown top-level keys; `terms` is now
    // a known key). `.optional()` is implied by `.partial()` but kept explicit:
    // an absent map means "no overrides", never `{}`.
    terms: z.record(z.string(), z.string()).optional(),
    // P2.2-auth (D-VOCAB): optional per-tenant role vocabulary. Same
    // explicit-`.optional()` convention as `terms`: absent means "default
    // vocabulary", never `[]`. Known to the `.strict()` update schema below.
    roles: z.array(z.string()).optional(),
    // P2.1c (D-WIZARD/D2): deployment mode toggle. Known to `.strict()` below
    // so the setup endpoint accepts `{ deployment: { mode: 'multi' } }`.
    deployment: deploymentSchema,
    admin_accounts: adminAccountsSchema,
    smtp: smtpSchema,
    modules: modulesSchema,
    legal: legalSchema,
    backups: backupsSchema,
    retention: retentionSchema,
    compliance: complianceSchema,
  })
  .partial()

/**
 * G-074 + G-098: structural validator for partial config updates. Used
 * by both `writeConfig()` and the two PATCH route handlers. `.strict()`
 * rejects unknown top-level keys so a typo in a setup-wizard step
 * (`{ orgg: {...} }`) surfaces as a 4xx instead of silently no-oping.
 *
 * Mirrors the `ConfigUpdate` TS type below — keep them in sync. The
 * setup wizard posts exactly the shapes covered here:
 *   Step1 → `{ wizard_steps: {...} }`
 *   Step2 → `{ org: {...}, deployment: {...}, wizard_steps: {...} }`
 *   Step3 → `{ admin_accounts: {...}, wizard_steps: {...} }`
 *   Step4 → `{ smtp: {...}, wizard_steps: {...} }`
 *   Step5 → `{ setup_complete: true }`
 *   StepBrandLegal → `{ brand: {...}, legal: {...} }`
 * (wizard-submit-schema.test.ts drives every step's submit against this schema.)
 */
export const configUpdateSchema = gremionConfigSchema.strict()

function getConfigPath(tenant: ConfigTenant): string {
  // §8.1 / D-CONFIGPATH: trust tenant.configPath UNCONDITIONALLY — the default
  // row rides the same path as every other tenant. The slug→path derivation
  // lives once in registry.ts (configPathForTenant), which already maps the
  // `default` slug to the CONFIG_PATH env; config.ts no longer special-cases the
  // default id or re-reads env (the second derivation that this removes).
  return tenant.configPath
}

type StoredConfig = z.infer<typeof gremionConfigSchema>

/**
 * gremion#22: back-fill + migrate the brand block. Brand config lives in
 * per-tenant config.json FILES (no SQL migration), so the "migration" for the
 * retired freeform `accent` key IS this read-time mapping: a stored legacy
 * accent that names a curated palette id or one of its hues maps onto
 * `palette` (legacyAccentToPalette; an unmapped/absent legacy value stays
 * null → the default rendering at render time). The deprecated key is
 * DESTRUCTURED OUT of the merged result, so the returned config never carries
 * it and the next writeConfig persists palette-only. A stored `palette`
 * always wins over a stored legacy `accent`.
 */
function mergeStoredBrand(storedBrand: StoredConfig['brand']): GremionConfig['brand'] {
  const { accent: legacyAccent, ...rest } = storedBrand ?? {}
  return {
    ...DEFAULT_CONFIG.brand,
    ...rest,
    palette: rest.palette ?? legacyAccentToPalette(legacyAccent),
    logo_url: rest.logo_url ?? null,
  }
}

/**
 * Deep-merge a validated (partial) stored config onto DEFAULT_CONFIG. Shared
 * by `readConfig()` and `parseConfig()` so both surface identical defaults for
 * fields a persisted config predates. Nested object fields are merged one
 * level deeper so a config persisted before a schema extension still picks up
 * the new defaults (e.g. org.portal_sections, brand.*).
 */
function mergeStored(stored: StoredConfig): GremionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    // #248: every nested object block is deep-merged ONE level onto its default
    // so a config persisted before a schema extension — or a hand-edited file
    // carrying only a subset of a block's keys (the schema's `.partial()` lets a
    // partial block validate) — keeps the sibling defaults instead of having the
    // whole block shallow-replaced. Dropping a numeric default this way (e.g.
    // backups.retention_days) later poisons the file: writeConfig's Math.min/max
    // clamps on the now-undefined field produce NaN, which JSON.stringify writes
    // as null. Flat scalar maps (terms, roles) are intentionally NOT deep-merged
    // — they are whole-value replace-or-absent.
    wizard_steps: { ...DEFAULT_CONFIG.wizard_steps, ...stored.wizard_steps },
    org: {
      ...DEFAULT_CONFIG.org,
      ...stored.org,
      portal_sections: {
        ...DEFAULT_CONFIG.org.portal_sections,
        ...stored.org?.portal_sections,
      },
    },
    // Back-fill brand defaults so configs persisted before slice 10 surface
    // the canonical values on read (UI never renders blank), and migrate a
    // deprecated legacy `accent` value onto the curated `palette` field
    // (gremion#22 — see mergeStoredBrand). Normalize an absent/undefined
    // palette/logo_url to null so the rest of the system only ever sees
    // `string | null`.
    brand: mergeStoredBrand(stored.brand),
    // P2.1c (D-WIZARD/D2): back-fill the deployment mode so a config persisted
    // before T12 (no `deployment` key) surfaces the default `single` on read —
    // byte-identical to today's single-tenant rendering. A present-but-partial
    // `deployment` (no `mode`) also resolves to `single`.
    deployment: {
      ...DEFAULT_CONFIG.deployment,
      ...stored.deployment,
    },
    admin_accounts: { ...DEFAULT_CONFIG.admin_accounts, ...stored.admin_accounts },
    smtp: { ...DEFAULT_CONFIG.smtp, ...stored.smtp },
    modules: { ...DEFAULT_CONFIG.modules, ...stored.modules },
    legal: { ...DEFAULT_CONFIG.legal, ...stored.legal },
    backups: { ...DEFAULT_CONFIG.backups, ...stored.backups },
    retention: { ...DEFAULT_CONFIG.retention, ...stored.retention },
    compliance: { ...DEFAULT_CONFIG.compliance, ...stored.compliance },
  } as GremionConfig
}

/**
 * Strict parse of a raw (already JSON-parsed) config object into a full
 * `GremionConfig`. Unlike `readConfig()`, this THROWS on a schema mismatch
 * instead of falling back to defaults — use it where an invalid config must
 * surface loudly (e.g. validating a committed example vertical fixture, or any
 * caller that wants the guarantee that the input genuinely conforms). The
 * validated partial is merged onto DEFAULT_CONFIG via the same `mergeStored`
 * path `readConfig()` uses, so the returned object is always a complete config.
 */
export function parseConfig(raw: unknown): GremionConfig {
  const stored = gremionConfigSchema.parse(raw)
  return mergeStored(stored)
}

// Per-tenant readConfig — reads tenant.configPath unconditionally (§8.1 /
// D-CONFIGPATH; the default row's configPath is registry-derived from the CONFIG_PATH
// env, byte-identical). Composed with P0.2's mergeStored/parseConfig extraction.
export function readConfig(tenant: ConfigTenant = requireTenant()): GremionConfig {
  const path = getConfigPath(tenant)
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }

  // G-016: corrupt JSON used to bubble out of readConfig and 500 the entire
  // server (every request reads config via hooks). Fall back to defaults so a
  // half-written or hand-edited file never takes the portal offline; the
  // warning surfaces the corruption in container logs / journalctl so an
  // operator can repair it.
  //
  // G-067: in addition to JSON.parse errors, also validate the parsed object
  // structurally via `gremionConfigSchema`. The previous code path used an
  // unsound cast on the parsed JSON that let a hand-edited file with a
  // type-confused value (e.g. setup_complete as a string) flow into the
  // rest of the app. We now schema-validate first and fall back to defaults
  // on either parse error or shape mismatch.
  let stored: StoredConfig = {}
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const validated = gremionConfigSchema.safeParse(parsed)
    if (!validated.success) {
      console.warn(
        `[config] ${path} failed schema validation, falling back to defaults:`,
        validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      )
      stored = {}
    } else {
      stored = validated.data
    }
  } catch (err) {
    console.warn(
      `[config] failed to parse ${path}, falling back to defaults:`,
      err instanceof Error ? err.message : err,
    )
    stored = {}
  }

  // Deep-merge nested object fields so configs persisted before a schema
  // extension still surface the new defaults on read.
  return mergeStored(stored)
}

// Two-level partial — top-level keys are optional, and within each top-level
// object key its own fields are optional. Matches the shallow-merge depth of
// writeConfig: callers can patch e.g. `{ org: { domain: 'x.de' } }` without
// having to supply every org sibling. Records inside nested objects (like
// `org.portal_sections`) accept any key shape because Record<string, boolean>
// is index-typed — partial-of-Record is identical to Record itself for the
// purpose of merging.
type ConfigUpdate = {
  [K in keyof GremionConfig]?: NonNullable<GremionConfig[K]> extends object
    ? Partial<NonNullable<GremionConfig[K]>>
    : GremionConfig[K]
}

export function writeConfig(update: ConfigUpdate, tenant: ConfigTenant = requireTenant()): GremionConfig {
  // G-074 + G-098: validate at the load-bearing chokepoint. Route handlers
  // also pre-validate (for richer error responses), but any direct internal
  // caller that bypasses the routes still gets the same gate here. `.strict()`
  // rejects unknown top-level keys — e.g. `{ orgg: {...} }` (typo) now throws
  // instead of being silently merged and forgotten.
  const validated = configUpdateSchema.safeParse(update)
  if (!validated.success) {
    const summary = validated.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`writeConfig: invalid update — ${summary}`)
  }
  const current = readConfig(tenant)

  // Enforce required modules cannot be disabled
  const mergedModules = { ...current.modules, ...update.modules }
  for (const mod of REQUIRED_MODULES) {
    ;(mergedModules as Record<string, boolean>)[mod] = true
  }

  // Clamp backup retention to minimum 7 days
  const mergedBackups = { ...current.backups, ...update.backups }
  mergedBackups.retention_days = Math.max(7, mergedBackups.retention_days)

  // Merge and enforce hard caps on log retention tiers (GDPR / BSI Mindeststandard)
  const mergedRetention = { ...current.retention, ...update.retention }
  mergedRetention.access_logs_days = Math.min(mergedRetention.access_logs_days, 30)
  mergedRetention.app_logs_days = Math.min(mergedRetention.app_logs_days, 90)
  mergedRetention.security_logs_days = Math.min(mergedRetention.security_logs_days, 180)
  mergedRetention.security_nopii_logs_days = Math.min(mergedRetention.security_nopii_logs_days, 365)

  const mergedCompliance = { ...current.compliance, ...update.compliance }

  // setup_complete is append-only (true → false is not allowed)
  const setupComplete = current.setup_complete || update.setup_complete === true

  // Shallow-merge nested object fields so partial PATCHes don't drop sibling keys.
  // org.portal_sections is itself a record — merge one level deeper so partial
  // toggle updates preserve untouched sections.
  const next: GremionConfig = {
    ...current,
    ...update,
    org: {
      ...current.org,
      ...update.org,
      // DeepPartial widens record values to `boolean | undefined`. The spread
      // preserves runtime semantics (omitted keys keep current value), but the
      // result type loses the boolean-only guarantee — assert it back.
      portal_sections: {
        ...current.org.portal_sections,
        ...update.org?.portal_sections,
      } as Record<string, boolean>,
    },
    brand: { ...current.brand, ...update.brand },
    // P2.2-data: terms is an optional flat record — an update carrying `terms`
    // replaces the whole map (overrides can be removed by omission); an update
    // without it keeps the current one. No `{...}` merge: that would
    // materialize an empty `{}` on every write and the default config must
    // stay free of the key (StuRa = no overrides).
    terms: (update.terms ?? current.terms) as GremionConfig['terms'],
    // P2.2-auth (D-VOCAB): roles mirrors terms — an update carrying `roles`
    // replaces the whole vocabulary; one without it keeps the current one. No
    // `{...}` merge, and the default config stays free of the key (StuRa
    // tenant #1 = the Role enum).
    roles: (update.roles ?? current.roles) as GremionConfig['roles'],
    smtp: { ...current.smtp, ...update.smtp },
    // P2.1c (D-WIZARD/D2): shallow-merge the single-field deployment object so a
    // partial update keeps the current mode when absent (current always carries
    // a mode via readConfig's back-fill).
    deployment: { ...current.deployment, ...update.deployment } as GremionConfig['deployment'],
    legal: { ...current.legal, ...update.legal },
    modules: mergedModules as GremionConfig['modules'],
    backups: mergedBackups,
    retention: mergedRetention,
    compliance: mergedCompliance,
    setup_complete: setupComplete,
    // wizard_steps and admin_accounts are not surfaced via the public PATCH
    // endpoint, but internal callers (setup wizard) may patch a single field —
    // deep-merge so partial updates don't drop siblings.
    wizard_steps: { ...current.wizard_steps, ...update.wizard_steps },
    admin_accounts: { ...current.admin_accounts, ...update.admin_accounts },
  }

  // G-016: atomic write — write to a sibling tmp file first then rename. A
  // crash mid-`writeFileSync` would otherwise leave a half-written JSON blob
  // that subsequent reads can't parse. `renameSync` is atomic on the same
  // filesystem (POSIX rename(2) / NTFS MoveFileEx), so a reader either sees
  // the old file or the fully-written new one — never a partial.
  const target = getConfigPath(tenant)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, target)
  return next
}
