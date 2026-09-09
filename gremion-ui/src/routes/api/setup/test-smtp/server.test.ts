import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// SSRF guard for the test-smtp endpoint.
//
// /api/setup/test-smtp opens an outbound TCP connection to a BODY-SUPPLIED
// host:port during the pre-setup window (setup token only). On a public host
// whose container can reach a cloud metadata endpoint that is an SSRF /
// internal port-probe oracle. The target must be refused BEFORE any connection
// is attempted — and the decision must be made on the CANONICAL bytes of the
// address, not on one of its many textual spellings.
//
// There is NO host allowlist: `config.smtp.host` is writable through
// PATCH /api/setup/config under the SAME setup token that calls this endpoint,
// so treating it as trusted would re-open the exact hole the guard closes.
// The only escape hatch is SMTP_TEST_ALLOW_PRIVATE=1, and it is a
// PRIVATE-RANGE opt-in, not a kill switch: loopback, link-local/metadata,
// multicast, CGNAT and the blocked names stay refused with it set.
//
// RED ledger: the kernel route at f2d7751 carries NO target guard at all — it
// hands `host` straight to nodemailer — so every case below is a real RED
// against that tip.

const hoisted = vi.hoisted(() => ({
  // Resolved addresses returned by the mocked DNS lookup for non-literal hosts.
  lookupAddresses: [{ address: '203.0.113.25', family: 4 }] as Array<{
    address: string
    family: number
  }>,
  lookupError: null as Error | null,
  /** A resolver that never answers — the black-holed case the bound exists for. */
  lookupHangs: false,
  sendMail: vi.fn(async () => ({ messageId: 'ok' })),
  createTransport: vi.fn(),
  readConfig: vi.fn(),
  env: {} as Record<string, string | undefined>,
}))
hoisted.createTransport.mockImplementation(() => ({ sendMail: hoisted.sendMail }))

vi.mock('nodemailer', () => ({
  default: { createTransport: hoisted.createTransport },
  createTransport: hoisted.createTransport,
}))

vi.mock('node:dns/promises', () => ({
  default: { lookup: async () => resolveMock() },
  lookup: async () => resolveMock(),
}))

function resolveMock() {
  if (hoisted.lookupHangs) return new Promise<never>(() => {})
  if (hoisted.lookupError) throw hoisted.lookupError
  return hoisted.lookupAddresses
}

vi.mock('$env/dynamic/private', () => ({ env: hoisted.env }))
vi.mock('$lib/server/config', () => ({ readConfig: hoisted.readConfig }))
vi.mock('$lib/server/setup-token', () => ({ validateSetupToken: () => true }))
// The route handler is called directly (no hooks.server.ts runWithTenant wrap),
// so the ALS-backed canonical tenant id used by the rate limiter is stubbed.
vi.mock('$lib/server/tenant/context', () => ({ currentTenantId: () => 'default' }))

import { POST } from './+server'
import { __resetRateLimits } from '$lib/server/rate-limit'
import { isIP } from 'node:net'

const BODY = {
  port: 587,
  user: 'smtp-user',
  password: 'secret',
  from_address: 'noreply@example.org',
  to_address: 'admin@example.org',
}

function call(host: string, port = 587) {
  const request = new Request('http://localhost/api/setup/test-smtp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Setup-Token': 't' },
    body: JSON.stringify({ ...BODY, host, port }),
  })
  return POST({ request, getClientAddress: () => '203.0.113.9' } as never)
}

beforeEach(() => {
  __resetRateLimits()
  hoisted.lookupAddresses = [{ address: '203.0.113.25', family: 4 }]
  hoisted.lookupError = null
  hoisted.lookupHangs = false
  hoisted.sendMail.mockClear()
  hoisted.createTransport.mockClear()
  hoisted.readConfig.mockReturnValue({ setup_complete: false, smtp: { host: '' } })
  for (const k of Object.keys(hoisted.env)) delete hoisted.env[k]
})

