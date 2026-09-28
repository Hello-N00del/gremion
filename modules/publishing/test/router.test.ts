import { describe, it, expect } from 'vitest'
import { createRouter, type RouteHandler } from '../src/http/router.ts'

// A trivial handler we can identify by reference in assertions.
const h = (name: string): RouteHandler => Object.assign(async () => {}, { _name: name })

describe('createRouter — path-param matching', () => {
  it('matches a static route and returns its handler with empty params', () => {
    const send = h('send')
    const router = createRouter([{ method: 'GET', path: '/healthz', handler: send }])
    const m = router.match('GET', '/healthz')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.handler).toBe(send)
    expect(m.params).toEqual({})
  })

  it('extracts a single :id path param', () => {
    const send = h('send')
    const router = createRouter([
      { method: 'POST', path: '/api/v1/newsletters/:id/send', handler: send },
    ])
    const m = router.match('POST', '/api/v1/newsletters/42/send')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.handler).toBe(send)
    expect(m.params).toEqual({ id: '42' })
  })

  it('extracts multiple path params', () => {
    const del = h('del-member')
    const router = createRouter([
      { method: 'DELETE', path: '/api/v1/lists/:id/members/:memberId', handler: del },
    ])
    const m = router.match('DELETE', '/api/v1/lists/7/members/abc-123')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: '7', memberId: 'abc-123' })
  })

  it('does NOT let a param swallow a path separator (single-segment only)', () => {
    const send = h('send')
    const router = createRouter([
      { method: 'POST', path: '/api/v1/newsletters/:id/send', handler: send },
    ])
    // '/api/v1/newsletters/42/extra/send' must NOT match :id = '42/extra'
    const m = router.match('POST', '/api/v1/newsletters/42/extra/send')
    expect(m.type).toBe('not-found')
  })
})

describe('createRouter — 404 on unknown path', () => {
  it('returns not-found for a path no pattern matches', () => {
    const router = createRouter([
      { method: 'GET', path: '/api/v1/newsletters', handler: h('list') },
    ])
    const m = router.match('GET', '/does/not/exist')
    expect(m.type).toBe('not-found')
  })

  it('treats a trailing-slash mismatch as not-found (no implicit normalization)', () => {
    const router = createRouter([{ method: 'GET', path: '/healthz', handler: h('hz') }])
    expect(router.match('GET', '/healthz/').type).toBe('not-found')
  })
})

describe('createRouter — method routing', () => {
  it('returns method-not-allowed when the path matches but the method does not', () => {
    const get = h('get')
    const router = createRouter([
      { method: 'GET', path: '/api/v1/newsletters/:id', handler: get },
    ])
    const m = router.match('POST', '/api/v1/newsletters/42')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    // The Allow header set should advertise the methods registered for that path.
    expect(m.allowed).toContain('GET')
  })

  it('dispatches to the right handler when two methods share a path', () => {
    const get = h('get')
    const post = h('post')
    const router = createRouter([
      { method: 'GET', path: '/api/v1/newsletters', handler: get },
      { method: 'POST', path: '/api/v1/newsletters', handler: post },
    ])
    expect((router.match('GET', '/api/v1/newsletters') as { handler: RouteHandler }).handler).toBe(get)
    expect((router.match('POST', '/api/v1/newsletters') as { handler: RouteHandler }).handler).toBe(post)
  })

  it('aggregates the Allow set across all methods registered for a matched path', () => {
    const router = createRouter([
      { method: 'GET', path: '/api/v1/newsletters', handler: h('g') },
      { method: 'POST', path: '/api/v1/newsletters', handler: h('p') },
    ])
    const m = router.match('PATCH', '/api/v1/newsletters')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect([...m.allowed].sort()).toEqual(['GET', 'POST'])
  })
})
