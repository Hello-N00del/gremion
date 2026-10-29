// operationIds of the `bodies` tag (TASK-080-a step c): the identity reads and
// the signed-in person's own preference.
//
// Authorization, in the shipped (default-deny) binding:
//   * the structure reads (tree, seats, seat history, memberships) answer any
//     signed-in user of the customer: they carry ids, titles and dates, never a
//     name or an address (a membership names its person by id only);
//   * personal data is served to the person themself only: getPerson answers
//     the record whose idp_subject is the token's verified `sub`, anything else
//     is 403 (not 404: never say who exists); the own preference is found by
//     `sub`, a subject with no active person is 403;
//   * none of these operations is on MODULE_CALLER_OPERATIONS, so a module
//     caller is refused 403 by the tenancy hook before a handler runs;
//   * no write exists over HTTP but the own preference: every other write is the
//     domain service's, behind the WriteAuthorizer (denyAll until TASK-081).
import type { OperationHandler } from '@gremion/fastify-service-template'
import { sendProblem } from '@gremion/fastify-service-template'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { KernelApiDeps } from '../app/deps.ts'
import { BodiesError } from '../bodies/errors.ts'
import { preferenceOps, type PreferencePatch } from '../bodies/preference.ts'
import { bodiesReads, type ReadCtx } from '../bodies/read.ts'
import { getContext } from '../tenancy/context.ts'
import { PROBLEM, RETRY_AFTER_REGISTRY } from '../tenancy/hook.ts'

type Deps = Pick<KernelApiDeps, 'tenantDb' | 'log'>

const forbidden = (reply: FastifyReply, detail: string) => sendProblem(reply, { type: PROBLEM.forbidden, title: 'Forbidden', status: 403, detail })

/** The verified subject of a signed-in user, or null (a module caller has none). */
function subjectOf(request: FastifyRequest): string | null {
  const { caller } = getContext(request)
  if (caller.kind !== 'user') return null
  const sub = caller.claims.sub
  return typeof sub === 'string' && sub.length > 0 && sub.length <= 255 ? sub : null
}

/** Opens the customer's pool, runs `fn`, and maps the domain's refusals to problems. */
async function onTenant(deps: Deps, request: FastifyRequest, reply: FastifyReply, fn: (ctx: ReadCtx) => Promise<unknown>): Promise<unknown> {
  const { tenant } = getContext(request)
  try {
    const sql = await deps.tenantDb.sqlFor(tenant)
    return await fn({ sql, customerId: tenant.customerId })
  } catch (err) {
    if (err instanceof BodiesError) {
      if (err.code === 'NOT_FOUND') return sendProblem(reply, { type: PROBLEM.notFound, title: 'Not Found', status: 404, detail: 'No such record for this customer.' })
      if (err.code === 'FORBIDDEN') return forbidden(reply, 'This is not permitted for this caller.')
    }
    deps.log.error('kernel-api: identity query failed', { customerId: tenant.customerId, err: (err as Error).message })
    reply.header('retry-after', String(RETRY_AFTER_REGISTRY)).header('cache-control', 'no-store')
    return sendProblem(reply, { type: PROBLEM.customerUnavailable, title: 'Service Unavailable', status: 503, detail: 'This customer is temporarily unavailable.' })
  }
}

export const getBodyTree = (deps: Deps): OperationHandler => (request, reply) => onTenant(deps, request, reply, (ctx) => bodiesReads.tree(ctx))

export const listBodySeats = (deps: Deps): OperationHandler => (request, reply) =>
  onTenant(deps, request, reply, (ctx) => bodiesReads.seats(ctx, (request.params as { bodyId: string }).bodyId))

export const listBodyMemberships = (deps: Deps): OperationHandler => (request, reply) =>
  onTenant(deps, request, reply, (ctx) => bodiesReads.memberships(ctx, (request.params as { bodyId: string }).bodyId, (request.query as { asOf?: string }).asOf))

export const listSeatTenures = (deps: Deps): OperationHandler => (request, reply) =>
  onTenant(deps, request, reply, (ctx) => bodiesReads.seatTenures(ctx, (request.params as { seatId: string }).seatId))

export const getPerson = (deps: Deps): OperationHandler => async (request, reply) => {
  const sub = subjectOf(request)
  if (sub === null) return forbidden(reply, 'A person record is served to the signed-in person only.')
  const out = await onTenant(deps, request, reply, (ctx) => bodiesReads.ownPerson(ctx, (request.params as { personId: string }).personId, sub))
  if (out === null) return forbidden(reply, 'A person record is served to the signed-in person only.')
  return out
}

export const getOwnPreference = (deps: Deps): OperationHandler => async (request, reply) => {
  const sub = subjectOf(request)
  if (sub === null) return forbidden(reply, 'The own preference belongs to a signed-in person.')
  const out = await onTenant(deps, request, reply, (ctx) => preferenceOps.getPreferenceBySubject(ctx, sub))
  return out === null ? forbidden(reply, 'The token belongs to no active person of this customer.') : out
}

export const putOwnPreference = (deps: Deps): OperationHandler => async (request, reply) => {
  const sub = subjectOf(request)
  if (sub === null) return forbidden(reply, 'The own preference belongs to a signed-in person.')
  const patch = request.body as PreferencePatch
  const { tenant } = getContext(request)
  try {
    const sql = await deps.tenantDb.sqlFor(tenant)
    return await preferenceOps.upsertPreferenceBySubject({ sql, customerId: tenant.customerId }, sub, patch)
  } catch (err) {
    if (err instanceof BodiesError && err.code === 'NOT_FOUND') return forbidden(reply, 'The token belongs to no active person of this customer.')
    if (err instanceof BodiesError && (err.code === 'INVALID' || err.code === 'CONFLICT')) {
      // a CHECK or the last_body_id foreign key refused the value: the caller's input, not an outage
      return sendProblem(reply, { type: 'urn:gremion:problem:validation-failed', title: 'Bad Request', status: 400, detail: 'The preference value is not accepted.' })
    }
    deps.log.error('kernel-api: preference write failed', { customerId: tenant.customerId, err: (err as Error).message })
    reply.header('retry-after', String(RETRY_AFTER_REGISTRY)).header('cache-control', 'no-store')
    return sendProblem(reply, { type: PROBLEM.customerUnavailable, title: 'Service Unavailable', status: 503, detail: 'This customer is temporarily unavailable.' })
  }
}
