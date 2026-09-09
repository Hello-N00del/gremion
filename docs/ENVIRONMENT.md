# Environment Variables Reference

Complete reference for the environment variables used by the Gremion governance
kernel. Copy `.env.example` to `.env` and configure these values for your
deployment.

This is the operational/technical layer. For the kernel's vision, architecture,
domain model, and governance charter, see [about-gremion.md](about-gremion.md).

> **Scope.** Gremion is the governance-only kernel. It ships exactly seven
> default services — `postgres`, `keycloak`, `gremion-ui`, `gremion-public`,
> `legal`, `vector`, `mailpit` — plus `traefik` + `docker-socket-proxy` (and,
> from `docker-compose.prod.yml`, `pgbouncer` + `cloudflared` + `fallback`) in
> the production profile. Feature modules (elections, newsletter, calendar,
> files, messages, board, users, finance, content, vault,
> handover) live in their own repositories — one per module — and are **not**
> part of the kernel, so none of their environment variables appear here.

> **Note on names.** The admin shell app is `gremion-ui` (SvelteKit / Auth.js)
> and the public portal app is `gremion-public`. These names appear throughout
> the compose files and variable values below.

## Important Security Notes

- **Never commit `.env` to version control** — it contains secrets.
- `.env` is listed in `.gitignore` for protection.
- The `CHANGE_ME_*` placeholders in `.env.example` are replaced with random
  secrets by `./scripts/setup.sh`.
- To generate a secret by hand: `openssl rand -hex 32` (or
  `openssl rand -base64 32`).
- Several values are RS256/JWT/OIDC secrets that are sed-substituted into
  `docker/keycloak/realm-export.json` at Keycloak boot by
  `docker/keycloak/substitute-realm-secrets.sh` — that script fails fast if any
  required value is empty.

---

## Domain & Tenancy

### DOMAIN

- **Type:** String (domain name)
- **Default:** `localhost`
- **Required:** Yes
- **Used by:** every service for URL routing and OIDC redirects.

```bash
# Local development
DOMAIN=localhost
# Production
DOMAIN=gremion.example.org
```

### DOMAIN_REGEX

- **Type:** String (Go regexp, with literal dots backslash-escaped)
- **Required in production** whenever `DOMAIN` is a real domain.
- **Used by:** the tenant wildcard edge routers in `docker-compose.prod.yml`
  (Traefik v3 `HostRegexp`).
- **Impact:** **Load-bearing.** If left unset/empty with a real `DOMAIN`, every
  wildcard router leg renders the dead pattern `^[a-z0-9-]+\.$`, which matches
  no tenant host — so all tenant subdomains 404 at Traefik while the apex still
  works and masks it. This is a silent misconfig, not a safe fail-closed.
  `pnpm -C gremion-ui check` (`scripts/check-domain-regex.mjs`) fails the build if
  a real prod `DOMAIN` is set with an empty `DOMAIN_REGEX`. Leave unset in dev
  (`DOMAIN=localhost` does not use wildcard routing).

```bash
# DOMAIN=gremion.example.org -> DOMAIN_REGEX=gremion\.example\.org
DOMAIN_REGEX=gremion\.example\.org
```

### TENANT_SECRETS_DIR

- **Type:** String (host path)
- **Default:** `./secrets/tenants`
- **Used by:** `gremion-ui`, bind-mounted read-only at `/run/secrets/tenants`.
  Per-tenant secret files written by the provisioner appear in the running
  container live, no recreate needed.
- **Impact:** Must be a **dedicated leaf directory** holding only per-tenant
  secret files. Never point it at the `secrets/` root (or any parent): that
  would expose the least-privilege provisioner credential
  (`TENANT_PROVISIONER_SECRET_FILE`) and other infra secrets to the tenant
  data-plane container. `pnpm -C gremion-ui check`
  (`scripts/check-tenant-secrets-dir.mjs`) fails the build if the provisioner
  credential resolves inside `TENANT_SECRETS_DIR`. Create it before `up`:
  `mkdir -p secrets/tenants`.

### TENANT_PROXY_SHARED_SECRET

- **Type:** String (secret; `openssl rand -hex 32`)
- **Default:** unset (the proxy-trust gate is a byte-identical no-op)
- **Used by:** Traefik (injects `x-proxy-trust` on the `gremion-ui` routers) and
  the tenant resolver (`resolve.ts isProxyTrusted`), which 403s any request
  lacking a constant-time match.
