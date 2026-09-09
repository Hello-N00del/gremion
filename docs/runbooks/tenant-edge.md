# Runbook — Tenant edge (wildcard ingress + per-tenant host routing)

How tenant subdomains (`<slug>.<your-domain>`) reach the governance kernel, and
the operator steps to turn them on. This is the operational layer; for the
multi-tenancy design, the control-plane registry, and the fail-closed tenant
model see [about-gremion.md](../about-gremion.md).

Throughout, `example.org` is a placeholder — substitute your own apex domain.
The admin shell app is **`gremion-ui`** and the public portal **`gremion-public`**;
both names appear in the compose files and Traefik router labels below.

## Topology

```
browser ──TLS──> CDN / tunnel edge ──https──> traefik:443 ──> app routers
                                                              ├─ gremion-ui   (apex + tenant subdomains)
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

1. **Slug = leftmost DNS label of the edge-forwarded host.**
   `extractLeftmostLabel(x-forwarded-host)` splits the trusted
   `X-Forwarded-Host` value. `acme.example.org` → slug `acme`. The raw `Host`
   header is **never** read — it is attacker-controllable.
2. **Fail-closed.** A 2-label apex, a single label, an empty/multi-value list,
   or any empty label resolves to `null` → **404**. There is no silent default
   to a "first" tenant. An unknown/deleted slug → 404; a *suspended* tenant → a
   branded 503 page; the control DB being unreachable → 503.
3. **Apex → default tenant.** The apex host (`example.org`, two labels) would
   otherwise 404. A dedicated apex router (`gremion-ui-apex`, priority 20) prepends
   the `gremion-ui-apexhost` middleware, which sets
   `X-Forwarded-Host: default.${DOMAIN}` so the resolver reads slug `default`.

The trust model is documented inline in `resolve.ts`: the forwarded host is
authoritative **only** because Traefik is the sole ingress and the app port is
never externally bound. The executable proxy-trust gate (STEP 0c below) makes
this enforceable rather than topology-only.

## Operator steps

> Run these against the **production** composition:
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile production <cmd>
> ```
> Use `up -d --force-recreate <svc>` (never plain `restart`) whenever an env var
> changes — a restart does **not** reload `.env`.

### ⛔ STEP 0a — set `DOMAIN_REGEX` in `.env` BEFORE the recreate (LOAD-BEARING)

The tenant-subdomain wildcard routers (`docker-compose.prod.yml`: `gremion-ui`,
`keycloak`, `keycloak-admin`, `fallback`) each carry a leg
``HostRegexp(`^[a-z0-9-]+\.${DOMAIN_REGEX:-}$`)``. **`DOMAIN_REGEX` is
load-bearing and defaults EMPTY.** If it is unset when the stack is recreated,
every wildcard leg collapses to the dead pattern ``^[a-z0-9-]+\.$``, which
matches **NO** real tenant host — so **every `<slug>.${DOMAIN}` subdomain 404s
at Traefik** while the apex/default host keeps working and masks the omission.
This is a silent misconfig, not a safe fail-closed.

Set `DOMAIN_REGEX` to the **regexp-escaped** `DOMAIN` (Traefik v3 `HostRegexp`
takes a Go regexp, so every literal dot must be backslash-escaped):

```
# .env — next to DOMAIN. Escape every literal dot.
DOMAIN=example.org
DOMAIN_REGEX=example\.org
```

