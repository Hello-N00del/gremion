// packages/provisioning/src/machine.ts — the ledger-driven step machine.
//
// openLedger appends one `pending` row for every kind that has no row yet
// (the visible, resumable state of a customer whose run has started). runPhase
// then walks its phase's kinds in EXECUTION_ORDER:
//   - a kind with a `done` row is skipped (a rerun calls nothing);
//   - every kind before it in EXECUTION_ORDER must be done, or the phase is
//     refused STEP_OUT_OF_ORDER before anything runs (phase B without the
//     host's mail principal, a host step before phase A, ...);
//   - the step runs; a throw appends `failed` and stops the run (nothing after
//     it runs); success appends `done` -- a 23505 there means a concurrent run
//     finished the same kind first, which is adopted;
//   - hooks.afterStep runs after the done row (the kill-injection seam).
// Resume is by the ledger alone: never by step_order, never by a flag.
import { assertUuid, ProvisioningError } from './errors.ts'
import { doneKinds, isDuplicateDone, type LedgerPort } from './ledger.ts'
import { EXECUTION_ORDER, PHASES, type Phase, type StepKind } from './steps.ts'

export type StepFns = Partial<Record<StepKind, () => Promise<void>>>

export interface RunPhaseOptions {
  customerId: string
  /** The operator on whose behalf the run acts (actor_operator_id). */
  operatorId: string | null
  ledger: LedgerPort
  steps: StepFns
  hooks?: { afterStep?(kind: StepKind): void | Promise<void> }
  log?: (line: string) => void
}

export interface RunPhaseResult {
  phase: Phase
  ran: StepKind[]
  skipped: StepKind[]
}

export async function openLedger(ledger: LedgerPort, customerId: string, operatorId: string | null): Promise<StepKind[]> {
  assertUuid(customerId, 'customer id')
  if (operatorId !== null) assertUuid(operatorId, 'operator id')
  const seen = new Set((await ledger.rows(customerId)).map((r) => r.kind))
  const opened: StepKind[] = []
  for (const kind of EXECUTION_ORDER) {
    if (seen.has(kind)) continue
    await ledger.append(customerId, kind, 'pending', operatorId)
    opened.push(kind)
  }
  return opened
}

export async function runPhase(phase: Phase, opts: RunPhaseOptions): Promise<RunPhaseResult> {
  const { customerId, operatorId, ledger, steps } = opts
  assertUuid(customerId, 'customer id')
  if (operatorId !== null) assertUuid(operatorId, 'operator id')
  const log = opts.log ?? (() => {})
  const kinds = PHASES[phase]
  if (!kinds) throw new ProvisioningError('INVALID_INPUT', `unknown phase ${String(phase)}`)
  const result: RunPhaseResult = { phase, ran: [], skipped: [] }

  const done = doneKinds(await ledger.rows(customerId))
  for (const kind of kinds) {
    if (done.has(kind)) {
      result.skipped.push(kind)
      continue
    }
    const missing = EXECUTION_ORDER.slice(0, EXECUTION_ORDER.indexOf(kind)).filter((k) => !done.has(k))
    if (missing.length) {
      throw new ProvisioningError('STEP_OUT_OF_ORDER', `${kind} cannot run before ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} done (EXECUTION_ORDER)`)
    }
    const fn = steps[kind]
    if (!fn) throw new ProvisioningError('INVALID_INPUT', `phase ${phase} has no implementation for ${kind}`)
    log(`step ${kind}: running`)
    try {
      await fn()
    } catch (err) {
      // The step's error stays the primary one (review B1, r2): a failed-row
      // append that also throws (pool closed, connection reset) must not
      // replace the seed post-condition or the Keycloak 5xx the operator needs.
      const msg = err instanceof Error ? err.message : String(err)
      try {
        await ledger.append(customerId, kind, 'failed', operatorId)
      } catch (appendErr) {
        const amsg = appendErr instanceof Error ? appendErr.message : String(appendErr)
        log(`step ${kind}: FAILED: ${msg}; the failed row could not be recorded: ${amsg}`)
        throw new AggregateError([err, appendErr], `step ${kind} failed: ${msg} (and its failed ledger row could not be recorded: ${amsg})`, { cause: err })
      }
      log(`step ${kind}: FAILED: ${msg}`)
      throw err
    }
    try {
      await ledger.append(customerId, kind, 'done', operatorId)
    } catch (err) {
      if (!isDuplicateDone(err)) throw err
      log(`step ${kind}: already done by a concurrent run`)
    }
    done.add(kind)
    result.ran.push(kind)
    log(`step ${kind}: done`)
    await opts.hooks?.afterStep?.(kind)
  }
  return result
}
