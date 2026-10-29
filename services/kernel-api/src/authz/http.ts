// services/kernel-api/src/authz/http.ts — the five authz operations of
// openapi/kernel-core.json (tag authz). Thin: the tenant and the verified
// claims come from the tenancy hook's request context (never re-verified, never
// read from the body), the database handle from the customer's own kernel
// database, and every decision and grant rule lives in pdp.ts / grants.ts.
//
// decideAuthz is the module-caller route (@gremion/authz-client); the four grant
// routes take the person's bearer token. A refusal is problem+json; the
// step-up refusal also answers RFC 9470 (WWW-Authenticate insufficient_user_authentication).
import type { OperationHandler } from '@gremion/fastify-service-template'
import { sendProblem } from '@gremion/fastify-service-template'
import type { FastifyReply } from 'fastify'
import type { KernelApiDeps, TenantRow } from '../app/deps.ts'
import { getContext } from '../tenancy/context.ts'
import { GrantError } from './errors.ts'
import type { GrantRow } from './events.ts'
import { issueGrant, listGrants, mayReadGrants, revokeAllForPerson, revokeGrant, type Granter, type GrantDeps } from './grants.ts'
import { decide, type EnabledModules } from './pdp.ts'
import { STEPUP_MAX_AGE_SECONDS } from './stepup.ts'
import { AuthzInputError } from './tx.ts'

type Deps = Pick<KernelApiDeps, 'registry' | 'log'> & Partial<Pick<KernelApiDeps, 'kernelDb'>>

const TITLES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 409: 'Conflict', 422: 'Unprocessable Content', 500: 'Internal Server Error', 503: 'Service Unavailable' }

/** The customer's kernel database is not wired into this process: the documented 503, not a fault. */
export class KernelDbNotWiredError extends Error {
  override name = 'KernelDbNotWiredError'
  constructor() {
    super('kernel-api: the customer kernel database is not wired (authz)')
  }
}

const AVAILABILITY_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  // postgres.js connection-level codes
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'CONNECTION_ENDED',
  // PostgreSQL: admin_shutdown, crash_shutdown, cannot_connect_now, too_many_connections
  '57P01', '57P02', '57P03', '53300',
])
const AVAILABILITY_MESSAGE = /(connect(ion)?|pool|acquir\w*).{0,40}time(d)?[ -]?out|time(d)?[ -]?out.{0,40}(connect(ion)?|pool|acquir)/i

/**
 * Is this the customer's store being unreachable (503, retry later) rather than a fault in this process or a
 * statement the database refused (500)? Looks at the error, its cause and an AggregateError's members.
 */
export function isAvailabilityError(err: unknown, depth = 0): boolean {
  if (typeof err !== 'object' || err === null || depth > 3) return false
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (e instanceof KernelDbNotWiredError) return true
  if (typeof e.code === 'string' && (AVAILABILITY_CODES.has(e.code) || e.code.startsWith('08'))) return true
  if (typeof e.message === 'string' && AVAILABILITY_MESSAGE.test(e.message)) return true
  if (isAvailabilityError(e.cause, depth + 1)) return true
  return Array.isArray(e.errors) && e.errors.some((x) => isAvailabilityError(x, depth + 1))
}

function problem(reply: FastifyReply, code: string, status: number, detail: string): FastifyReply {
  if (status === 401) {
    reply.header('www-authenticate', `Bearer error="insufficient_user_authentication", error_description="a fresh step-up is required", acr_values="loa2", max_age=${STEPUP_MAX_AGE_SECONDS}`)
  }
  return sendProblem(reply, { type: `urn:gremion:problem:${code.replaceAll('_', '-')}`, title: TITLES[status] ?? 'Error', status, detail })
}

export function toApiGrant(g: GrantRow) {
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString())
  return {
    grantId: g.grant_id,
    bodyId: g.body_id,
    subjectPersonId: g.subject_person_id,
    grantKind: g.grant_kind,
    key: (g.role_key ?? g.capability_key)!,
    resourceKind: g.resource_kind,
    resourceId: g.resource_id,
    validFrom: iso(g.valid_from)!,
    validUntil: iso(g.valid_until),
    granterKind: g.granter_kind,
    source: g.source,
    state: g.state,
    revokedAt: iso(g.revoked_at),
    revokeReason: g.revoke_reason,
    rowVersion: Number(g.row_version),
  }
}

