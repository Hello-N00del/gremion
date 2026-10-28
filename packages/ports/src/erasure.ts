// packages/ports/src/erasure.ts (@gremion/ports/erasure)
// TRD-196 / PRD-OPS-005: the per-module erasure hook contract.
//
// A data-subject erasure runs PER MODULE. Each module that holds personal data
// registers ONE ModuleErasureHook (kernel side: runtime-registry's
// registerErasureHook) and the kernel's erasure orchestrator calls it for the
// subject in one tenant. The orchestrator, never the hook, decides the report:
//
//   erased   the hook ran and removed/pseudonymised the subject's data
//   skipped  the data was NOT touched: no hook, no database connection, or the
//            module's database could not be reached. Never "erased".
//   failed   the hook threw (or returned a malformed result)
//
// A hook must be idempotent (a re-run on an already-erased subject returns
// `erased` with zero counts) and must NOT alter tamper-evident chained records
// (audit_log, Beschluss register); those are answered by TRD-160's redaction
// layer, not by this seam.

/**
 * The subject, VERIFIED against the tenant before any hook runs: the id is a user of
 * the tenant's identity realm, or the tenant's own data holds records of it (an
 * account already removed from the realm). A hook that reaches a system shared by
 * every tenant (one Nextcloud serves them all) acts only on a verified id.
 */
export interface ErasureSubject {
  readonly id: string
  /** The Keycloak username (= Matrix localpart); null when the realm no longer holds the account. */
  readonly username: string | null
  /** The e-mail address ('' when the account has none); null when the realm no longer holds the account. */
  readonly email: string | null
}

/** What a hook is asked to erase. `subjectId` is the identity-provider user id. */
export interface ErasureContext<Db = unknown> {
  readonly tenantId: string
  readonly subjectId: string
  /** The verified identity of `subjectId`; always set by the kernel orchestrator. */
  readonly subject?: ErasureSubject
  /**
   * The module's database connection, or null when the module has none (or the
   * kernel cannot reach it). A hook with `requiresConnection` (the default) is
   * never called with null: the orchestrator reports it `skipped` itself.
   */
  readonly db: Db | null
}

/**
 * A subject-id column a hook DELIBERATELY left in place, with how many rows of
 * the subject it still holds and why (e.g. a council record whose redaction is
 * TRD-160's). Makes an `erased` honest about what "erased" did not cover. Never
 * carries the subject id itself.
 */
export interface ErasureResidual {
  readonly table: string
  readonly column: string
  /** Rows that still reference the subject after the hook ran. */
  readonly rows: number
  readonly reason: string
}

/** What a hook may report. A throw is reported `failed` (or `skipped` when the
 *  error is a connection error), never `erased`. */
export type ErasureHookResult =
  | {
      readonly status: 'erased'
      readonly counts: Readonly<Record<string, number>>
      readonly residuals?: readonly ErasureResidual[]
    }
  | { readonly status: 'skipped'; readonly reason: string }

export interface ModuleErasureHook<Db = unknown> {
  /** The module id (module.json `id`, equal to the config.modules key). */
  readonly moduleId: string
  /** Default true. Set false only for a hook that needs no database at all. */
  readonly requiresConnection?: boolean
  erase(ctx: ErasureContext<Db>): Promise<ErasureHookResult>
}

/** Per-module outcome as recorded in the report. */
export type ErasureOutcomeStatus = 'erased' | 'skipped' | 'failed'

export interface ModuleErasureOutcome {
  readonly moduleId: string
  readonly status: ErasureOutcomeStatus
  /** Rows touched per table/kind; empty unless `erased`. */
  readonly counts: Readonly<Record<string, number>>
  /** Why a module was skipped or failed; null when erased. */
  readonly reason: string | null
  /** What an `erased` hook deliberately left (see ErasureResidual); [] otherwise. */
  readonly residuals: readonly ErasureResidual[]
}

/** `complete` only when every enabled module is `erased`; otherwise `incomplete`. */
export type ErasureOverallStatus = 'running' | 'complete' | 'incomplete'

/** The overall verdict. Pure; the one place a "complete" claim can originate. */
export function overallErasureStatus(outcomes: readonly ModuleErasureOutcome[]): 'complete' | 'incomplete' {
  return outcomes.length > 0 && outcomes.every((o) => o.status === 'erased') ? 'complete' : 'incomplete'
}
