// The operationId -> handler table (Q11, shared-append): dependants (TASK-080
// bodies, TASK-081 authz) add their entries here, kept SORTED BY operationId,
// and their operations to openapi/kernel-core.json under their own tag.
// createService refuses to boot if this table and the spec disagree in either
// direction.
import type { HandlerTable } from '@gremion/fastify-service-template'
import type { KernelApiDeps } from '../app/deps.ts'
import { getTenancySelf } from './getTenancySelf.ts'
import { listEnabledModules } from './listEnabledModules.ts'

export function createHandlers(deps: KernelApiDeps): HandlerTable {
  return {
    getHealth: async () => ({ status: 'ok' }),
    getTenancySelf: getTenancySelf(),
    listEnabledModules: listEnabledModules(deps),
  }
}
