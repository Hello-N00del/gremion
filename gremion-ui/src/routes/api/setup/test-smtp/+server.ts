import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { readConfig } from '$lib/server/config'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { validateSetupToken } from '$lib/server/setup-token'
import { requireSetupRateLimit } from '$lib/server/rate-limit'

// The rate limit below bounds how OFTEN this endpoint can be used as an
// outbound oracle, but not WHERE it points. A caller holding only the setup
// token could aim it at a cloud metadata address or at any service on the host
// network and read the connection outcome back out of the error string. Refuse
// those targets before nodemailer opens a socket.
//
// The guard decides on the CANONICAL BYTES of an address, not on one of its
// spellings. `::ffff:7f00:1`, `0:0:0:0:0:ffff:127.0.0.1` and `::ffff:127.0.0.1`
// are the same 16 bytes; a per-spelling regex catches only the last one.
// Anything that cannot be canonicalised to a public address is DENIED — the
// guard has no "unrecognised, therefore fine" branch.
//
// There is NO host allowlist. Exempting `config.smtp.host` would not work:
// PATCH /api/setup/config writes that value under the SAME setup token this
// endpoint accepts, so the "operator's own choice" is in fact attacker-supplied
// and two requests re-open the metadata address. The env half (EMAIL_HOST /
// SMTP_HOST) is dead anyway — neither name exists in the gremion-ui container.
// The only escape hatch is SMTP_TEST_ALLOW_PRIVATE, and it widens the ADDRESS
// PREDICATE for private ranges instead of short-circuiting the whole guard:
// loopback, link-local/metadata, multicast and the blocked names stay refused
// with it set.
const BLOCKED_HOST_NAMES = ['localhost', 'metadata.google.internal', 'instance-data']

/**
 * Wall-clock bound on the ONE `dns.lookup()` this route performs.
 *
 * `dns.lookup()` has no timeout of its own: against a black-holed resolver it
 * holds the request — and the rate-limit slot it consumed — for as long as the
 * platform resolver retries, which is minutes. The connect timeouts below
 * (5 s) never apply, because no socket is opened until resolution finishes.
 * Matching them keeps the worst case of a refused request in the same order of
 * magnitude as an accepted one.
 */
const DNS_TIMEOUT_MS = 5000
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

/**
 * Operator-facing remediation for a refusal. BOTH in-repo SMTP surfaces render
 * it — `routes/setup/steps/Step4Smtp.svelte` (first-run wizard) and
 * `routes/settings/tabs/TabEmail.svelte` (Settings → E-Mail) — so an operator
 * pointing at an internal mail catcher is told what to do instead of
 * dead-ending on a bare refusal.
 *
 * ⚠ Neither surface can actually reach this endpoint today: POST below returns
 * 401 without an `X-Setup-Token` header that no `.svelte` sends, and 404 once
 * `setup_complete` is true — which Settings → E-Mail always is. That is a
 * PRE-EXISTING product defect of the setup-token auth model, not a property of
 * this guard, and this change deliberately does not alter that model. See
 * docs/security/test-smtp-guard.md.
 *
 * The text names the exact rule the predicate below implements: the opt-in
 * widens RFC1918 and IPv6 ULA only.
 */
const REFUSAL_HINT =
  'Nur öffentlich erreichbare SMTP-Server sind zugelassen. Für einen internen Relay ' +
  '(z. B. ein Mail-Catcher im Container-Netz) SMTP_TEST_ALLOW_PRIVATE=1 in der .env ' +
  'setzen und gremion-ui neu erstellen (docker compose up -d --force-recreate ' +
  'gremion-ui) — docker compose restart liest die .env nicht neu. Die Freigabe gilt ' +
  'nur für private Bereiche (10/8, 172.16/12, 192.168/16 und IPv6 fc00::/7). ' +
  'Loopback-, Link-Local-, CGNAT- (100.64/10) und Metadaten-Adressen bleiben auch ' +
  'dann gesperrt.'

/**
 * A refusal caused by DNS, not by the address predicate.
 *
 * Answering an unresolvable name with REFUSAL_HINT sends the operator to the
 * private-range opt-in for what is almost always a typo or a resolver outage —
 * a hint that is confidently wrong. The two causes get two answers.
 */
const DNS_FAILURE_HINT =
  'Der SMTP-Host konnte nicht per DNS aufgelöst werden (kein Ergebnis, Fehler oder ' +
  'Zeitüberschreitung nach ' +
  `${DNS_TIMEOUT_MS / 1000} s). Namen und DNS-Erreichbarkeit des Containers prüfen; ` +
  'Details stehen im Server-Log von gremion-ui.'

