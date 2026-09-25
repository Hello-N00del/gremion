# Deployment architecture

How a Gremion distribution is deployed on a single host. This is the public
counterpart of a deployment's private host design: it states the *shape* — the
tiers, the two colours, the networks, the release tree and the env contract —
and never a deployment's own addresses or names.

Addresses here are documentation values (`example.org`, `203.0.113.0/24`,
`2001:db8::/32`). A deployment's real values live in
`/opt/gremion/etc/env/state.env` and in that deployment's private annex.
`scripts/kernel-hygiene-check.mjs` check `k1` and
`test/host/no-host-literals.bats` both fail if a real one reaches this tree.

## Two tiers, two colours

| Project | Compose project name | Holds |
|---|---|---|
| state | `${STACK}-state` | every Postgres server, Keycloak, Traefik, socket proxy, pgbouncer, NATS, Redis, MinIO, vector, legal, fallback, the sales site and the module-owned services |
| app (blue) | `${STACK}-app-blue` | `gremion-ui`, `gremion-public`, the nine leaves, `migrate` |
| app (green) | `${STACK}-app-green` | the same set, the other colour |

"State project" is a **deploy-time placement**, never repo ownership: a
module's service block lives in that module's own repository as
`compose/<id>.yml` and is inlined by the assembler at release build.

App-tier services carry `traefik.enable=false` and colour-suffixed network
aliases; only the edge publishes ports. Composition is env-file only:
`--env-file` is the single permitted flag.

## Networks

| Network | Purpose | Created by |
|---|---|---|
| `${STACK}_edge` | Traefik ↔ app tiers, control plane, sales site, legal, fallback | the host bootstrap; `external: true` in every project |
| `${STACK}_state` | databases, Keycloak, NATS, Redis, MinIO, and the other state services | the host bootstrap; `external: true` |
| `app` | one per colour, project-scoped | the colour project |

All are pinned and dual-stack with a ULA prefix. Traefik's
`forwardedHeaders.trustedIPs` is the edge subnet and nothing else; tenant
selection never rests on that list — every router pins `X-Forwarded-Host`.

## The edge

One Traefik, bound to the deployment's edge address only (`:80`, `:443`, both
families). `:80` redirects to `:443` at the entrypoint. The API and the
`internaltest` entrypoint bind loopback. Certificates come from an ACME
resolver against a persistent volume; every router carries a certresolver, an
HSTS middleware and a rate-limit middleware, and `gremion-verify` reads that
from Traefik's own API rather than from a config file.

### Accepted exposure: the ACME challenge path is not rate-limited

The `web` entrypoint serves exactly two things: Traefik's internal
`acme-http@internal` router for `/.well-known/acme-challenge/`, and the
entrypoint-level 301 to `websecure`. `acme-http@internal` is internal to
Traefik and carries no middleware chain, so the rate-limit family that every
application router carries does not apply to it. Neither surface authenticates
a request nor reaches an application.

There is **no compensating control on that port today**. The host firewall
template accepts the edge HTTP and HTTPS ports unconditionally — it carries no
`ct count` and no `limit rate` clause — and fail2ban, which acts on log
evidence after the fact, is the only per-source brake on the box. A per-source
connection limit in the firewall is the *intended* control and is an operator
item, not something this release ships. Until it exists this paragraph records
an **accepted exposure**, and it names no control as proven.

## The release tree

A release is a directory checked out at its tag, carrying:

| Artefact | Contract |
|---|---|
| `release.json` | `{tag, overlap, migrations, distManifestDigest}`; the digest is `"sha256:" + 64 lowercase hex` of the manifest bytes as read — the bare hex form is rejected at both ends |
| `docker-compose.pins.yml` | every first-party service `build: !reset null` plus `image: …@sha256:` |
| `docker-compose.app.yml` | the colour project's app-tier services |
| `pnpm-lock.yaml` | the assembled lockfile, committed next to the pins, so `--frozen-lockfile` holds inside the image build |

`gremion-migrate` is a separate first-party image, pinned like the others.
`gremion-deploy` checks the release out with `git clone --depth 1 --branch
<tag>` of the whole repository, so `docs/` travels with a release and
`gremion-verify` reads the signed waiver ledger out of `current/docs/ops/`
rather than carrying a copy of it.

## Deploy, switch, rollback

`gremion-deploy` renders the env files, pulls the pinned images, runs the
migrate job, brings up the inactive colour and verifies it through the loopback
`internaltest` entrypoint. `gremion-switch <colour>` moves the edge switch file
and requires a `204` from every evicting process. `gremion-rollback` redeploys
`previous-tag`. `runtime/active-colour` and `runtime/previous-tag` are the
record of each transition.

