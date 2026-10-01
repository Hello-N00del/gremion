/**
 * F1-FIX-07 K5#8 / K5#33: the content leaf builds every unsubscribe link from
 * PUBLIC_BASE_URL. It used to default to http://localhost:3000, so a missing
 * value mailed subscribers links into THEIR OWN machine. The base is now checked
 * and an unusable one is refused (fail closed) — mirrors the publishing leaf's
 * requireUsableLinkBase.
 */
import { describe, it, expect } from 'vitest'
import { checkLinkBase, resolveContentLinkBase } from '../src/link-base.ts'

describe('checkLinkBase', () => {
  it.each([
    ['https://rat.example.org', 'https://rat.example.org'],
    ['https://rat.example.org/', 'https://rat.example.org'],
    ['http://intranet.example:8080', 'http://intranet.example:8080'],
  ])('accepts %j as origin %j', (raw, origin) => {
    expect(checkLinkBase(raw)).toEqual({ usable: true, base: origin })
  })

  it.each([
    ['', 'missing'],
    [undefined, 'missing'],
    ['localhost:3000', 'malformed'],
    ['ftp://files.example.org', 'malformed'],
    ['https://rat.example.org/app', 'malformed'],
    ['https://rat.example.org?x=1', 'malformed'],
    ['http://localhost:3000', 'loopback'],
    ['http://127.0.0.1', 'loopback'],
    ['http://[::1]:3000', 'loopback'],
    ['http://0.0.0.0', 'unspecified'],
  ])('refuses %j (%s)', (raw, fault) => {
    const out = checkLinkBase(raw as string | undefined)
    expect(out.usable).toBe(false)
    if (!out.usable) expect(out.fault).toBe(fault)
  })

  it('a loopback base is allowed only with CONTENT_ALLOW_LOOPBACK_LINKS=1 (local dev)', () => {
    expect(checkLinkBase('http://localhost:3000', { allowLoopback: true })).toEqual({
      usable: true,
      base: 'http://localhost:3000',
    })
  })
})

describe('resolveContentLinkBase (boot)', () => {
  it('has NO localhost default: an unset PUBLIC_BASE_URL is unusable', () => {
    expect(resolveContentLinkBase({}).usable).toBe(false)
  })

  it('reads PUBLIC_BASE_URL and the loopback opt-in', () => {
    expect(resolveContentLinkBase({ PUBLIC_BASE_URL: 'https://a.example' })).toEqual({
      usable: true,
      base: 'https://a.example',
    })
    expect(
      resolveContentLinkBase({ PUBLIC_BASE_URL: 'http://localhost:3000', CONTENT_ALLOW_LOOPBACK_LINKS: '1' }).usable,
    ).toBe(true)
  })
})
