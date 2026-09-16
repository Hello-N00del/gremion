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
a request nor reaches an application, and the compensating control is the host
firewall's per-source connection limit on the edge HTTP port. This is recorded
here as an **accepted exposure**, not as a control that has been proven.

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