## Verification

`gremion-verify` asserts against the **running** system: Traefik's API for the
router graph, the certificate the edge actually presents, real HTTP requests
through the edge, and `docker inspect` / `docker exec` for the containers
behind it. It writes `runtime/last-verify.json`. It also prints the six P4
waivers of `docs/ops/release-1-waivers.md` as `WAIVED`, never as `OK`: release 1
is a deployment bar, not the go-live gate of `docs/ops/go-live-gate.md`.

## What this document is not

It is not a host build runbook (`docs/ops/host-tooling.md`), not the go-live
gate (`docs/ops/go-live-gate.md`), and not a deployment's own address plan —
that belongs in that deployment's private annex and never here.

## `/healthz` and the boot-and-resolve exemption

Every web app answers `GET /healthz` with `200`. `gremion-ui` returns
`{"ok":true,"tenant":<slug|null>,"colour":"<COLOUR>"}`, keys in that order;
`gremion-public` returns `{"ok":true,"app":"gremion-public"}` at
`${PUBLIC_BASE_PATH}/healthz`, because the portal's base path is baked in at
build time. `COLOUR` is read once at start-up and is empty until the colour
projects set it. The container healthchecks and the four `healthCheck` blocks of
the switch file probe these paths; `gremion-switch` substitutes
`PUBLIC_BASE_PATH` from `state.env` into the `public` and `public-next` probes.

The `gremion-ui` marker needs no host header, no proxy-trust header and no tenant
row. That is possible because `/healthz` is on a **closed** list,
`BOOT_AND_RESOLVE_EXEMPT_PATHS` (`gremion-ui/src/lib/server/boot-exempt.ts`),
which is exactly `['/healthz', '/api/internal/']`; a test pins it by value, so a
third entry is a reviewed change, not a drive-by. A request on that list that
names no tenant is handed on by the tenant resolver without a lookup, skips
Auth.js and the session guard, and is answered while the process boots:

- `/healthz` always.
- `/api/internal/…` only when the request names no tenant (no
  `x-forwarded-host`, no `x-tenant-id`), e.g. the switch's evict fan-out on the
  container network. A leaf callback or an internal hop that names a tenant is
  resolved and gated as before — resolver, boot 503, session, Bearer,
  iss-match and module gates — and the edge always stamps `x-forwarded-host`,
  so nothing arriving through Traefik takes the exemption. Every endpoint that
  can serve a path under `/api/internal/` (route groups and params included)
  must call `isInternalTrustRequest` or `constantTimeEqual`, and no page or
  layout may serve one; a static test fails the build otherwise. It is a
  tripwire, not a proof: each such handler still needs review.

Two properties are accepted and deliberate:

- **Liveness, not readiness.** A process that is still booting, or whose boot
  failed, also answers `200` on `/healthz`. `/api/health` stays the boot probe
  (`200` only once boot completed). Anything that must not route to a
  half-booted colour — the switch gate — has to read `/api/health` as well.
- **Slug disclosure.** Anyone who can reach `/healthz` can ask whether a host is
  a registered tenant and learn its slug. The lookup goes through the registry's
  cached host resolution, misses are remembered for the cache lifetime (errors
  and lookups slower than 2 s for 5 s, answering `null`), and concurrent probes
  of one host share one lookup, so repeated probes of a host do not cost one
  database query each. A never-seen host costs one lookup, as it does on the
  tenant resolver.

## Boot determinism

`gremion-ui` does not need Postgres to be up before it starts. Boot first waits
for the control database on an exponential ladder: 500 ms, doubling, never more
than 30 s per wait, each wait jittered into 50–100 % of its step. Every wait is
logged as `[boot] database not ready (attempt n/60): <error>; backoff=<step>ms
[(capped)] wait=<ms>`. While it waits, `/healthz` answers and every other route
answers `503` with `Retry-After: 5`.

What happens when boot fails depends on the failure:

- **Transient** (the database went away mid-boot): the attempt is dropped and one
  re-attempt is scheduled 5 s later; the process heals without a restart. The
  tenth consecutive transient failure is treated as non-transient, so a
  database that answers but keeps failing boot cannot keep the process in a
  healthy-looking `503` state forever.
- **Non-transient** (wrong credentials, a schema fault, or the 60-attempt budget
  running out, roughly 14–27 minutes): boot logs the cause and exits with status
  1, and `restart: unless-stopped` starts a fresh container. A wrong database
  password therefore shows up as a rising restart count, not as a container that
  stays up serving `503`.
