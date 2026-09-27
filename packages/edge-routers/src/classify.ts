// classify.ts — colour-bound vs state-bound, the classification spec A §F.4.10
// makes and gremion-verify's check_routers applies to the RUNNING edge.
//
// A router is COLOUR-BOUND when its service is one of the four file-provider
// services active.yml defines and gremion-switch rewrites; everything else —
// including a same-named service from another provider — is STATE-BOUND and
// untouched by a switch. test/classify.test.ts reads gremion-verify as text and
// asserts its bash `case` table is equal to COLOUR_BOUND_SERVICES, so the two
// classifiers cannot drift.

export const COLOUR_BOUND_SERVICES = Object.freeze([
  'app@file',
  'public@file',
  'app-next@file',
  'public-next@file',
] as const)

export type RouterClass = 'colour-bound' | 'state-bound'

/**
 * Traefik reports a router's service WITHOUT a provider suffix when router and
 * service share a provider, and resolves the bare name against the ROUTER's
 * provider. Same rule as gremion-verify check_routers.
 */
export function qualifyService(service: string, routerName: string): string {
  if (service.includes('@')) return service
  const at = routerName.lastIndexOf('@')
  if (at < 0 || at === routerName.length - 1) {
    throw new Error(`qualifyService: router name ${JSON.stringify(routerName)} carries no provider`)
  }
  return `${service}@${routerName.slice(at + 1)}`
}

export function classifyService(qualified: string): RouterClass {
  return (COLOUR_BOUND_SERVICES as readonly string[]).includes(qualified) ? 'colour-bound' : 'state-bound'
}

export function classifyRouter(router: { readonly name: string; readonly service: string }): RouterClass {
  return classifyService(qualifyService(router.service, router.name))
}
