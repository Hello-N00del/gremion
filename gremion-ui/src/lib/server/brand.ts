// src/lib/server/brand.ts
// Server-side per-tenant brand resolution. Distinct from the client-bundled
// $lib/brand: this reads server config + the resolved TenantContext and FAILS
// CLOSED — an unresolved tenant throws rather than silently rendering one
// tenant's identity (P2.1a §3.4).
import type { Brand } from '$lib/brand'
import type { GremionConfig, ConfigTenant } from './config'
import { readConfig } from './config'
import { requireTenant } from '$lib/server/tenant/context'
import { resolvePaletteId } from '$lib/theme/instance-theme'

/** Map a (per-tenant) GremionConfig to the client-safe Brand model. Canonical
 *  mapping previously inlined in routes/+layout.server.ts loadBrand. */
export function brandFromConfig(cfg: GremionConfig): Brand {
  return {
    product: cfg.brand.product,
    logoLetter: cfg.brand.logo_letter,
    orgShort: cfg.brand.org_short,
    term: cfg.brand.term,
    orgName: cfg.org.name || cfg.brand.org_short,
    domain: cfg.org.domain,
    version: cfg.brand.version,
    // gremion#22: per-tenant curated accent palette. `cfg.brand.palette` is a
    // structurally-validated string at this point (zod), NOT yet guaranteed to
    // be a curated id — resolvePaletteId is the runtime gate that makes the
    // client-facing Brand.palette id-only (a stray/hand-edited/legacy-shaped
    // value maps to `null` + a server warning rather than leaking a freeform
    // string to the client, same as the pre-#22 behaviour normalized `?? null`
    // for an absent field, now extended to also curate a present-but-invalid one).
    palette: resolvePaletteId(cfg.brand.palette),
    logoUrl: cfg.brand.logo_url ?? null,
  }
}

/** The resolved per-tenant brand. Fail-closed via requireTenant(). */
export function requireBrand(tenant: ConfigTenant = requireTenant()): Brand {
  return brandFromConfig(readConfig(tenant))
}
