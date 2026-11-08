// src/lib/server/elections/helios-pause.ts
// Module Karenz (phase 2, Task 14): the one seam through which the elections participant pauses and
// resumes a Helios election.
//
// The Helios source is not part of this repository (docs/ops/vendor-patch-notice.md), so whether and how
// an election can be paused is a fact of the deployed instance, not something this file may assume. The
// mode below records what the probe on the running test stack found; it ships `unsupported`, and an
// unsupported port refuses every lock and unlock. The participant then marks the election lock_failed and
// fails its step loudly, and the switch-off guard (karenz.ts) refuses to switch elections off while an
// election is open. Nothing here closes an election it cannot verifiably reopen.
//
// Port contract (the participant relies on all of it):
//   lock(uuid)             After `ok: true` the election reads as closed (HeliosClient.getElection ->
//                          deriveLifecycle 'closed'). Idempotent: locking a locked election is ok.
//   unlock(uuid, remainingMs)
//                          After `ok: true` the election reads as open and ends `remainingMs` after now.
//                          Idempotent in the same way. The participant verifies both by reading back, so a
//                          port that answers ok without the effect is caught there.
// A reason is a short machine-readable label (an HTTP status, `unsupported`), never a message from Helios.

export type HeliosPauseResult = { ok: true } | { ok: false; reason: string }

export interface HeliosPausePort {
  readonly mode: 'extend' | 'unsupported'
  lock(uuid: string): Promise<HeliosPauseResult>
  unlock(uuid: string, remainingMs: number): Promise<HeliosPauseResult>
}

/** What the extend implementation does against Helios; written once the probe has shown which admin forms exist. */
export interface HeliosExtendImpl {
  lock(uuid: string): Promise<void>
  unlock(uuid: string, remainingMs: number): Promise<void>
}

/**
 * The mode of the deployed Helios. `unsupported` until the probe on the running test stack (list the admin
 * endpoints for an unfrozen and a frozen election) has been done and recorded in the pull request; the
 * probe is owed after deploy. Flip it together with the extend implementation, never alone.
 */
export const HELIOS_PAUSE_MODE: HeliosPausePort['mode'] = 'unsupported'

const refuse = (reason: string): HeliosPauseResult => ({ ok: false, reason })

/** A short label of a failure: the HTTP status when the message carries one, else the error class. Never the message text. */
function reasonOf(e: unknown): string {
  const status = e instanceof Error ? /→\s*(\d{3})\b/.exec(e.message) : null
  if (status) return `HTTP ${status[1]}`
  return e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'error'
}

export function heliosPause(mode: HeliosPausePort['mode'] = HELIOS_PAUSE_MODE, impl?: HeliosExtendImpl): HeliosPausePort {
  if (mode === 'unsupported') {
    return { mode, lock: async () => refuse('unsupported'), unlock: async () => refuse('unsupported') }
  }
  if (!impl) {
    // extend was declared but nothing implements it yet: say so instead of pretending to pause
    return { mode, lock: async () => refuse('not implemented'), unlock: async () => refuse('not implemented') }
  }
  const run = async (fn: () => Promise<void>): Promise<HeliosPauseResult> => {
    try {
      await fn()
      return { ok: true }
    } catch (e) {
      return refuse(reasonOf(e))
    }
  }
  return { mode, lock: (uuid) => run(() => impl.lock(uuid)), unlock: (uuid, remainingMs) => run(() => impl.unlock(uuid, remainingMs)) }
}
