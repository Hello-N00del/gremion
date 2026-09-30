// T6 (#320 contestability UI): pure client-side helper for the /beschluesse
// 'Anfechten' (challenge) form. Kept dependency-free under src/lib/governance
// (committee-color/compute-result precedent) so the unit suite covers it
// without a server or DB.
//
// The upper bound mirrors migration 055's CHECK
// (char_length(grounds) BETWEEN 1 AND 4000) so an over-long Begründung gets a
// German message client-side instead of surfacing as a DB CHECK violation.

export const CHALLENGE_GROUNDS_MAX = 4000

export type ChallengeGroundsResult =
  | { ok: true; grounds: string }
  | { ok: false; error: string }

/** Validate (and trim) the member's Begründung. The bound is measured on the
 * TRIMMED text — that is what buildChallengePayload actually sends. */
export function validateChallengeGrounds(raw: string): ChallengeGroundsResult {
  const grounds = raw.trim()
  if (grounds.length === 0) {
    return { ok: false, error: 'Begründung ist erforderlich.' }
  }
  if (grounds.length > CHALLENGE_GROUNDS_MAX) {
    return { ok: false, error: `Begründung darf höchstens ${CHALLENGE_GROUNDS_MAX} Zeichen umfassen.` }
  }
  return { ok: true, grounds }
}

export interface ChallengePostRequest {
  url: string
  method: 'POST'
  body: { grounds: string }
}

/** Build the request for POST /api/protocols/resolutions/[resId]/challenges
 * (T2 contract: JSON body { grounds }; the challenger identity comes from the
 * session server-side, never from the body). Throws the German validation
 * message when the grounds are invalid — callers validate first for inline
 * display; the throw is the last-line guard against submitting anyway. */
export function buildChallengePayload(resolutionId: string, rawGrounds: string): ChallengePostRequest {
  const v = validateChallengeGrounds(rawGrounds)
  if (!v.ok) throw new Error(v.error)
  return {
    url: `/api/protocols/resolutions/${encodeURIComponent(resolutionId)}/challenges`,
    method: 'POST',
    body: { grounds: v.grounds },
  }
}