- **Impact:** When set, x-forwarded-host trust no longer rests on network
  topology alone. Set the env var **and** the Traefik label together at deploy;
  leave unset for local dev.

### TENANT_RATE_LIMIT_RPS / TENANT_RATE_LIMIT_BURST

- **Type:** Integer
- **Default:** unset (per-tenant rate limiting disabled)
- **Used by:** the per-tenant rate limit at the resolution seam
  (`gremion-ui/src/lib/server/tenant/rate-limit.ts`). `RPS` = sustained
  tokens/second per tenant; `BURST` = bucket capacity (defaults to `ceil(RPS)`
  when unset).

---

## PostgreSQL

One PostgreSQL instance backs Keycloak, the governance application database,
and the tenancy control plane. `docker/postgres/init-databases.sh` creates the
extra databases and roles on first init.

### POSTGRES_USER / POSTGRES_PASSWORD

- **Type:** String
- **Default:** `POSTGRES_USER=postgres`
- **Required:** Yes
- **Impact:** Root PostgreSQL user, used by the init script to create the other
  databases and roles. Keep `POSTGRES_PASSWORD` secret.

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=CHANGE_ME_postgres_root
```

### Application database (governance)

The governance domain (committees, members, org-unit tree, protocols,
resolutions, the public portal) lives in this database.

| Variable | Default | Notes |
|----------|---------|-------|
| `GREMION_DB_USER` | `gremion` | Application DB role |
| `GREMION_DB_PASSWORD` | (`CHANGE_ME_gremion_db`) | `openssl rand -hex 32` |
| `GREMION_DB_NAME` | `gremion` | Application DB name |

`gremion-ui` derives its `DATABASE_URL` from these:
`postgresql://${GREMION_DB_USER}:${GREMION_DB_PASSWORD}@postgres:5432/${GREMION_DB_NAME}`.

### Control-plane database (tenancy)

Tenant registry + fleet-migration ledger
(`gremion-ui/migrations-control/`). Created by `init-databases.sh` on **first
init only**.

| Variable | Default | Notes |
|----------|---------|-------|
| `CONTROL_DB_USER` | `control` | Control-plane role |
| `CONTROL_DB_PASSWORD` | (`CHANGE_ME_control_db`) | `openssl rand -hex 32` |
| `CONTROL_DB_NAME` | `control` | Control-plane DB name |

`gremion-ui` derives `CONTROL_DATABASE_URL` from these. **`gremion-ui` connects
directly to `postgres:5432` for the control plane** — never through the
production PgBouncer overlay (the registry is the direct `+ control` term in the
connection budget; reads are cached). Without it, boot's
`runControlMigrations()` fails and every request 503s. To rotate:
`ALTER ROLE control WITH PASSWORD '<new>';`, update the value, then
`up -d --force-recreate gremion-ui postgres` (a plain `restart` will **not**
reload `.env`).

### Public-portal reader role

Read-only role used by the `gremion-public` container.

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_DB_PASSWORD` | (`CHANGE_ME_public_reader`) | `openssl rand -hex 32`; role created by `init-databases.sh` |
| `GREMION_PUBLIC_DB_URL` | `postgresql://gremion_public_reader:<pw>@postgres:5432/gremion` | Read-only DSN for `gremion-public` |

### Keycloak database

| Variable | Default | Notes |
|----------|---------|-------|
| `KEYCLOAK_DB_USER` | `keycloak` | Keycloak DB role |
| `KEYCLOAK_DB_PASSWORD` | (`CHANGE_ME_keycloak_db`) | `openssl rand -hex 32` |
| `KEYCLOAK_DB_NAME` | `keycloak` | Keycloak DB name |

---

## Keycloak

Central identity provider (OIDC/SSO). Admin UI:
`http://localhost:8082/auth/admin` (local dev).

### Admin account

| Variable | Default | Notes |
|----------|---------|-------|
| `KEYCLOAK_ADMIN` | `admin` | Bootstrap admin username (`KC_BOOTSTRAP_ADMIN_USERNAME`) |
| `KEYCLOAK_ADMIN_PASSWORD` | (`CHANGE_ME_keycloak_admin`) | Bootstrap admin password |

### KC_ADMIN_ALLOWLIST_CIDRS

