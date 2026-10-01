// packages/provisioning/src/steps.ts — the eight provisioning step kinds of
// plt.provisioning_step (SCHEMA DB-PLT-PROVISIONING-STEP verbatim, plus two
// appended kinds: Q2's named deviation) and the ONE order they execute in.
//
// step_order is the column SCHEMA generates from the kind; it is NOT the
// execution order. The broker account (7) and the mail principal (8) must
// exist before the first accounts (6) are created -- an invite mail needs the
// realm's own sender, and the kernel's broker identity must exist before an
// administrator can act. Resume therefore walks EXECUTION_ORDER, never
// step_order (TDD 3: a kill after first_body_created resumes at
// broker_account_created).

export const STEP_ORDER = Object.freeze({
  realm_created: 1,
  database_created: 2,
  domain_bound: 3,
  storage_prefix_reserved: 4,
  first_body_created: 5,
  first_accounts_created: 6,
  broker_account_created: 7,
  mail_principal_issued: 8,
} as const)

export type StepKind = keyof typeof STEP_ORDER
export type StepStatus = 'pending' | 'done' | 'failed'

export const EXECUTION_ORDER: readonly StepKind[] = Object.freeze([
  'realm_created',
  'database_created',
  'domain_bound',
  'storage_prefix_reserved',
  'first_body_created',
  'broker_account_created',
  'mail_principal_issued',
  'first_accounts_created',
] as const)

/**
 * Where each step runs (§5): container phase A, the host phase (the vendor
 * mail launcher lives on the host, TRD-045 keeps tenant-create off the mail
 * network), container phase B.
 */
export type Phase = 'a' | 'host' | 'b'

export const PHASES: Readonly<Record<Phase, readonly StepKind[]>> = Object.freeze({
  a: Object.freeze([
    'realm_created',
    'database_created',
    'domain_bound',
    'storage_prefix_reserved',
    'first_body_created',
    'broker_account_created',
  ] as const),
  host: Object.freeze(['mail_principal_issued'] as const),
  b: Object.freeze(['first_accounts_created'] as const),
})

export const PHASE_ORDER: readonly Phase[] = Object.freeze(['a', 'host', 'b'] as const)

export function isStepKind(value: unknown): value is StepKind {
  return typeof value === 'string' && Object.hasOwn(STEP_ORDER, value)
}

/** "completed" = every one of the eight kinds has a done row (Q2). */
export function isComplete(done: ReadonlySet<StepKind>): boolean {
  return EXECUTION_ORDER.every((k) => done.has(k))
}
