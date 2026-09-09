// packages/ports/src/subject-match.ts (@gremion/ports — internal)
//
// The NATS subject grammar, in one place. Two DIFFERENT questions live here and
// conflating them is how a subscriber ends up silently receiving nothing:
//
//   subjectMatches(pattern, subject)
//     "Does this concrete subject match this consumer pattern?" The subject side
//     is LITERAL. This is what InMemoryBroker delivers on (./broker.ts) and what
//     a live server's consumer filter reproduces — the parity the wildcard tests
//     in nats-topology.test.ts pin.
//
//   streamCovers(streamSubjects, pattern)
//     "Is EVERY subject this pattern could match captured by the stream?" Both
//     sides are patterns. NatsBroker must answer this BEFORE it creates a
//     consumer: JetStream is happy to create a consumer whose filter the stream
//     does not capture, and that consumer then delivers nothing, forever, with
//     no error anywhere. The same question, asked with a concrete subject,
//     answers "can this stream store what I am about to publish?".
//
// Dependency-free (no NATS import) so it loads under gremion-ui's jsdom monolith
// run alongside ./broker.ts. NOT part of the package's `exports` map: it backs
// ./broker.ts and ./nats-broker.ts, and callers use those.

/** A '>' is legal only as the FINAL token. Anywhere else the token sequence is
 *  not a valid NATS pattern and must match/cover nothing rather than be
 *  silently reinterpreted. */
function gtIsMisplaced(tokens: string[]): boolean {
  const i = tokens.indexOf('>')
  return i !== -1 && i !== tokens.length - 1
}

/**
 * NATS subject matching — pattern against a CONCRETE subject.
 *  - '*' = exactly one token.
 *  - '>' = one-or-more remaining tokens; valid ONLY as the FINAL pattern token.
 *    Implemented at P1 (D-P1-7): the newsletter consumer subscribes
 *    `gremion.*.newsletter.>` over the 5-token subjects newsletterSubject() builds.
 *    A '>' anywhere but the last position is invalid and matches nothing; a final
 *    '>' requires at least one remaining subject token (does NOT match the bare prefix).
 */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.'); const s = subject.split('.')
  const gtIdx = p.indexOf('>')
  if (gtIdx !== -1) {
    // '>' is valid only as the final token; anywhere else → invalid pattern, no match.
    if (gtIdx !== p.length - 1) return false
    // '>' must consume at least one remaining subject token.
    if (s.length < p.length) return false
    // Match the fixed prefix tokens (everything before '>').
    for (let i = 0; i < gtIdx; i++) {
      if (p[i] !== '*' && p[i] !== s[i]) return false
    }
    return true
  }
  if (p.length !== s.length) return false
  return p.every((tok, i) => tok === '*' || tok === s[i])
}

/**
 * Does ONE stream subject filter cover a consumer pattern — i.e. is every
 * subject the consumer pattern could match captured by this filter?
 *
 * Token by token, with the filter on the left and the consumer pattern on the
 * right:
 *  - filter '>'  covers any NON-EMPTY remainder, a consumer '>' included.
 *  - a consumer '>' against a filter literal or '*' is BROADER than the filter
 *    (it reaches past what the filter captures) → not covered.
 *  - filter '*'  covers exactly one consumer token, as long as that token is not '>'.
 *  - a filter literal covers only the identical consumer literal; a consumer '*'
 *    in that position is broader → not covered.
 *
 * Passing a concrete subject as `pattern` answers the publish-side question
 * ("can this stream store this subject?") with the same code, because a concrete
 * subject is just a pattern with no wildcards.
 */
export function filterCovers(streamFilter: string, pattern: string): boolean {
  const f = streamFilter.split('.')
  const c = pattern.split('.')
  if (gtIsMisplaced(f) || gtIsMisplaced(c)) return false

  for (let i = 0; i < f.length; i++) {
    if (f[i] === '>') return c.length > i
    if (i >= c.length) return false
    if (c[i] === '>') return false
    if (f[i] === '*') continue
    if (f[i] !== c[i]) return false
  }
  return c.length === f.length
}

/**
 * Do the stream's subject filters cover this consumer pattern (or concrete
 * subject)?
 *
 * CONSERVATIVE BY DESIGN: satisfied only when a SINGLE filter covers the
 * pattern. A pattern that only the UNION of several filters covers is reported
 * as uncovered — subscribe once per filter instead. Over-refusing is a loud,
 * fixable boot error; under-refusing is the silent no-delivery this function
 * exists to prevent.
 */
export function streamCovers(streamSubjects: readonly string[], pattern: string): boolean {
  return streamSubjects.some((filter) => filterCovers(filter, pattern))
}
