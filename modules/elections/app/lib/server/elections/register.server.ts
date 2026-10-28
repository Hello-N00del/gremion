// src/lib/server/elections/register.server.ts
// Civitas Session-A inversion A1: the elections module self-registers its
// per-tenant Helios session evictor into the runtime-registry seam, so the
// tenant registry never imports elections internals (this removes the
// no-deep-import-into-elections allow entry that named tenant/registry.ts).
// Loaded for its side effects by the generated server-init barrel.
import { registerErasureHook, registerTenantEvictHook } from '$lib/server/modules/runtime-registry'
import { electionsErasureHook } from './erasure'
import { evictHeliosSession } from './helios-client'

// The per-tenant Helios session the elections module caches. The tenant
// registry's evictTenantRuntime runs this on the suspend/delete lifecycle seam.
registerTenantEvictHook(evictHeliosSession)

// TRD-196: the elections module's data-subject erasure step.
registerErasureHook(electionsErasureHook)
