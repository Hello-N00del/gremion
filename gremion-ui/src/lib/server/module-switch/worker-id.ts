// src/lib/server/module-switch/worker-id.ts
// The id the module switch reconciler runs under: the label in logs and the single-flight key
// (`<id>::<tenant id>`) of worker-fleet. Its own file so the timer (register.server.ts) and the on-demand run
// (on-demand.ts) share ONE key without the second importing the first's side effects.

/** The id the reconciler reports under in logs and single-flight. */
export const MODULE_SWITCH_WORKER = 'module-switch'
