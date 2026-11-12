# Runbook — Tenant edge (per-host ingress + whole-host tenant routing)

How a tenant's hosts reach the governance kernel, and the operator steps to
turn them on. Every served host is a row in the control DB's `tenant_domain`
table and a `Host(...)`-literal edge router; there is no wildcard router and no
default tenant on the apex (TASK-041; TRD-074/075).

This is the operational layer; for the
multi-tenancy design, the control-plane registry, and the fail-closed tenant
model see [about-gremion.md](../about-gremion.md).

Throughout, `example.org` is a placeholder — substitute your own apex domain.
The admin shell app is **`gremion-ui`** and the public portal **`gremion-public`**;
both names appear in the compose files and Traefik router labels below.

## Topology

```
browser ──TLS──> traefik:443 (the host's edge address) ──> routers
                                                           ├─ gremion-ui   (one router file per tenant host, on the active colour)
                                                           └─ keycloak   (/auth path routers on the apex; the realm paths on a customer host)
```

- **The public portal has no public router in this tree today.** `active.yml`
  defines the `public` and `public-next` services for `gremion-public`, and the
  only router that uses one of them is the loopback-only `test-public` router of
  the inactive colour (`infra/host/templates/edge/active.yml.tmpl`). Neither the
  compose labels nor the per-tenant router files route a public host to the
  portal.

- **Traefik is the sole ingress** and runs only in the `production` profile
  (`docker-compose.yml`, `profiles: [production]`). In local dev there is no
  Traefik — services are reached on direct host ports. It belongs to the state
  project together with `docker-socket-proxy`, `pgbouncer` and the `fallback`
  "starting" page (`docker-compose.prod.yml`); `gremion-ui` and `gremion-public`
  are the app project's, one project per colour, reached only through
  `etc/edge/active.yml` and the per-tenant router files
  ([deployment-architecture.md](../deployment-architecture.md)). There is no
  `cloudflared` service and no tunnel: `docker-compose.prod.yml` records it as
  removed.
