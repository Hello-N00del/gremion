import { describe, it, expect } from 'vitest'
import { toSpecPath, parseExportedMethods, isKernelRoute, compareCoverage } from './route-coverage'

describe('toSpecPath', () => {
  it('converts SvelteKit dirs to OpenAPI paths', () => {
    expect(toSpecPath('api/groups')).toBe('/api/groups')
    expect(toSpecPath('api/groups/[id]')).toBe('/api/groups/{id}')
    expect(toSpecPath('api/finance/budget/[id]/groups/[gid]')).toBe('/api/finance/budget/{id}/groups/{gid}')
    expect(toSpecPath('api/files/[...path]')).toBe('/api/files/{path}')
  })
})

describe('parseExportedMethods', () => {
  it('finds const/function method exports', () => {
    const src = `export const GET: RequestHandler = () => {}\nexport async function POST() {}\nconst DELETE = 1 // not exported`
    expect(parseExportedMethods(src)).toEqual(['GET', 'POST'])
  })
})

describe('isKernelRoute', () => {
  it('matches kernel prefixes segment-safely + the extra route', () => {
    expect(isKernelRoute('api/governance/committees/[id]')).toBe(true)
    expect(isKernelRoute('api/groups')).toBe(true)
    expect(isKernelRoute('api/groupsX')).toBe(false)
    expect(isKernelRoute('api/committees/[id]/child-term')).toBe(true)
    expect(isKernelRoute('api/committees/[id]/beschluesse')).toBe(false)
    expect(isKernelRoute('api/newsletter')).toBe(false)
  })
})

describe('compareCoverage', () => {
  const routes = [{ specPath: '/api/groups', methods: ['GET', 'POST'] }]
  it('reports spec gaps and phantom spec entries', () => {
    const specOps = new Set(['get /api/groups', 'delete /api/groups'])
    const r = compareCoverage(routes, specOps)
    expect(r.missingInSpec).toEqual(['post /api/groups'])
    expect(r.extraInSpec).toEqual(['delete /api/groups'])
  })
  it('is empty when equivalent', () => {
    const r = compareCoverage(routes, new Set(['get /api/groups', 'post /api/groups']))
    expect(r.missingInSpec).toEqual([])
    expect(r.extraInSpec).toEqual([])
  })
})
