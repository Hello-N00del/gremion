// services/kernel-api/src/authz/pdp.ts — the ONE policy decision point
// (TASK-081, TRD-429, PRD-IDN-007). decide() is the only place a request is
// turned into allow/deny; nothing else in the kernel API compares a role.
//
//  - tenant: the customer's RLS context is set first (inCustomerTx); a grant
//    issued in tenant A is invisible in tenant B (TRD-084).
//  - body: only grants of the requested body count (TRD-429, DOMAIN:363).
//  - validity: valid_from <= now() < valid_until, read from the database clock
//    at decision time; a state='active' row whose window has passed denies
//    before the sweep runs.
//  - module: a module capability decides allow only while its module is
//    enabled FOR THIS CUSTOMER, read per request from the registry (Q9: no
//    cache; M-OFF-1/2). A positive deny with reason module_not_enabled.
//  - resource: a grant that names a resource matches that resource only
//    (per-meeting roles); a standing grant matches any resource.
//  - roles expand to the database's `available` capabilities; customer-level
//    roles count only in the 'verwaltung' body (DOMAIN:408).
import { capabilityDef } from './catalogue.ts'
import { inCustomerTx, assertUuid, type Sql } from './tx.ts'

export type Subject = { sub: string } | { personId: string }

export interface DecideInput {
  customerId: string
  subject: Subject
  bodyId: string
  capability: string
  resource?: { kind: string; id: string }
}

export type DenyReason =
  | 'capability_unknown'
  | 'module_not_enabled'
  | 'capability_unavailable'
  | 'subject_unknown'
  | 'body_unknown'
  | 'no_grant'

export interface Decision {
  allow: boolean
  reason: 'granted' | DenyReason
  grantIds: string[]
}

/** The live per-request registry read (plt.module_enablement.state = 'enabled'). */
export type EnabledModules = (customerId: string) => Promise<ReadonlySet<string>>

const deny = (reason: DenyReason): Decision => ({ allow: false, reason, grantIds: [] })

export async function decide(sql: Sql, enabledModules: EnabledModules, input: DecideInput): Promise<Decision> {
  assertUuid(input.bodyId, 'bodyId')
  return decideChecked(sql, enabledModules, input, (fn) => inCustomerTx(sql, input.customerId, fn))
}

/** The same decision inside a transaction the caller already opened with the customer context set. */
export async function decideInTx(tx: Sql, enabledModules: EnabledModules, input: DecideInput): Promise<Decision> {
  assertUuid(input.bodyId, 'bodyId')
  return decideChecked(tx, enabledModules, input, (fn) => fn(tx))
}

async function decideChecked(_sql: Sql, enabledModules: EnabledModules, input: DecideInput, run: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>): Promise<Decision> {
  const def = capabilityDef(input.capability)
  if (!def) return deny('capability_unknown')
  if (def.moduleKey !== null) {
    const enabled = await enabledModules(input.customerId)
    if (!enabled.has(def.moduleKey)) return deny('module_not_enabled')
  }
  return run(async (tx) => {
    const subjectRows =
      'sub' in input.subject
        ? await tx<{ person_id: string }[]>`SELECT person_id::text FROM idt.person WHERE idp_subject = ${input.subject.sub} AND state = 'active'`
        : await tx<{ person_id: string }[]>`SELECT person_id::text FROM idt.person WHERE person_id = ${input.subject.personId}::uuid AND state = 'active'`
    const person = subjectRows[0]
    if (!person) return deny('subject_unknown')
    const bodyRows = await tx<{ body_kind: string }[]>`SELECT body_kind FROM idt.body WHERE body_id = ${input.bodyId}::uuid`
    const body = bodyRows[0]
    if (!body) return deny('body_unknown')
    const cap = await tx<{ state: string }[]>`SELECT state FROM idt.capability WHERE capability_key = ${input.capability}`
    // a capability the catalogue never wrote (module absent from the build, M-OFF-3) is unavailable. The row's own
    // 'module_disabled' marker is the sweep's bookkeeping, not a gate: the live registry read above is the only module gate
    // (C6, no cache), so a re-enabled module decides on its very next request instead of waiting for the next sweep.
    if (!cap[0]) return deny('capability_unavailable')
    const resKind = input.resource?.kind ?? null
    const resId = input.resource?.id ?? null
    const grants = await tx<{ grant_id: string }[]>`
      SELECT g.grant_id::text
        FROM idt.authz_grant g
        LEFT JOIN idt.role r ON r.role_key = g.role_key AND r.state = 'active'
       WHERE g.subject_person_id = ${person.person_id}::uuid
         AND g.body_id = ${input.bodyId}::uuid
         AND g.state IN ('active', 'scheduled')
         AND g.valid_from <= now()
         AND (g.valid_until IS NULL OR g.valid_until > now())
         AND (g.resource_id IS NULL OR (g.resource_kind = ${resKind}::text AND g.resource_id = ${resId}::uuid))
         AND (
               (g.grant_kind = 'capability' AND g.capability_key = ${input.capability})
            OR (g.grant_kind = 'role' AND r.role_key IS NOT NULL AND ${input.capability}::text = ANY (r.capability_keys)
                AND (r.scope_level = 'body' OR ${body.body_kind}::text = 'verwaltung'))
         )
       ORDER BY g.grant_id`
    if (grants.length === 0) return deny('no_grant')
    return { allow: true, reason: 'granted', grantIds: grants.map((g) => g.grant_id) }
  })
}

/**
 * Operator decision 2026-10-22: a CUSTOMER-level role (scope_level 'customer': council_admin, it_admin) held
 * live in one of this customer's verwaltung bodies is authority to administer grants (idt.grant.manage) in
 * ANY body of the same customer. The customer boundary is the RLS context of `tx`; a body-level role never
 * counts here (not even one held in the verwaltung), and a customer-level role held in a non-verwaltung body
 * does not count either. Returns the role keys the person holds that carry the authority (empty = none).
 */
export async function customerWideGrantRoles(tx: Sql, personId: string): Promise<string[]> {
  assertUuid(personId, 'personId')
  const rows = await tx<{ role_key: string }[]>`
    SELECT DISTINCT g.role_key
      FROM idt.authz_grant g
      JOIN idt.role r ON r.role_key = g.role_key AND r.state = 'active'
      JOIN idt.body b ON b.body_id = g.body_id
     WHERE g.subject_person_id = ${personId}::uuid
       AND g.grant_kind = 'role'
       AND r.scope_level = 'customer'
       AND b.body_kind = 'verwaltung'
       AND 'idt.grant.manage' = ANY (r.capability_keys)
       AND g.state IN ('active', 'scheduled')
       AND g.valid_from <= now()
       AND (g.valid_until IS NULL OR g.valid_until > now())
     ORDER BY g.role_key`
  return rows.map((r) => r.role_key)
}
