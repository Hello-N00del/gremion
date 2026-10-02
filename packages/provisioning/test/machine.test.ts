// TDD 3 (TASK-043): the step machine resumes from the ledger, in
// EXECUTION_ORDER, never by step_order; phase B refuses the accounts step
// without the mail principal; a failing step stops the run and is recorded;
// a rerun of a completed customer calls no step at all.
import { describe, expect, it } from 'vitest'
import {
  EXECUTION_ORDER,
  memoryLedger,
  openLedger,
  PHASES,
  PHASE_ORDER,
  ProvisioningError,
  runPhase,
  STEP_ORDER,
  type StepKind,
} from '../src/index.ts'

const CUSTOMER = '01927f00-0000-7000-8000-000000000001'
const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'

function recordingSteps(calls: StepKind[], fail: Partial<Record<StepKind, Error>> = {}) {
  const steps = {} as Record<StepKind, () => Promise<void>>
  for (const k of EXECUTION_ORDER) {
    steps[k] = async () => {
      calls.push(k)
      const e = fail[k]
      if (e) throw e
    }
  }
  return steps
}

async function runAll(ledger: ReturnType<typeof memoryLedger>, steps: Record<StepKind, () => Promise<void>>, afterStep?: (k: StepKind) => void) {
  await openLedger(ledger, CUSTOMER, OPERATOR)
  for (const phase of PHASE_ORDER) {
    await runPhase(phase, { customerId: CUSTOMER, operatorId: OPERATOR, ledger, steps, ...(afterStep ? { hooks: { afterStep } } : {}) })
  }
}

describe('EXECUTION_ORDER and the phases', () => {
  it('holds the eight kinds; broker and principal run before the accounts although their step_order is higher', () => {
    expect(EXECUTION_ORDER).toEqual([
      'realm_created',
      'database_created',
      'domain_bound',
      'storage_prefix_reserved',
      'first_body_created',
      'broker_account_created',
      'mail_principal_issued',
      'first_accounts_created',
    ])
    expect(STEP_ORDER.first_accounts_created).toBe(6)
    expect(STEP_ORDER.broker_account_created).toBe(7)
    expect(STEP_ORDER.mail_principal_issued).toBe(8)
    expect(PHASE_ORDER.flatMap((p) => PHASES[p])).toEqual(EXECUTION_ORDER)
  })
})