describe('POST /api/setup/test-smtp — internal target guard', () => {
  // Every row is RED against f2d7751: the kernel route has no guard at all.
  const blocked: Array<[label: string, host: string]> = [
    ['IPv4 loopback', '127.0.0.1'],
    ['the loopback hostname', 'localhost'],
    ['IPv6 loopback', '::1'],
    ['the cloud metadata link-local address', '169.254.169.254'],
    ['an RFC1918 10/8 address', '10.0.0.5'],
    ['an RFC1918 172.16/12 address', '172.16.0.1'],
    ['an RFC1918 192.168/16 address', '192.168.1.10'],
    // ── canonicalisation: the SAME addresses, spelled differently ──────────
    ['hex-group v4-mapped loopback', '::ffff:7f00:1'],
    ['hex-group v4-mapped metadata address', '::ffff:a9fe:a9fe'],
    ['hex-group v4-mapped RFC1918 address', '::ffff:0a00:1'],
    ['fully-expanded v4-mapped loopback', '0:0:0:0:0:ffff:127.0.0.1'],
    ['fully-expanded IPv6 loopback', '0:0:0:0:0:0:0:1'],
    ['the v4-compatible unspecified address', '::0.0.0.0'],
    ['dotted v4-mapped loopback', '::ffff:127.0.0.1'],
    ['dotted v4-mapped metadata address', '::ffff:169.254.169.254'],
    ['a bracketed IPv6 loopback', '[::1]'],
    ['the IPv6 unspecified address', '::'],
    ['the IPv4 unspecified address', '0.0.0.0'],
    ['a unique-local IPv6 address', 'fd00::1'],
    ['a link-local IPv6 address', 'fe80::1'],
    ['a CGNAT address', '100.64.0.1'],
    ['an RFC1918 172.31/12 edge address', '172.31.255.254'],
    ['a multicast address', '224.0.0.1'],
    // ── spellings net.isIP() rejects, so nodemailer would RE-RESOLVE them ──
    // dns.lookup('012.0.0.1') answers 10.0.0.1: judging one string and
    // dialling another is the bug class this guard exists to remove.
    ['a leading-zero dotted quad (decimal-parsed 10/8)', '012.0.0.1'],
    ['an octal-looking dotted quad', '0177.0.0.1'],
    ['a bare 32-bit integer address', '2130706433'],
    ['a hex dotted address', '0x7f.0x0.0x0.0x1'],
    // NAT64 / SIIT / 6to4 / Teredo each embed an IPv4 address in an IPv6 one.
    ['NAT64 well-known-prefix loopback', '64:ff9b::7f00:1'],
    ['NAT64 well-known-prefix metadata address', '64:ff9b::a9fe:a9fe'],
    ['NAT64 RFC 8215 local-use prefix loopback', '64:ff9b:1::7f00:1'],
    ['the SIIT IPv4-translated loopback', '::ffff:0:7f00:1'],
    ['a 6to4 encoding of loopback', '2002:7f00:1::'],
    ['a 6to4 encoding of the metadata address', '2002:a9fe:a9fe::'],
    ['a Teredo address embedding loopback', '2001:0:4136:e378:8000:63bf:80ff:fffe'],
    // RFC 6666 discard-only. `100::` canonicalises to 01 00 00 … — b[0] is
    // 0x01, so it is NOT under ::/8 and needs its own rule and its own vector.
    ['the RFC 6666 discard prefix', '100::'],
    ['a discard-prefix address embedding loopback', '100::7f00:1'],
    ['a discard-prefix address at the /64 edge', '100::ffff:ffff:ffff:ffff'],
  ]

  for (const [label, host] of blocked) {
    it(`refuses ${label} (${host}) before any connect`, async () => {
      const res = await call(host)
      expect(res.status).toBe(400)
      expect(hoisted.createTransport).not.toHaveBeenCalled()
      expect(hoisted.sendMail).not.toHaveBeenCalled()
    })
  }

  it('still allows a public IPv6 address that neighbours the blocked prefixes', async () => {
    const res = await call('2001:4860:4860::8888', 587)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({
      host: '2001:4860:4860::8888',
    })
  })

  it('refuses a public hostname that resolves to a private address', async () => {
    hoisted.lookupAddresses = [{ address: '127.0.0.1', family: 4 }]
    const res = await call('smtp.attacker.example')
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('refuses a hostname whose answer set MIXES public and private addresses', async () => {
    hoisted.lookupAddresses = [
      { address: '203.0.113.25', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]
    const res = await call('rebind.attacker.example')
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('answers a refusal with an operator hint naming the opt-in', async () => {
    const res = await call('10.0.0.5')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; hint?: string }
    expect(body.error).toContain('SMTP-Host')
    expect(body.hint).toContain('SMTP_TEST_ALLOW_PRIVATE')
  })

  // The hint is the ONLY place most operators ever read the rule, so it must
  // state the rule the predicate actually implements. A hint that promises
  // "metadata addresses stay locked" while the flag waived 100.64/10 would be
  // false as shipped — a cloud metadata endpoint lives in that range.
  it('states the RFC1918/ULA-only rule and names CGNAT as still blocked', async () => {
    const res = await call('10.0.0.5')
    const { hint } = (await res.json()) as { hint: string }
    for (const range of ['10/8', '172.16/12', '192.168/16', 'fc00::/7']) {
      expect(hint, `hint names waived range ${range}`).toContain(range)
    }
    expect(hint).toContain('100.64/10')
    expect(hint).toContain('CGNAT')
    expect(hint).toContain('Metadaten-Adressen')
  })
})

// `config.smtp.host` is writable by the same setup token that calls this
// endpoint (PATCH /api/setup/config), so treating it as trusted would be an
// attacker-writable allowlist: two requests re-open the metadata address.
describe('POST /api/setup/test-smtp — no mutable host allowlist', () => {
  it('refuses an internal relay name even when it IS the configured smtp host', async () => {
    hoisted.readConfig.mockReturnValue({ setup_complete: false, smtp: { host: 'mailpit' } })
    hoisted.lookupAddresses = [{ address: '172.18.0.5', family: 4 }]
    const res = await call('mailpit', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('refuses an internal relay name even when EMAIL_HOST names it', async () => {
    hoisted.env.EMAIL_HOST = 'mailpit'
    hoisted.lookupAddresses = [{ address: '172.18.0.5', family: 4 }]
    const res = await call('mailpit', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('refuses an internal relay name even when SMTP_HOST names it', async () => {
    hoisted.env.SMTP_HOST = 'mailpit'
    hoisted.lookupAddresses = [{ address: '172.18.0.5', family: 4 }]
    const res = await call('mailpit', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('refuses the metadata address even after it is written into config.smtp.host', async () => {
    // The exact two-request escalation an allowlist would permit:
    // PATCH /api/setup/config {"smtp":{"host":"169.254.169.254"}}, then POST here.
    hoisted.readConfig.mockReturnValue({
      setup_complete: false,
      smtp: { host: '169.254.169.254' },
    })
    const res = await call('169.254.169.254', 80)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })
})

// The escape hatch is a RANGE opt-in, not a kill switch. It waives RFC1918 and
// IPv6 unique-local only; loopback, link-local/metadata, multicast, CGNAT and
// the blocked host names stay refused, and the resolve-once path still applies.
describe('POST /api/setup/test-smtp — SMTP_TEST_ALLOW_PRIVATE is a private-range opt-in', () => {
  it('allows an RFC1918 literal when SMTP_TEST_ALLOW_PRIVATE=1', async () => {
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
    const res = await call('10.0.0.5', 1025)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport).toHaveBeenCalledTimes(1)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({ host: '10.0.0.5' })
  })

  it('allows a private NAME and connects by the RESOLVED IP with the name as servername', async () => {
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
    hoisted.lookupAddresses = [{ address: '172.18.0.5', family: 4 }]
    const res = await call('mailpit', 1025)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({
      host: '172.18.0.5',
      port: 1025,
      tls: { servername: 'mailpit' },
    })
  })

  const stillRefused: Array<[label: string, host: string]> = [
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['the cloud metadata address', '169.254.169.254'],
    ['the loopback hostname', 'localhost'],
    ['the GCE metadata hostname', 'metadata.google.internal'],
    ['a multicast address', '224.0.0.1'],
    ['the v4-mapped metadata address', '::ffff:a9fe:a9fe'],
  ]

  for (const [label, host] of stillRefused) {
    it(`still refuses ${label} (${host}) with SMTP_TEST_ALLOW_PRIVATE=1`, async () => {
      hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
      const res = await call(host, 1025)
      expect(res.status).toBe(400)
      expect(hoisted.createTransport).not.toHaveBeenCalled()
    })
  }

  it('still refuses a NAME that resolves to loopback with SMTP_TEST_ALLOW_PRIVATE=1', async () => {
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
    hoisted.lookupAddresses = [{ address: '127.0.0.1', family: 4 }]
    const res = await call('localtest.me', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('still refuses a private target when SMTP_TEST_ALLOW_PRIVATE is anything else', async () => {
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '0'
    const res = await call('10.0.0.5', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  // ── CGNAT (100.64/10) is OUT of the opt-in ────────────────────────────────
  // A public-cloud instance-metadata endpoint sits inside 100.64/10, so "CGNAT
  // addresses no host-local or metadata service" is false, and the hint's
  // promise that metadata stays locked would be false with it. The opt-in is
  // RFC1918 + IPv6 ULA only.
  //
  // Each row is asserted on the side its NAME states, under the flag state
  // that side needs, so mutating either edge of the range fails a test.
  const cgnatEdges: Array<[label: string, host: string, allowPrivate: boolean, status: number]> = [
    // Just BELOW the range: ordinary public space, reachable with no flag.
    ['the public address immediately below CGNAT', '100.63.255.255', false, 200],
    // The range itself: refused even WITH the flag (both edges + the metadata
    // endpoint that is the counter-example to the "no metadata here" claim).
    ['the first CGNAT address', '100.64.0.0', true, 400],
    ['the cloud metadata address inside CGNAT', '100.100.100.200', true, 400],
    ['the last usable CGNAT address', '100.127.255.254', true, 400],
    // Just ABOVE the range: ordinary public space again, reachable with no flag.
    ['the public address immediately above CGNAT', '100.128.0.0', false, 200],
  ]

  for (const [label, host, allowPrivate, status] of cgnatEdges) {
    const flag = allowPrivate ? 'SMTP_TEST_ALLOW_PRIVATE=1' : 'no flag'
    const verb = status === 200 ? 'allows' : 'refuses'
    it(`${verb} ${label} (${host}) with ${flag}`, async () => {
      if (allowPrivate) hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
      const res = await call(host, 1025)
      expect(res.status).toBe(status)
      if (status === 200) {
        expect(hoisted.createTransport).toHaveBeenCalledTimes(1)
        expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({ host })
      } else {
        expect(hoisted.createTransport).not.toHaveBeenCalled()
      }
    })
  }

  it('refuses a CGNAT address by default too', async () => {
    const res = await call('100.64.0.1', 1025)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })
})

// Checking the name and then handing the NAME to nodemailer leaves a DNS
// rebinding window: the second lookup (nodemailer's own) can answer 127.0.0.1.
// Resolve once, connect to the address that was actually vetted, and keep the
// hostname only as the TLS SNI name so certificate validation still works.
describe('POST /api/setup/test-smtp — resolve once, connect to the vetted IP', () => {
  it('hands nodemailer the RESOLVED IP with the hostname as TLS servername', async () => {
    const res = await call('smtp.example.com', 587)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { success: boolean }
    expect(payload.success).toBe(true)
    expect(hoisted.createTransport).toHaveBeenCalledTimes(1)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({
      host: '203.0.113.25',
      port: 587,
      tls: { servername: 'smtp.example.com' },
    })
    expect(hoisted.sendMail).toHaveBeenCalledTimes(1)
  })

  it('never hands nodemailer a name on ANY allowed branch', async () => {
    // Every allowed branch (public name, public literal, private literal +
    // opt-in, private name + opt-in) must dial a string net.isIP() recognises
    // — anything else nodemailer resolves itself, which is exactly the
    // rebinding window this guard closes.
    const cases: Array<[host: string, envVars: Record<string, string>, resolvesTo: string]> = [
      ['smtp.example.com', {}, '203.0.113.25'],
      ['198.51.100.7', {}, '203.0.113.25'],
      ['10.0.0.5', { SMTP_TEST_ALLOW_PRIVATE: '1' }, '203.0.113.25'],
      ['mailpit', { SMTP_TEST_ALLOW_PRIVATE: '1' }, '172.18.0.5'],
    ]
    for (const [host, envVars, resolvesTo] of cases) {
      __resetRateLimits()
      hoisted.createTransport.mockClear()
      for (const k of Object.keys(hoisted.env)) delete hoisted.env[k]
      Object.assign(hoisted.env, envVars)
      hoisted.lookupAddresses = [{ address: resolvesTo, family: 4 }]
      const res = await call(host, 1025)
      expect(res.status, `status for ${host}`).toBe(200)
      const dialled = (hoisted.createTransport.mock.calls[0][0] as { host: string }).host
      expect(isIP(dialled), `dialled ${dialled} for ${host}`).not.toBe(0)
    }
  })

  it('passes a public IP literal through unchanged (nothing to resolve)', async () => {
    const res = await call('198.51.100.7', 587)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({ host: '198.51.100.7' })
  })

  // `addrs[0]` is whatever the resolver happened to list first. On a host with
  // no IPv6 route that can be a AAAA answer, and the connect then fails with
  // EHOSTUNREACH/ENETUNREACH on a relay that plainly works over IPv4 — a
  // guard-shaped outage with no guard message. Every answer in the set is
  // vetted either way, so preferring the A record costs nothing.
  it('dials the IPv4 answer when the set mixes families', async () => {
    hoisted.lookupAddresses = [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '203.0.113.25', family: 4 },
    ]
    const res = await call('smtp.example.com', 587)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({
      host: '203.0.113.25',
      tls: { servername: 'smtp.example.com' },
    })
  })

  it('still dials the IPv6 answer when that is all there is', async () => {
    hoisted.lookupAddresses = [{ address: '2606:4700:4700::1111', family: 6 }]
    const res = await call('v6only.example.com', 587)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({
      host: '2606:4700:4700::1111',
    })
  })

  it('still refuses when the IPv6 half of a mixed set is private', async () => {
    // Preference must not become selection: a blocked answer anywhere in the
    // set still refuses the whole target.
    hoisted.lookupAddresses = [
      { address: 'fe80::1', family: 6 },
      { address: '203.0.113.25', family: 4 },
    ]
    const res = await call('mixed.example.com', 587)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('fails closed when resolution fails', async () => {
    hoisted.lookupError = new Error('ENOTFOUND')
    const res = await call('nx.example.com')
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })
})

// ── The opt-in must be SETTABLE in the shipped deployment ─────────────────
//
// A guard whose only escape hatch cannot be reached is a guard operators route
// around. `SMTP_TEST_ALLOW_PRIVATE` is read from the gremion-ui process
// environment, and a compose service only sees a variable its own
// `environment:` mapping passes through — `.env` alone does NOT reach the
// container. Without the passthrough the hint below instructs an operator to
// set a variable that has no effect, which is the shape of a hint that lies.
describe('SMTP_TEST_ALLOW_PRIVATE reaches the shipped gremion-ui container', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
  const compose = () => readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8')

  /** The `environment:` mapping compose renders for one service. */
  function serviceEnvironment(text: string, service: string): Record<string, string> {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l === `  ${service}:`)
    expect(start, `docker-compose.yml has no service ${service}`).toBeGreaterThan(-1)
    let inEnv = false
    const out: Record<string, string> = {}
    for (const line of lines.slice(start + 1)) {
      if (/^\s{0,2}\S/.test(line) && line.trim() !== '') break // next service
      if (/^\s{4}\S/.test(line)) inEnv = line.trim() === 'environment:'
      if (!inEnv) continue
      const m = /^\s{6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  }

  it('control: the parser really reads the gremion-ui environment mapping', () => {
    // Without this a mapping the parser silently failed to find would make
    // every assertion below pass vacuously.
    const env = serviceEnvironment(compose(), 'gremion-ui')
    expect(env.AUTH_SECRET).toBe('${AUTH_SECRET}')
    expect(Object.keys(env).length).toBeGreaterThan(5)
  })

  it('passes SMTP_TEST_ALLOW_PRIVATE through to the container', () => {
    const env = serviceEnvironment(compose(), 'gremion-ui')
    expect(
      env,
      'the only escape hatch must be settable without editing docker-compose.yml',
    ).toHaveProperty('SMTP_TEST_ALLOW_PRIVATE')
    expect(
      env.SMTP_TEST_ALLOW_PRIVATE,
      'it must read the operator .env value, not a value pinned in the compose file',
    ).toContain('${SMTP_TEST_ALLOW_PRIVATE')
  })

  it('defaults to OFF when the operator sets nothing', () => {
    const env = serviceEnvironment(compose(), 'gremion-ui')
    // `${VAR:-}` / `${VAR:-0}` — never a bare `1`, which would ship the stack
    // with the private-range opt-in already on.
    expect(env.SMTP_TEST_ALLOW_PRIVATE).toMatch(/^\$\{SMTP_TEST_ALLOW_PRIVATE:-[01]?\}$/)
  })

  it('.env.example documents the variable', () => {
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8')
    expect(
      example,
      'a passthrough nobody is told about is a passthrough nobody uses',
    ).toContain('SMTP_TEST_ALLOW_PRIVATE')
  })
})

// The hint is the ONLY place most operators read the rule. It must name the
// variable AND the place a value set there actually arrives from — `.env` plus
// a container recreate — because compose reads `.env` at CREATE time and
// `docker compose restart` does not re-read it.
describe('POST /api/setup/test-smtp — the hint names the deployment path', () => {
  it('names the variable, the .env file and the recreate', async () => {
    const res = await call('10.0.0.5')
    const { hint } = (await res.json()) as { hint: string }
    expect(hint).toContain('SMTP_TEST_ALLOW_PRIVATE=1')
    expect(hint, 'the variable is read from the compose env file').toContain('.env')
    expect(hint, 'restart does not re-read .env — the container must be recreated').toMatch(
      /neu erstellen|--force-recreate/,
    )
    expect(hint).toContain('gremion-ui')
  })
})

// ── The IPv6 instance-metadata endpoint lives INSIDE the waived range ─────
//
// fc00::/7 is the one IPv6 range the opt-in waives, and a public-cloud
// instance-metadata service answers at fd00:ec2::254 — inside it. Waiving the
// range wholesale would make the hint's promise that metadata addresses stay
// locked false exactly when the flag is set, which is the only state in which
// it matters.
describe('POST /api/setup/test-smtp — the IPv6 metadata prefix is never waivable', () => {
  const vectors: Array<[label: string, host: string]> = [
    ['the IPv6 instance-metadata address', 'fd00:ec2::254'],
    ['its bracketed spelling', '[fd00:ec2::254]'],
    ['its fully-expanded spelling', 'fd00:0ec2:0000:0000:0000:0000:0000:0254'],
    ['another address in the same metadata prefix', 'fd00:ec2::1'],
  ]

  for (const [label, host] of vectors) {
    it(`refuses ${label} (${host}) WITHOUT the flag`, async () => {
      const res = await call(host, 80)
      expect(res.status).toBe(400)
      expect(hoisted.createTransport).not.toHaveBeenCalled()
    })

    it(`refuses ${label} (${host}) WITH SMTP_TEST_ALLOW_PRIVATE=1`, async () => {
      hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
      const res = await call(host, 80)
      expect(res.status).toBe(400)
      expect(hoisted.createTransport).not.toHaveBeenCalled()
    })
  }

  it('refuses a NAME that resolves into the metadata prefix even WITH the flag', async () => {
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
    hoisted.lookupAddresses = [{ address: 'fd00:ec2::254', family: 6 }]
    const res = await call('relay.internal.example', 25)
    expect(res.status).toBe(400)
    expect(hoisted.createTransport).not.toHaveBeenCalled()
  })

  it('still allows an ordinary ULA relay with the flag — the carve-out is the PREFIX only', async () => {
    // Narrowing must not swallow the opt-in it is carved out of.
    hoisted.env.SMTP_TEST_ALLOW_PRIVATE = '1'
    const res = await call('fd12:3456:789a::25', 1025)
    expect(res.status).toBe(200)
    expect(hoisted.createTransport.mock.calls[0][0]).toMatchObject({ host: 'fd12:3456:789a::25' })
  })
})

// ── DNS failures are classified, logged and bounded ───────────────────────
//
// A name that does not resolve and a name that resolves to loopback are two
// different operator problems answered by the same 400 today, so the operator
// reads the private-range remediation for a typo. And an unbounded
// `dns.lookup()` holds the request (and its rate-limit slot) for as long as the
// resolver takes, which on a black-holed resolver is minutes.
describe('POST /api/setup/test-smtp — DNS failures are classified, logged and bounded', () => {
  it('answers a resolution failure with a DISTINCT hint, not the private-range one', async () => {
    hoisted.lookupError = new Error('ENOTFOUND')
    const res = await call('nx.example.com')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; hint?: string }
    expect(body.hint, 'a DNS failure needs its own remediation').toBeTruthy()
    expect(
      body.hint,
      'pointing at the private-range opt-in for a name that does not resolve is a wrong answer',
    ).not.toContain('SMTP_TEST_ALLOW_PRIVATE')
    expect(body.hint).toMatch(/DNS/i)
    expect(body.error, 'the two refusals must not be indistinguishable').not.toBe(
      'SMTP-Host ist keine erlaubte externe Adresse',
    )
  })

  it('an EMPTY answer set is classified as a DNS failure too', async () => {
    hoisted.lookupAddresses = []
    const res = await call('empty.example.com')
    expect(res.status).toBe(400)
    const { hint } = (await res.json()) as { hint: string }
    expect(hint).toMatch(/DNS/i)
  })

  it('a name that resolves to a BLOCKED address still gets the private-range hint', async () => {
    // Classification must split the two causes, not relabel every refusal.
    hoisted.lookupAddresses = [{ address: '127.0.0.1', family: 4 }]
    const res = await call('localtest.example')
    expect(res.status).toBe(400)
    const { hint } = (await res.json()) as { hint: string }
    expect(hint).toContain('SMTP_TEST_ALLOW_PRIVATE')
  })

  it('logs the failure server-side', async () => {
    // The response deliberately carries no resolver detail; without a
    // server-side line the operator's only evidence is a generic 400.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      hoisted.lookupError = new Error('EAI_AGAIN')
      await call('flaky.example.com')
      expect(warn).toHaveBeenCalled()
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toMatch(/test-smtp/)
      expect(logged, 'the log must say which lookup failed').toContain('flaky.example.com')
    } finally {
      warn.mockRestore()
    }
  })

  /** The ceiling the bound must sit under. Asserting a CEILING rather than the
   *  exact constant keeps the test from pinning an implementation detail while
   *  still failing outright if the lookup is unbounded. */
  const DNS_BOUND_CEILING_MS = 10_000

  it('is BOUNDED: a lookup that never answers is abandoned, not awaited forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      hoisted.lookupHangs = true
      // `POST` is typed MaybePromise<Response>; normalise before observing it.
      const pending = Promise.resolve(call('blackhole.example.com'))
      let settled = false
      void pending.then(() => {
        settled = true
      })
      // Nothing may resolve on its own: only the bound can end this request.
      await vi.advanceTimersByTimeAsync(0)
      expect(settled, 'the handler must not answer before the bound elapses').toBe(false)
      await vi.advanceTimersByTimeAsync(DNS_BOUND_CEILING_MS)
      const res = await pending
      expect(res.status).toBe(400)
      const { hint } = (await res.json()) as { hint: string }
      expect(hint).toMatch(/DNS/i)
      expect(hoisted.createTransport).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })
})

// A guard nobody can find is a guard nobody maintains, and a doc that hides its
// own gaps is how a known residual becomes a surprise.
describe('the guard doc is reachable and states its residuals', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..')

  it('docs/INDEX.md links the guard doc', () => {
    const index = readFileSync(join(repoRoot, 'docs/INDEX.md'), 'utf8')
    expect(index, 'an unlinked doc is an unread doc').toContain('security/test-smtp-guard.md')
  })

  it('the guard doc carries a named residual list', () => {
    const doc = readFileSync(join(repoRoot, 'docs/security/test-smtp-guard.md'), 'utf8')
    expect(doc).toMatch(/^## Residuals/m)
    for (const marker of ['R1', 'R2', 'R3']) {
      expect(doc, `residual ${marker} must be named, not implied`).toContain(marker)
    }
  })

  it('the guard doc enumerates the fc00::/7 waiver AND its metadata carve-out', () => {
    const doc = readFileSync(join(repoRoot, 'docs/security/test-smtp-guard.md'), 'utf8')
    expect(doc).toContain('fc00::/7')
    expect(doc, 'the one prefix inside the waiver that is never waived').toContain('fd00:ec2::/32')
  })

  it('the guard doc documents the compose passthrough and the DNS bound', () => {
    const doc = readFileSync(join(repoRoot, 'docs/security/test-smtp-guard.md'), 'utf8')
    expect(doc).toContain('.env.example')
    expect(doc).toMatch(/DNS/)
  })
})
