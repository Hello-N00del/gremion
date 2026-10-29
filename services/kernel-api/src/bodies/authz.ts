// services/kernel-api/src/bodies/authz.ts -- the WriteAuthorizer seam (Q4).
//
// Default deny: denyAll refuses every write that is not the caller's own
// preference. The served app binds decide() (the PDP) here through
// src/authz/write-authorizer.ts (TASK-081 G3): a person token's write is 403
// unless a live grant carries the capability the operation needs. The operator
// surfaces (the migrate hook, the `kernel-api bodies` verbs) pass an actor of
// kind 'operator' / 'system' through operatorAuthorizer. There is NO allow-all
// in src/: a test authorizer lives under test/ and is never bundled (the proof
// greps dist for it).

import type { Sql } from '@gremion/db'

export type Actor =
  | { kind: 'person'; id: string }
  | { kind: 'operator'; id: string }
  | { kind: 'system'; id: null }

export interface WriteRequest {
  actor: Actor
  customerId: string
  /** e.g. 'body.create', 'membership.end' */
  operation: string
  /** The body the write is scoped to, when it has one (customer-level writes: null). */
  bodyId: string | null
  /** The customer's app-role pool the write runs on: a PDP-backed authorizer decides over it, inside the customer's RLS context. */
  sql: Sql
}

export interface WriteAuthorizer {
  authorize(req: WriteRequest): Promise<boolean>
}

/** The shipped default: nobody writes through the API until the PDP is bound. */
export const denyAll: WriteAuthorizer = { authorize: async () => false }

/**
 * For the operator surfaces only (CLI verbs, migrate hook): an actor of kind
 * 'operator' or 'system' is let through, a person never is. A person's write
 * stays on the PDP (081).
 */
export const operatorAuthorizer: WriteAuthorizer = { authorize: async (r) => r.actor.kind !== 'person' }
