// src/lib/server/module-switch/listeners.ts
// Karenz phase 1 (Task 13): who hears that a council module request reached a final state.
//
// The reconciler (reconciler.ts) calls notifyModuleSwitchListeners once per request (the atomic
// claimNotification decides who). Phase 1 registers no listener; phase 2 registers the info mail and
// the Karenz bookkeeping here. This is Interface I-2 (listener part) for phase 2.
//
// Delivery is AT-MOST-ONCE by design: the notified_at claim happens before the call, so a process
// that dies in between loses the event. A listener that must not lose one keeps its own ledger.

export interface ModuleSwitchEvent {
  requestId: string
  tenantId: string
  slug: string
  /** Catalogue id (what the platform knows). */
  moduleId: string
  /** The config.modules key, or null when the id is not switchable. */
  manifestId: string | null
  action: 'enable' | 'disable'
  outcome: 'applied' | 'failed' | 'refused' | 'expired' | 'dead'
  /** Audit only; NEVER put it in a mail. */
  actorUserId: string
  at: Date
  /** The executor's outcome text, when there is one. */
  detail: string | null
}

export type ModuleSwitchListener = (e: ModuleSwitchEvent) => Promise<void>

const listeners: ModuleSwitchListener[] = []

/** Register a listener. Called in registration order; a second registration of the same function adds it again. */
export function registerModuleSwitchListener(l: ModuleSwitchListener): void {
  listeners.push(l)
}

/**
 * Call every listener in turn. A listener that rejects (or throws) is caught and logged and never
 * stops the next one; this function itself never rejects.
 */
export async function notifyModuleSwitchListeners(e: ModuleSwitchEvent): Promise<void> {
  for (const l of listeners) {
    try {
      await l(e)
    } catch (err) {
      console.error(`[module-switch] listener failed for request ${e.requestId} (${e.action} ${e.moduleId} ${e.outcome}):`, err instanceof Error ? err.message : err)
    }
  }
}

/** Test-only: drop every registered listener. */
export function _clearModuleSwitchListenersForTests(): void {
  listeners.length = 0
}
