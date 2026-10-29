// The operationId -> handler table (Q11, shared-append): dependants (TASK-080
// bodies, TASK-081 authz) add their entries here, kept SORTED BY operationId,
// and their operations to openapi/kernel-core.json under their own tag.
// createService refuses to boot if this table and the spec disagree in either
// direction.
import type { HandlerTable } from '@gremion/fastify-service-template'
import type { KernelApiDeps } from '../app/deps.ts'
import { getBodyTree, getOwnPreference, getPerson, listBodyMemberships, listBodySeats, listSeatTenures, putOwnPreference } from './bodies.ts'
import { getTenancySelf } from './getTenancySelf.ts'
import { listEnabledModules } from './listEnabledModules.ts'

export function createHandlers(deps: KernelApiDeps): HandlerTable {
  return {
    getBodyTree: getBodyTree(deps),
    getHealth: async () => ({ status: 'ok' }),
    getOwnPreference: getOwnPreference(deps),
    getPerson: getPerson(deps),
    getTenancySelf: getTenancySelf(),
    listBodyMemberships: listBodyMemberships(deps),
    listBodySeats: listBodySeats(deps),
    listEnabledModules: listEnabledModules(deps),
    listSeatTenures: listSeatTenures(deps),
    putOwnPreference: putOwnPreference(deps),
  }
}
