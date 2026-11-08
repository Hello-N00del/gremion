// src/lib/server/board/register.server.ts
// TRD-196: the board module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports board
// internals. Loaded for its side effects by the generated server-init barrel.
import { registerErasureHook } from '$lib/server/modules/runtime-registry'
import { registerNoRetention } from '$lib/server/module-karenz/retained/extractors'
import { boardErasureHook } from './erasure'

registerErasureHook(boardErasureHook)

// Module Karenz (phase 2): boards and cards (RC-BRD) are kept only for the grace after a disablement, through
// the pg_dump export of the blocked database (RC-MOD-EXPORT); no sealed copy is written. Without this
// declaration the retained step fails closed on every pass.
registerNoRetention('board')