async function setup(deps: Deps, request: Parameters<OperationHandler>[0]) {
  const ctx = getContext(request)
  const tenant: TenantRow = ctx.tenant
  if (!deps.kernelDb) throw new KernelDbNotWiredError()
  const sql = await deps.kernelDb(tenant)
  const enabledModules: EnabledModules = async (customerId) => new Set((await deps.registry.listEnabled(customerId)).map((m) => m.moduleKey))
  const gdeps: GrantDeps = { enabledModules }
  return { ctx, tenant, sql, enabledModules, gdeps }
}

export function authzHandlers(deps: Deps): Record<'decideAuthz' | 'listAuthzGrants' | 'issueAuthzGrant' | 'revokeAuthzGrant' | 'revokeAllAuthzGrants', OperationHandler> {
  const failed = (reply: FastifyReply, err: unknown, operation: string, customerId: string | null) => {
    const e = (err ?? {}) as { message?: unknown; stack?: unknown; code?: unknown; constraint_name?: unknown }
    const unavailable = isAvailabilityError(err)
    // the cause goes to the log only: the response body names none of it
    deps.log.error(unavailable ? 'kernel-api: authz store unavailable' : 'kernel-api: authz request failed', {
      err: typeof e.message === 'string' ? e.message : String(err),
      stack: typeof e.stack === 'string' ? e.stack : null,
      code: typeof e.code === 'string' ? e.code : null,
      constraint_name: typeof e.constraint_name === 'string' ? e.constraint_name : null,
      operation,
      customerId,
    })
    return unavailable
      ? problem(reply, 'customer-unavailable', 503, 'This customer is temporarily unavailable.')
      : problem(reply, 'internal', 500, 'The request could not be completed.')
  }
  const userGranter = (ctx: ReturnType<typeof getContext>): Granter | null => (ctx.caller.kind === 'user' ? { kind: 'person', claims: ctx.caller.claims } : null)
  const run = async (operation: string, request: Parameters<OperationHandler>[0], reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GrantError) return problem(reply, err.code, err.status, err.message)
      if (err instanceof AuthzInputError) return problem(reply, 'bad-request', 400, err.message)
      let customerId: string | null = null
      try {
        customerId = getContext(request).tenant.customerId
      } catch {
        // no resolved context: the log line says so with a null customer
      }
      return failed(reply, err, operation, customerId)
    }
  }
  return {
    decideAuthz: async (request, reply) =>
      run('decideAuthz', request, reply, async () => {
        const { ctx, tenant, sql, enabledModules } = await setup(deps, request)
        // security: moduleCaller only. A person's bearer must never read another person's decisions.
        if (ctx.caller.kind !== 'module') return problem(reply, 'forbidden', 403, 'Decisions are served to module callers only.')
        const b = request.body as { subject: string; bodyId: string; capability: string; resource?: { kind: string; id: string } }
        const d = await decide(sql, enabledModules, { customerId: tenant.customerId, subject: { sub: b.subject }, bodyId: b.bodyId, capability: b.capability, ...(b.resource ? { resource: b.resource } : {}) })
        return { allow: d.allow, reason: d.reason, grantIds: d.grantIds }
      }),
    listAuthzGrants: async (request, reply) =>
      run('listAuthzGrants', request, reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const q = request.query as { bodyId: string; personId?: string }
        if (ctx.caller.kind !== 'user') return problem(reply, 'forbidden', 403, 'Grants are listed by a person.')
        const d = await mayReadGrants(sql, gdeps, tenant.customerId, ctx.caller.claims, q.bodyId)
        if (!d.allow) return problem(reply, 'forbidden', 403, `Reading grants is not allowed in this body (${d.reason}).`)
        const rows = await listGrants(sql, tenant.customerId, { bodyId: q.bodyId, ...(q.personId ? { personId: q.personId } : {}) })
        return { grants: rows.map(toApiGrant) }
      }),
    issueAuthzGrant: async (request, reply) =>
      run('issueAuthzGrant', request, reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are issued by a person.')
        const b = request.body as Parameters<typeof issueGrant>[4]
        const row = await issueGrant(sql, gdeps, tenant.customerId, granter, b)
        return reply.code(201).send(toApiGrant(row))
      }),
    revokeAuthzGrant: async (request, reply) =>
      run('revokeAuthzGrant', request, reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are revoked by a person.')
        const { grantId } = request.params as { grantId: string }
        return toApiGrant(await revokeGrant(sql, gdeps, tenant.customerId, granter, grantId))
      }),
    revokeAllAuthzGrants: async (request, reply) =>
      run('revokeAllAuthzGrants', request, reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are revoked by a person.')
        const { personId } = request.params as { personId: string }
        return { grants: (await revokeAllForPerson(sql, gdeps, tenant.customerId, granter, personId)).map(toApiGrant) }
      }),
  }
}
