// dns-preflight.ts — does a CANDIDATE tenant host point at this edge?
//
// New build (spec B B-06; no code existed in either tree). Distinct from
// infra/host/bin/gremion-dns-check, which verifies the PLATFORM zone per edit:
// this checks one tenant-supplied host before the control plane registers it,
// so a router is never emitted for a name whose traffic lands elsewhere.
//
// A host passes only when BOTH families answer and EVERY record of each family
// is one of the edge's own addresses:
//   * A-only (or AAAA-only) fails: a dual-stack client would reach nothing, or
//     somebody else, on the missing family;
//   * an extra foreign record fails: resolvers round-robin, so part of the
//     traffic — and every ACME HTTP-01 validation that lands there — goes to a
//     machine this platform does not run;
//   * NXDOMAIN fails; so does any resolver error that is not an answer
//     (SERVFAIL, timeout): unknown is not "fine".
// The resolver is INJECTED (tests never touch the network); the default is a
// node:dns Resolver with a bounded timeout.
//
// Reserved platform names are NOT this function's business: they point at the
// edge by definition and must be refused earlier (isReservedHost, render.ts).

import { Resolver } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { isRuleSafeHost } from './render.js'

export interface DnsResolver {
  resolve4(host: string): Promise<string[]>
  resolve6(host: string): Promise<string[]>
}

export interface EdgeAddresses {
  readonly ipv4: readonly string[]
  readonly ipv6: readonly string[]
}

export type DnsProblemCode = 'nxdomain' | 'no-a' | 'no-aaaa' | 'a-mismatch' | 'aaaa-mismatch' | 'lookup-failed'

export interface DnsProblem {
  readonly code: DnsProblemCode
  readonly detail: string
}

export interface DnsPreflightResult {
  readonly host: string
  readonly ok: boolean
  readonly a: readonly string[]
  readonly aaaa: readonly string[]
  readonly problems: readonly DnsProblem[]
}

export interface CheckTenantHostDnsOptions {
  readonly edge: EdgeAddresses
  readonly resolver?: DnsResolver
}

/** IPv6 by value: the WHATWG URL parser prints the canonical compressed form. */
function canonical6(ip: string): string {
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1)
}

function edgeSet(values: readonly string[] | undefined, family: 'ipv4' | 'ipv6'): Set<string> {
  const valid = family === 'ipv4' ? isIPv4 : isIPv6
  if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string' && valid(v))) {
    throw new Error(`checkTenantHostDns: edge.${family} must be a non-empty list of ${family} addresses, got ${JSON.stringify(values)}`)
  }
  if (family === 'ipv4') return new Set(values)
  try {
    return new Set(values.map(canonical6))
  } catch {
    throw new Error(`checkTenantHostDns: edge.ipv6 carries an address that cannot be compared by value (a zone index?): ${JSON.stringify(values)}`)
  }
}

function defaultResolver(): DnsResolver {
  return new Resolver({ timeout: 5000, tries: 2 })
}

type Lookup = { readonly ok: true; readonly records: string[] } | { readonly ok: false; readonly problem: DnsProblem }

async function lookup(fn: () => Promise<string[]>, family: 'A' | 'AAAA'): Promise<Lookup> {
  try {
    return { ok: true, records: await fn() }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTFOUND') return { ok: false, problem: { code: 'nxdomain', detail: `${family} lookup: the name does not exist (NXDOMAIN)` } }
    if (code === 'ENODATA') {
      return { ok: false, problem: { code: family === 'A' ? 'no-a' : 'no-aaaa', detail: `no ${family} record` } }
    }
    return { ok: false, problem: { code: 'lookup-failed', detail: `${family} lookup failed (${code ?? String(err)})` } }
  }
}

export async function checkTenantHostDns(host: string, opts: CheckTenantHostDnsOptions): Promise<DnsPreflightResult> {
  if (!isRuleSafeHost(host)) throw new Error(`checkTenantHostDns: ${JSON.stringify(host)} is not a host`)
  const want4 = edgeSet(opts.edge?.ipv4, 'ipv4')
  const want6 = edgeSet(opts.edge?.ipv6, 'ipv6')
  const resolver = opts.resolver ?? defaultResolver()

  const [a, aaaa] = await Promise.all([
    lookup(() => resolver.resolve4(host), 'A'),
    lookup(() => resolver.resolve6(host), 'AAAA'),
  ])

  const problems: DnsProblem[] = []
  // NXDOMAIN is one fact about the name, not one per family.
  if (!a.ok && a.problem.code === 'nxdomain' && !aaaa.ok && aaaa.problem.code === 'nxdomain') {
    problems.push(a.problem)
  } else {
    for (const [res, want, code, canon] of [
      [a, want4, 'a-mismatch', (s: string) => s],
      [aaaa, want6, 'aaaa-mismatch', canonical6],
    ] as const) {
      if (!res.ok) {
        // NXDOMAIN on ONE family while the other answered is not a missing name —
        // it is a missing record of that family (or a resolver disagreeing).
        problems.push(
          res.problem.code === 'nxdomain'
            ? { code: code === 'a-mismatch' ? 'no-a' : 'no-aaaa', detail: res.problem.detail }
            : res.problem,
        )
        continue
      }
      if (res.records.length === 0) {
        problems.push({ code: code === 'a-mismatch' ? 'no-a' : 'no-aaaa', detail: 'empty answer' })
        continue
      }
      const foreign = res.records.filter((r) => {
        try {
          return !want.has(canon(r))
        } catch {
          return true // an unparseable record is not one of ours
        }
      })
      if (foreign.length > 0) {
        problems.push({ code, detail: `points at ${foreign.join(', ')}, which is not this edge (${[...want].join(', ')})` })
      }
    }
  }
  return {
    host,
    ok: problems.length === 0,
    a: a.ok ? a.records : [],
    aaaa: aaaa.ok ? aaaa.records : [],
    problems,
  }
}
