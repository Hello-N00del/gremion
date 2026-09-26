// routes:check core. Fail-closed diff of a service's ACTUAL route table (the
// onRoute collector createService installs) against the spec's declared
// (METHOD, path) set, read independently from the spec file.
//
// Ported idea (not import) from gremion-ui's boundary/route-coverage.ts: both
// sides normalised to `METHOD /spec/{path}` keys and diffed as one list each
// way. Added here: duplicates on either side, the platform allow-list, and a
// vacuity guard (a spec with no operations proves nothing).
import type { FastifyInstance } from 'fastify'
import { PLATFORM_ROUTES, type PlatformRoute } from './loader.ts'
import { getRouteTable } from './service.ts'
import { routeKey, specRouteKeys, type OpenApiDocument } from './spec.ts'

export interface RoutesCheckResult {
  ok: boolean
  problems: string[]
  declared: number
  actual: number
}

/** `/a/{id}` and `/a/{x}` are the same route to a router: compare on the shape. */
function shape(key: string): string {
  return key.replace(/\{[^}/]*\}/g, '{}')
}

function duplicatesByShape(keys: string[]): Map<string, string[]> {
  const byShape = new Map<string, string[]>()
  for (const k of keys) byShape.set(shape(k), [...(byShape.get(shape(k)) ?? []), k])
  return new Map([...byShape].filter(([, ks]) => ks.length > 1))
}

export function diffRouteTables(input: {
  declared: string[]
  actual: string[]
  platform?: readonly PlatformRoute[]
}): RoutesCheckResult {
  const { declared, actual } = input
  const platformKeys = (input.platform ?? PLATFORM_ROUTES).map((r) => routeKey(r.method, r.path))
  const problems: string[] = []

  if (declared.length === 0) {
    problems.push('the spec declares 0 operations: nothing to check (vacuous), refusing to pass')
  }
  for (const [, keys] of duplicatesByShape(declared)) {
    problems.push(`duplicate route in the spec: ${keys.join(' and ')} resolve to the same route`)
  }
  for (const [, keys] of duplicatesByShape(actual)) {
    problems.push(`duplicate route registered: ${keys.join(' and ')} (${keys.length} registrations for one route)`)
  }

  const declaredSet = new Set(declared)
  const actualSet = new Set(actual)
  for (const k of [...declaredSet].sort()) {
    if (!actualSet.has(k)) problems.push(`missing route: ${k} is declared in the spec but not registered`)
  }
  for (const k of [...actualSet].sort()) {
    if (declaredSet.has(k) || platformKeys.includes(k)) continue
    problems.push(`extra route: ${k} is registered but not declared in the spec (only ${platformKeys.join(', ')} are exempt)`)
  }
  for (const k of platformKeys) {
    if (!declaredSet.has(k) && !actualSet.has(k)) problems.push(`platform route ${k} is not registered`)
  }
  return { ok: problems.length === 0, problems, declared: declared.length, actual: actual.length }
}

/**
 * Boot `app` (a createService instance, possibly with hand-written extras) and
 * diff its route table against `specDoc`. A boot failure is itself a problem,
 * reported with whatever the collector saw before it.
 */
export async function checkAppRoutes(app: FastifyInstance, specDoc: OpenApiDocument): Promise<RoutesCheckResult> {
  const problems: string[] = []
  try {
    await app.ready()
  } catch (e) {
    problems.push(`service failed to boot: ${(e as Error).message}`)
  }
  const result = diffRouteTables({ declared: specRouteKeys(specDoc), actual: getRouteTable(app) })
  return { ...result, ok: result.ok && problems.length === 0, problems: [...problems, ...result.problems] }
}
