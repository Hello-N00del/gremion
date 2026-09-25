// packages/generated-clients/src/governance-http-surface.test.ts
//
// TASK-083 round 4: HTTP-surface conventions for
// contracts/governance/openapi.gov.json that the brief fixes as decisions
// (§5 Q6 problem types, Q7 cursor pagination, "chair-only operations
// document 403") and that the round-3 review found stated only in prose.
// A later change to any of these is a breaking change under the compat
// gate, so they are pinned before 1.0.0 merges.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'

function loadOpenApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance/openapi.gov.json'), 'utf8'))
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

function allOperations(doc: any): Array<{ path: string; method: string; op: any; pathParams: any[] }> {
  const ops: Array<{ path: string; method: string; op: any; pathParams: any[] }> = []
  for (const [p, item] of Object.entries<any>(doc.paths)) {
    for (const m of HTTP_METHODS) {
      if (item[m]) ops.push({ path: p, method: m, op: item[m], pathParams: item.parameters ?? [] })
    }
  }
  return ops
}

/** Follow one local $ref (components/...) to its target node. */
function deref(doc: any, node: any): any {
  let n = node
  while (n && typeof n.$ref === 'string') {
    n = n.$ref
      .slice(2)
      .split('/')
      .reduce((acc: any, seg: string) => acc?.[decodeURIComponent(seg)], doc)
  }
  return n
}

function paramNames(doc: any, op: any, pathParams: any[]): string[] {
  return [...pathParams, ...(op.parameters ?? [])].map((p) => deref(doc, p).name)
}

describe('H1 - every list operation is cursor-paginated (brief §5 Q7)', () => {
  it('there are list operations to check (non-vacuity)', () => {
    const lists = allOperations(loadOpenApi()).filter(({ op }) => /^list/.test(op.operationId))
    expect(lists.length).toBeGreaterThanOrEqual(6)
  })

  it('each list takes ?cursor= and ?limit= and returns a named *Page {items, nextCursor}', () => {
    const doc = loadOpenApi()
    for (const { path, method, op, pathParams } of allOperations(doc)) {
      if (!/^list/.test(op.operationId)) continue
      const where = `${method} ${path}`
      const names = paramNames(doc, op, pathParams)
      expect(names, where).toContain('cursor')
      expect(names, where).toContain('limit')
      const schema = op.responses['200'].content['application/json'].schema
      expect(schema.$ref, `${where} must return a named page, not a bare array`).toMatch(/Page$/)
      const page = deref(doc, schema)
      expect(page.required, where).toEqual(expect.arrayContaining(['items', 'nextCursor']))
      expect(page.properties.items.type, where).toBe('array')
    }
  })

  it('no GET returns a bare array (a later move to a page object would be breaking)', () => {
    const doc = loadOpenApi()
    for (const { path, op } of allOperations(doc)) {
      const schema = op.responses['200']?.content?.['application/json']?.schema
      if (schema) expect(schema.type, `${path}`).not.toBe('array')
    }
  })
})
