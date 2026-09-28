import { describe, it, expect } from 'vitest'
import { Role } from '$lib/auth/types'
import { contentManifest } from './content'
import { MODULE_MANIFESTS } from '../registry'

describe('content manifest — shape conforms (golden)', () => {
  it('declares the stable id and is toggleable', () => {
    expect(contentManifest.id).toBe('content')
    expect(contentManifest.toggleable).toBe(true)
  })

  it('owns the /content authoring page at the finance/elections view minRole', () => {
    expect(contentManifest.pages).toEqual([{ segment: 'content', minRole: Role.Member }])
  })

  it('owns exactly its UI + API route prefixes', () => {
    expect(contentManifest.routePrefixes).toEqual(['/content', '/api/content'])
  })

  it('declares the content capabilities; publish.instagram is defined but ungranted (L3 wires it)', () => {
    expect(contentManifest.capabilities).toEqual({
      'content.author':            ['admin', 'it-admin'],
      'content.publish':           ['admin', 'it-admin'],
      'content.publish.instagram': [],
    })
    // The Instagram publish capability id MUST exist now (contract pinned for L3)
    // but stay ungranted in L1.
    expect(contentManifest.capabilities?.['content.publish.instagram']).toEqual([])
  })

  it('owns the 044 content-schema + 045 publish + 046 publish-ops migration basenames', () => {
    expect(contentManifest.migrations).toEqual([
      '044_content_schema',
      '045_content_publish',
      '046_content_publish_ops',
    ])
  })

  it('is registered in MODULE_MANIFESTS', () => {
    expect(MODULE_MANIFESTS).toContain(contentManifest)
    expect(MODULE_MANIFESTS.map((m) => m.id)).toContain('content')
  })
})
