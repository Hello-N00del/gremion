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
import { issueGrant, listGrants, revokeAllForPerson, revokeGrant, type Granter, type GrantDeps } from './grants.ts'
import { decide, type EnabledModules } from './pdp.ts'
import { STEPUP_MAX_AGE_SECONDS } from './stepup.ts'

type Deps = Pick<KernelApiDeps, 'registry' | 'log'> & Partial<Pick<KernelApiDeps, 'kernelDb'>>

const TITLES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 409: 'Conflict', 422: 'Unprocessable Content', 503: 'Service Unavailable' }

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
  if (!deps.kernelDb) throw new Error('kernel-api: the customer kernel database is not wired (authz)')
  const sql = await deps.kernelDb(tenant)
  const enabledModules: EnabledModules = async (customerId) => new Set((await deps.registry.listEnabled(customerId)).map((m) => m.moduleKey))
  const gdeps: GrantDeps = { enabledModules }
  return { ctx, tenant, sql, enabledModules, gdeps }
}

export function authzHandlers(deps: Deps): Record<'decideAuthz' | 'listAuthzGrants' | 'issueAuthzGrant' | 'revokeAuthzGrant' | 'revokeAllAuthzGrants', OperationHandler> {
  const unavailable = (reply: FastifyReply, err: unknown) => {
    deps.log.error('kernel-api: authz store unavailable', { err: (err as Error).message })
    return problem(reply, 'customer-unavailable', 503, 'This customer is temporarily unavailable.')
  }
  const userGranter = (ctx: ReturnType<typeof getContext>): Granter | null => (ctx.caller.kind === 'user' ? { kind: 'person', claims: ctx.caller.claims } : null)
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GrantError) return problem(reply, err.code, err.status, err.message)
      if (err instanceof TypeError && /^authz: /.test(err.message)) return problem(reply, 'bad-request', 400, err.message)
      return unavailable(reply, err)
    }
  }
  return {
    decideAuthz: async (request, reply) =>
      run(reply, async () => {
        const { ctx, tenant, sql, enabledModules } = await setup(deps, request)
        // security: moduleCaller only. A person's bearer must never read another person's decisions.
        if (ctx.caller.kind !== 'module') return problem(reply, 'forbidden', 403, 'Decisions are served to module callers only.')
        const b = request.body as { subject: string; bodyId: string; capability: string; resource?: { kind: string; id: string } }
        const d = await decide(sql, enabledModules, { customerId: tenant.customerId, subject: { sub: b.subject }, bodyId: b.bodyId, capability: b.capability, ...(b.resource ? { resource: b.resource } : {}) })
        return { allow: d.allow, reason: d.reason, grantIds: d.grantIds }
      }),
    listAuthzGrants: async (request, reply) =>
      run(reply, async () => {
        const { ctx, tenant, sql, enabledModules } = await setup(deps, request)
        const q = request.query as { bodyId: string; personId?: string }
        if (ctx.caller.kind !== 'user') return problem(reply, 'forbidden', 403, 'Grants are listed by a person.')
        const d = await decide(sql, enabledModules, { customerId: tenant.customerId, subject: { sub: String(ctx.caller.claims.sub ?? '') }, bodyId: q.bodyId, capability: 'idt.grant.read' })
        if (!d.allow) return problem(reply, 'forbidden', 403, `Reading grants is not allowed in this body (${d.reason}).`)
        const rows = await listGrants(sql, tenant.customerId, { bodyId: q.bodyId, ...(q.personId ? { personId: q.personId } : {}) })
        return { grants: rows.map(toApiGrant) }
      }),
    issueAuthzGrant: async (request, reply) =>
      run(reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are issued by a person.')
        const b = request.body as Parameters<typeof issueGrant>[4]
        const row = await issueGrant(sql, gdeps, tenant.customerId, granter, b)
        return reply.code(201).send(toApiGrant(row))
      }),
    revokeAuthzGrant: async (request, reply) =>
      run(reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are revoked by a person.')
        const { grantId } = request.params as { grantId: string }
        return toApiGrant(await revokeGrant(sql, gdeps, tenant.customerId, granter, grantId))
      }),
    revokeAllAuthzGrants: async (request, reply) =>
      run(reply, async () => {
        const { ctx, tenant, sql, gdeps } = await setup(deps, request)
        const granter = userGranter(ctx)
        if (!granter) return problem(reply, 'forbidden', 403, 'Grants are revoked by a person.')
        const { personId } = request.params as { personId: string }
        return { grants: (await revokeAllForPerson(sql, gdeps, tenant.customerId, granter, personId)).map(toApiGrant) }
      }),
  }
}