Verify the rendered routers embed the escaped domain (read-only — never `up`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile production config \
  | grep -E 'routers\.(gremion-ui|keycloak|keycloak-admin|fallback)\.rule'
# PASS: each HostRegexp embeds the escaped domain, e.g.
#   HostRegexp(`^[a-z0-9-]+\.example\.org$`)
# FAIL (DOMAIN_REGEX unset/empty): the collapsed dead pattern
#   HostRegexp(`^[a-z0-9-]+\.$`)   <-- matches nothing; tenant subdomains 404
```

This is also enforced automatically: `pnpm -C gremion-ui check` runs
`scripts/check-domain-regex.mjs`, which fails the build if a real production
`DOMAIN` is configured with an empty `DOMAIN_REGEX`. (`DOMAIN=localhost` for
local dev does not use wildcard routing, so `DOMAIN_REGEX` may stay unset.)

### ⛔ STEP 0b — `INTERNAL_BASE_URL` must be the in-container origin (tenant isolation, LOAD-BEARING)

`internalFetch` (`gremion-ui/src/lib/server/internal-fetch.ts`) makes a fresh
server-to-server HTTP hop for same-app `/api/` calls (e.g. a governance
protocol-publish step calling another internal route). On that hop it re-stamps
the **current tenant's** `X-Forwarded-Host: <slug>.<apex>` so the resolver
re-selects the SAME tenant, plus a constant-time-validated
`x-internal-host-trust` secret. `resolveInternalBaseUrl()` picks the hop's base
origin: **`INTERNAL_BASE_URL` if set, else it falls through to
`PUBLIC_BASE_URL` = the public apex `https://${DOMAIN}`.**

**The apex fallback is a tenant-isolation hole.** A hop to the public apex
re-enters Traefik and matches the apex router (`gremion-ui-apex`, priority 20),
whose `gremion-ui-apexhost` middleware **unconditionally** sets
`X-Forwarded-Host=default.${DOMAIN}` — overwriting the `<slug>.<apex>` the hop
stamped. The resolver then reads `default`, and the inner call (a *write* on a
governance write path) executes against the **default tenant's data plane**:
cross-tenant read+write. Harmless while only one tenant exists; activates the
instant a second tenant is provisioned.

**`INTERNAL_BASE_URL=http://gremion-ui:3000`** (set on the gremion-ui service in
`docker-compose.yml`, inherited by prod) points the hop at the in-container
service origin directly — it never traverses Traefik or the apexhost middleware,
so the stamped `<slug>.<apex>` survives and the resolver re-selects the correct
tenant. **Leave it set; do NOT point it at the public apex.** Verify
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
(applied to both the apex and wildcard routers), and the resolver 403s any
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

Use a slug that is actually **provisioned** (substitute a real slug for `acme`):

```bash
# Follow redirects + show the final URL so the PASS signal is UNAMBIGUOUS.
curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://acme.example.org
# PASS: the APP answered — e.g. a redirect to .../auth/login?callbackUrl=...
#   (the Auth.js login flow) OR a 200 carrying a gremion-ui/tenant marker.

# The tenant's Keycloak issuer is reachable on the same host (KC path routers
# are realm-agnostic, so the wildcard leg routes /auth too):
curl -sI https://acme.example.org/auth/realms/<tenant-realm>/.well-known/openid-configuration
#   PASS: 200 — NOT a bare 404.

# The apex still answers as the default tenant:
curl -sI https://example.org
#   PASS: e.g. 302 -> /auth/login; any 5xx/530 here is a regression.
```

> **A bare Traefik 404 (no `Location`, no app/login redirect, no gremion-ui
> marker) is a FALSE GREEN.** It is indistinguishable from a healthy
> unprovisioned-tenant response by the status line alone — always follow
> redirects / inspect the body.

**Troubleshooting an unexpected response — check in this order:**

1. **Traefik no-router 404 = `DOMAIN_REGEX` unset/empty (STEP 0a, first
   suspect).** A bare 404 with no `Location`/app body means no router matched
   because the wildcard leg collapsed to ``^[a-z0-9-]+\.$``. Confirm with the
   STEP 0a render command, set `DOMAIN_REGEX`, recreate, re-test.
2. **403 Forbidden** = the proxy-trust gate (STEP 0c) rejected the request —
   the app has `TENANT_PROXY_SHARED_SECRET` set but the Traefik
   `gremion-ui-proxytrust` middleware is not stamping a matching `x-proxy-trust`
   (the env var and the label must hold the same value).
3. **Edge 5xx (e.g. 530)** = the tunnel rejected/missed the hostname (step 1).
4. **NXDOMAIN** = the wildcard DNS record is missing (step 2).
5. Only once the request demonstrably reaches gremion-ui (login redirect / app
   body): a fallback page or apex/default content under an unprovisioned slug is
   app-level routing (the resolver / readiness gate), not an edge problem.

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