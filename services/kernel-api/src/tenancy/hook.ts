// services/kernel-api/src/tenancy/hook.ts — the ONE tenancy gate, an
// onRequest hook in front of every spec operation but getHealth (the route
// sweep test proves it covers every route the template registers, C18).
//
// Two ways in, and nothing else:
//
//   EDGE / BFF path (a request carrying no x-gremion-module):
//     1. x-proxy-trust constant-time equals TENANT_PROXY_SHARED_SECRET, else
//        403 -- before any registry read (Q8; boot refuses an unset secret);
//     2. X-Forwarded-Host normalises (tenancy-core, the ONE normaliser) and
//        Host names the same host, else 404, no registry read (TASK-041 Q2;
//        RFC 7239 s8.1); a reserved platform name is 404, no registry read;
//     3. exactly ONE lookup of the WHOLE host in the control registry (Q1;
//        TRD-082 pinned exemption 1): none -> 404 unbound; provisioning,
//        deleting, deleted -> 404 inactive; suspended -> 503, no data; the
//        control DB down -> 503, nothing cached (Q9 caches nothing at all);
//     4. a Bearer access token of THAT customer's realm (Q7), else 401 --
//        before the customer's own database is touched;
//     5. the customer's kernel database is at the kernel-api manifest, else
//        503 for THIS customer only (B21; the gate caches nothing, A3).
//
//   MODULE CALLER path (Q8, gremion-ui leaf-trust's four clauses, B8):
//     1. the operation is on MODULE_CALLER_OPERATIONS (exact operationIds),
//        else 403;
//     2. x-internal-auth constant-time equals that module's own
//        KERNEL_API_MODULE_SECRET_<ID> (unset = no trust), else 401;
//     3. x-tenant-id is a canonical UUIDv7, else 401;
//     4. the module is enabled for that customer, else 403;
//     then the same status table and gate as above. No host is involved.
//
// Every 404 on the host path emits ONE tenant.host.rejected event (TRD-076)
// through the bounded emitter; a 503 never does. Problem bodies name no
// customer, no host and no file (details go to the log).
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { sendProblem } from '@gremion/fastify-service-template'
import { isReservedPlatformHost, normaliseHost, type HostRejectReason } from '@gremion/tenancy-core'
import type { KernelApiDeps, TenantRow } from '../app/deps.ts'
import { setContext } from './context.ts'

/** The operations a module caller may call (clause 1): exact operationIds, never a prefix. */
export const MODULE_CALLER_OPERATIONS: ReadonlySet<string> = new Set(['getTenancySelf', 'listEnabledModules'])

/** RFC 9562 UUIDv7, canonical lower case (the control registry's customer id). */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const PROBLEM = {
  forbidden: 'urn:gremion:problem:forbidden',
  unauthorized: 'urn:gremion:problem:unauthorized',
  notFound: 'urn:gremion:problem:not-found',
  customerUnavailable: 'urn:gremion:problem:customer-unavailable',
  registryUnavailable: 'urn:gremion:problem:registry-unavailable',
  notConfigured: 'urn:gremion:problem:not-configured',
} as const

/** Retry-After of a suspended customer and of a registry outage. */
export const RETRY_AFTER_SUSPENDED = 30
export const RETRY_AFTER_REGISTRY = 5

/** Constant-time comparison of two secrets of any length (hash first, so lengths never leak). */
export function constantTimeEqual(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b) && supplied.length === expected.length
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name]
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined
  return v
}

function forbidden(reply: FastifyReply, detail: string): FastifyReply {
  return sendProblem(reply, { type: PROBLEM.forbidden, title: 'Forbidden', status: 403, detail })
}

function unauthorized(reply: FastifyReply, detail: string): FastifyReply {
  reply.header('www-authenticate', 'Bearer')
  return sendProblem(reply, { type: PROBLEM.unauthorized, title: 'Unauthorized', status: 401, detail })
}

function notFound(reply: FastifyReply): FastifyReply {
  return sendProblem(reply, { type: PROBLEM.notFound, title: 'Not Found', status: 404, detail: 'No customer is served at this address.' })
}

function unavailable(reply: FastifyReply, type: string, retryAfterSeconds: number, detail: string): FastifyReply {
  reply.header('retry-after', String(retryAfterSeconds)).header('cache-control', 'no-store')
  return sendProblem(reply, { type, title: 'Service Unavailable', status: 503, detail })
}

export interface TenancyHookOptions {
  /**
   * The spec operationId of the matched route; null when NO route matched
   * (the 404 handler answers). A matched route with no operation must throw
   * (fail closed: 500), never return null.
   */
  operationOf(request: FastifyRequest): string | null
  /** Operations served with no tenant (getHealth). */
  exempt: ReadonlySet<string>
}

