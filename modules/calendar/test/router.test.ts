import { describe, it, expect } from 'vitest'
import { createRouter, type RouteHandler } from '../src/http/router.ts'

// A trivial handler we can identify by reference in assertions.
const h = (name: string): RouteHandler => Object.assign(async () => {}, { _name: name })

describe('createRouter — path-param matching', () => {
  it('matches a static route and returns its handler with empty params', () => {
    const send = h('list')
    const router = createRouter([{ method: 'GET', path: '/healthz', handler: send }])
    const m = router.match('GET', '/healthz')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.handler).toBe(send)
    expect(m.params).toEqual({})
  })

  it('extracts a single :id path param', () => {
    const get = h('get')
    const router = createRouter([
      { method: 'GET', path: '/api/v1/events/:id', handler: get },
    ])
    const m = router.match('GET', '/api/v1/events/42')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.handler).toBe(get)
    expect(m.params).toEqual({ id: '42' })
  })

  it('extracts multiple path params', () => {
    const del = h('del-by-external')
    const router = createRouter([
      { method: 'DELETE', path: '/api/v1/events/by-external/:source/:externalId', handler: del },
    ])
    const m = router.match('DELETE', '/api/v1/events/by-external/helios/abc-123')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ source: 'helios', externalId: 'abc-123' })
  })

  it('does NOT let a param swallow a path separator (single-segment only)', () => {
    const get = h('get')
    const router = createRouter([
      { method: 'GET', path: '/api/v1/events/:id', handler: get },
    ])
    // '/api/v1/events/42/extra' must NOT match :id = '42/extra'
    const m = router.match('GET', '/api/v1/events/42/extra')
    expect(m.type).toBe('not-found')
  })
})

describe('createRouter — 404 on unknown path', () => {
  it('returns not-found for a path no pattern matches', () => {
    const router = createRouter([
      { method: 'GET', path: '/api/v1/events', handler: h('list') },
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
      { method: 'GET', path: '/api/v1/events/:id', handler: get },
    ])
    const m = router.match('POST', '/api/v1/events/42')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    // The Allow header set should advertise the methods registered for that path.
    expect(m.allowed).toContain('GET')
  })

  it('dispatches to the right handler when two methods share a path', () => {
    const get = h('get')
    const post = h('post')
    const router = createRouter([
      { method: 'GET', path: '/api/v1/events', handler: get },
      { method: 'POST', path: '/api/v1/events', handler: post },
    ])
    expect((router.match('GET', '/api/v1/events') as { handler: RouteHandler }).handler).toBe(get)
    expect((router.match('POST', '/api/v1/events') as { handler: RouteHandler }).handler).toBe(post)
  })

  it('aggregates the Allow set across all methods registered for a matched path', () => {
    const router = createRouter([
      { method: 'GET', path: '/api/v1/events', handler: h('g') },
      { method: 'POST', path: '/api/v1/events', handler: h('p') },
    ])
    const m = router.match('PATCH', '/api/v1/events')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect([...m.allowed].sort()).toEqual(['GET', 'POST'])
  })
})
