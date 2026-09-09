# `/api/setup/test-smtp` — outbound target guard

`POST /api/setup/test-smtp` opens an outbound TCP connection to a
**body-supplied** `host:port` during the pre-setup window, authorised by the
setup token alone. Without a target guard that is a server-side request forgery
and internal port-probe oracle: a caller can aim it at a cloud metadata address
or at any service reachable from the container's network and read the outcome
back out of the returned error string.

Implementation: `gremion-ui/src/routes/api/setup/test-smtp/+server.ts`.
Cover: `gremion-ui/src/routes/api/setup/test-smtp/server.test.ts`.

## What the guard decides, and when

The target is refused **before a nodemailer transport — and therefore a socket —
exists**, so no timing or error-string difference leaks the probe result.

The decision is made on the **canonical bytes** of an address, never on one of
its spellings. `::ffff:7f00:1`, `0:0:0:0:0:ffff:127.0.0.1` and
`::ffff:127.0.0.1` are the same sixteen bytes; a per-spelling regex catches only
the last one. The parser folds an embedded dotted-quad tail into its two hex
groups and expands `::`, so every spelling reduces to one array before any rule
looks at it.

**Default-deny.** An address that cannot be parsed at all is refused. There is
no "unrecognised, therefore fine" branch.

Blocked IPv4 space: this-network (`0/8`), loopback (`127/8`), CGNAT
(`100.64/10`), link-local incl. the metadata address (`169.254/16`), IETF
protocol assignments (`192.0/16`), the 6to4 relay anycast (`192.88.99/24`),
benchmarking (`198.18/15`), and everything from `224/4` up.

Blocked IPv6 space: the whole of `::/8` — which covers the unspecified address,
loopback, v4-compatible, SIIT/IPv4-translated and both NAT64 prefixes in one
rule — plus the RFC 6666 discard prefix `100::/64` (which is **not** under
`::/8`: `100::` canonicalises to `01 00 …`, so it needs its own branch), Teredo
`2001::/32`, 6to4 `2002::/16`, link-local `fe80::/10`, site-local `fec0::/10`
and multicast `ff00::/8`, plus the IPv6 instance-metadata prefix `fd00:ec2::/32`
(inside `fc00::/7`, and never waivable — see the opt-in section). A v4-mapped
address is judged as the IPv4 address it is.

## DNS: classified, logged, bounded

A name that does not resolve and a name that resolves to loopback are two
different operator problems. They are refused separately:

- **blocked address** → the private-range hint below;
- **DNS failure** (resolver error, empty answer set, or timeout) → its own hint,
  which does *not* point at `SMTP_TEST_ALLOW_PRIVATE`. Sending someone who
  mistyped a hostname to the private-range opt-in is a confidently wrong answer.

The cause is written to the gremion-ui server log; the response deliberately
carries no resolver detail, because an error string is exactly the oracle this
endpoint must not become.

`dns.lookup()` has no timeout of its own, so the one lookup is raced against a
**5 s** bound — the same order as the connect/greeting timeouts. Without it a
black-holed resolver holds the request, and the rate-limit slot it consumed, for
as long as the platform resolver retries. The bound answers the request; Node
offers no cancellation for the lookup itself, so the abandoned lookup finishes
into nothing.

## Resolve once, connect to the vetted address

Validating the *name* and then handing the *name* to nodemailer leaves a DNS
rebinding window: nodemailer resolves again, and the second answer can be
loopback. The route therefore resolves once, requires **every** answer in the
set to be public, and dials the address that was actually vetted. The hostname
is kept only as the TLS `servername`, so certificate validation still works.

Resolution failure fails closed. When the answer set mixes families the A record
is preferred — on a host with no IPv6 route, dialling a AAAA answer produces an
`ENETUNREACH` outage that looks like the guard but carries no guard message.
Every answer in the set is vetted either way, so this is a reachability
preference and never a way to select past a refusal.

A string that is *trying* to be an address literal (any colon; an all-digit or
`0x…` rightmost label) is judged as an address and never sent down the DNS path.
If `net.isIP()` rejects it, it is refused outright rather than handed to a
resolver — `dns.lookup('012.0.0.1')` answers `10.0.0.1`, and judging one string
while dialling another is the whole bug class.

## There is no host allowlist

Exempting `config.smtp.host` does not work: `PATCH /api/setup/config` writes
that value under the **same setup token** this endpoint accepts, so the
"operator's own choice" is attacker-supplied and two requests re-open the
metadata address. The `EMAIL_HOST` / `SMTP_HOST` environment names are not set
on the `gremion-ui` container at all.