- **Type:** String (comma-separated CIDRs)
- **Default:** `127.0.0.1/32` (no external request matches)
- **Used by:** the `kc-admin-allowlist` IPAllowList middleware that protects the
  Keycloak admin console + Admin REST API at `https://${DOMAIN}/auth/admin` in
  production.
- **Impact:** With the default, operators reach the console only via
  `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh ...` or
  `kubectl port-forward`. Set a CIDR list to allow bastion/VPN access, e.g.
  `KC_ADMIN_ALLOWLIST_CIDRS=203.0.113.10/32,198.51.100.0/24`.

### KC_REALM_SSL_REQUIRED

- **Type:** String (`all` | `external` | `none`)
- **Default:** `all` (HTTPS required for every request, including private-IP)
- **Used by:** substituted into the realm export as the realm `sslRequired`.
- **Impact:** The dev override drops it to `external` so pure-local
  `http://localhost:8082` browser login works without per-developer CA trust.
  The actual internal HTTPS listener (`KC_HTTPS_*` + cert) lives in
  `docker-compose.prod.yml`.

### OIDC client secrets

Sed-substituted into `realm-export.json` at container start by
`substitute-realm-secrets.sh`. Both **must** be set — the script fails fast if
either is empty. Generated by `scripts/setup.sh`.

| Variable | Used for |
|----------|----------|
| `GREMION_UI_OIDC_CLIENT_SECRET` | The `gremion-ui` (app shell) OIDC client |
| `GREMION_ADMIN_OIDC_CLIENT_SECRET` | The admin OIDC client |

### Admin REST / JWT

| Variable | Default | Notes |
|----------|---------|-------|
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | (empty) | Service-account secret `gremion-ui` uses for Keycloak Admin API calls (governance committee provisioning, step-up `hasOtpCredential`) |
| `KEYCLOAK_JWT_PUBLIC_KEY` | (empty) | RS256 public key (PEM, single line with `\n`), filled after first start |
| `KEYCLOAK_ISSUER_URL` | `http://keycloak:8080/auth/realms/sturaos` | Issuer URL used by the kernel for token validation |

---

## App Shell (gremion-ui)

The SvelteKit / Auth.js admin shell that hosts the governance domain.

### Auth.js / OIDC

| Variable | Default | Notes |
|----------|---------|-------|
| `AUTH_SECRET` | (empty; set by `setup.sh`) | Auth.js signing secret (`openssl rand -hex 32`) |
| `AUTH_KEYCLOAK_ID` | `gremion-ui` | OIDC client id |
| `AUTH_KEYCLOAK_SECRET` | (empty) | OIDC client secret — set after the Keycloak realm import |
| `AUTH_KEYCLOAK_ISSUER` | `http://keycloak:8080/auth/realms/sturaos` | Public issuer used by the browser-facing OIDC flow |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public base URL of the app shell |

The compose file also sets server-only OIDC values that are **not** read from
`.env`: `AUTH_KEYCLOAK_INTERNAL` and `KEYCLOAK_ADMIN_URL` point at the internal
TLS listener `https://keycloak:8443` in production (the dev override drops these
to `http://keycloak:8080`), and `AUTH_TRUST_HOST=1`.

### STEPUP_FRESHNESS_SECONDS

- **Type:** Integer (seconds)
- **Default:** `300`
- **Used by:** the generic LoA/ACR step-up freshness window — how long a fresh
  LoA-2 elevation stays valid before a re-prompt. The kernel keeps the Keycloak
  step-up/ACR plumbing; the module-specific approval-enforcement flag left with
  the relevant feature module.

### Database URLs

These are constructed by the compose files from the PostgreSQL variables above;
you normally do not set them directly in `.env`:

- `DATABASE_URL` → the application (governance) DB. In production the overlay
  re-points this through PgBouncer (`pgbouncer:6432`); dev/CI use the direct
  `postgres:5432` URL.
- `CONTROL_DATABASE_URL` → the control-plane DB, always direct to
  `postgres:5432` (never PgBouncer). The prod overlay deliberately does **not**
  override this key.

### Internal server-to-server calls

| Variable | Default | Notes |
|----------|---------|-------|
| `INTERNAL_PUSH_SECRET` | (`CHANGE_ME_internal_push_secret`) | Shared secret the server-only `internalFetch` helper compares (constant-time) on the `Authorization: Bearer` header for same-app internal calls |
| `INTERNAL_BASE_URL` | `http://gremion-ui:3000` | The in-container origin `internalFetch`'s server-to-server hop targets. **Load-bearing for tenant isolation:** must be the in-container service name/port, never the public apex — otherwise the apex middleware rewrites `X-Forwarded-Host` and a second tenant's self-call resolves the **default** tenant's data plane. Leave as-is unless you change the service name/port |

