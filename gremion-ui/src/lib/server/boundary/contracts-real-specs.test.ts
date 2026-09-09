// gremion-ui/src/lib/server/boundary/contracts-real-specs.test.ts
// P0.4 permanent gates: the checked-in kernel specs are structurally valid,
// $ref-closed, and inventory-equivalent to the live route tree. Runs in every
// `pnpm test:unit` — this is the contract-drift alarm, independent of CI.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } from './contracts-schema'
import { listKernelRoutes, specOpsFromDocs, compareCoverage } from './route-coverage'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const repoRoot = join(gremionUiRoot, '..')
const load = (rel: string) => JSON.parse(readFileSync(join(repoRoot, 'contracts', rel), 'utf8'))

describe('checked-in kernel contracts', () => {
  // Carve note: the finance OpenAPI contract (kernel/openapi.finance.json) left
  // with the finance module, so only the governance OpenAPI spec is checked.
  const gov = load('kernel/openapi.governance.json')

  it('OpenAPI docs are structurally valid with resolvable refs', () => {
    for (const d of [gov]) {
      expect(validateOpenApiDoc(d)).toEqual([])
      expect(collectUnresolvedRefs(d)).toEqual([])
    }
  })

  it('spec inventory === kernel route inventory (both directions)', () => {
    const routes = listKernelRoutes(join(gremionUiRoot, 'src/routes'))
    const { missingInSpec, extraInSpec } = compareCoverage(routes, specOpsFromDocs([gov]))
    expect(missingInSpec, `add these operations to the spec (same commit as the route change):\n${missingInSpec.join('\n')}`).toEqual([])
    expect(extraInSpec, `these spec operations have no route (remove or fix):\n${extraInSpec.join('\n')}`).toEqual([])
  })

  // AsyncAPI assertions activate in Task 14 — written here, skipped until the file exists.
  it('AsyncAPI doc (if present) is structurally valid', () => {
    let doc: unknown
    try { doc = load('kernel/asyncapi.provisioning.json') } catch { return /* lands in Task 14 */ }
    expect(validateAsyncApiDoc(doc)).toEqual([])
    expect(collectUnresolvedRefs(doc)).toEqual([])
  })
})
