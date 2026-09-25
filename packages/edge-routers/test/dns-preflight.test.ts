import { describe, expect, it } from 'vitest'
import { checkTenantHostDns, type DnsResolver } from '../src/dns-preflight.ts'

const EDGE = { ipv4: ['192.0.2.10'], ipv6: ['2001:db8::10'] }

function err(code: string): Error {
  return Object.assign(new Error(`query failed ${code}`), { code })
}

/** A resolver from a table; a missing family answers ENODATA, a missing host ENOTFOUND. */
function fake(table: Record<string, { a?: string[] | Error; aaaa?: string[] | Error }>): DnsResolver & { calls: string[] } {
  const calls: string[] = []
  const answer = (host: string, fam: 'a' | 'aaaa') => {
    calls.push(`${fam}:${host}`)
    const row = table[host]
    if (!row) return Promise.reject(err('ENOTFOUND'))
    const v = row[fam]
    if (v === undefined) return Promise.reject(err('ENODATA'))
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  }
  return { calls, resolve4: (h) => answer(h, 'a'), resolve6: (h) => answer(h, 'aaaa') }
}

const check = (host: string, r: DnsResolver) => checkTenantHostDns(host, { edge: EDGE, resolver: r })

describe('checkTenantHostDns — TDD 6', () => {
  it('passes when A and AAAA both point at the edge and nowhere else', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: ['192.0.2.10'], aaaa: ['2001:db8::10'] } }))
    expect(r).toMatchObject({ ok: true, problems: [] })
  })

  it('fails an A-only host', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: ['192.0.2.10'] } }))
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.code)).toEqual(['no-aaaa'])
  })

  it('fails an AAAA that points somewhere else', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: ['192.0.2.10'], aaaa: ['2001:db8::99'] } }))
    expect(r.problems.map((p) => p.code)).toEqual(['aaaa-mismatch'])
    expect(r.problems[0]!.detail).toContain('2001:db8::99')
  })

  it('fails an A set that ALSO names a foreign address (split traffic)', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: ['192.0.2.10', '198.51.100.7'], aaaa: ['2001:db8::10'] } }))
    expect(r.problems.map((p) => p.code)).toEqual(['a-mismatch'])
  })

  it('fails NXDOMAIN', async () => {
    const r = await check('nothing.example.net', fake({}))
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.code)).toEqual(['nxdomain'])
  })

  it('fails closed on a resolver error that is not an answer (SERVFAIL, timeout)', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: err('ESERVFAIL'), aaaa: err('ETIMEOUT') } }))
    expect(r.problems.map((p) => p.code)).toEqual(['lookup-failed', 'lookup-failed'])
  })

  it('compares IPv6 by value, not by spelling', async () => {
    const r = await check('council.example.net', fake({ 'council.example.net': { a: ['192.0.2.10'], aaaa: ['2001:DB8:0:0:0:0:0:10'] } }))
    expect(r.ok).toBe(true)
  })

  it('uses ONLY the injected resolver, once per family', async () => {
    const r = fake({ 'council.example.net': { a: ['192.0.2.10'], aaaa: ['2001:db8::10'] } })
    await check('council.example.net', r)
    expect(r.calls).toEqual(['a:council.example.net', 'aaaa:council.example.net'])
  })

  it('refuses an edge config with an empty or malformed family, and a non-host', async () => {
    const r = fake({})
    await expect(checkTenantHostDns('a.example.net', { edge: { ipv4: [], ipv6: ['2001:db8::10'] }, resolver: r })).rejects.toThrow(/ipv4/)
    await expect(checkTenantHostDns('a.example.net', { edge: { ipv4: ['192.0.2.10'], ipv6: ['nope'] }, resolver: r })).rejects.toThrow(/ipv6/)
    await expect(checkTenantHostDns('a`b', { edge: EDGE, resolver: r })).rejects.toThrow(/not a host/)
    expect(r.calls).toEqual([])
  })
})