### Seeding (test fixtures)

| Variable | Default | Notes |
|----------|---------|-------|
| `SEED_TOKEN` | (`CHANGE_ME_seed_token`) | Gates the one-time `POST /api/setup/seed` endpoint; leave empty to disable the endpoint |
| `SEED_USER_PASSWORD` | (`CHANGE_ME_seed_user_pw`) | Password set on every seeded test-fixture user; `scripts/setup.sh` generates a random value |

### Tracing

| Variable | Default | Notes |
|----------|---------|-------|
| `TRACE_EXPORTER` | `log` | Trace exporter selection for the `TracerPort` (`@gremion/ports`) |

---

## Public Portal (gremion-public)

The read-only, unauthenticated public portal served at `public.${DOMAIN}`. It
publishes governance content (committees, protocols, resolutions/Beschlüsse).
Beyond `GREMION_PUBLIC_DB_URL` and `PUBLIC_DB_PASSWORD` (see PostgreSQL above), it
takes Impressum/contact metadata for TMG §5 compliance:

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_CONTACT_NAME` | `Studierendenrat` | Responsible body name |
| `PUBLIC_CONTACT_ADDRESS` | (empty) | Postal address |
| `PUBLIC_CONTACT_EMAIL` | (empty) | Contact email |
| `PUBLIC_CONTACT_PHONE` | (empty) | Contact phone |
| `PUBLIC_IMPRINT_RESPONSIBLE` | `Vorsitz des StuRa` | Person/role responsible for content |
| `PUBLIC_LEGISLATURE_LABEL` | (empty) | Optional legislature/term label |

The compose file also derives `PUBLIC_MAIN_APP_URL=https://${DOMAIN}` and
`ORIGIN=https://public.${DOMAIN}` for this service.

---

## Outgoing Email / SMTP

**Default = Mailpit catcher.** With no email vars set, the stack sends all mail
to the internal `mailpit` service (`mailpit:1025`, no auth, TLS off) and nothing
leaves the host. Read trapped mail at `http://localhost:8026` (web UI). You
normally need none of these for staging — the compose defaults already point at
Mailpit. Set them only to switch to a real outbound relay. Full activation
steps: [runbooks/email-smtp.md](runbooks/email-smtp.md).

`gremion-ui`'s SMTP host/port/from come from the in-app **Settings → E-Mail**
wizard (stored in config), **not** from env — only the SMTP password is read
from the environment.

| Variable | Default | Notes |
|----------|---------|-------|
| `EMAIL_HOST_PASSWORD` | (empty) | SMTP relay password for the app shell's mailer (set on the prod host; never in the template) |

---

## Legal Pages (legal)

The static `legal` nginx service serves Impressum/GDPR pages. Its configuration
comes from a dedicated env file rather than the root `.env`:

- **Env file:** `legal/legal.env` (loaded via `env_file` in compose)
- **Port (local dev):** `127.0.0.1:8083:8080`

In production the config-driven legal pages are rendered by the `gremion-ui` apex
catch-all router; the `legal` nginx is retained for the imprint pages and
reached internally by `gremion-ui`.

---

## Logging & Hardening (vector)

The `vector` service tails Traefik access logs, pseudonymises IPs
(ipcrypt-nd), and enforces retention. Retention values are integers in seconds
(days × 86400) with server-side hard caps:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | `1209600` (14 d) | `2592000` (30 d) |
| `LOG_APP_RETENTION_SECONDS` | `2592000` (30 d) | `7776000` (90 d) |
| `LOG_SECURITY_RETENTION_SECONDS` | `7776000` (90 d) | `15552000` (180 d) |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | `7776000` (90 d) | `31536000` (365 d) |

The IP-pseudonymisation key is supplied to Vector as a Docker secret file
(`./secrets/ipcrypt_key.txt`), not via env.

---

## Backup (restic + rclone)

Provider-agnostic backup configuration.

