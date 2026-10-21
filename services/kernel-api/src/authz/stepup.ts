// services/kernel-api/src/authz/stepup.ts — TRD-090 step-up freshness from the
// ALREADY-VERIFIED token claims (RFC 9470 / NIST SP 800-63B-4 s.5.2): acr at
// least loa2 AND auth_time within STEPUP_MAX_AGE seconds. A missing claim
// refuses (never "assume fresh"). No second token verification happens here.
export const STEPUP_MAX_AGE_SECONDS = 300
const SKEW_SECONDS = 60

export type StepUpVerdict = { ok: true } | { ok: false; reason: 'acr_insufficient' | 'auth_time_missing' | 'auth_time_stale' }

function acrLevel(acr: unknown): number {
  if (typeof acr === 'number' && Number.isFinite(acr)) return acr
  if (typeof acr !== 'string') return 0
  const m = /^(?:loa)?(\d+)$/i.exec(acr.trim())
  return m ? Number(m[1]) : 0
}

export function checkStepUp(claims: Record<string, unknown>, nowSeconds: number = Math.floor(Date.now() / 1000), maxAge: number = STEPUP_MAX_AGE_SECONDS): StepUpVerdict {
  if (acrLevel(claims.acr) < 2) return { ok: false, reason: 'acr_insufficient' }
  const t = claims.auth_time
  if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, reason: 'auth_time_missing' }
  if (t > nowSeconds + SKEW_SECONDS || nowSeconds - t > maxAge) return { ok: false, reason: 'auth_time_stale' }
  return { ok: true }
}
