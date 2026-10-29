// services/kernel-api/src/bodies/service.ts -- the identity domain service
// (TASK-080-a step b): bodies, org units, seats, wahlperioden, persons,
// memberships, tenures. The rules every operation obeys are in core.ts.
import type { WriteAuthorizer } from './authz.ts'
import { makeCore } from './core.ts'
import { peopleOps } from './people.ts'
import { structureOps } from './structure.ts'

export interface BodiesServiceOptions {
  /** Default deny: pass pdpWriteAuthorizer (the served HTTP binding) or operatorAuthorizer (the operator verbs). */
  authorizer: WriteAuthorizer
}

export function createBodiesService(opts: BodiesServiceOptions) {
  const core = makeCore(opts.authorizer)
  return { ...structureOps(core), ...peopleOps(core) }
}

export type BodiesService = ReturnType<typeof createBodiesService>
export type { OpCtx } from './core.ts'
