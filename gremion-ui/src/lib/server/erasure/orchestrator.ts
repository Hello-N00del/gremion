// TRD-196 / PRD-OPS-005 — the data-subject erasure orchestrator.
//
// For ONE subject in ONE tenant it walks the ENABLED modules, calls each module's
// erasure hook (contract: @gremion/ports/erasure, registry: runtime-registry §10)
// and records an outcome PER MODULE: erased | skipped | failed. The overall status
// is `complete` only when every enabled module is `erased` (overallErasureStatus);
// a module with no hook, no database connection, or an unreachable database is
// `skipped` and can never be reported `erased`.
//
// Pure of I/O apart from the injected deps (hooks, connections, report store, clock),
// so the seam is unit-testable; deps.ts wires the real ones. The chained records
// (audit_log, Beschluss register) are never touched here: TRD-160's redaction layer
// owns them.
import { createHmac, hkdfSync } from 'node:crypto'
import type { Sql } from '@gremion/db'
import {
  overallErasureStatus,
  type ErasureHookResult,
  type ErasureOverallStatus,
  type ErasureResidual,
  type ModuleErasureOutcome,
} from '@gremion/ports/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { isTransientDbStartupError } from '$lib/server/db'

export interface ErasureReport {
  readonly id: string
  readonly tenantId: string
  /** Keyed, tenant-bound pseudonym of the subject (never the raw id; see subjectRef). */
  readonly subjectRef: string
  readonly requestedBy: string
  readonly status: ErasureOverallStatus
  readonly startedAt: Date
  readonly finishedAt: Date | null
  /** Why a run was finished `incomplete` by an error or the stale sweep; null otherwise. */
  readonly finishReason: string | null
  readonly modules: readonly ModuleErasureOutcome[]
}

export interface ErasureReportStore {
  begin(header: {
    tenantId: string
    subjectRef: string
    requestedBy: string
    startedAt: Date
    moduleIds: readonly string[]
  }): Promise<string>
  record(reportId: string, outcome: ModuleErasureOutcome): Promise<void>
  finish(reportId: string, status: 'complete' | 'incomplete', finishedAt: Date, reason?: string | null): Promise<void>
  /** Finish every `running` report of the tenant started before `olderThan` as
   *  `incomplete` (a crashed or killed run). Returns how many were swept. */
  sweepStale(tenantId: string, olderThan: Date, finishedAt: Date): Promise<number>
}

/** A run still `running` after this long is dead (its process crashed or was killed). */
export const STALE_RUN_MS = 60 * 60 * 1000

export interface ErasureDeps {
  /** Ids of the modules the run must cover (enabled, or still holding data because
   *  their migrations are applied), the kernel's own step first. */
  enabledModuleIds(): readonly string[] | Promise<readonly string[]>
  hookFor(moduleId: string): KernelErasureHook | undefined
  /** The module's database connection, or null when it has none. */
  connectionFor(moduleId: string): Sql | null
  store: ErasureReportStore
  now(): Date
}

export interface ErasureInput {
  tenantId: string
  subjectId: string
  requestedBy: string
}

const SUBJECT_REF_INFO = 'gremion/erasure/subject-ref/v1'

/**
 * The tenant-bound PSEUDONYM stored instead of the subject id:
 * HMAC-SHA256(key, subjectId) with key = HKDF-SHA256(AUTH_SECRET, salt = tenantId,
 * info = 'gremion/erasure/subject-ref/v1'). No per-tenant secret exists in the
 * kernel today, so the key is derived from the deployment's AUTH_SECRET with a
 * purpose label (it never doubles as the session key). Unlike a bare hash, a
 * party without the secret cannot confirm a guessed id against a stored ref; the
 * server (which holds the secret) still can, which is what the lookup-by-subject
 * needs. Rotating AUTH_SECRET makes earlier reports unfindable by subject id
 * (they stay readable by report id). Throws when no secret is configured.
 */
export function subjectRef(tenantId: string, subjectId: string, secret = process.env.AUTH_SECRET): string {
  if (!secret) throw new Error('AUTH_SECRET must be set to derive the erasure subject reference')
  const key = Buffer.from(hkdfSync('sha256', secret, tenantId, SUBJECT_REF_INFO, 32))
  return createHmac('sha256', key).update(subjectId).digest('hex')
}

const skipped = (moduleId: string, reason: string): ModuleErasureOutcome => ({
  moduleId,
  status: 'skipped',
  counts: {},
  reason,
  residuals: [],
})

const isCountMap = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const isResidualList = (v: unknown): v is ErasureResidual[] =>
  Array.isArray(v) &&
  v.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      nonEmpty((r as ErasureResidual).table) &&
      nonEmpty((r as ErasureResidual).column) &&
      nonEmpty((r as ErasureResidual).reason) &&
      Number.isInteger((r as ErasureResidual).rows) &&
      (r as ErasureResidual).rows >= 0,
  )

