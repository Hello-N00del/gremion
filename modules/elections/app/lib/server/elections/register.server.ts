// src/lib/server/elections/register.server.ts
// Civitas Session-A inversion A1: the elections module self-registers its
// per-tenant Helios session evictor into the runtime-registry seam, so the
// tenant registry never imports elections internals (this removes the
// no-deep-import-into-elections allow entry that named tenant/registry.ts).
// Loaded for its side effects by the generated server-init barrel.
//
// Module Karenz (phase 2, Task 14): the same seam carries the elections participant (pause and restore
// the Helios elections), its sealed election results and, while Helios offers no pause, the switch-off
// guard that keeps a running election from being left behind.
import { registerErasureHook, registerTenantEvictHook } from '$lib/server/modules/runtime-registry'
import { registerKarenzParticipant } from '$lib/server/module-karenz/participants'
import { registerRetentionExtractor } from '$lib/server/module-karenz/retained/extractors'
import { registerSwitchOffGuard } from '$lib/server/module-switch/guards'
import { electionsErasureHook } from './erasure'
import { evictHeliosSession } from './helios-client'
import { heliosPause } from './helios-pause'
import { electionResultsExtractor, electionsKarenz, electionsSwitchOffGuard } from './karenz'

// The per-tenant Helios session the elections module caches. The tenant
// registry's evictTenantRuntime runs this on the suspend/delete lifecycle seam.
registerTenantEvictHook(evictHeliosSession)

// TRD-196: the elections module's data-subject erasure step.
registerErasureHook(electionsErasureHook)

registerKarenzParticipant(electionsKarenz)
registerRetentionExtractor(electionResultsExtractor)
// With no way to pause Helios, a running election must keep the module on (Open Decision 11).
if (heliosPause().mode === 'unsupported') registerSwitchOffGuard('elections', electionsSwitchOffGuard)