/**
 * Canonical 4 bytes of a dotted-quad, or null when it is not one. STRICT: a
 * leading zero (`012.0.0.1`) is refused rather than read as decimal, because
 * `net.isIP()` does not accept that spelling and nodemailer would therefore
 * hand the string to its own resolver — where `dns.lookup('012.0.0.1')` answers
 * 10.0.0.1. Judging one string and dialling another is the bug class this file
 * exists to remove.
 */
function parseIpv4Bytes(s: string): number[] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/**
 * Canonical 16 bytes of an IPv6 literal, or null when it is not one. Handles
 * `::` compression, full 8-group form, and an embedded dotted-quad tail
 * (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:127.0.0.1`, `::0.0.0.0`) by folding the
 * quad into its two hex groups first, so every spelling reduces to one array.
 */
function parseIpv6Bytes(input: string): number[] | null {
  let s = input.toLowerCase()
  const dot = s.indexOf('.')
  if (dot !== -1) {
    const lastColon = s.lastIndexOf(':')
    if (lastColon === -1 || lastColon > dot) return null
    const quad = parseIpv4Bytes(s.slice(lastColon + 1))
    if (!quad) return null
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const groups = (g: string): number[] | null => {
    if (g === '') return []
    const out: number[] = []
    for (const p of g.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null
      const n = parseInt(p, 16)
      out.push((n >> 8) & 0xff, n & 0xff)
    }
    return out
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  if (halves.length === 2) {
    const head = groups(halves[0])
    const tail = groups(halves[1])
    if (!head || !tail) return null
    const fill = 16 - head.length - tail.length
    if (fill < 0) return null
    return [...head, ...new Array<number>(fill).fill(0), ...tail]
  }
  const all = groups(s)
  return all && all.length === 16 ? all : null
}

/**
 * `allowPrivate` is the SMTP_TEST_ALLOW_PRIVATE opt-in. It waives the RFC1918
 * ranges (and IPv6 unique-local, below) and NOTHING else. Loopback,
 * this-network, link-local (the cloud metadata address), CGNAT, the 6to4 relay
 * anycast, benchmarking, multicast and reserved space are never waivable — an
 * operator wanting an internal relay never needs them, and they are the targets
 * the guard exists for.
 *
 * CGNAT (100.64/10) stays OUT of the opt-in: a public-cloud instance-metadata
 * endpoint lives inside that range, so waiving it would make the hint's promise
 * that metadata addresses stay locked false as shipped. The opt-in is RFC1918 +
 * ULA only; 100.64/10 is refused with the flag and without it.
 */
function isBlockedIpv4Bytes(o: number[], allowPrivate = false): boolean {
  const [a, b, c] = o
  if (a === 0 || a === 127) return true // this-network, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT — never waivable (a metadata endpoint lives here)
  if (a === 169 && b === 254) return true // link-local — incl. the metadata address
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved
  // RFC1918 — the only IPv4 ranges the private-relay opt-in unlocks.
  if (a === 10) return !allowPrivate
  if (a === 172 && b >= 16 && b <= 31) return !allowPrivate
  if (a === 192 && b === 168) return !allowPrivate
  return false
}

function isBlockedIpv6Bytes(b: number[], allowPrivate = false): boolean {
  const topZero = b.slice(0, 10).every((x) => x === 0)
  // ::ffff:a.b.c.d — v4-mapped: judge it as the IPv4 address it IS.
  if (topZero && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4Bytes(b.slice(12), allowPrivate)
  // Everything else under ::/8 is reserved (RFC 6890) and is never a public
  // SMTP target. Judging the whole /8 at once closes the embedded-IPv4 family
  // in one rule instead of one prefix at a time — and the per-prefix form is
  // easy to get wrong: a `64:ff9b::/96` test that compares b[0..2] matches the
  // routable 64ff:9b00::/24 instead, and NAT64-embedded loopback is ALLOWED.
  // Covered here: ::/96 (unspecified, loopback, v4-compatible), ::ffff:0:0/96
  // (SIIT / IPv4-translated), 64:ff9b::/32 and 64:ff9b:1::/48 (NAT64).
  if (b[0] === 0x00) return true
  // 100::/64 — RFC 6666 discard-only. It is NOT under ::/8: `100::`
  // canonicalises to 01 00 00 …, i.e. b[0] === 0x01, so without its own branch
  // it falls through every rule above. Named prefixes need their own vector.
  if (b[0] === 0x01 && b.slice(1, 8).every((x) => x === 0)) return true
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return true // 2002::/16 6to4 (deprecated, RFC 7526)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true // multicast
  // fd00:ec2::/32 — the IPv6 instance-metadata prefix of a major public cloud
  // (fd00:ec2::254 is the endpoint). It sits INSIDE fc00::/7, the one IPv6
  // range the opt-in waives, so without this branch setting the flag would hand
  // back the very metadata endpoint the hint promises stays locked — and it
  // would do so exactly in the state where the promise is load-bearing. Same
  // shape as CGNAT on the IPv4 side: the carve-out is the PREFIX, so an
  // ordinary ULA relay is still reachable with the flag.
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2) return true
  if ((b[0] & 0xfe) === 0xfc) return !allowPrivate // fc00::/7 unique-local
  return false
}

/**
 * True when `addr` is NOT a demonstrably public IP literal. Default-deny: an
 * address that cannot be parsed at all is refused, so a spelling this parser
 * does not understand can never be treated as safe.
 */
function isBlockedAddress(addr: string, allowPrivate = false): boolean {
  const ip = addr.replace(/^\[|\]$/g, '').split('%')[0] // strip brackets + zone id
  const v4 = parseIpv4Bytes(ip)
  if (v4) return isBlockedIpv4Bytes(v4, allowPrivate)
  const v6 = parseIpv6Bytes(ip)
  if (v6) return isBlockedIpv6Bytes(v6, allowPrivate)
  return true // unparseable — deny
}

/**
 * Is this string TRYING to be an address literal rather than a hostname? Any
 * colon means an IPv6 attempt; per RFC 1123 a real hostname's rightmost label
 * is never all-digits, and a `0x…` label only ever spells an address. Such a
 * string must be judged as an address — never sent down the DNS path, where a
 * resolver's own re-interpretation (`012.0.0.1` → 10.0.0.1) would decide.
 */
function looksLikeAddressLiteral(s: string): boolean {
  if (s.includes(':')) return true
  const last = s.split('.').pop() ?? ''
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)
}

function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
}