function fromHookResult(moduleId: string, result: ErasureHookResult | undefined): ModuleErasureOutcome {
  if (result?.status === 'erased' && isCountMap(result.counts)) {
    const residuals = result.residuals ?? []
    if (isResidualList(residuals)) {
      return {
        moduleId,
        status: 'erased',
        counts: { ...result.counts },
        reason: null,
        residuals: residuals.map(({ table, column, rows, reason }) => ({ table, column, rows, reason })),
      }
    }
  }
  if (result?.status === 'skipped' && typeof result.reason === 'string' && result.reason !== '') {
    return skipped(moduleId, result.reason)
  }
  return { moduleId, status: 'failed', counts: {}, reason: 'malformed erasure hook result', residuals: [] }
}

/**
 * The failure text that may be STORED. The report is append-only (the DB guard
 * refuses UPDATE/DELETE once a run is finished), so nothing identifying may reach
 * it, and the real client errors do carry it: NextcloudResponseError's message holds
 * the request path `/ocs/v2.php/cloud/users/<subject id>` and the response body,
 * SynapseError's the Matrix id `@<username>:<server>` and Synapse's own error text.
 * So a stored reason is only the error CLASS plus the HTTP status, never a message.
 */
export function safeFailureReason(err: unknown): string {
  const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : 'Error'
  const status = (err as { status?: unknown } | null | undefined)?.status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? `${name} (HTTP ${status})`
    : name
}

/** `text` with every occurrence of the given identifiers (and their URL-encoded form) removed. */
export function redactIdentifiers(text: string, identifiers: readonly (string | null | undefined)[]): string {
  let out = text
  for (const id of identifiers) {
    if (!id) continue
    for (const variant of new Set([id, encodeURIComponent(id)])) out = out.split(variant).join('[redacted]')
  }
  return out
}

const identifiersOf = (input: ErasureInput) => [input.subjectId]

async function eraseModule(
  moduleId: string,
  input: ErasureInput,
  deps: ErasureDeps,
): Promise<ModuleErasureOutcome> {
  const hook = deps.hookFor(moduleId)
  if (!hook) return skipped(moduleId, 'no erasure hook registered')
  const db = deps.connectionFor(moduleId)
  if (db === null && hook.requiresConnection !== false) return skipped(moduleId, 'no database connection')
  try {
    const result = await hook.erase({ tenantId: input.tenantId, subjectId: input.subjectId, db })
    return fromHookResult(moduleId, result)
  } catch (err) {
    // The operator log keeps the message (redacted); the append-only report only the class.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[erasure] ${moduleId} hook failed:`, redactIdentifiers(message, identifiersOf(input)).slice(0, 500))
    const reason = safeFailureReason(err)
    if (isTransientDbStartupError(err)) return skipped(moduleId, `module database unreachable: ${reason}`)
    return { moduleId, status: 'failed', counts: {}, reason, residuals: [] }
  }
}

const errText = (err: unknown, identifiers: readonly (string | null | undefined)[] = []) =>
  redactIdentifiers(err instanceof Error ? err.message : String(err), identifiers).slice(0, 500)

export async function runErasure(input: ErasureInput, deps: ErasureDeps): Promise<ErasureReport> {
  if (typeof input.subjectId !== 'string' || input.subjectId.trim() === '') {
    throw new Error('erasure requires a non-empty subject id')
  }
  const moduleIds = [...new Set(await deps.enabledModuleIds())]
  const ref = subjectRef(input.tenantId, input.subjectId)
  const startedAt = deps.now()

  // MED-2: a run that died mid-way leaves a `running` header forever; close those
  // first. Best effort: a sweep failure must not block a new erasure.
  try {
    await deps.store.sweepStale(input.tenantId, new Date(startedAt.getTime() - STALE_RUN_MS), startedAt)
  } catch (err) {
    console.error('[erasure] stale-run sweep failed:', errText(err))
  }

  const id = await deps.store.begin({
    tenantId: input.tenantId,
    subjectRef: ref,
    requestedBy: input.requestedBy,
    startedAt,
    moduleIds,
  })

  const modules: ModuleErasureOutcome[] = []
  let finished = false
  let failure: unknown = null
  try {
    for (const moduleId of moduleIds) {
      const outcome = await eraseModule(moduleId, input, deps)
      await deps.store.record(id, outcome)
      modules.push(outcome)
    }
    const status = overallErasureStatus(modules)
    const finishedAt = deps.now()
    await deps.store.finish(id, status, finishedAt, null)
    finished = true
    return {
      id,
      tenantId: input.tenantId,
      subjectRef: ref,
      requestedBy: input.requestedBy,
      status,
      startedAt,
      finishedAt,
      finishReason: null,
      modules,
    }
  } catch (err) {
    failure = err
    throw err
  } finally {
    // A store error (record or finish) must never leave the header `running`:
    // finish it `incomplete` with the reason, and let the original error propagate.
    if (!finished) {
      try {
        await deps.store.finish(id, 'incomplete', deps.now(), `run aborted: ${errText(failure, identifiersOf(input))}`)
      } catch (err) {
        console.error('[erasure] could not mark the aborted run incomplete:', errText(err))
      }
    }
  }
}