- **TLS.** Traefik obtains its certificates itself from an ACME CA over HTTP-01
  through the `le-http` resolver (`docker/traefik/traefik.yml`); the host
  publishes `:80` and `:443` on its edge address and requests arrive directly.
  Every router names its resolver itself (`certResolver` in each rendered router
  file; a router with a bare `tls` serves Traefik's self-signed default), so
  there is no wildcard certificate, no origin certificate
  (`docker/traefik/dynamic/tls.yml` and the Cloudflare Origin mounts are gone)
  and no per-tenant certificate step. Details and checks:
  [deployment.md](../deployment.md#the-edge-traefik--acme).
- **DNS.** A tenant host is an ordinary `A`/`AAAA` record at the registrar,
  published by hand at the host's edge address; the zone wildcard is deliberately
  absent. `gremion-dns-check` reads what is published (edit 2 covers the tenant
  hosts), and the create request's `domain_bound` step runs a DNS pre-flight
  against the edge address.

## How a tenant host resolves to a tenant

Tenant selection is performed in `gremion-ui` by the resolver
(`gremion-ui/src/lib/server/tenant/resolve.ts`), which runs as element 0 of the
handle sequence — before auth:

1. **The WHOLE edge-forwarded host is the key.** The resolver normalises the
   trusted `X-Forwarded-Host` (`normaliseHost` in `tenant/host.ts`: lowercase,
   one trailing dot and a numeric port stripped, ASCII LDH only) and looks it up
   in `tenant_domain`, whose `host` is the PRIMARY KEY. `acme.example.org` is
   looked up as `acme.example.org`, never as a slug `acme`. The raw `Host`
   header is **never** a selector.
2. **Fail-closed.** An absent, multi-value or malformed header, a host bound to
   no tenant, and a host of a provisioning/deleting/deleted tenant all return
   **404**; a *suspended* tenant returns a branded 503 page; the control DB being
   unreachable returns 503. There is no default tenant: the apex binds no host
   (TRD-075), so `https://example.org` 404s until a tenant binds it.
3. **Host cross-check.** On an edge request (proxy-trust secret set, STEP 0c),
   the `Host` the router matched must normalise to the same host as
   `X-Forwarded-Host`; a mismatch is a 404 before any lookup. The check only
   rejects — it never selects.
4. **Every host-path 404 is logged** as one JSON line
   `{"level":"warn","msg":"tenant.host.rejected","ts":"<RFC 3339>","host":"…","reason":"unparseable|unbound|inactive|forged"}`
   (TRD-076). Repeats of one `(reason, host)` within 60 s are folded into the
   next line's `suppressed` count, and a process writes at most 60 such lines a
   minute, then one `tenant.host.rejected.flood` line with `dropped`.

The trust model is documented inline in `resolve.ts`: the forwarded host is
authoritative **only** because Traefik is the sole ingress and the app port is
never externally bound. The executable proxy-trust gate (STEP 0c below) and the
host cross-check make this enforceable rather than topology-only.

## Operator steps

> On a distribution host, run `docker compose` only as
> `docker compose --env-file /opt/gremion/etc/env/<project>.env <cmd>` from the
> release tree (`state` for Traefik, Keycloak and the databases; `app-blue` /
> `app-green` for the app colours). The env file carries `COMPOSE_FILE`, the
> project name and the profiles, so no `-f`, `-p` or `--profile` is passed
> ([docs/ops/runbook/README.md](../ops/runbook/README.md)). Use
> `up -d --force-recreate <svc>` (never plain `restart`) whenever an env value
> changes — a restart does **not** re-read the env file.

### ⛔ STEP 0a — bind every host you serve (no wildcard)

A host reaches a tenant only when BOTH exist:

- a `tenant_domain` row binding it to the tenant (written only by the registry
  call `addTenantDomain`), and
- a `Host(...)`-literal Traefik router for exactly that host, pinning
  `X-Forwarded-Host` to that host FIRST and then chaining `edge-hsts-custom`,
  `edge-ratelimit-app`, the tenant's per-IP cap and `gremion-ui-proxytrust`
  (rendered per customer host by the edge router emitter, TASK-034; the
  `edge-*` middlewares are labels on the production traefik service since
  TASK-043c, without them Traefik disables the router and the host answers
  404; the customer's Keycloak router carries the same chain minus
  `gremion-ui-proxytrust`).

> **A customer's host is bound by the create request (TASK-043, run by the executor), and by
> nothing else.** The resolver selects by the whole bound host only
> (TASK-041); the apex binds no tenant (TRD-075) and the old wildcard and apex
> default-tenant routes are gone. `create` writes the ONE primary
> `tenant_domain` row through `addTenantDomain` in its container phase A
> (reserved-host refusal, owner pre-read and cache-eviction notice in one
> transaction), checks the host's DNS against the edge (`domain_bound`), and
> after phase B writes the customer's router file
> `etc/edge/tenant-<slug>.yml` from the host. Do not hand-insert
> `tenant_domain` rows: a raw `INSERT` skips all three guards.

The compose files carry only apex routers (`keycloak`, `keycloak-admin`,
`fallback`, plus the pilot services' `matrix` and `livekit`), each literal on
`${PLATFORM_DOMAIN}`; the `gremion-ui` routers left with the app tier
(TASK-040). A request for any other host gets Traefik's own no-router 404
(visible in Traefik's access log with an empty router name). `make lint-edge-host`
(`scripts/check-edge-host-model.mjs`) fails the tree if a `HostRegexp` leg, the
old wildcard env key, the apex default-tenant injection or the leftmost-label
resolver comes back.

Verify the rendered apex routers (read-only — never `up`):

```bash
docker compose --env-file /opt/gremion/etc/env/state.env config \
  | grep -E 'routers\.(keycloak|keycloak-admin|fallback)\.rule'
# PASS: every rule is Host(`example.org`) literal (keycloak adds its path prefixes)
# FAIL: any HostRegexp(...) leg
```

### ⛔ STEP 0b — `INTERNAL_BASE_URL` must be the in-container origin (tenant isolation, LOAD-BEARING)

`internalFetch` (`gremion-ui/src/lib/server/internal-fetch.ts`) makes a fresh
server-to-server HTTP hop for same-app `/api/` calls (e.g. a governance
protocol-publish step calling another internal route). On that hop it re-stamps
the **current tenant's registered primary host** (`ctx.primaryHost`, the
`tenant_domain` row with `is_primary`, normalised; never a synthesised
slug-dot-apex string) as `X-Forwarded-Host` so the resolver re-selects the SAME
tenant, plus a constant-time-validated `x-internal-host-trust` secret. A tenant
with no primary host gets neither header, and the inner call 404s. `resolveInternalBaseUrl()` picks the hop's base
origin: **`INTERNAL_BASE_URL` if set, else it falls through to
`PUBLIC_BASE_URL` = the public apex `https://${DOMAIN}`.**

**The apex fallback is a tenant-isolation hazard.** A hop to the public apex
re-enters Traefik, and the edge — not the sender — then decides what
`X-Forwarded-Host` says. Historically the apex router's host-injection
middleware overwrote the stamped host with the default tenant's, so the inner
call (a *write* on a governance write path) executed against the **default
tenant's data plane**. That middleware is gone (TASK-041), but the header is now
the ENTIRE tenant selector, so the inner hop must still never meet an edge that
could restate it.

**`INTERNAL_BASE_URL=http://gremion-ui-<colour>:3000`** (set on the `gremion-ui`
service in `docker-compose.app.yml`, derived from `COLOUR` and never read from an
env file) points the hop at this colour's own container directly — it never
traverses Traefik, so the stamped primary host survives and the resolver
re-selects the correct tenant. **Leave it as it is; do NOT point it at the public
apex.** Verify (read-only — never `up`):

```bash
docker compose --env-file /opt/gremion/etc/env/app-blue.env config \
  | grep 'INTERNAL_BASE_URL'
# PASS: INTERNAL_BASE_URL: http://gremion-ui-blue:3000   (an in-container origin)
# FAIL: absent (falls through to the public apex) OR https://example.org
```

### ⛔ STEP 0c — set `TENANT_PROXY_SHARED_SECRET` to make proxy-trust enforceable

By default tenant selection trusts the edge-injected `x-forwarded-host` on
topology alone. The executable proxy-trust gate
(`isProxyTrusted` in `resolve.ts`) hardens this: when
`TENANT_PROXY_SHARED_SECRET` is set, Traefik's `gremion-ui-proxytrust` middleware
stamps `x-proxy-trust: <secret>` on **every** edge request reaching gremion-ui
(applied to the apex router and to every per-host router), and the resolver 403s any
request whose `x-proxy-trust` does not constant-time-match — *before* any
registry lookup. An `internalFetch` hop never traverses the edge, so its
`x-internal-host-trust` secret (STEP 0b) satisfies the gate as an OR.

The gate is **fail-open only while the secret is unset** (a byte-identical
no-op). The app env line (`app-<colour>.env`, read by `docker-compose.app.yml`)
and the Traefik label (`state.env`, read by `docker-compose.prod.yml`) both
interpolate `TENANT_PROXY_SHARED_SECRET` — set them to the same value together,
or the middleware stamps a header the app never checks. Once set, the gate is
fail-closed (absent/mismatched header → 403). The `kernel-api` service refuses
to start without it, so a host that runs the app project has it set.

### ⛔ STEP 0d — materialize a tenant's stored config BEFORE the recreate

The kernel ships **no** institution-identity defaults in source — `config.ts`
does not back-fill any brand block. The brand-identity readiness guard
therefore **refuses to boot a tenant whose stored `config.json` lacks a complete
brand block** (a loud, tenant-scoped 503). A create request writes the brand
identity into the tenant's config; a tenant whose config predates that needs it
baked in before a recreate brings the new colour up. Bake the fully-merged
effective config back to the tenant's stored `config.json`:

```bash
# <slug> is required. Add --config <path> to point at a specific file.
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts materialize-config <slug>
```

The command merges current defaults into the stored config, enforces the
brand-identity guard, and writes the complete config back atomically. **If the
stored config has a blank/missing brand it exits non-zero and writes nothing** —
fix the brand (Settings) and re-run before deploying.

### 1. Publish the host's DNS records

At the registrar, add an `A` (and `AAAA`) record for the tenant host that points
at the host's edge address (`EDGE_BIND_IP` / `EDGE_BIND_IP6` in `state.env`). A
customer's own domain (not under `example.org`) needs its own record. There is
no wildcard record and no tunnel hostname: which hosts reach a tenant is decided
by the per-host routers and `tenant_domain` rows of STEP 0a. Check what is
published:

```bash
gremion-dns-check --domain example.org --edge-ip <EDGE_BIND_IP> --edge-ip6 <EDGE_BIND_IP6> \
  --mail-ip <mail address> --tenant-hosts <file, one host per line> --edit 2
```

### 2. Let the edge issue the certificate

Nothing to configure per tenant. The router file written by the create request
names the `le-http` resolver, so Traefik requests a certificate for the host over
HTTP-01 when it loads that file (`:80` must reach Traefik, which is why the `web`
entrypoint never captures `/.well-known/acme-challenge/`, and the host's DNS
record must already resolve to the edge address). Rehearse against the ACME staging directory
first (`ACME_CA_SERVER`, [deployment.md](../deployment.md#the-edge-traefik--acme)).

### 3. Create the control-plane DB on an existing volume (one-shot)

Postgres `initdb` hooks do **not** re-run on an existing data volume, so the
`control` database (tenant registry + fleet-migration ledger,
`gremion-ui/migrations-control/`) added to `docker/postgres/init-databases.sh`
must be created once by hand on an upgraded host. The `CONTROL_DB_*` env keys
must already be on the `postgres` container (`state.env`) and
`CONTROL_DATABASE_URL` on the app colour — so recreate `postgres` and the app
colour FIRST, then re-run the bind-mounted init script (idempotent by
construction — every statement is create-if-missing / grant):

```bash
docker compose --env-file /opt/gremion/etc/env/state.env \
  exec postgres bash /docker-entrypoint-initdb.d/init-databases.sh
```

Verify: `… exec postgres psql -U "$POSTGRES_USER" -l` lists `control` owned by
`control`. Do not improvise grants — the script is the single source of the SQL.
(On a fresh volume the script runs automatically and this step is unnecessary.)

### 4. Create the tenant-secrets host dir BEFORE the recreate

```bash
mkdir -p secrets/tenants     # a host sets TENANT_SECRETS_DIR=/opt/gremion/etc/secrets/tenants (bootstrap.sh creates it)
```

The gremion-ui service carries a read-only bind mount
`${TENANT_SECRETS_DIR:-./secrets/tenants} → /run/secrets/tenants`. Bind mounts
are live, so a new per-tenant secret written by the provisioner appears in the
running container without a compose edit. If the host dir is missing at `up`
time, Docker creates it root-owned — create it first. (`pnpm -C gremion-ui check`
runs `scripts/check-tenant-secrets-dir.mjs` as a guard.)

### 5. Verify

Use a host that is actually **bound** to a provisioned tenant (substitute a real
bound host for `acme.example.org`):

```bash
# Follow redirects + show the final URL so the PASS signal is UNAMBIGUOUS.
curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://acme.example.org
# PASS: the APP answered — e.g. a redirect to .../auth/login?callbackUrl=...
#   (the Auth.js login flow) OR a 200 carrying a gremion-ui/tenant marker.

# An unbound host is refused, with no tenant content and no default tenant:
curl -sI https://not-bound.example.org
#   PASS: 404 (Traefik no-router, or the app's 404 plus one
#   tenant.host.rejected line in the gremion-ui log).
```

Per-host Keycloak routing for a customer's primary host (its issuer host,
`https://<host>/auth/realms/<slug>`) is in the customer's router file, not in
the compose files: `tenant-<slug>.kc` routes `/auth/realms/<slug>/` and
`/auth/resources/` on that host to `keycloak@docker`, with the host's own pin
first (TASK-043 Q16). The dot in the name is deliberate: no slug can spell it,
so it never collides with customer `<slug>-kc`'s host router. Never
`/auth/admin`, never another realm (the render refuses `master`, `platform`
and any realm but the slug): the admin console stays on the apex behind its
allowlist. That file is written by the executor's create handler (render-router);
`syncTenantRouters` does not co-manage it and refuses to rewrite or prune a
file that carries the realm router.

> **A bare Traefik 404 (no `Location`, no app/login redirect, no gremion-ui
> marker) is a FALSE GREEN for a host you expected to serve.** Always follow
> redirects / inspect the body.

**Troubleshooting an unexpected response — check in this order:**

1. **Traefik no-router 404 = no router for that host (STEP 0a, first
   suspect).** A bare 404 with no `Location`/app body means no `Host(...)`
   router matched: the host has no rendered per-host router.
2. **App 404 with a `tenant.host.rejected` line** in the gremion-ui log: its
   `reason` says why — `unbound` (no `tenant_domain` row: bind it), `inactive`
   (the tenant is provisioning/deleting/deleted), `forged` (the `Host` and
   `X-Forwarded-Host` disagreed: check the router's host pin), `unparseable`
   (a malformed or absent forwarded host).
3. **403 Forbidden** = the proxy-trust gate (STEP 0c) rejected the request —
   the app has `TENANT_PROXY_SHARED_SECRET` set but the Traefik
   `gremion-ui-proxytrust` middleware is not stamping a matching `x-proxy-trust`
   (the env var and the label must hold the same value).
4. **Edge 5xx** = the colour behind `active.yml` is not answering `/healthz`
   (Traefik's service health check removes it), or the `fallback` "starting"
   page is being served; read `gremion-verify`.
5. **NXDOMAIN, or the default certificate** = the DNS record is missing (step 1),
   or the router names no certificate resolver (step 2; `gremion-verify` turns the
   latter red).
