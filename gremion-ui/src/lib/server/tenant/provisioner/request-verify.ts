// src/lib/server/tenant/provisioner/request-verify.ts — TASK-043d-1 D4: the
// trusted layer re-verifies a control-panel request's evidence before the
// host-side executor runs anything (ASVS 4.0.3 V4.1.1 "enforced on a trusted
// service layer"; V1.4 privilege separation). A stolen panel database
// password or a panel RCE is not enough to provision: the request must carry
// the operator's SIGNED tokens from the sign-in, and only the ops realm's key
// signs them.
//
// What is signed where (measured on Keycloak 26.6.1, the ops realm template +
// its step-up flow; test/host/fixtures/executor/kc2661-token-claims.json):
//   ID token      sub (the operator's user id), acr, aud/azp, iat, sid, at_hash
//   access token  realm_access.roles, acr, aud/azp, sid           (no sub)
//   neither       auth_time (the realm assigns no `basic` scope)
// So the evidence is the PAIR of one code exchange, bound by the ID token's
// at_hash (OIDC Core 3.1.3.6) and the shared sid. The sign-in time is
// auth_time when present, else the ID token's iat: the code exchange, which is
// the panel's own sign-in (its absolute session counts from it), requested
// with max_age=3600 (OIDC Core 3.1.2.1) through the step-up flow whose loa2
// condition re-asks the second factor after 300 s.
//
// exp is NOT the bound (Keycloak's token lifespan is minutes; the policy is
// the panel's 3600 s absolute session, ASVS V7.3.2): the signatures are
// checked "as of" the request's created_at with a 3600 s tolerance, and the
// sign-in time is checked explicitly against created_at.
import { createHash } from 'node:crypto'
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

export const EVIDENCE_WINDOW_SECONDS = 3600
export const EVIDENCE_SKEW_SECONDS = 60
export const OPERATOR_ROLE = 'operator'
const ALGORITHMS = ['RS256']

export interface EvidencePair {
  id: string
  access: string
}

/** The ONE string the panel stores as plt.provisioning_request.evidence_token. */
export function encodeEvidence(p: EvidencePair): string {
  return JSON.stringify({ id: p.id, access: p.access })
}

function decodeEvidence(evidence: string): EvidencePair | null {
  try {
    const o = JSON.parse(evidence) as { id?: unknown; access?: unknown }
    if (typeof o?.id === 'string' && typeof o.access === 'string') return { id: o.id, access: o.access }
  } catch {
    // not JSON
  }
  return null
}

export interface EvidenceCheck {
  evidence: string
  /** The ops realm's JWKS (createRemoteJWKSet over Keycloak's internal base in the container). */
  jwks: JWTVerifyGetKey
  /** The exact public issuer of the ops realm. */
  issuer: string
  /** The control panel's client id. */
  clientId: string
  /** plt.provisioning_request.operator_id */
  operatorId: string
  /** plt.provisioning_request.created_at (the server clock at submit) */
  createdAt: Date
  /** plt.provisioning_request.evidence_auth_time (what the panel recorded) */
  recordedAuthTime: Date
}

export type EvidenceResult = { ok: true; sub: string; acr: string; authTime: number; timeClaim: 'auth_time' | 'iat' } | { ok: false; reason: string }

const audienceHas = (p: JWTPayload, client: string) => (Array.isArray(p.aud) ? p.aud : [p.aud]).includes(client)

async function verifyOne(token: string, what: string, c: EvidenceCheck): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, c.jwks, {
      issuer: c.issuer,
      audience: c.clientId,
      algorithms: ALGORITHMS,
      currentDate: c.createdAt,
      clockTolerance: EVIDENCE_WINDOW_SECONDS,
    })
    return payload
  } catch (err) {
    const e = err as { code?: string; message?: string }
    throw new Error(`the ${what} does not verify (${e.code ?? 'ERR'}: ${e.message ?? String(err)}; signature, issuer and audience are checked against the ops realm)`)
  }
}

/** at_hash for an RS256 ID token: the left half of SHA-256 of the access token, base64url. */
function atHash(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url')
}

export async function verifyRequestEvidence(c: EvidenceCheck): Promise<EvidenceResult> {
  const p = decodeEvidence(c.evidence)
  if (!p) return { ok: false, reason: 'the evidence is not the token pair the panel stores ({"id","access"})' }
  try {
    const id = await verifyOne(p.id, 'ID token', c)
    const at = await verifyOne(p.access, 'access token', c)
    if (id.typ !== 'ID') throw new Error(`the ID token has typ ${String(id.typ)}, not ID`)
    if (at.typ !== 'Bearer') throw new Error(`the access token has typ ${String(at.typ)}, not Bearer`)
    for (const [what, t] of [['ID token', id], ['access token', at]] as const) {
      if (t.azp !== c.clientId) throw new Error(`the ${what} has azp ${String(t.azp)}, not ${c.clientId}`)
      if (!audienceHas(t, c.clientId)) throw new Error(`the ${what} is not for ${c.clientId}`)
      if (t.acr !== 'loa2') throw new Error(`the ${what} has acr ${String(t.acr ?? 'none')}, loa2 is required`)
    }
    if (typeof id.at_hash !== 'string' || id.at_hash !== atHash(p.access)) throw new Error('the access token is not the one issued with the ID token (at_hash)')
    if (typeof id.sid !== 'string' || id.sid !== at.sid) throw new Error('the two tokens come from different sessions (sid)')
    if (id.sub !== c.operatorId) throw new Error(`the ID token's sub ${String(id.sub)} is not the request's operator ${c.operatorId}`)
    const roles = (at.realm_access as { roles?: unknown } | undefined)?.roles
    if (!Array.isArray(roles) || !roles.includes(OPERATOR_ROLE)) throw new Error('the access token carries no operator role of the ops realm')
    const timeClaim = typeof id.auth_time === 'number' ? 'auth_time' : 'iat'
    const authTime = timeClaim === 'auth_time' ? (id.auth_time as number) : id.iat
    if (typeof authTime !== 'number' || !Number.isFinite(authTime)) throw new Error('the ID token carries neither auth_time nor iat')
    const age = Math.floor(c.createdAt.getTime() / 1000) - authTime
    // the database's own bound on the recorded time (plt 0009): [created_at - 3600 s, created_at + 60 s]
    if (age > EVIDENCE_WINDOW_SECONDS || age < -EVIDENCE_SKEW_SECONDS) {
      throw new Error(`the sign-in (${timeClaim}) is ${age} s before the request; at most ${EVIDENCE_WINDOW_SECONDS} s before (or ${EVIDENCE_SKEW_SECONDS} s after) is accepted`)
    }
    if (Math.abs(Math.floor(c.recordedAuthTime.getTime() / 1000) - authTime) > 1) {
      throw new Error(`the recorded sign-in time is not the token's ${timeClaim}`)
    }
    return { ok: true, sub: id.sub, acr: 'loa2', authTime, timeClaim }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
