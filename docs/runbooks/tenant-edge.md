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
browser ──TLS──> CDN / tunnel edge ──https──> traefik:443 ──> app routers
                                                              ├─ gremion-ui   (apex + one router per tenant host)
                                                              ├─ keycloak   (/auth path routers)
                                                              └─ gremion-public (public.example.org)
```

- **Traefik is the sole ingress** and runs only in the `production` profile
  (`docker-compose.yml`, `profiles: [production]`). In local dev there is no
  Traefik — services are reached on direct host ports. The governance-only
  default stack is seven services (postgres, keycloak, gremion-ui, gremion-public,
  legal, vector, mailpit); the `production` profile adds **traefik** and
  **docker-socket-proxy**, and `docker-compose.prod.yml` additionally brings up
  **pgbouncer**, the **fallback** "starting" page, and a **cloudflared** tunnel
  connector.
- **Origin TLS.** Traefik serves a certificate via its file provider
  (`docker/traefik/dynamic/tls.yml`); cert/key are mounted from
  `secrets/cf-origin.pem` / `secrets/cf-origin.key` on the `traefik` service.
  Use a wildcard certificate (SAN covering `example.org` and `*.example.org`) so
  every tenant host terminates on the same cert with no per-tenant ACME work —
  the edge routers stay bare `tls=true` (no certresolver).
- **The edge connector** (`cloudflared` in `docker-compose.prod.yml`) runs
  `tunnel --no-autoupdate run`, reads `TUNNEL_TOKEN` from the environment
  (`CF_TUNNEL_TOKEN` in `.env`), and dials out to the CDN edge — no inbound
  ports are opened on the host. Public-hostname → `https://traefik:443` routing
  lives in the tunnel provider's dashboard, not in this repo. The repo ships
  only `docker/cloudflared/origin-ca-root.pem` (the origin CA the connector uses
  to verify Traefik's cert), mounted read-only at
  `/etc/cloudflared/origin-ca.pem`.

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

> Run these against the **production** composition:
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile production <cmd>
> ```
> Use `up -d --force-recreate <svc>` (never plain `restart`) whenever an env var
> changes — a restart does **not** reload `.env`.

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

The compose files carry only the apex routers (`gremion-ui`, `keycloak`,
`keycloak-admin`, `fallback`), each literal on `${DOMAIN}`. A request for any
other host gets Traefik's own no-router 404 (visible in Traefik's access log
with an empty router name). `make lint-edge-host`
(`scripts/check-edge-host-model.mjs`) fails the tree if a `HostRegexp` leg, the
old wildcard env key, the apex default-tenant injection or the leftmost-label
resolver comes back.

Verify the rendered apex routers (read-only — never `up`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile production config \
  | grep -E 'routers\.(gremion-ui|keycloak|keycloak-admin|fallback)\.rule'
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

**`INTERNAL_BASE_URL=http://gremion-ui:3000`** (set on the gremion-ui service in
`docker-compose.yml`, inherited by prod) points the hop at the in-container
service origin directly — it never traverses Traefik, so the stamped primary
host survives and the resolver re-selects the correct tenant. **Leave it set; do NOT point it at the public apex.** Verify
(read-only — never `up`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile production config \
  | grep -A1 'INTERNAL_BASE_URL'
# PASS: INTERNAL_BASE_URL: http://gremion-ui:3000   (an in-container origin)
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
no-op). The app env line and the Traefik label both interpolate the same
`.env` var — set them together, or the middleware stamps a header the app never
checks. Once set, the gate is fail-closed (absent/mismatched header → 403).

### ⛔ STEP 0d — materialize the default tenant's stored config BEFORE the recreate

The kernel ships **no** institution-identity defaults in source — `config.ts`
does not back-fill any brand block. The brand-identity readiness guard
therefore **refuses to boot a tenant whose stored `config.json` lacks a complete
brand block** (a loud, tenant-scoped 503). Before a recreate brings gremion-ui up,
bake the fully-merged effective config back to each tenant's stored
`config.json`:

```bash
# Against the default tenant's live config.json (CONFIG_PATH). Add <slug> for a
# non-default tenant, or --config <path> to point at a specific file.
pnpm -C gremion-ui exec tsx scripts/tenant-provision.mjs materialize-config
```

The command merges current defaults into the stored config, enforces the
brand-identity guard, and writes the complete config back atomically. **If the
stored config has a blank/missing brand it exits non-zero and writes nothing** —
fix the brand (Setup wizard / Settings) and re-run before deploying.

### 1. Add the wildcard public hostname on the tunnel

A wildcard tunnel hostname only carries `*.example.org` traffic to Traefik. It
serves nothing by itself: which hosts reach a tenant is decided by the
per-host routers and `tenant_domain` rows of STEP 0a. A customer's own domain
(not under `example.org`) needs its own literal public hostname.

In the tunnel provider's dashboard, add a public hostname for the tunnel:

- Subdomain: `*` — Domain: `example.org` (i.e. `*.example.org`)
- Service: **HTTPS** → `traefik:443`
- TLS → **Origin Server Name:** `example.org`; **CA Pool:**
  `/etc/cloudflared/origin-ca.pem` (the mounted origin CA root)

Mirror these TLS settings on the apex (`example.org`) and the public-portal
(`public.example.org`) hostnames.

### 2. Add the wildcard DNS record manually

Some tunnel dashboards auto-create DNS for **literal** hostnames but not for
wildcard public hostnames. Add a `CNAME` record manually in the DNS zone:

- Type: `CNAME` — Name: `*`
- Target: `<TUNNEL_ID>.cfargotunnel.com` (the tunnel UUID; same target as the
  apex record)
- Proxy status: **Proxied** (required — `cfargotunnel.com` is not directly
  reachable)

### 3. Create the control-plane DB on an existing volume (one-shot)

Postgres `initdb` hooks do **not** re-run on an existing data volume, so the
`control` database (tenant registry + fleet-migration ledger,
`gremion-ui/migrations-control/`) added to `docker/postgres/init-databases.sh`
must be created once by hand on an upgraded host. The `CONTROL_DB_*` env keys
and `CONTROL_DATABASE_URL` must already be on the containers — so recreate
postgres + gremion-ui FIRST, then re-run the bind-mounted init script (idempotent
by construction — every statement is create-if-missing / grant):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile production exec postgres \
  bash /docker-entrypoint-initdb.d/init-databases.sh
```

Verify: `… exec postgres psql -U "$POSTGRES_USER" -l` lists `control` owned by
`control`. Do not improvise grants — the script is the single source of the SQL.
(On a fresh volume the script runs automatically and this step is unnecessary.)

### 4. Create the tenant-secrets host dir BEFORE the recreate

```bash
mkdir -p secrets/tenants
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
4. **Edge 5xx (e.g. 530)** = the tunnel rejected/missed the hostname (step 1).
5. **NXDOMAIN** = the DNS record is missing (step 2).

## Residual risk + fallback

**Wildcard public hostnames on a tunnel may be gated by account/plan.** If the
dashboard rejects `*.example.org` in step 1, the fallback is to **enumerate
per-tenant hostnames at provisioning time**: for each new tenant add a literal
public hostname `<slug>.example.org` → `https://traefik:443` (same Origin Server
Name + CA pool as step 1); dashboards typically auto-create DNS for literal
hostnames. This becomes a documented manual step in the tenant-provisioning
runbook ([tenant-lifecycle.md](./tenant-lifecycle.md)); it is deliberately not
automated (no tunnel-provider API token in this stack). The wildcard DNS record
from step 2 is harmless to keep in either case.