## `SMTP_TEST_ALLOW_PRIVATE` is a range opt-in, not a kill switch

Setting `SMTP_TEST_ALLOW_PRIVATE=1` widens the **address predicate** for RFC1918
(`10/8`, `172.16/12`, `192.168/16`) and IPv6 unique-local (`fc00::/7`) — and
nothing else. Every other branch still runs, so loopback, the blocked host names
and suffixes, link-local/metadata, multicast and CGNAT stay refused with it set,
and the resolve-once path still applies.

**It has to be settable in the shipped deployment.** The value is read from the
`gremion-ui` process environment, and a compose service only sees what its own
`environment:` mapping passes through — a value in `.env` alone never reaches
the container. `docker-compose.yml` therefore maps
`SMTP_TEST_ALLOW_PRIVATE: ${SMTP_TEST_ALLOW_PRIVATE:-}` (default **off**), and
`.env.example` documents it. Compose reads `.env` at container *create* time, so
a change needs `docker compose up -d --force-recreate gremion-ui`;
`docker compose restart` does not re-read it. The refusal hint names the
variable, the file and the recreate, so following the hint actually works.

**Two prefixes inside the waived ranges are never waived**, because a cloud
instance-metadata endpoint lives in each:

| Prefix | Family | Why it is carved out |
|--------|--------|----------------------|
| `100.64/10` | IPv4 CGNAT | a public-cloud instance-metadata endpoint answers inside it |
| `fd00:ec2::/32` | IPv6 ULA — inside `fc00::/7` | the IPv6 instance-metadata endpoint (`fd00:ec2::254`) answers inside it |

Both are refused **with the flag and without it**, and the suite asserts each
under both flag states. The carve-outs are *prefixes*, not single addresses, and
they do not swallow the opt-in: an ordinary ULA relay (e.g. `fd12:3456:789a::25`)
is still reachable with the flag set.

**CGNAT (`100.64/10`) is deliberately outside the opt-in.** A public-cloud
instance-metadata endpoint lives inside that range, so waiving it would make the
operator-facing hint's promise that metadata addresses stay locked false as
shipped. The range is refused with the flag and without it, and the test suite
asserts both edges plus the metadata address inside it, each on the side its
name states, so mutating either boundary fails a test.

## The refusal hint, and where it is rendered

A refusal answers `400` with `error` plus a `hint` naming the opt-in and the
exact ranges it waives. Both in-repo consumers render that hint:

- `gremion-ui/src/routes/setup/steps/Step4Smtp.svelte` (first-run wizard)
- `gremion-ui/src/routes/settings/tabs/TabEmail.svelte` (Settings → E-Mail)

Both render it as **plain text**, never `{@html}` — the string arrives in a
server response body — and both place it **inside** the refusal's
`role="alert"` region, so assistive technology announces the remediation
together with the refusal instead of staying silent about it. Each component's
test asserts this against a fixture that *contains markup*: against a plain
string `{text}` and `{@html text}` render the same single text node, so a
markup-free fixture cannot tell them apart and the guard would pass with the
component mutated.

The DNS-failure hint is rendered the same way, by the same two components.

## Residuals

Known gaps that this guard does **not** close. They are listed so a later reader
finds them here rather than discovering them in production.

**R1 — neither UI surface can reach this endpoint.** A property of the
endpoint's auth model, not of the guard, and deliberately unchanged here: the
handler returns **401** without an `X-Setup-Token` header (no `.svelte`
component sends one) and **404** once `setup_complete` is true — which
Settings → E-Mail always is. So today the hint is rendered by two surfaces that
cannot currently trigger it. The guard is still the right place for the check:
it protects the endpoint for any caller that *does* hold the token, which is the
threat model that matters, and both consumers become correct the moment the auth
model is fixed. Changing that model is separate work.

**R2 — with the opt-in set, the rest of the private ranges are reachable.** That
is what the opt-in *is*: outside the two carved-out metadata prefixes, the guard
cannot tell an operator's internal relay from any other service on the same
private network, so `SMTP_TEST_ALLOW_PRIVATE=1` re-opens the internal
port-probe oracle for RFC1918 and `fc00::/7`. It is off by default, it is an
explicit operator decision recorded in `.env`, and it is documented as a
testing aid — not a production setting.

**R3 — the DNS bound caps one lookup, not the endpoint's total cost.** The 5 s
race bounds the single `dns.lookup()` per request; what bounds *repeated* use of
the endpoint is the setup rate limiter, not this cap. The abandoned lookup is
not cancelled (Node exposes no cancellation for `dns.lookup()`) — it finishes
into nothing after the request has already been answered.
