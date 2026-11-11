// src/lib/server/board/register.server.ts
// TRD-196: the board module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports board
// internals. Loaded for its side effects by the generated server-init barrel.
import { registerErasureHook } from '$lib/server/modules/runtime-registry'
import { registerNoRetention } from '$lib/server/module-karenz/retained/extractors'
import { boardErasureHook } from './erasure'

registerErasureHook(boardErasureHook)

// Module Karenz (phase 2): the board owns NO module database. Its boards, stacks and cards (RC-BRD) live in
// the tenant's own kernel database (migration 0034, read through getDb()), and modules/board/module.json
// declares neither a runtime database nor an export. So a platform disable_module has nothing to export or
// block: it drops the platform enablement and opens a Karenz row without an export. The module-switch
// reconciler follows that state and sets config.modules.board false (it follows the platform for the board
// although a council may not switch it), so every board page and api answers as for a disabled module.
// A switch-off HIDES the board and deletes nothing: the rows stay in the kernel tables, and a later enable
// shows the same boards again. No board participant is registered, so the Karenz final step deletes none of
// them either, and no sealed copy is written. Without the declaration below the retained step fails closed
// on every pass.
registerNoRetention('board')
