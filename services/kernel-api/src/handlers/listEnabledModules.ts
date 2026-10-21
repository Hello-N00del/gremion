// operationId listEnabledModules: GET /api/v1/modules (PRD-PLAT-012).
// Exactly the resolved customer's plt.module_enablement rows in state
// 'enabled' (the query carries customer_id = the resolved id, TRD-082), each
// with the runtime declaration of the module.json this image carries.
//
// Skew rule (lane note s.5): the declaration is served only when its
// runtime.version equals the semver of the version the customer ENABLED. A
// mismatch, or an enabled module this image has no declaration for, is an
// image/database skew (a deploy bug): 503 for THIS customer, logged, and
// never a declaration of a version the customer did not enable.
import type { OperationHandler } from '@gremion/fastify-service-template'
import { sendProblem } from '@gremion/fastify-service-template'
import type { KernelApiDeps } from '../app/deps.ts'
import { getContext } from '../tenancy/context.ts'
import { PROBLEM, RETRY_AFTER_REGISTRY } from '../tenancy/hook.ts'

export function listEnabledModules(deps: Pick<KernelApiDeps, 'registry' | 'declarations' | 'log'>): OperationHandler {
  return async (request, reply) => {
    const { tenant } = getContext(request)
    let rows
    try {
      rows = await deps.registry.listEnabled(tenant.customerId)
    } catch (err) {
      deps.log.error('kernel-api: module registry lookup failed', { customerId: tenant.customerId, err: (err as Error).message })
      reply.header('retry-after', String(RETRY_AFTER_REGISTRY)).header('cache-control', 'no-store')
      return sendProblem(reply, { type: PROBLEM.registryUnavailable, title: 'Service Unavailable', status: 503, detail: 'The module registry is unavailable.' })
    }
    const modules = []
    const skew: string[] = []
    for (const row of rows) {
      const decl = deps.declarations.get(row.moduleKey)
      if (!decl || decl.version !== row.semver) {
        skew.push(`${row.moduleKey}: enabled ${row.semver}, image ${decl ? decl.version : 'none'}`)
        continue
      }
      modules.push({ moduleKey: row.moduleKey, semver: row.semver, runtime: decl })
    }
    if (skew.length) {
      deps.log.error('kernel-api: module declaration skew', { customerId: tenant.customerId, skew })
      reply.header('retry-after', String(RETRY_AFTER_REGISTRY)).header('cache-control', 'no-store')
      return sendProblem(reply, { type: PROBLEM.customerUnavailable, title: 'Service Unavailable', status: 503, detail: 'This customer is temporarily unavailable.' })
    }
    return { customerId: tenant.customerId, modules }
  }
}
