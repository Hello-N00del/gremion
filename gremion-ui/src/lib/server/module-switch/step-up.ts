// src/lib/server/module-switch/step-up.ts
// Karenz phase 1: the step-up a module switch needs. Same env contract as erasure/step-up.ts: a FRESH
// LoA 2 through evaluateStepUp with the platform-wide STEPUP_FRESHNESS_SECONDS window (default 300 s).
// There is no off switch. The executor re-verifies the signed tokens on its side (acr loa2, sign-in
// within the evidence window), so this is the first of two checks, not the only one.
import { env } from '$env/dynamic/private'
import { LOA } from '$lib/auth/step-up'

export const MODULE_SWITCH_REQUIRED_LOA = LOA.STEP_UP

export function moduleSwitchStepUpFreshnessSeconds(): number {
  const n = Number(env.STEPUP_FRESHNESS_SECONDS ?? '300')
  return Number.isFinite(n) && n > 0 ? n : 300
}
