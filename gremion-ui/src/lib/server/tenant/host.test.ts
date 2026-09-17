import { describe, it, expect } from 'vitest'
import { normaliseHost, hostFromIssuer } from './host'

// Tenancy D1 (§1.3) — normaliseHost is the cross-tenant isolation boundary's
// FIRST gate: whatever it returns becomes the tenant_domain PK lookup key. A
// value it accepts wrongly selects a tenant; a value it accepts ambiguously
// selects the WRONG tenant. Every case below is therefore an assertion about
// fail-closed behaviour, and null ALWAYS means reject — never "default tenant".
//
// Non-ASCII inputs are written as \u escapes on purpose: the point of those
// cases is the exact code point, which must not depend on this file's encoding.
describe('normaliseHost — accepts', () => {
  it('a plain apex host unchanged', () => {
    expect(normaliseHost('rat-musterstadt.de')).toBe('rat-musterstadt.de')
  })
  it('a multi-label host unchanged (no leftmost-label arithmetic remains)', () => {
    expect(normaliseHost('www.rat-musterstadt.de')).toBe('www.rat-musterstadt.de')
    expect(normaliseHost('demo.sturaos.com')).toBe('demo.sturaos.com')
  })
  it('lowercases (the DB CHECK stores host = lower(host))', () => {
    expect(normaliseHost('STURAOS.COM')).toBe('sturaos.com')
    expect(normaliseHost('Demo.SturaOS.com')).toBe('demo.sturaos.com')
  })
  it('strips a numeric port', () => {
    expect(normaliseHost('sturaos.com:443')).toBe('sturaos.com')
    expect(normaliseHost('localhost:4001')).toBe('localhost')
  })
  it('strips exactly ONE trailing FQDN root dot', () => {
    expect(normaliseHost('sturaos.com.')).toBe('sturaos.com')
  })
  it('trims surrounding whitespace before parsing', () => {
    expect(normaliseHost('  sturaos.com  ')).toBe('sturaos.com')
    expect(normaliseHost('sturaos.com\r\n')).toBe('sturaos.com')
  })
  it('accepts a punycode A-label IDN (what the edge actually sends)', () => {
    expect(normaliseHost('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
    expect(normaliseHost('XN--BCHER-KVA.EXAMPLE')).toBe('xn--bcher-kva.example')
  })
  it('accepts a single-label host (it simply will not match a tenant_domain row)', () => {
    expect(normaliseHost('localhost')).toBe('localhost')
  })
  it('accepts hosts at the RFC length limits', () => {
    const label63 = 'a'.repeat(63)
    expect(normaliseHost(`${label63}.example`)).toBe(`${label63}.example`)
    // 253 chars total: 3 x 63-char labels + 3 dots + a 61-char label
    const host253 = [label63, label63, label63, 'b'.repeat(61)].join('.')
    expect(host253.length).toBe(253)
    expect(normaliseHost(host253)).toBe(host253)
  })
})

describe('normaliseHost — rejects (fail closed)', () => {
  it('absent / empty / whitespace-only input', () => {
    expect(normaliseHost(undefined)).toBeNull()
    expect(normaliseHost(null)).toBeNull()
    expect(normaliseHost('')).toBeNull()
    expect(normaliseHost('   ')).toBeNull()
  })

  // #256-2: duplicate or chained X-Forwarded-Host headers JOIN into one
  // comma-separated value. Taking the first (client-most) element would let an
  // attacker-supplied host win over the trusted hop's appended one.
  it('a comma-joined multi-value header', () => {
    expect(normaliseHost('evil.example, sturaos.com')).toBeNull()
    expect(normaliseHost('sturaos.com,evil.example')).toBeNull()
    expect(normaliseHost('sturaos.com,')).toBeNull()
  })
  it('an INNER-whitespace-joined multi-value header (trim only strips the ends)', () => {
    expect(normaliseHost('evil.example sturaos.com')).toBeNull()
    expect(normaliseHost('sturaos.com\tevil.example')).toBeNull()
    expect(normaliseHost('sturaos.com\nevil.example')).toBeNull()
  })

  it('empty labels anywhere', () => {
    expect(normaliseHost('sturaos..com')).toBeNull()
    expect(normaliseHost('.sturaos.com')).toBeNull()
    expect(normaliseHost('sturaos.com..')).toBeNull() // a SECOND trailing dot
    expect(normaliseHost('.')).toBeNull()
    expect(normaliseHost('..')).toBeNull()
  })

  // Raw Unicode never appears in a real Host header (it is ASCII by protocol),
  // and the charset check runs BEFORE toLowerCase() so no Unicode case fold can
  // smuggle a non-ASCII byte into a key that matches a registered ASCII host.
  it('raw (non-punycode) Unicode IDN', () => {
    expect(normaliseHost('b\u00FCcher.example')).toBeNull()
    expect(normaliseHost('m\u00FCnchen.de')).toBeNull()
  })
  it('a Unicode homoglyph that would case-fold to ASCII', () => {
    // Assert the fold really would have produced ASCII, so this test fails
    // loudly if the charset check is ever moved after toLowerCase().
    expect('\u212A'.toLowerCase()).toBe('k')
    expect(normaliseHost('sturaos.com\u212A')).toBeNull() // KELVIN SIGN
    expect(normaliseHost('\u0130sturaos.com')).toBeNull() // I WITH DOT ABOVE
  })

  // The old split(':', 1)[0] accepted all of these and produced *something*.
  it('an ambiguous authority form (userinfo / non-numeric port / bare colon)', () => {
    expect(normaliseHost('evil.example:80@sturaos.com')).toBeNull()
    expect(normaliseHost('sturaos.com:')).toBeNull()
    expect(normaliseHost('sturaos.com:https')).toBeNull()
    expect(normaliseHost('sturaos.com:443:443')).toBeNull()
    expect(normaliseHost('user@sturaos.com')).toBeNull()
  })
  it('an IPv6 literal (bracketed or bare)', () => {
    expect(normaliseHost('[::1]:443')).toBeNull()
    expect(normaliseHost('[2001:db8::1]')).toBeNull()
    expect(normaliseHost('::1')).toBeNull()
  })
  it('a URL rather than a host', () => {
    expect(normaliseHost('https://sturaos.com')).toBeNull()
    expect(normaliseHost('sturaos.com/admin')).toBeNull()
  })
  it('a wildcard or underscore label', () => {
    expect(normaliseHost('*.sturaos.com')).toBeNull()
    expect(normaliseHost('_acme-challenge.sturaos.com')).toBeNull()
  })
  it('non-whitespace control characters that survive trim()', () => {
    expect(normaliseHost('stura\u0000os.com')).toBeNull() // NUL
    expect(normaliseHost('sturaos.com\u0007')).toBeNull() // BEL
    expect(normaliseHost('stura os.com')).toBeNull() // inner space
  })
  it('over-length hosts and labels', () => {
    expect(normaliseHost(`${'a'.repeat(64)}.example`)).toBeNull()
    const label63 = 'a'.repeat(63)
    const host254 = [label63, label63, label63, 'b'.repeat(62)].join('.')
    expect(host254.length).toBe(254)
    expect(normaliseHost(host254)).toBeNull()
  })
})

describe('normaliseHost — idempotence (read path and write path agree)', () => {
  // addTenantDomain persists normaliseHost(raw); the resolver looks up
  // normaliseHost(x-forwarded-host). Re-normalising an already-normalised host
  // MUST be a fixed point, or a stored row could be permanently unreachable.
  it('normalising twice equals normalising once', () => {
    for (const raw of [
      'STURAOS.COM.',
      'Demo.SturaOS.com:443',
      '  xn--BCHER-kva.Example.  ',
      'rat-musterstadt.de',
      'localhost:5432',
    ]) {
      const once = normaliseHost(raw)
      expect(once).not.toBeNull()
      expect(normaliseHost(once)).toBe(once)
    }
  })

  // The migration's CHECK is `host = lower(host) AND host !~ '[[:space:],]'`.
  // Anything normaliseHost returns must satisfy it, or an addTenantDomain write
  // would fail at the constraint instead of at the guard.
  it('every accepted host satisfies the tenant_domain CHECK constraint', () => {
    for (const raw of ['STURAOS.COM.', 'Demo.SturaOS.com:443', ' xn--BCHER-kva.Example ']) {
      const host = normaliseHost(raw)!
      expect(host).toBe(host.toLowerCase())
      expect(/[\s,]/.test(host)).toBe(false)
    }
  })
})

// Tenancy D1 (§1.2/§1.4) — hostFromIssuer is migration 004's seed expressed in
// TypeScript. `assertIssMatch` is BYTE-STRICT, so if these two ever derive a
// different host from the same issuer, a tenant seeded by the migration and a
// tenant reconciled by registerDefaultTenant disagree about their own identity
// and every login 403s. Each case below is pinned against the SQL twin
// (`substring(issuer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)')` + numeric-port
// strip + lower + LDH/length filter) — verified by applying 004 to a real DB.
describe('hostFromIssuer', () => {
  it('returns the issuer authority, normalised the same way the resolver reads a header', () => {
    expect(hostFromIssuer('https://sturaos.com/auth/realms/sturaos')).toBe('sturaos.com')
    expect(hostFromIssuer('https://rat-musterstadt.de/auth/realms/must')).toBe('rat-musterstadt.de')
    expect(hostFromIssuer('https://Ported.Example:8443/auth/realms/x')).toBe('ported.example')
    expect(hostFromIssuer('https://xn--bcher-kva.example/auth/realms/uni')).toBe('xn--bcher-kva.example')
    expect(hostFromIssuer('https://sturaos.com')).toBe('sturaos.com')
  })

  it('rejects every shape migration 004 skips — null is the only failure signal', () => {
    for (const bad of [
      undefined, null, '', '   ',
      'not-a-url',
      '/auth/realms/x',                       // relative — no authority
      'https:///auth/realms/x',               // EMPTY authority. `new URL().host`
                                              // returns 'auth' here; we must not.
      'https://bücher.example/auth/realms/x', // raw unicode — must arrive punycode
      'https://u:p@h.example/auth/realms/x',  // userinfo — ambiguous authority
      'https://a..b/auth/realms/x',           // empty label
      'https://h.example:notaport/auth',      // non-numeric port
      'https://a.example, b.example/auth',    // comma-joined list
    ]) {
      expect(hostFromIssuer(bad)).toBeNull()
    }
  })

  it('agrees with normaliseHost, so no issuer can imply an unmatchable host', () => {
    for (const iss of [
      'https://sturaos.com/auth/realms/sturaos',
      'https://Demo.SturaOS.com:443/auth/realms/demo',
      'https://gremion.example.org/auth/realms/hs',
    ]) {
      const host = hostFromIssuer(iss)!
      expect(normaliseHost(host)).toBe(host) // idempotent under the READ path
    }
  })
})

// §T.1 post-condition: ONE function normalises on read and on write, so a host
// written by addTenantDomain and a host resolved by resolveTenantByHost agree
// byte-for-byte. Idempotence is that property expressed without a database:
// whatever the write path stored, the read path maps to the identical string.
describe('one normaliser on read and on write', () => {
  const raws = [
    'Rat-Musterstadt.DE',
    'rat-musterstadt.de.',
    'RAT-musterstadt.de:8443',
    '  rat-musterstadt.de  ',
  ]
  it('maps every spelling to one key and is idempotent on that key', () => {
    for (const raw of raws) {
      const written = normaliseHost(raw)
      expect(written).toBe('rat-musterstadt.de')
      expect(normaliseHost(written)).toBe(written)
    }
  })
})