export function createTenancyHook(deps: KernelApiDeps, opts: TenancyHookOptions) {
  const rejectHost = (reply: FastifyReply, reason: HostRejectReason, host: string | null | undefined): FastifyReply => {
    // Decide first, then the event, then answer; the emitter never throws.
    try {
      deps.hostRejection(reason, host ?? '')
    } catch {
      // a logging failure never turns a 404 into a 500
    }
    return notFound(reply)
  }

  /** Steps shared by both paths once a customer row is in hand: status table, then (caller check), then the gate. */
  const statusRefusal = (reply: FastifyReply, tenant: TenantRow, onInactive: () => FastifyReply): FastifyReply | null => {
    if (tenant.status === 'active') return null
    if (tenant.status === 'suspended') {
      return unavailable(reply, PROBLEM.customerUnavailable, RETRY_AFTER_SUSPENDED, 'This customer is suspended.')
    }
    // provisioning, deleting, deleted: not served, indistinguishable from unbound
    return onInactive()
  }

  const gate = async (reply: FastifyReply, tenant: TenantRow): Promise<FastifyReply | null> => {
    let verdict
    try {
      verdict = await deps.gate.check(tenant)
    } catch (err) {
      deps.log.error('kernel-api: schema gate failed', { customerId: tenant.customerId, err: (err as Error).message })
      verdict = { ok: false as const, reason: 'unavailable' as const, retryAfterSeconds: RETRY_AFTER_REGISTRY }
    }
    if (verdict.ok) return null
    deps.log.warn('kernel-api: customer database not served', { customerId: tenant.customerId, reason: verdict.reason })
    return unavailable(reply, PROBLEM.customerUnavailable, verdict.retryAfterSeconds, 'This customer is temporarily unavailable.')
  }

  const modulePath = async (request: FastifyRequest, reply: FastifyReply, operationId: string, moduleKey: string): Promise<FastifyReply | void> => {
    if (!MODULE_CALLER_OPERATIONS.has(operationId)) return forbidden(reply, 'A module may not call this operation.')
    const expected = deps.moduleSecrets.get(moduleKey)
    const supplied = header(request, 'x-internal-auth')
    if (!expected || !supplied || !constantTimeEqual(supplied, expected)) return unauthorized(reply, 'The module credential is missing or wrong.')
    const tenantId = header(request, 'x-tenant-id')
    if (!tenantId || !UUID_V7.test(tenantId)) return unauthorized(reply, 'x-tenant-id is not a customer id.')
    let tenant: TenantRow | null
    try {
      tenant = await deps.tenancy.lookupId(tenantId)
    } catch (err) {
      deps.log.error('kernel-api: control registry lookup failed', { err: (err as Error).message })
      return unavailable(reply, PROBLEM.registryUnavailable, RETRY_AFTER_REGISTRY, 'The customer registry is unavailable.')
    }
    if (!tenant) return notFound(reply)
    const refused = statusRefusal(reply, tenant, () => notFound(reply))
    if (refused) return refused
    let enabled: boolean
    try {
      enabled = await deps.registry.isEnabled(tenant.customerId, moduleKey)
    } catch (err) {
      deps.log.error('kernel-api: module registry lookup failed', { err: (err as Error).message })
      return unavailable(reply, PROBLEM.registryUnavailable, RETRY_AFTER_REGISTRY, 'The module registry is unavailable.')
    }
    if (!enabled) return forbidden(reply, 'This module is not enabled for this customer.')
    const closed = await gate(reply, tenant)
    if (closed) return closed
    setContext(request, { tenant, caller: { kind: 'module', moduleKey } })
  }

  const edgePath = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (!deps.proxySecret || !deps.platformDomain) {
      return unavailable(reply, PROBLEM.notConfigured, RETRY_AFTER_REGISTRY, 'The kernel API is not configured.')
    }
    const trust = header(request, 'x-proxy-trust')
    if (!trust || !constantTimeEqual(trust, deps.proxySecret)) return forbidden(reply, 'The request did not come through the proxy.')

    const rawForwarded = header(request, 'x-forwarded-host')
    const host = normaliseHost(rawForwarded)
    if (!host) return rejectHost(reply, 'unparseable', rawForwarded)
    if (normaliseHost(header(request, 'host')) !== host) return rejectHost(reply, 'forged', host)
    if (isReservedPlatformHost(host, deps.platformDomain)) return rejectHost(reply, 'unbound', host)

    let tenant: TenantRow | null
    try {
      tenant = await deps.tenancy.lookupHost(host)
    } catch (err) {
      deps.log.error('kernel-api: control registry lookup failed', { host, err: (err as Error).message })
      return unavailable(reply, PROBLEM.registryUnavailable, RETRY_AFTER_REGISTRY, 'The customer registry is unavailable.')
    }
    if (!tenant) return rejectHost(reply, 'unbound', host)
    const refused = statusRefusal(reply, tenant, () => rejectHost(reply, 'inactive', host))
    if (refused) return refused

    const auth = header(request, 'authorization')
    const m = auth ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(auth) : null
    if (!m) return unauthorized(reply, 'A bearer access token of this customer is required.')
    let claims: Record<string, unknown>
    try {
      claims = await deps.tokens.verify(m[1]!, tenant)
    } catch (err) {
      deps.log.warn('kernel-api: token refused', { customerId: tenant.customerId, err: (err as Error).message })
      return unauthorized(reply, 'The access token is not valid for this customer.')
    }
    const closed = await gate(reply, tenant)
    if (closed) return closed
    setContext(request, { tenant, caller: { kind: 'user', claims } })
  }

  return async function tenancyHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const operationId = opts.operationOf(request)
    // No route matched (the 404 handler answers it) or an exempt one: no tenant.
    if (operationId === null || opts.exempt.has(operationId)) return
    const moduleKey = header(request, 'x-gremion-module')
    if (moduleKey !== undefined) return modulePath(request, reply, operationId, moduleKey)
    return edgePath(request, reply)
  }
}
