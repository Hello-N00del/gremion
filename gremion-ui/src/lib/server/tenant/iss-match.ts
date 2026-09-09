// src/lib/server/tenant/iss-match.ts
// P2.1a iss-match backstop (spec §3.2 / §7.3, R1/R4). The host-resolved tenant
// and the auth token's realm are two independent signals. Crypto verification
// proves the token is valid for SOME realm; it does NOT prove that realm is the
// one the host resolved to. A token minted against A and replayed on B's host
// verifies fine against A's JWKS yet must be rejected — otherwise a real A user
// runs data-plane queries against B's physically-isolated DB. Pure (no env/IO).

export function normalizeIssuer(iss: string | undefined): string {
  // Strip surrounding whitespace and ANY run of trailing slashes, so registry-vs-
  // token formatting drift (a stray space, a double slash) fails toward the
  // canonical form rather than a surprise availability 403. Deliberately byte-
  // strict on scheme/host/path otherwise — NO case-folding or unicode coercion,
  // which would WEAKEN the cross-tenant gate (Stage-5 review hardening).
  return (iss ?? '').trim().replace(/\/+$/, '')
}

export function assertIssMatch({ tokenIss, tenantIssuer }: { tokenIss: string | undefined; tenantIssuer: string }): boolean {
  const a = normalizeIssuer(tokenIss)
  const b = normalizeIssuer(tenantIssuer)
  if (!a || !b) return false
  return a === b
}
