// packages/ports/src/subject-match.test.ts
//
// Unit proofs for the NATS subject grammar helpers in ./subject-match.ts.
// Dependency-free (no NATS import), so this file runs under BOTH
// `pnpm --filter @gremion/ports test` and gremion-ui's monolith vitest run
// (the `../packages/ports/src/**/*.test.ts` include glob).
//
// Two DIFFERENT questions live here and must not be conflated:
//
//   subjectMatches(pattern, subject) — "does this concrete subject match this
//     consumer pattern?" The subject side is LITERAL: a '>' inside a subject is
//     just a token. This is the semantics InMemoryBroker delivers on and the
//     one a live server's consumer filter reproduces.
//
//   streamCovers(streamSubjects, pattern) — "is every subject this pattern
//     could ever match captured by the stream?" BOTH sides are patterns. This
//     is the question NatsBroker must answer BEFORE it creates a consumer:
//     a filter the stream does not cover yields a consumer that is legal to
//     create and then delivers nothing, forever.

import { describe, it, expect } from 'vitest'
import { subjectMatches, streamCovers, filterCovers } from './subject-match'

describe('subjectMatches (pattern vs concrete subject)', () => {
  it('matches literal token-for-token', () => {
    expect(subjectMatches('a.b.c', 'a.b.c')).toBe(true)
    expect(subjectMatches('a.b.c', 'a.b.d')).toBe(false)
  })

  it("'*' consumes exactly one token", () => {
    expect(subjectMatches('a.*.c', 'a.b.c')).toBe(true)
    expect(subjectMatches('a.*.c', 'a.b.x.c')).toBe(false)
    expect(subjectMatches('a.*', 'a')).toBe(false)
  })

  it("a final '>' consumes one-or-more tokens, never zero", () => {
    expect(subjectMatches('a.>', 'a.b')).toBe(true)
    expect(subjectMatches('a.>', 'a.b.c.d')).toBe(true)
    expect(subjectMatches('a.>', 'a')).toBe(false)
  })

  it("'>' anywhere but the final position is an invalid pattern and matches nothing", () => {
    expect(subjectMatches('a.>.c', 'a.b.c')).toBe(false)
  })

  it('reproduces the newsletter consumer pattern over a 5-token subject', () => {
    expect(subjectMatches('gremion.*.newsletter.>', 'gremion.t1.newsletter.send.succeeded')).toBe(true)
    expect(subjectMatches('gremion.*.newsletter.>', 'gremion.t1.content.publish.succeeded')).toBe(false)
  })
})

describe('filterCovers (stream filter vs consumer pattern)', () => {
  it('a literal stream filter covers only the identical pattern', () => {
    expect(filterCovers('a.b.c', 'a.b.c')).toBe(true)
    expect(filterCovers('a.b.c', 'a.b.*')).toBe(false)
  })

  it("a stream '*' covers a literal or a '*' in that position, never a '>'", () => {
    expect(filterCovers('a.*.c', 'a.b.c')).toBe(true)
    expect(filterCovers('a.*.c', 'a.*.c')).toBe(true)
    expect(filterCovers('a.*.>', 'a.>')).toBe(false)
  })

  it("a stream '>' covers any non-empty remainder, including a consumer '>'", () => {
    expect(filterCovers('a.>', 'a.b')).toBe(true)
    expect(filterCovers('a.>', 'a.b.c')).toBe(true)
    expect(filterCovers('a.>', 'a.>')).toBe(true)
    expect(filterCovers('a.>', 'a.*.>')).toBe(true)
    // '>' requires at least one remaining token — the bare prefix is NOT captured.
    expect(filterCovers('a.b.>', 'a.b')).toBe(false)
  })

  it('a consumer pattern BROADER than the stream filter is not covered', () => {
    expect(filterCovers('a.b.>', 'a.>')).toBe(false)
    expect(filterCovers('a.b.>', 'a.*.>')).toBe(false)
  })

  it("rejects an invalid '>' placement on either side", () => {
    expect(filterCovers('a.>.c', 'a.b.c')).toBe(false)
    expect(filterCovers('a.b.c', 'a.>.c')).toBe(false)
  })
})

describe('streamCovers (any one of the stream filters covers the pattern)', () => {
  const NEWSLETTER = ['gremion.*.newsletter.>']

  it('covers the domain pattern the newsletter consumer subscribes with', () => {
    expect(streamCovers(NEWSLETTER, 'gremion.*.newsletter.>')).toBe(true)
    expect(streamCovers(NEWSLETTER, 'gremion.t1.newsletter.send.succeeded')).toBe(true)
  })

  it('does NOT cover another domain — the silent-nothing case', () => {
    expect(streamCovers(NEWSLETTER, 'gremion.t1.content.publish.succeeded')).toBe(false)
    expect(streamCovers(NEWSLETTER, 'gremion.>')).toBe(false)
  })

  it('is satisfied by any single filter in a multi-filter stream', () => {
    const perTenant = ['gremion.t1.newsletter.>', 'gremion.t2.newsletter.>']
    expect(streamCovers(perTenant, 'gremion.t2.newsletter.send.failed')).toBe(true)
    expect(streamCovers(perTenant, 'gremion.t3.newsletter.send.failed')).toBe(false)
    // Conservative BY DESIGN: a pattern that only the UNION of the filters
    // covers is refused, because no single filter covers it. Subscribe once per
    // filter instead of relying on the union.
    expect(streamCovers(perTenant, 'gremion.*.newsletter.send.failed')).toBe(false)
  })

  it('an empty filter list covers nothing', () => {
    expect(streamCovers([], 'gremion.t1.newsletter.send.succeeded')).toBe(false)
  })
})
