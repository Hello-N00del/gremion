// The files module's contribution to the shell (see $lib/modules/layout-slot.ts).
// The document editor takes the whole viewport in its own tab: no rail, no top bar. On a phone the shell
// left the Collabora iframe a sliver; the editor page carries its own thin bar with Schließen instead.
import type { ModuleLayoutSlot } from '$lib/modules/layout-slot'

const slot: ModuleLayoutSlot = {
  bareRoutes: ['/files/edit'],
}

export default slot
