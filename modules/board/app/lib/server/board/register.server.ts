// src/lib/server/board/register.server.ts
// TRD-196: the board module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports board
// internals. Loaded for its side effects by the generated server-init barrel.
import { registerDataProvider, registerErasureHook } from '$lib/server/modules/runtime-registry'
import { registerNoRetention } from '$lib/server/module-karenz/retained/extractors'
import { boardErasureHook, deleteBoardsOfOrgUnit } from './erasure'
import { boardRefsOfOrgUnit } from './org-unit-refs'

registerErasureHook(boardErasureHook)

// The org-unit cascade. While a customer's boards live in the kernel tables, deleting an org unit removes
// them by the database cascade of migration 0034. In the board module's own database nothing cascades
// (the leaf keeps no foreign key to the kernel's org units), so the kernel's deleteOrgUnit(id) asks here
// after its own commit. The kernel reaches it only through this seam: it never imports module code.
registerDataProvider('board:delete-org-unit-boards', deleteBoardsOfOrgUnit)

// The question before the delete: does the unit still have boards? The kernel's committee delete asks
// this first and refuses while the answer is yes, so a council never loses its cards through a delete.
registerDataProvider('board:org-unit-refs', boardRefsOfOrgUnit)

// Module Karenz (phase 2): the board is a module like finance. Where its rows live is one flag per
// customer (backend/location.ts): in the customer's kernel tables (migration 0034, read through getDb()) or,
// once moved, in the board module's own database, served by the board leaf. A platform disable_module then
// exports and blocks that database like finance's, or, for a customer whose board is still in the kernel
// tables, opens a Karenz row without an export. The module-switch reconciler follows that state and sets
// config.modules.board false (it follows the platform for the board although a council may not switch it),
// so every board page and api answers as for a disabled module.
// PREREQUISITE: that hide exists only while the reconciler runs. gremion-ui module-switch/register.server.ts
// leaves it off when the council requester pool is not configured (the platform modules connection string
// is empty; the deploy wiring leaves it empty when the modules role password is unset, see
// modules/board/README.md); there a platform disable does NOT hide the board. A customer created
// with board unticked has no platform row, so nothing follows and the board stays on by default.
// A switch-off HIDES the board and deletes nothing: the rows stay where they are (kernel tables or the
// blocked module database). A later enable shows the same boards again for a board in its module
// database (it restores the blocked database); for an active customer whose board is still in the kernel
// tables a later enable is refused by the module gate, because it would create an empty module database
// beside the kernel rows, and the move that carries them is not part of this release. Such a board
// is hidden by setting config.modules.board to false by hand (modules/board/README.md). The board retains no K-class
// record, so no participant is registered here and the Karenz final step seals no copy of it. Without the
// declaration below the retained step fails closed on every pass.
registerNoRetention('board')
