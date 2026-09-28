import { describe, it, expect } from 'vitest'
import type { ContentBackendPort, Post } from './port'

describe('ContentBackendPort shape', () => {
  it('is a type-only module; a structural stub satisfies the interface', () => {
    const stub = { kind: 'inprocess' } as Partial<ContentBackendPort>
    expect(stub.kind).toBe('inprocess')
  })
  it('Post DTO carries the L1 contract fields', () => {
    const p: Post = { id: 'a', slug: 's', title: 't', body_html: '', created_by: 'u', created_at: '2026-06-30T00:00:00Z', updated_at: '2026-06-30T00:00:00Z' }
    expect(p.body_html).toBe('')
  })
})