| Variable | Default | Notes |
|----------|---------|-------|
| `RESTIC_PASSWORD` | (`CHANGE_ME_restic_repo_password`) | Restic repository password |
| `RCLONE_BACKEND_TYPE` | `s3` | `s3` \| `sftp` \| `b2` |
| `RCLONE_ENDPOINT` | (empty) | Provider endpoint URL |
| `RCLONE_ACCESS_KEY_ID` | (empty) | Provider access key |
| `RCLONE_SECRET_ACCESS_KEY` | (empty) | Provider secret key |
| `RCLONE_BUCKET` | (empty) | Target bucket |

---

## Production Overlay (docker-compose.prod.yml)

The production overlay is **not** auto-loaded. Bring it up explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

It adds `pgbouncer`, `cloudflared`, and a static `fallback` service, wires
Traefik routing, and reads two extra variables:

### PGBOUNCER_AUTH_PASSWORD

- **Type:** String (`openssl rand -hex 32`)
- **Default:** (`CHANGE_ME_pgbouncer_auth`)
- **Note:** Password for the `pgbouncer_auth` login role (the `auth_query`
  lookup user). **Not** read by compose — it is used at deploy to render
  `docker/pgbouncer/userlist.txt` from `userlist.txt.example` and to create the
  role.

### CF_TUNNEL_TOKEN

- **Type:** String (secret)
- **Required:** Yes (production cutover, gitignored)
- **Used by:** the `cloudflared` connector, which establishes outbound-only
  connections to Cloudflare's edge (no inbound host ports). Passed as
  `TUNNEL_TOKEN` to the container via the environment, not on the command line.

---

## Example: minimal local development `.env`

```bash
DOMAIN=localhost

POSTGRES_USER=postgres
POSTGRES_PASSWORD=dev_postgres_root

GREMION_DB_USER=gremion
GREMION_DB_PASSWORD=dev_gremion_db
GREMION_DB_NAME=gremion

CONTROL_DB_USER=control
CONTROL_DB_PASSWORD=dev_control_db
CONTROL_DB_NAME=control

PUBLIC_DB_PASSWORD=dev_public_reader
GREMION_PUBLIC_DB_URL=postgresql://gremion_public_reader:dev_public_reader@postgres:5432/gremion

KEYCLOAK_DB_USER=keycloak
KEYCLOAK_DB_PASSWORD=dev_keycloak_db
KEYCLOAK_DB_NAME=keycloak

KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=dev_keycloak_admin
KC_ADMIN_ALLOWLIST_CIDRS=127.0.0.1/32

GREMION_UI_OIDC_CLIENT_SECRET=dev_gremion_ui_oidc
GREMION_ADMIN_OIDC_CLIENT_SECRET=dev_gremion_admin_oidc

AUTH_SECRET=dev_auth_secret
AUTH_KEYCLOAK_ID=gremion-ui
AUTH_KEYCLOAK_SECRET=dev_gremion_ui_oidc
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/sturaos
PUBLIC_BASE_URL=http://localhost:3000

INTERNAL_PUSH_SECRET=dev_internal_push_secret
SEED_TOKEN=dev_seed_token
SEED_USER_PASSWORD=dev_seed_user_pw
```

> For local development the `scripts/setup.sh` helper generates `.env` with
> random secrets for you — prefer it over editing values by hand.

---

## Troubleshooting

### `CHANGE_ME` placeholder still in .env

`./scripts/setup.sh` replaces these with random values. If some remain:

```bash
# Check which ones failed
grep 'CHANGE_ME' .env
```

### Environment variable not being read

```bash
# Confirm the rendered value Docker Compose will use
docker compose config | grep VARIABLE_NAME
```

Remember: a `.env` change only lands on a running container via
`up -d --force-recreate <service>`, never a plain `restart`.

### OIDC authentication fails

```bash
# Verify the realm's OIDC discovery document is reachable
curl https://${DOMAIN}/auth/realms/sturaos/.well-known/openid-configuration

# Confirm the client secrets match: both GREMION_UI_OIDC_CLIENT_SECRET and
# GREMION_ADMIN_OIDC_CLIENT_SECRET must be non-empty, or
# substitute-realm-secrets.sh fails fast at Keycloak boot.
grep -E 'GREMION_(UI|ADMIN)_OIDC_CLIENT_SECRET' .env
```

### Tenant subdomains 404 in production

Confirm `DOMAIN_REGEX` is set to the backslash-escaped `DOMAIN`; an empty
`DOMAIN_REGEX` with a real `DOMAIN` collapses every wildcard router leg to a
pattern that matches no tenant host while the apex keeps working. See
[runbooks/tenant-edge.md](runbooks/tenant-edge.md).
