// services/kernel-api/src/app/build.ts — buildApp(config, deps): the kernel
// API as a template service (Q5, Q11: ONE spec, openapi/kernel-core.json).
//
// Routes come from the spec (the template's loader); this file adds the two
// hooks the template has no seam for (C18), on the root instance, so they
// cover every route it registered:
//   onRequest         the tenancy gate (src/tenancy/hook.ts) -- every
//                     operation but getHealth (route sweep test, TDD 2);
//   preSerialization  the response contract (Q4, response-contract.ts).
//
// Constructs without a database, a secret or a network (routes:check boots
// it with no environment): with no deps every tenant-resolved request is a
// 503 not-configured, and nothing is read.
import { createService, inlineRefs, listOperations, loadSpec, routeKey, toFastifyPath, type ServiceConfig } from '@gremion/fastify-service-template'
import type { FastifyRequest } from 'fastify'
import { createHandlers } from '../handlers/index.ts'
import { createTenancyHook } from '../tenancy/hook.ts'
import { unwiredDeps, type KernelApiDeps } from './deps.ts'
import { buildResponseContract, createResponseContractHook } from './response-contract.ts'

export const SPEC_URL = new URL('../../openapi/kernel-core.json', import.meta.url)

/** Operations served with no tenant. */
export const TENANT_EXEMPT_OPERATIONS: ReadonlySet<string> = new Set(['getHealth'])

export class UnmappedRouteError extends Error {
  override name = 'UnmappedRouteError'
}

export interface BuildOptions {
  /**
   * Where the spec is read from. Default SPEC_URL (relative to this source
   * file); the bundled image passes its own path (dist/ is one level below
   * the service root, src/app/ two).
   */
  spec?: URL | string
}

export function buildApp(config: ServiceConfig = {}, deps: KernelApiDeps = unwiredDeps(), options: BuildOptions = {}) {
  const spec = options.spec ?? SPEC_URL
  const app = createService({ spec, handlers: createHandlers(deps), config })
  const doc = inlineRefs(loadSpec(spec))
  const opByRoute = new Map<string, string>()
  for (const op of listOperations(doc)) if (op.operationId) opByRoute.set(routeKey(op.method, toFastifyPath(op.path)), op.operationId)

  const operationOf = (request: FastifyRequest): string | null => {
    const url = request.routeOptions?.url
    if (url === undefined) return null
    const id = opByRoute.get(routeKey(request.method, url))
    // Fail closed: a route the template registered that maps to no operation
    // is never served unguarded (the error handler answers 500).
    if (id === undefined) throw new UnmappedRouteError(`route ${request.method} ${url} maps to no spec operation`)
    return id
  }

  app.addHook('onRequest', createTenancyHook(deps, { operationOf, exempt: TENANT_EXEMPT_OPERATIONS }))
  app.addHook('preSerialization', createResponseContractHook({ contract: buildResponseContract(doc), operationOf, log: deps.log }))
  return app
}
