// services/kernel-api/src/tenancy/context.ts — the resolved request context.
// Set ONLY by the tenancy hook, after every check passed; a handler that
// finds none fails closed (500), it never guesses a customer.
import type { FastifyRequest } from 'fastify'
import type { TenantRow } from '../app/deps.ts'

export type Caller = { kind: 'user'; claims: Record<string, unknown> } | { kind: 'module'; moduleKey: string }

export interface RequestContext {
  tenant: TenantRow
  caller: Caller
}

const CONTEXT = new WeakMap<FastifyRequest, RequestContext>()

export function setContext(request: FastifyRequest, ctx: RequestContext): void {
  CONTEXT.set(request, Object.freeze({ ...ctx }))
}

export class NoTenantContextError extends Error {
  override name = 'NoTenantContextError'
  constructor() {
    super('no resolved tenant context on this request: the tenancy hook did not run for this route')
  }
}

export function getContext(request: FastifyRequest): RequestContext {
  const ctx = CONTEXT.get(request)
  if (!ctx) throw new NoTenantContextError()
  return ctx
}
