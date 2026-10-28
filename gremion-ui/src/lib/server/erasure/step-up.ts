// TRD-196 MED-4 — the step-up requirement for STARTING an erasure (irreversible,
// cross-module). Same enforcement as the vault reveal (#405) and finance (#164):
// a FRESH LoA 2 via evaluateStepUp, with the platform-wide STEPUP_FRESHNESS_SECONDS
// window (default 300). There is no off switch: an erasure cannot be undone.
import { env } from '$env/dynamic/private'
import { LOA } from '$lib/auth/step-up'

export const ERASURE_REQUIRED_LOA = LOA.STEP_UP

export function erasureStepUpFreshnessSeconds(): number {
  const n = Number(env.STEPUP_FRESHNESS_SECONDS ?? '300')
  return Number.isFinite(n) && n > 0 ? n : 300
}