describe('runPhase', () => {
  it('a fresh customer runs every step once, in EXECUTION_ORDER, and records one done row per kind', async () => {
    const ledger = memoryLedger()
    const calls: StepKind[] = []
    await runAll(ledger, recordingSteps(calls))
    expect(calls).toEqual(EXECUTION_ORDER)
    const rows = await ledger.rows(CUSTOMER)
    for (const k of EXECUTION_ORDER) {
      expect(rows.filter((r) => r.kind === k && r.status === 'done')).toHaveLength(1)
      expect(rows.filter((r) => r.kind === k && r.status === 'pending')).toHaveLength(1)
    }
    expect(rows.every((r) => r.operatorId === OPERATOR)).toBe(true)
  })

  it('a step error survives a failed-row append that also throws (review B1, r2): the original error is the primary one', async () => {
    const inner = memoryLedger()
    const ledger = {
      rows: (c: string) => inner.rows(c),
      append: async (c: string, k: StepKind, s: Parameters<typeof inner.append>[2], o: string | null) => {
        if (s === 'failed') throw new Error('platform pool closed')
        return inner.append(c, k, s, o)
      },
    }
    const lines: string[] = []
    await openLedger(ledger, CUSTOMER, OPERATOR)
    const stepErr = new Error('seed file(s) 0005_dev_seed.sql applied: GREMION_DISABLE_SEEDS was not true')
    const err = await runPhase('a', {
      customerId: CUSTOMER,
      operatorId: OPERATOR,
      ledger,
      steps: recordingSteps([], { realm_created: stepErr }),
      log: (l) => void lines.push(l),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).cause).toBe(stepErr)
    expect((err as AggregateError).errors).toEqual([stepErr, expect.objectContaining({ message: 'platform pool closed' })])
    expect((err as Error).message).toMatch(/realm_created.*seed file/)
    expect(lines.join('\n')).toMatch(/realm_created: FAILED.*seed file.*failed row could not be recorded.*platform pool closed/)
  })

  it('a failed step logs its error message', async () => {
    const lines: string[] = []
    const ledger = memoryLedger()
    await openLedger(ledger, CUSTOMER, OPERATOR)
    await expect(
      runPhase('a', { customerId: CUSTOMER, operatorId: OPERATOR, ledger, steps: recordingSteps([], { realm_created: new Error('keycloak 503') }), log: (l) => void lines.push(l) }),
    ).rejects.toThrow('keycloak 503')
    expect(lines).toContain('step realm_created: FAILED: keycloak 503')
  })

  it('a rerun of a completed customer calls no step and appends no row', async () => {
    const ledger = memoryLedger()
    await runAll(ledger, recordingSteps([]))
    const before = (await ledger.rows(CUSTOMER)).length
    const calls: StepKind[] = []
    await runAll(ledger, recordingSteps(calls))
    expect(calls).toEqual([])
    expect((await ledger.rows(CUSTOMER)).length).toBe(before)
  })

  it.each(EXECUTION_ORDER.slice(0, -1).map((k, i) => [k, EXECUTION_ORDER[i + 1]!] as const))(
    'a kill after %s resumes at %s',
    async (killed, next) => {
      const ledger = memoryLedger()
      const first: StepKind[] = []
      await expect(
        runAll(ledger, recordingSteps(first), (k) => {
          if (k === killed) throw new Error(`killed after ${k}`)
        }),
      ).rejects.toThrow(`killed after ${killed}`)
      expect(first.at(-1)).toBe(killed)
      const second: StepKind[] = []
      await runAll(ledger, recordingSteps(second))
      expect(second[0]).toBe(next)
      expect([...first, ...second]).toEqual(EXECUTION_ORDER)
    },
  )

  it('a kill after first_body_created resumes at broker_account_created, not at the step_order successor', async () => {
    const ledger = memoryLedger()
    await expect(
      runAll(ledger, recordingSteps([]), (k) => {
        if (k === 'first_body_created') throw new Error('killed')
      }),
    ).rejects.toThrow('killed')
    const second: StepKind[] = []
    await runAll(ledger, recordingSteps(second))
    expect(second[0]).toBe('broker_account_created')
    expect(second.indexOf('first_accounts_created')).toBeGreaterThan(second.indexOf('mail_principal_issued'))
  })

  it('phase B refuses the accounts step while mail_principal_issued is not done', async () => {
    const ledger = memoryLedger()
    const calls: StepKind[] = []
    const steps = recordingSteps(calls)
    await openLedger(ledger, CUSTOMER, OPERATOR)
    await runPhase('a', { customerId: CUSTOMER, operatorId: OPERATOR, ledger, steps })
    const err = await runPhase('b', { customerId: CUSTOMER, operatorId: OPERATOR, ledger, steps }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProvisioningError)
    expect((err as ProvisioningError).code).toBe('STEP_OUT_OF_ORDER')
    expect((err as Error).message).toMatch(/mail_principal_issued/)
    expect(calls).not.toContain('first_accounts_created')
  })

  it('a failing step is recorded failed, stops the run, and is retried by the next run', async () => {
    const ledger = memoryLedger()
    const calls: StepKind[] = []
    await expect(runAll(ledger, recordingSteps(calls, { domain_bound: new Error('dns says no') }))).rejects.toThrow('dns says no')
    expect(calls).toEqual(['realm_created', 'database_created', 'domain_bound'])
    const rows = await ledger.rows(CUSTOMER)
    expect(rows.filter((r) => r.kind === 'domain_bound').map((r) => r.status)).toEqual(['pending', 'failed'])
    const again: StepKind[] = []
    await runAll(ledger, recordingSteps(again))
    expect(again[0]).toBe('domain_bound')
  })

  it('a done row already written by a concurrent run is adopted, not duplicated', async () => {
    const ledger = memoryLedger()
    await openLedger(ledger, CUSTOMER, OPERATOR)
    const steps = recordingSteps([])
    steps.realm_created = async () => {
      await ledger.append(CUSTOMER, 'realm_created', 'done', OPERATOR)
    }
    await runPhase('a', { customerId: CUSTOMER, operatorId: OPERATOR, ledger, steps })
    const rows = await ledger.rows(CUSTOMER)
    expect(rows.filter((r) => r.kind === 'realm_created' && r.status === 'done')).toHaveLength(1)
  })

  it('refuses an operator id or customer id that is not a uuid', async () => {
    const ledger = memoryLedger()
    await expect(runPhase('a', { customerId: 'x', operatorId: OPERATOR, ledger, steps: recordingSteps([]) })).rejects.toBeInstanceOf(ProvisioningError)
    await expect(openLedger(ledger, CUSTOMER, 'nope')).rejects.toBeInstanceOf(ProvisioningError)
  })
})
