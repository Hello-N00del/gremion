// gremion-ui/src/lib/auth/capabilities.ts
// Kernel-side capability seam. This file is part of $lib/auth (client-safe) and
// MUST NOT depend on any feature module: CapabilityId is the GENERIC kernel id
// type (`string`), and the only manifest it reads is the always-on CORE manifest
// (for the platform admin / it-admin group literals). The concrete finance
// capability union + the ref-finanzen* group literals live in the finance
// feature module ($lib/modules/finance/capabilities), not here.
import { coreManifest } from '$lib/modules/manifests/core'
import { composeCapabilities } from '$lib/modules/registry'
import type { TenantVocabularySource } from './types'

// Platform group literals owned by the core manifest (admin / it-admin). Read
// via a cast rather than a load-time guard: core always declares these, and the
// values are pinned by capabilities.test.ts (PLATFORM_GROUPS.itAdmin) +
// registry.test.ts (core/finance group goldens). No throw at module load.
const platform = coreManifest.groups as Record<string, string>
export const PLATFORM_GROUPS = { admin: platform.admin, itAdmin: platform.itAdmin } as const

/** Generic kernel capability id. Concrete per-module unions (e.g. the finance
 *  capability union in $lib/modules/finance/capabilities) narrow this. */
export type CapabilityId = string

// CAPABILITIES flows through the registry's composeCapabilities() so the registry
// is the single composition seam (Pillar-3 ready); every module contributes its
// own capabilities (pinned equal to the merged manifest maps by registry.test.ts).
export const CAPABILITIES = composeCapabilities() as Record<CapabilityId, readonly string[]>

/**
 * P2.2-auth A4 (D-CONST): the tenant-aware CAPABILITIES accessor — the
 * counterpart of pageAccessForTenant ($lib/auth/index.ts). The DEFAULT tenant
 * (no `config.roles` override) resolves to the SAME golden CAPABILITIES object
 * above (referential, tenant #1 byte-identical); an override tenant delegates
 * to the vocabulary-arg compose seam (content-identical today — capabilities
 * are GROUP-keyed; P2.3 owns per-tenant shaping). The nav filter routes
 * through this via makeAuthHelpers' capabilities arg (+layout.server.ts).
 */
export function capabilitiesForTenant(
  ctx: TenantVocabularySource,
): Record<CapabilityId, readonly string[]> {
  const override = ctx.config.roles
  return override === undefined
    ? CAPABILITIES
    : (composeCapabilities(override) as Record<CapabilityId, readonly string[]>)
}

/** The groups that grant a capability (any-of). */
export function capabilityGroups(id: CapabilityId): readonly string[] {
  return CAPABILITIES[id]
}
