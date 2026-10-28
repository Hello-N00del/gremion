// src/lib/server/board/register.server.ts
// TRD-196: the board module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports board
// internals. Loaded for its side effects by the generated server-init barrel.
import { registerErasureHook } from '$lib/server/modules/runtime-registry'
import { boardErasureHook } from './erasure'

registerErasureHook(boardErasureHook)
