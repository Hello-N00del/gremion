// src/lib/modules/layout-slot.ts
//
// TASK-205b: the interim client-side composition seam for module halves that contribute chrome to the shell.
//
// A feature module does not edit TopBar.svelte or +layout.svelte (topbar-slot.ts: "a feature module does not
// edit TopBar.svelte"). It ships ONE file, `lib/modules/slots/<id>.slot.ts`, whose default export is a
// ModuleLayoutSlot: the Svelte components for the TopBar's three slot parts (chips, liveCall, bell, see
// $lib/components/layout/topbar-slot.ts for the below-768 px rules) and an optional overlay mounted once beside
// the shell (the video-call picture-in-picture). The root layout globs `slots/*.slot.ts` (eager), so a module
// that is not built simply has no file, and removing a module's half removes its chrome with it.
//
// TASK-125 (TRD-411 composition and its drift guard) replaces this glob with the composed module registry.
import type { Component } from 'svelte'
import type { SessionUser } from '$lib/auth/types'

export interface ModuleLayoutSlot {
  /** Status chips (hidden below the rail breakpoint). */
  chips?: Component
  /** The live-call indicator (kept below the breakpoint). */
  liveCall?: Component
  /** The notification bell (kept below the breakpoint; its target is at least the shell control size). */
  bell?: Component
  /** Mounted once beside the shell for a signed-in user (e.g. the call picture-in-picture). */
  overlay?: Component<{ user: SessionUser | undefined }>
}
