// src/lib/brand.ts
//
// Client-safe tenant branding model (v4 re-audit slice 10). The handoff
// (design_handoff_stura_v4/design_files/web/seed-stub.ts `BRAND`) defines this
// as the single source for institution-specific UI strings. The root
// +layout.server.ts derives a `Brand` from the server config (lib/server/config.ts)
// and ships it in the layout payload; shell components read it via
// `page.data.brand`, falling back to DEFAULT_BRAND when absent.
//
// MUST stay free of server-only imports — it is bundled into the client.

import type { PaletteId } from '$lib/theme/instance-theme'

export interface Brand {
  product: string
  logoLetter: string
  orgShort: string
  term: string
  orgName: string
  domain: string
  version: string
  // gremion#22 (theming parity, supersedes the freeform #288 accent field):
  // per-tenant CURATED accent palette id + logo URL (config.brand.palette /
  // config.brand.logo_url via lib/server/brand.ts brandFromConfig, validated
  // against $lib/theme/instance-theme TENANT_PALETTES). NULL = today's
  // rendering — app.css accent tokens + the logoLetter mark.
  palette: PaletteId | null
  logoUrl: string | null
}

/** Neutral client fallback. Institution-agnostic placeholders — the real per-
 *  tenant brand is resolved server-side (lib/server/brand.ts requireBrand) and
 *  shipped in the layout payload. An unresolved tenant errors server-side; this
 *  fallback exists only so a transient missing-page.data.brand never crashes the
 *  client shell. (P2.1a §3.4.) */
export const DEFAULT_BRAND: Brand = {
  product: 'Portal',
  logoLetter: 'P',
  orgShort: 'Portal',
  term: '—',
  orgName: 'Portal',
  domain: 'localhost',
  version: 'v0',
  palette: null,
  logoUrl: null,
}

/**
 * Merge a partial brand (e.g. from `page.data.brand`) over the defaults.
 *
 * P2.1c (T15 / §6-P2.2 finding B): an EMPTY (or whitespace-only) STRING field is
 * treated as ABSENT — it falls through to the neutral DEFAULT_BRAND placeholder
 * rather than overriding it with a blank. After brand-neutralization an
 * un-materialized tenant's config resolves `product`/`org_short` to `''`;
 * without this an unbranded deploy would render a
 * literally blank product/org name. With it the WORST case is the neutral
 * 'Portal' fallback — consistent with the loud per-tenant boot/readiness guard
 * (finding A): readiness fails such a tenant loudly, and IF anything still
 * renders, it shows 'Portal', never blank. The default (materialized) tenant
 * carries real non-empty brand values, so this is byte-identical for it (a
 * non-empty string always wins). Nullable fields (`palette`/`logoUrl`) keep their
 * explicit `null`/value — only string fields get the empty-string-as-absent
 * treatment.
 */
export function resolveBrand(partial?: Partial<Brand> | null): Brand {
  // Treat an empty/whitespace-only STRING in the partial as ABSENT so it falls
  // through to the DEFAULT_BRAND placeholder rather than overriding it with a
  // blank. `??` alone is not enough — '' is a defined value that would win the
  // spread. The required (non-null) string fields are listed explicitly so each
  // stays statically typed; the nullable palette/logoUrl keep their value/null.
  const p = partial ?? {}
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v.trim().length > 0 ? v : fallback
  return {
    product: str(p.product, DEFAULT_BRAND.product),
    logoLetter: str(p.logoLetter, DEFAULT_BRAND.logoLetter),
    orgShort: str(p.orgShort, DEFAULT_BRAND.orgShort),
    term: str(p.term, DEFAULT_BRAND.term),
    orgName: str(p.orgName, DEFAULT_BRAND.orgName),
    domain: str(p.domain, DEFAULT_BRAND.domain),
    version: str(p.version, DEFAULT_BRAND.version),
    // Nullable per-tenant fields: an undefined key falls back to the default
    // (null); an explicit null or a real value is preserved as-is.
    palette: p.palette === undefined ? DEFAULT_BRAND.palette : p.palette,
    logoUrl: p.logoUrl === undefined ? DEFAULT_BRAND.logoUrl : p.logoUrl,
  }
}
