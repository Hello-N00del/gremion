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
import { createHash } from 'node:crypto'
import type { Sql } from '@gremion/db'
import {
  overallErasureStatus,
  type ErasureHookResult,
  type ErasureOverallStatus,
  type ModuleErasureOutcome,
} from '@gremion/ports/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { isTransientDbStartupError } from '$lib/server/db'

export interface ErasureReport {
  readonly id: string
  readonly tenantId: string
  /** Pseudonymous, tenant-bound reference of the subject (never the raw id). */
  readonly subjectRef: string
  readonly requestedBy: string
  readonly status: ErasureOverallStatus
  readonly startedAt: Date
  readonly finishedAt: Date | null
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
  finish(reportId: string, status: 'complete' | 'incomplete', finishedAt: Date): Promise<void>
}

export interface ErasureDeps {
  /** Ids of the modules enabled for the tenant, the kernel's own step first. */
  enabledModuleIds(): readonly string[]
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

/** The audit-safe, tenant-bound reference stored instead of the subject id. */
export function subjectRef(tenantId: string, subjectId: string): string {
  return createHash('sha256').update(`${tenantId}:${subjectId}`).digest('hex')
}

const skipped = (moduleId: string, reason: string): ModuleErasureOutcome => ({
  moduleId,
  status: 'skipped',
  counts: {},
  reason,
})

const isCountMap = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)

function fromHookResult(moduleId: string, result: ErasureHookResult | undefined): ModuleErasureOutcome {
  if (result?.status === 'erased' && isCountMap(result.counts)) {
    return { moduleId, status: 'erased', counts: { ...result.counts }, reason: null }
  }
  if (result?.status === 'skipped' && typeof result.reason === 'string' && result.reason !== '') {
    return skipped(moduleId, result.reason)
  }
  return { moduleId, status: 'failed', counts: {}, reason: 'malformed erasure hook result' }
}

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
    // The error text is stored in the report: keep it to the message (no subject id is ever in it).
    const message = err instanceof Error ? err.message : String(err)
    if (isTransientDbStartupError(err)) return skipped(moduleId, `module database unreachable: ${message}`)
    return { moduleId, status: 'failed', counts: {}, reason: message }
  }
}

export async function runErasure(input: ErasureInput, deps: ErasureDeps): Promise<ErasureReport> {
  if (typeof input.subjectId !== 'string' || input.subjectId.trim() === '') {
    throw new Error('erasure requires a non-empty subject id')
  }
  const moduleIds = [...new Set(deps.enabledModuleIds())]
  const ref = subjectRef(input.tenantId, input.subjectId)
  const startedAt = deps.now()
  const id = await deps.store.begin({
    tenantId: input.tenantId,
    subjectRef: ref,
    requestedBy: input.requestedBy,
    startedAt,
    moduleIds,
  })

  const modules: ModuleErasureOutcome[] = []
  for (const moduleId of moduleIds) {
    const outcome = await eraseModule(moduleId, input, deps)
    await deps.store.record(id, outcome)
    modules.push(outcome)
  }

  const status = overallErasureStatus(modules)
  const finishedAt = deps.now()
  await deps.store.finish(id, status, finishedAt)
  return {
    id,
    tenantId: input.tenantId,
    subjectRef: ref,
    requestedBy: input.requestedBy,
    status,
    startedAt,
    finishedAt,
    modules,
  }
}
