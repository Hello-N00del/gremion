// src/lib/server/tenant/provisioner/materialize.ts
// P2.1c (T15) — materialize-config PURE logic (no IO). The CLI subcommand
// `tenant-provision materialize-config <slug>` (scripts/tenant-provision.ts)
// reads a tenant's stored config.json, runs it through `materializeConfig`, and
// writes the FULLY-MERGED effective config back. After T15 the DEFAULT_CONFIG
// brand block is NEUTRAL (empty institution identity); materialization bakes the
// current effective defaults into the stored file so the resolved config is
// self-contained and no institution literal needs to live in source (§6-P2.2).
//
// The §6-P2.2 boot guard lives here too: `assertBrandIdentityComplete` refuses
// (loudly) a config whose brand identity is still empty AFTER neutralization —
// no silent blank, and (now that the institution-specific defaults are gone) no silent
// one-institution rendering. The materialize CLI calls it after merging; the
// per-tenant boot-readiness wiring (P2.1b) can adopt the same predicate.
import { parseConfig, type GremionConfig } from '$lib/server/config'

/**
 * Produce the fully-merged effective config from a raw (already JSON-parsed)
 * stored config object. Delegates to `parseConfig`, which validates the input
 * structurally and merges the validated partial onto DEFAULT_CONFIG — so this
 * THROWS (loud) on a malformed stored file rather than silently defaulting, and
 * back-fills every field the stored file predates (incl. the neutral brand /
 * legal defaults). An empty `{}` materializes to the pure neutral defaults.
 */
export function materializeConfig(rawStored: unknown): GremionConfig {
  return parseConfig(rawStored ?? {})
}

/**
 * §6-P2.2 brand-identity completeness: a tenant's effective brand carries a real
 * institution identity iff product AND org_short are both non-empty
 * (whitespace-only counts as empty). After neutralization an un-materialized
 * tenant has both empty, which this reports as incomplete. (The former
 * matrix_homeserver requirement was dropped with the open-core carve — Matrix is
 * a feature-module satellite, not part of the governance kernel's brand identity.)
 */
export function brandIdentityComplete(config: GremionConfig): boolean {
  const b = config.brand
  return (
    b.product.trim().length > 0 &&
    b.org_short.trim().length > 0
  )
}

/**
 * Loud guard: throw unless the (materialized) config has a complete brand
 * identity. Names the offending tenant slug and the remedy (`materialize-config`
 * with a real config) so the failure is actionable. Used by the materialize CLI
 * after merge; the boot path can consult `brandIdentityComplete` to fail a
 * tenant's readiness (tenant-scoped 503) instead of rendering a blank brand.
 */
export function assertBrandIdentityComplete(config: GremionConfig, slug: string): void {
  if (!brandIdentityComplete(config)) {
    throw new Error(
      `tenant "${slug}" config has an INCOMPLETE brand identity (product / org_short ` +
        `must both be set). After P2.1c brand-neutralization the ` +
        `defaults are empty placeholders — populate the tenant config.json with the ` +
        `real institution identity (Setup wizard / Settings) and run ` +
        `\`tenant-provision materialize-config ${slug}\` before serving.`,
    )
  }
}
