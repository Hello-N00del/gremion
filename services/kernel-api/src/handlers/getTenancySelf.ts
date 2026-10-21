// operationId getTenancySelf: GET /api/v1/tenancy/self (TRD-407 first half).
// The customer the tenancy hook resolved: id, slug, realm. Nothing is read
// here; the hook already did the one lookup.
import type { OperationHandler } from '@gremion/fastify-service-template'
import { getContext } from '../tenancy/context.ts'

export function getTenancySelf(): OperationHandler {
  return async (request) => {
    const { tenant } = getContext(request)
    return { customerId: tenant.customerId, slug: tenant.slug, realm: tenant.realm }
  }
}
