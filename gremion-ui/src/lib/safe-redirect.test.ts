// One shared same-origin path guard for every post-login / return-to redirect
// (login callbackUrl, step-up returnTo, locale-switch redirectTo, and the
// Auth.js redirect callback). Hostile inputs are listed once, here.
import { describe, test, expect } from 'vitest'
import { sameOriginPath, authRedirect } from './safe-redirect'

const HOSTILE: Array<[string, unknown]> = [
  ['protocol-relative', '//evil.example'],
  ['triple slash', '///evil.example/x'],
  ['slash-backslash', '/\\evil.example'],
  ['double backslash', '\\\\evil.example'],
  ['backslash-slash', '\\/evil.example'],
  ['slash-double-backslash', '/\\\\evil.example'],
  ['backslash later in the path', '/a\\b'],
  ['absolute https', 'https://evil.example/'],
  ['absolute http', 'http://evil.example/x'],
  ['absolute with userinfo', 'https://app.test@evil.example/'],
  ['bare host', 'evil.example'],
  ['relative path without leading slash', 'settings'],
  ['empty', ''],
  ['javascript scheme', 'javascript:alert(1)'],
  ['mixed-case javascript scheme', 'JaVaScRiPt:alert(1)'],
  ['leading-space javascript scheme', ' javascript:alert(1)'],
  ['data scheme', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript scheme', 'vbscript:msgbox(1)'],
  ['tab inside the slashes', '/\t/evil.example'],
  ['newline inside the slashes', '/\n/evil.example'],
  ['carriage return inside the slashes', '/\r/evil.example'],
  ['leading tab', '\t//evil.example'],
  ['NUL byte', '/a\u0000b'],
  ['DEL', '/a\u007fb'],
  ['C1 control', '/a\u0085b'],
  ['dot segment collapsing to //', '/.//evil.example'],
  ['encoded dot segment collapsing to //', '/%2e//evil.example'],
  ['upper-case encoded dot segment', '/%2E//evil.example'],
  ['double dot collapsing to //', '/..//evil.example'],
  ['nested double dot collapsing to //', '/a/..//evil.example'],
  ['encoded double dot collapsing to //', '/%2e%2e//evil.example'],
  ['mixed dot encoding collapsing to //', '/.%2e//evil.example'],
  ['repeated dot segments collapsing to //', '/././/evil.example'],
  ['dot segment then backslash', '/./\\evil.example'],
  ['encoded slash after the first slash', '/%2f/evil.example'],
  ['upper-case encoded slash', '/%2F/evil.example'],
  ['encoded backslash', '/%5c/evil.example'],
  ['upper-case encoded backslash', '/%5C/evil.example'],
  ['encoded slashes deeper in the path', '/a/%2f%2fevil.example'],
  ['over-long value', '/' + 'a'.repeat(3000)],
  ['null', null],
  ['undefined', undefined],
  ['number', 123],
  ['object', { toString: () => '/ok' }]
]

describe('sameOriginPath', () => {
  test.each(HOSTILE)('rejects: %s', (_label, raw) => {
    expect(sameOriginPath(raw)).toBe('/')
  })

  test('the fallback is configurable', () => {
    expect(sameOriginPath('//evil.example', '/settings/darstellung')).toBe('/settings/darstellung')
    expect(sameOriginPath(null, '/settings/darstellung')).toBe('/settings/darstellung')
  })

  test.each([
    ['/', '/'],
    ['/finance', '/finance'],
    ['/finance?x=1#a', '/finance?x=1#a'],
    ['/a/../finance', '/finance'],
    ['/a/./b', '/a/b'],
    ['/javascript:alert(1)', '/javascript:alert(1)'],
    ['/%09/evil.example', '/%09/evil.example'],
    ['/a%20b', '/a%20b'],
    ['/%25', '/%25'],
    // Encoded slashes are only suspicious in the path; the query is opaque data.
    ['/p?next=%2f%2fevil.example', '/p?next=%2f%2fevil.example'],
    ['/p?next=https://evil.example', '/p?next=https://evil.example']
  ])('keeps the same-origin path %j as %j', (raw, expected) => {
    expect(sameOriginPath(raw)).toBe(expected)
  })

  test('the result is always a single-slash path that resolves on any origin', () => {
    for (const [, raw] of HOSTILE) {
      const out = sameOriginPath(raw)
      expect(out.startsWith('/') && !out.startsWith('//')).toBe(true)
      expect(new URL(out, 'https://pilot.test/').origin).toBe('https://pilot.test')
    }
  })
})

describe('authRedirect (Auth.js redirect callback)', () => {
  const baseUrl = 'https://app.test'

  test.each([
    ['/finance', 'https://app.test/finance'],
    ['/finance?x=1#a', 'https://app.test/finance?x=1#a'],
    ['https://app.test/finance?x=1', 'https://app.test/finance?x=1'],
    ['https://app.test', 'https://app.test/']
  ])('same-origin target %j resolves to %j', (url, expected) => {
    expect(authRedirect({ url, baseUrl })).toBe(expected)
  })

  test.each([
    ['https://evil.example/x'],
    ['https://app.test.evil.example/'],
    ['https://app.test@evil.example/'],
    ['http://app.test/finance'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['/.//evil.example'],
    ['/%2f/evil.example'],
    ['https://app.test/.//evil.example'],
    ['https://app.test/%2f/evil.example'],
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['not a url'],
    ['']
  ])('hostile target %j lands on the app root', (url) => {
    const out = authRedirect({ url, baseUrl })
    expect(out === baseUrl || out === `${baseUrl}/`, out).toBe(true)
  })
})
