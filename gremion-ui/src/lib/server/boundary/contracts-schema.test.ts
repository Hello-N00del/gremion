// gremion-ui/src/lib/server/boundary/contracts-schema.test.ts
import { describe, it, expect } from 'vitest'
import { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } from './contracts-schema'

const minimalOpenApi = {
  openapi: '3.1.0',
  info: { title: 'T', version: '0.1.0' },
  paths: {
    '/api/x/{id}': {
      get: {
        summary: 'Read x',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
  components: { schemas: { Thing: { type: 'object' } } },
}

describe('validateOpenApiDoc', () => {
  it('accepts a minimal valid 3.1 doc', () => {
    expect(validateOpenApiDoc(minimalOpenApi)).toEqual([])
  })
  it('rejects wrong version, missing summary, bad status keys, non-/ paths', () => {
    expect(validateOpenApiDoc({ ...minimalOpenApi, openapi: '3.0.3' })).not.toEqual([])
    const noSummary = structuredClone(minimalOpenApi) as any
    delete noSummary.paths['/api/x/{id}'].get.summary
    expect(validateOpenApiDoc(noSummary)).not.toEqual([])
    const badStatus = structuredClone(minimalOpenApi) as any
    badStatus.paths['/api/x/{id}'].get.responses = { ok: {} }
    expect(validateOpenApiDoc(badStatus)).not.toEqual([])
    const badPath = structuredClone(minimalOpenApi) as any
    badPath.paths['api/no-slash'] = badPath.paths['/api/x/{id}']
    expect(validateOpenApiDoc(badPath)).not.toEqual([])
  })
})

describe('collectUnresolvedRefs', () => {
  it('flags local $refs that resolve nowhere', () => {
    const doc = structuredClone(minimalOpenApi) as any
    doc.paths['/api/x/{id}'].get.responses['200'] = {
      description: 'ok',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
    }
    expect(collectUnresolvedRefs(doc)).toEqual(['#/components/schemas/Missing'])
    doc.paths['/api/x/{id}'].get.responses['200'].content['application/json'].schema =
      { $ref: '#/components/schemas/Thing' }
    expect(collectUnresolvedRefs(doc)).toEqual([])
  })
})

describe('validateAsyncApiDoc', () => {
  it('accepts a minimal valid 3.0 doc and rejects a 2.x one', () => {
    const doc = {
      asyncapi: '3.0.0',
      info: { title: 'T', version: '0.1.0' },
      channels: { c1: { address: 'gremion.{tenant}.provisioning.{event}' } },
      operations: { pub: { action: 'send', channel: { $ref: '#/channels/c1' } } },
    }
    expect(validateAsyncApiDoc(doc)).toEqual([])
    expect(validateAsyncApiDoc({ ...doc, asyncapi: '2.6.0' })).not.toEqual([])
  })
})
