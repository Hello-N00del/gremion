// The operationId -> handler table (Q11, shared-append): dependants (TASK-080
// bodies, TASK-081 authz) add their entries here, kept SORTED BY operationId,
// and their operations to openapi/kernel-core.json under their own tag.
// createService refuses to boot if this table and the spec disagree in either
// direction.
import type { HandlerTable } from '@gremion/fastify-service-template'
import type { KernelApiDeps } from '../app/deps.ts'
import { getTenancySelf } from './getTenancySelf.ts'
import { authzHandlers } from '../authz/http.ts'
import { listEnabledModules } from './listEnabledModules.ts'

export function createHandlers(deps: KernelApiDeps): HandlerTable {
  const authz = authzHandlers(deps)
  return {
    decideAuthz: authz.decideAuthz,
    getHealth: async () => ({ status: 'ok' }),
    getTenancySelf: getTenancySelf(),
    issueAuthzGrant: authz.issueAuthzGrant,
    listAuthzGrants: authz.listAuthzGrants,
    listEnabledModules: listEnabledModules(deps),
    revokeAllAuthzGrants: authz.revokeAllAuthzGrants,
    revokeAuthzGrant: authz.revokeAuthzGrant,
  }
}
