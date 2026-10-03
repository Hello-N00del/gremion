// The messaging module's contribution to the shell chrome (TASK-205b; see $lib/modules/layout-slot.ts).
// TopBar renders each part in a fixed place with fixed below-768 px rules (topbar-slot.ts): the Matrix chip is
// hidden below the rail breakpoint (it lives in the drawer there), the live-call indicator and the bell stay.
// The video-call picture-in-picture is mounted once beside the shell for a signed-in user.
import type { ModuleLayoutSlot } from '$lib/modules/layout-slot'
import MatrixChip from '$lib/components/messaging/MatrixChip.svelte'
import CallLiveChip from '$lib/components/messaging/CallLiveChip.svelte'
import NotificationBell from '$lib/components/messaging/NotificationBell.svelte'
import VideoCallPip from '$lib/components/VideoCallPip.svelte'

const slot: ModuleLayoutSlot = {
  chips: MatrixChip,
  liveCall: CallLiveChip,
  bell: NotificationBell,
  overlay: VideoCallPip,
}

export default slot
