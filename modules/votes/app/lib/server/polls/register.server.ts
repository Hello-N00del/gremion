// src/lib/server/polls/register.server.ts
// TRD-196: the votes module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports votes
// internals. Loaded for its side effects by the generated server-init barrel.
import { registerErasureHook } from '$lib/server/modules/runtime-registry'
import { votesErasureHook } from './erasure'

registerErasureHook(votesErasureHook)
