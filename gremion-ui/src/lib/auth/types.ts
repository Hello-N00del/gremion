export enum Role {
  Guest = 'guest',
  Member = 'member',
  // TASK-205a: re-applied from the source (the carve removed them so the kernel compiled without the
  // finance module). Finance gates the finance module's write surfaces; the 'finance' and 'auditor'
  // realm roles map in through hooks.server.ts validRoles = Object.values(Role).
  Finance = 'finance',
  CouncilAdmin = 'council-admin',
  ITAdmin = 'it-admin',
  // Dedicated finance read-only auditor (D1(a)). Standalone role: it confers finance see-all (read) but
  // NO write, decoupled from it-admin, which used to double as the auditor stand-in.
  Auditor = 'auditor'
}

/**
 * P2.2-auth A4 (D-CONST/D-VOCAB): the minimal CLIENT-SAFE slice of a resolved
 * TenantContext that the per-tenant auth accessors (pageAccessForTenant,
 * capabilitiesForTenant) read. lib/auth is imported by .svelte client code, so
 * it must NOT value-import $lib/server/tenant/* — this structural twin of the
 * server seam's VocabularyTenant keeps the accessors importable everywhere
 * while staying assignable FROM the real TenantContext (compile-time pin in
 * tenant-accessors.test.ts). Semantics MUST track
 * $lib/server/tenant/role-vocabulary.ts: an ABSENT `config.roles` means the
 * default vocabulary; a PRESENT array (even []) is a narrowing override
 * (agreement-guard-tested against roleVocabularyForTenant).
 */
export interface TenantVocabularySource {
  readonly config: { readonly roles?: readonly string[] }
}

export interface SessionUser {
  id: string
  email: string
  name: string
  preferredUsername?: string
  roles: Role[]
  groups: string[]
  /** Level of Assurance derived from the token acr (0 none, 1 password, 2 step-up). */
  loa: number
  /** auth_time (epoch seconds) — the authentication event time, for step-up freshness. */
  authTime: number
  // tokens are server-side only — not part of the client session
}