type SmtpTarget =
  /** `reason` splits "this target is not allowed" from "DNS could not answer",
   *  so the operator is not handed the private-range remediation for a typo. */
  | { allowed: false; reason: 'blocked' | 'dns' }
  /** `connectHost` is what nodemailer must dial; `servername` pins TLS SNI. */
  | { allowed: true; connectHost: string; servername?: string }

/**
 * The one lookup, bounded. On timeout the underlying `dns.lookup()` is left to
 * finish into nothing — Node offers no cancellation for it — but the REQUEST is
 * already answered, which is the property that matters: a black-holed resolver
 * can no longer pin a request open. The timer is always cleared, so a fast
 * answer does not keep the event loop alive for the rest of the bound.
 */
async function boundedLookup(name: string): Promise<Array<{ address: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(name, { all: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS} ms`)),
          DNS_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Decide the target ONCE and hand back the address to dial. Validating the
 * NAME and then handing the NAME to nodemailer leaves a DNS-rebinding window:
 * nodemailer resolves again, and the second answer can be 127.0.0.1. Resolving
 * here and connecting to the vetted address closes it; the hostname is kept
 * only as the TLS servername so certificate validation still works.
 */
async function resolveSmtpTarget(host: string): Promise<SmtpTarget> {
  const name = normaliseHost(host)
  if (!name) return { allowed: false, reason: 'blocked' }

  // Widens the ADDRESS predicate for RFC1918 (10/8, 172.16/12, 192.168/16) and
  // IPv6 unique-local (fc00::/7) — and for nothing else. It is not a bypass:
  // every branch below still runs, so `localhost`, `127.0.0.1`, the link-local
  // metadata address, CGNAT (100.64/10) and the blocked suffixes stay refused
  // with it set.
  const allowPrivate = env.SMTP_TEST_ALLOW_PRIVATE === '1'

  if (BLOCKED_HOST_NAMES.includes(name)) return { allowed: false, reason: 'blocked' }
  if (BLOCKED_HOST_SUFFIXES.some((s) => name.endsWith(s)))
    return { allowed: false, reason: 'blocked' }

  if (looksLikeAddressLiteral(name)) {
    // Node must agree it is a literal. A spelling only THIS parser accepts
    // would be re-resolved by nodemailer (net.isIP() is what makes it skip its
    // own DNS), so anything net.isIP() rejects is denied outright rather than
    // being handed to the resolver as if it were a hostname.
    if (isIP(name) === 0) return { allowed: false, reason: 'blocked' }
    if (isBlockedAddress(name, allowPrivate)) return { allowed: false, reason: 'blocked' }
    return { allowed: true, connectHost: name }
  }

  // A name is only as safe as what it resolves to — some public names resolve
  // to 127.0.0.1 by design. Require EVERY answer to be public, and fail closed
  // on a resolution failure (nodemailer could not have reached it either).
  //
  // A DNS failure is classified SEPARATELY from a blocked address. Both refuse,
  // but they are different operator problems: one is a typo or a resolver
  // outage, the other is a target the guard will never allow. Merging them
  // hands the private-range remediation to someone who mistyped a hostname.
  // The cause is logged server-side because the response deliberately carries
  // no resolver detail — an error string is exactly the oracle this endpoint
  // must not become.
  let addrs: Array<{ address: string }>
  try {
    addrs = await boundedLookup(name)
  } catch (err) {
    console.warn(
      `[test-smtp] DNS lookup failed for ${JSON.stringify(name)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { allowed: false, reason: 'dns' }
  }
  if (addrs.length === 0) {
    console.warn(`[test-smtp] DNS lookup for ${JSON.stringify(name)} returned no addresses`)
    return { allowed: false, reason: 'dns' }
  }
  if (addrs.some((a) => isBlockedAddress(a.address, allowPrivate)))
    return { allowed: false, reason: 'blocked' }
  // Prefer an A record when the set mixes families. `addrs[0]` is only
  // whatever the resolver listed first; on a host with no IPv6 route that can
  // be the AAAA answer, and the connect then dies with ENETUNREACH against a
  // relay that plainly works over IPv4 — an outage that looks like the guard
  // but carries no guard message. Every answer was vetted above, so this is a
  // reachability preference and never a way to select past a refusal.
  const preferred = addrs.find((a) => isIP(a.address) === 4) ?? addrs[0]
  return { allowed: true, connectHost: preferred.address, servername: name }
}

// Best-effort IP extraction — mirrors routes/api/setup/config/+server.ts.
// getClientAddress() exists in production; partial test events may omit it.
function clientIp(event: { getClientAddress?: () => string }): string {
  try {
    return event.getClientAddress?.() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const smtpTestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string(),
  password: z.string(),
  from_address: z.string().email(),
  to_address: z.string().email(),
})

export const POST: RequestHandler = async (event) => {
  const { request } = event
  // #257-3: rate-limit BEFORE token validation so wrong-token attempts still
  // count, matching the config/admins setup endpoints. This endpoint also opens
  // an outbound SMTP connection to a body-supplied host:port, so the cap also
  // bounds its use as an SSRF/port-probe oracle during the pre-setup window.
  const limited = requireSetupRateLimit(clientIp(event))
  if (limited) return limited
  if (!validateSetupToken(request.headers.get('X-Setup-Token'))) {
    return json({ success: false, error: 'Invalid or missing setup token' }, { status: 401 })
  }
  const config = readConfig()
  if (config.setup_complete) {
    return json({ success: false, error: 'Setup already complete' }, { status: 404 })
  }

  const body = await request.json()
  const parsed = smtpTestSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    )
  }

  const { host, port, user, password, from_address, to_address } = parsed.data

  // Refuse internal/metadata targets BEFORE a transport (and therefore a socket)
  // exists, so no timing or error-string difference leaks the probe result.
  const target = await resolveSmtpTarget(host)
  if (!target.allowed) {
    const dns = target.reason === 'dns'
    return json(
      {
        success: false,
        error: dns
          ? 'SMTP-Host konnte nicht aufgelöst werden'
          : 'SMTP-Host ist keine erlaubte externe Adresse',
        hint: dns ? DNS_FAILURE_HINT : REFUSAL_HINT,
      },
      { status: 400 },
    )
  }

  const transporter = nodemailer.createTransport({
    // Dial the address that was actually vetted, not the name — re-resolving
    // here would reopen the DNS-rebinding window the guard just closed.
    host: target.connectHost,
    port,
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    ...(target.servername ? { tls: { servername: target.servername } } : {}),
  })

  try {
    await transporter.sendMail({
      from: from_address,
      to: to_address,
      subject: 'Gremion SMTP-Test',
      text: 'Diese E-Mail bestätigt, dass die SMTP-Konfiguration erfolgreich ist.',
    })
    return json({ success: true, data: { success: true } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler'
    return json({
      success: false,
      data: { success: false, error: message },
    })
  }
}
