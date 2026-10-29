// services/kernel-api/src/authz/write-authorizer.ts -- the PDP-backed WriteAuthorizer
// (TASK-081 G3; the seam is TASK-080-a's src/bodies/authz.ts, Q4).
//
// A person's write through the identity domain service is allowed only when
// decide() says so: the capability the operation needs, in the body the write is
// scoped to, held by that person through a live grant of THIS customer. Default
// deny stays in force everywhere decide() does not say yes:
//   * an operation without a row in WRITE_CAPABILITY is refused (a new domain
//     operation is closed until it is named here);
//   * an actor that is not a person is refused (the operator surfaces use
//     operatorAuthorizer; the PDP never speaks for them);
//   * a customer-level write (bodyId null: person.*, a top-level body) is decided
//     in the customer's active verwaltung body, where customer-level roles count
//     (DOMAIN:408); a customer without one has nobody who may write;
//   * a malformed body id is a refusal, not a crash.
// The decision reads the module registry live per request (decide's own rule), the
// grant table through the customer's RLS context, on the write's own transaction (WriteRequest.sql).
import type { WriteAuthorizer, WriteRequest } from '../bodies/authz.ts'
import { decideInTx, type EnabledModules } from './pdp.ts'
import type { Sql } from './tx.ts'

/** Domain operation (the strings core.allow() is called with) -> the kernel capability it needs. */
const WRITE_CAPABILITY: ReadonlyMap<string, string> = new Map([
  ['body.create', 'idt.structure.manage'],
  ['body.update', 'idt.structure.manage'],
  ['body.archive', 'idt.structure.manage'],
  ['orgunit.create', 'idt.structure.manage'],
  ['orgunit.update', 'idt.structure.manage'],
  ['orgunit.archive', 'idt.structure.manage'],
  ['seat.create', 'idt.structure.manage'],
  ['seat.retire', 'idt.structure.manage'],
  ['wahlperiode.create', 'idt.structure.manage'],
  ['wahlperiode.close', 'idt.structure.manage'],
  ['membership.start', 'idt.membership.manage'],
  ['membership.correct', 'idt.membership.manage'],
  ['membership.end', 'idt.membership.manage'],
  ['tenure.start', 'idt.membership.manage'],
  ['tenure.correct', 'idt.membership.manage'],
  ['tenure.end', 'idt.membership.manage'],
  ['person.invite', 'idt.person.manage'],
  ['person.activate', 'idt.person.manage'],
  ['person.disable', 'idt.person.manage'],
  ['person.enable', 'idt.person.manage'],
])

/** The operations the PDP can authorize (for the test that keeps this table and the domain service in step). */
export const AUTHORIZED_WRITE_OPERATIONS: readonly string[] = Object.freeze([...WRITE_CAPABILITY.keys()])

// runs on the write's own transaction (the customer's RLS context is already set), so the decision is taken in the
// same snapshot as the write it guards and holds no second connection of the pool
async function verwaltungBodyId(tx: Sql): Promise<string | null> {
  const rows = await tx<{ body_id: string }[]>`SELECT body_id::text FROM idt.body WHERE kind_key = 'verwaltung' AND state = 'active'`
  return rows[0]?.body_id ?? null
}

export function pdpWriteAuthorizer(enabledModules: EnabledModules): WriteAuthorizer {
  return {
    async authorize(req: WriteRequest): Promise<boolean> {
      if (req.actor.kind !== 'person') return false
      const capability = WRITE_CAPABILITY.get(req.operation)
      if (capability === undefined) return false
      try {
        const bodyId = req.bodyId ?? (await verwaltungBodyId(req.sql))
        if (bodyId === null) return false
        const d = await decideInTx(req.sql, enabledModules, { customerId: req.customerId, subject: { personId: req.actor.id }, bodyId, capability })
        return d.allow
      } catch (err) {
        // assertUuid's refusal of a malformed id is a deny; a database failure is not ours to swallow
        if (err instanceof TypeError) return false
        throw err
      }
    },
  }
}
