// T2: $ref closure on the real calendar/content specs.
// RED because: percent-encoded fragments were unresolved (the ported
// collector, before the percent-decode fix, reports every percent-encoded
// channel ref in the content spec as unresolved).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } from './schema.js'
import { REPO_ROOT } from './repo-root.js'

function loadDoc(relPath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'))
}

describe('collectUnresolvedRefs — percent-decoding (the fixed defect)', () => {
  it('resolves a JSON-Pointer-in-URI-fragment ref whose segment is percent-encoded', () => {
    const doc = {
      channels: { 'gremion.{tenantId}.content.publish.failed': { address: 'x' } },
      refHolder: { $ref: '#/channels/gremion.%7BtenantId%7D.content.publish.failed' },
    }
    expect(collectUnresolvedRefs(doc)).toEqual([])
  })

  it('still reports a ref that does not resolve even after percent-decoding', () => {
    const doc = {
      channels: { real: { address: 'x' } },
      refHolder: { $ref: '#/channels/%67host' }, // decodes to "ghost", still missing
    }
    expect(collectUnresolvedRefs(doc)).toEqual(['#/channels/%67host'])
  })

  it('does not crash on a segment that is not valid percent-encoding', () => {
    const doc = { a: { $ref: '#/b/100%' } }
    expect(() => collectUnresolvedRefs(doc)).not.toThrow()
    expect(collectUnresolvedRefs(doc)).toEqual(['#/b/100%'])
  })
})

describe('the real contract documents — structural validation + $ref closure', () => {
  const specs: Array<{ file: string; kind: 'openapi' | 'asyncapi' }> = [
    { file: 'contracts/kernel/openapi.governance.json', kind: 'openapi' },
    { file: 'contracts/kernel/asyncapi.provisioning.json', kind: 'asyncapi' },
    { file: 'contracts/calendar/asyncapi.calendar.json', kind: 'asyncapi' },
    { file: 'contracts/content/asyncapi.content.json', kind: 'asyncapi' },
  ]

  for (const { file, kind } of specs) {
    it(`${file}: structurally valid ${kind === 'openapi' ? 'OpenAPI 3.1' : 'AsyncAPI 3.0'}`, () => {
      const doc = loadDoc(file)
      const problems = kind === 'openapi' ? validateOpenApiDoc(doc) : validateAsyncApiDoc(doc)
      expect(problems).toEqual([])
    })

    it(`${file}: every $ref resolves (including percent-encoded fragments)`, () => {
      const doc = loadDoc(file)
      expect(collectUnresolvedRefs(doc)).toEqual([])
    })
  }

  it('the content spec specifically carries percent-encoded channel refs that must resolve', () => {
    const doc = loadDoc('contracts/content/asyncapi.content.json') as { channels: Record<string, unknown> }
    const raw = JSON.stringify(doc)
    expect(raw).toMatch(/%7B/) // sanity: the percent-encoding is really there
    expect(collectUnresolvedRefs(doc)).toEqual([])
  })
})
