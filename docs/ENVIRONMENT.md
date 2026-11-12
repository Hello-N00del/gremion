# Environment Variables Reference

Reference for the keys of the local `.env` (template: [`.env.example`](../.env.example))
and for the mail-transport and pilot-service keys of a host's env files. Do not
copy `.env.example` to `.env` by hand for a local stack: `./scripts/setup.sh`
writes the file and generates every secret, and it skips that step when the file
already exists ([LOCAL_TESTING.md](LOCAL_TESTING.md#quick-start)). A production
host does not use this `.env` at all; its env files are rendered by
`gremion-init-secrets` from `infra/host/templates/env/`.

This is the operational/technical layer. For the kernel's vision, architecture,
domain model, and governance charter, see [about-gremion.md](about-gremion.md).

> **Scope.** `make up` runs two compose projects. The state project runs seven
> services — `postgres`, `governance-postgres`, `nats`, `keycloak`, `legal`,
> `vector` and, under the `dev` profile, `mailpit` — and the app project four:
> `gremion-ui`, `gremion-public`, `control-panel` and `kernel-api`. The
> `production` profile adds `traefik` + `docker-socket-proxy`, and
> `docker-compose.prod.yml` adds `pgbouncer` + `fallback`. The feature modules
> (board, calendar, content, elections, files, finance, handover, messaging,
> publishing, vault, votes) live under `modules/` in this tree
> ([modules.md](modules.md)); their services start only under their compose
> profiles, and the keys those need on a host are in
> [Pilot services](#pilot-services-host-install) below.

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
- The OIDC client secrets are substituted by `buildTenantRealmDoc` into the
  composed per-tenant realm document at tenant-create time (nothing is
  substituted at Keycloak boot) — provisioning throws if a required value is
  empty.

---

## Domain & Tenancy

### DOMAIN

- **Type:** String (domain name)
- **Default:** `localhost`
- **Required:** Yes
- **Used by:** `scripts/setup.sh` (which writes it) and the dev/ops scripts. No
  compose file reads `DOMAIN` itself: `.env.example` binds `PLATFORM_DOMAIN` to
  it, and that is the key the compose files read.

```bash
# Local development
DOMAIN=localhost
# Production
DOMAIN=gremion.example.org
```

> **No wildcard key.** Since TASK-041 a request is resolved by its WHOLE host
> (a `tenant_domain` row) and every tenant host has its own `Host(...)`-literal
> router, so there is no regexp-escaped domain variable any more. `DOMAIN` names
> only the apex, which binds no tenant (TRD-075). See
> [runbooks/tenant-edge.md](runbooks/tenant-edge.md) STEP 0a.

### PLATFORM_DOMAIN

- **Type:** String (domain name)
- **Default:** `${DOMAIN}` in `.env.example`; a host's env files carry it directly.
- **Required:** Yes. `docker-compose.app.yml` and `docker-compose.prod.yml`
  refuse to render without it.
- **Used by:** the apex routers of the state project, and `gremion-ui` and
  `gremion-public` (as `DOMAIN`, `PUBLIC_MAIN_APP_URL` and the default of
  `PUBLIC_BASE_URL`). Also the platform mail transport, see below.

### TENANT_SECRETS_DIR

- **Type:** String (host path)
- **Default:** `./secrets/tenants` (the checkout ships the directory)
- **Used by:** `gremion-ui`, bind-mounted read-only at `/run/secrets/tenants`.
  Per-tenant secret files written by the provisioner appear in the running
  container live, no recreate needed.
- **Impact:** Must be a **dedicated leaf directory** holding only per-tenant
  secret files. Never point it at the `secrets/` root (or any parent): that
  would expose the least-privilege provisioner credential
  (`TENANT_PROVISIONER_SECRET_FILE`) and other infra secrets to the tenant
  data-plane container. `pnpm -C gremion-ui check`
  (`scripts/check-tenant-secrets-dir.mjs`) fails the build if the provisioner
  credential resolves inside `TENANT_SECRETS_DIR`.

### TENANT_PROXY_SHARED_SECRET

- **Type:** String (secret; `openssl rand -hex 32`)
- **Default:** unset in `.env.example` (commented out), and `setup.sh` does not
  generate it. `docker-compose.app.yml` nevertheless **requires** a value for
  `kernel-api`, so the app project does not render without one, in local dev
  too ([LOCAL_TESTING.md](LOCAL_TESTING.md#quick-start), step 3).
- **Used by:** Traefik (injects `x-proxy-trust` on the `gremion-ui` routers),
  the tenant resolver (`resolve.ts isProxyTrusted`), which 403s any request
  lacking a constant-time match, and `kernel-api`.
- **Impact:** When set, x-forwarded-host trust no longer rests on network
  topology alone. On a host, set the env var **and** the Traefik label together
  at deploy. In local dev there is no Traefik to inject the header, so a request
  to port 3001 must carry it itself
  ([LOCAL_TESTING.md](LOCAL_TESTING.md#probing-gremion-ui-by-hand)). In
  `gremion-ui` alone an unset value makes the gate a no-op.

### TENANT_RATE_LIMIT_RPS / TENANT_RATE_LIMIT_BURST

- **Type:** Integer
- **Default:** unset (per-tenant rate limiting disabled)
- **Used by:** the per-tenant rate limit at the resolution seam
  (`gremion-ui/src/lib/server/tenant/rate-limit.ts`). `RPS` = sustained
  tokens/second per tenant; `BURST` = bucket capacity (defaults to `ceil(RPS)`
  when unset). `docker-compose.app.yml` does not pass either key to the
  container.

---

## Compose projects (pooled stack)

Both projects refuse to render while one of their required keys is unset or
empty (`x-required-env` in `docker-compose.yml` and `docker-compose.app.yml`).
`.env.example` carries workstation values for all of them.

| Variable | `.env.example` | Notes |
|----------|----------------|-------|
| `STACK` | `gremion` | Stack name; prefixes the external networks and volumes (`${STACK}_state`, `${STACK}_edge`). Required by every compose file. `make up` passes `STACK=dev` on the command line |
| `COLOUR` | (not in `.env`) | The app colour. Required by `docker-compose.app.yml`; `make up` passes `COLOUR=blue` |
| `COMPOSE_PROFILES` | `dev` | Profiles of the state project. `dev` starts `mailpit`; a host renders with `production` |
| `IMAGE_TAG` | `dev` | Tag of the first-party `gremion-*` images. `make up` / `make build` pass `dev` |
| `APP_V4_SUBNET` / `APP_V6_SUBNET` | `10.91.2.0/24` / `fd5a:192::/64` | Subnets of the app project's own network. Required by `docker-compose.app.yml` |
| `GREMION_ROOT` | `/opt/gremion` | The root whose `etc/edge` directory is Traefik's read-only router directory. Required by `docker-compose.yml` |
| `GREMION_MIGRATION_DUMP_DIR` | `/opt/gremion/migration-dumps` | Pre-migration dump directory bind-mounted into `kernel-api-migrate`. Required by `docker-compose.app.yml` |

### Edge (Traefik, production profile)

Read by `docker-compose.yml`. Traefik itself starts only under the `production`
profile, but the keys marked required are checked on every render.

| Variable | `.env.example` | Notes |
|----------|----------------|-------|
| `ACME_EMAIL` | (empty) | ACME account address; needed whenever `TRAEFIK_CERT_RESOLVER` is non-empty |
| `TRAEFIK_CERT_RESOLVER` | `le-http` | Certificate resolver the public routers name. Empty only where TLS terminates in front of Traefik |
| `ACME_CA_SERVER` | `https://acme.invalid/directory` | ACME directory. Required. The template value is a reserved `.invalid` name, so a copied template can place no real order |
| `EDGE_V4_SUBNET` / `EDGE_V6_SUBNET` | `10.90.0.0/24` / `fd5a:90::/64` | The pinned `${STACK}_edge` subnets, trusted for forwarded headers. Required |
| `EDGE_BIND_IP` / `EDGE_BIND_IP6` | `127.0.0.1` / `::1` | Addresses the edge ports publish on. Required, so an empty value can never publish on `0.0.0.0` |
| `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` | `80` / `443` | Published edge ports. Required |
| `TRAEFIK_API_PORT` / `INTERNALTEST_PORT` | `8080` / `8081` | The Traefik API and the `internaltest` entrypoint, published on `127.0.0.1` only. Required |

---

## PostgreSQL

The `postgres` server backs Keycloak, the governance application database,
the tenancy control plane and the platform database.
`docker/postgres/init-databases.sh` creates the Keycloak, application and
control databases and their roles on first init. The governance service has its
own server, `governance-postgres`, and each module database server starts under
its module's compose profile.

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

The compose files build `gremion-ui`'s `DATABASE_URL` from these, see
[Database URLs](#database-urls).

### Control-plane database (tenancy)

Tenant registry + fleet-migration ledger
(`gremion-ui/migrations-control/`). Created by `init-databases.sh` on **first
init only**.

| Variable | Default | Notes |
|----------|---------|-------|
| `CONTROL_DB_USER` | `control` | Control-plane role |
| `CONTROL_DB_PASSWORD` | (`CHANGE_ME_control_db`) | `openssl rand -hex 32` |
| `CONTROL_DB_NAME` | `control` | Control-plane DB name |

The compose file builds `CONTROL_DATABASE_URL` from these. **`gremion-ui` connects
directly to `postgres-<stack>:5432` for the control plane** — never through
PgBouncer (the registry is the direct `+ control` term in the connection budget;
reads are cached). Without it, boot's `runControlMigrations()` fails and every
request 503s. To rotate: `ALTER ROLE control WITH PASSWORD '<new>';`, update the
value, then recreate `gremion-ui` with `up -d --force-recreate` (a plain
`restart` will **not** reload `.env`).

### Platform database and service roles

The provisioning ledger and module catalogue live in `gremion_platform`. It is
created by `gremion-tenant init`, never by `init-databases.sh`; the panel,
kernel-API, access-record and module-switch roles are made by the same init.
`setup.sh` generates every password in this table, and `docker-compose.app.yml`
refuses to render without the platform, panel, kernel-API and access-record
passwords.

| Variable | `.env.example` | Notes |
|----------|----------------|-------|
| `PLATFORM_DB_USER` / `PLATFORM_DB_PASSWORD` | `gremion_platform` / (`CHANGE_ME_platform_db`) | Owner of the platform database; `tenant-create` connects as it, directly |
| `PANEL_DB_USER` / `PANEL_DB_PASSWORD` | `gremion_panel` / (`CHANGE_ME_panel_db`) | The control panel's read-only role |
| `KERNEL_API_DB_USER` / `KERNEL_API_DB_PASSWORD` | `gremion_kernel_api` / (`CHANGE_ME_kernel_api_db`) | The kernel API's read-only role |
| `UI_OAC_DB_PASSWORD` | (`CHANGE_ME_ui_oac_db`) | Password of `gremion_ui_oac`, the access-record reader role; `gremion-ui` reads it as `PLATFORM_ACCESS_DATABASE_URL` |
| `UI_MODULES_DB_PASSWORD` | (`CHANGE_ME_ui_modules_db`) | Password of `gremion_ui_modules`, the council module-switch role. Optional: when empty, `gremion-ui` gets no `PLATFORM_MODULES_DATABASE_URL` |
| `GOVERNANCE_PG_USER` / `GOVERNANCE_PG_PASSWORD` | `governance` / (`CHANGE_ME_governance_pg`) | Superuser of `governance-postgres`. The server starts under every profile, so the password must be set |

### Public-portal reader role

Read-only role used by the `gremion-public` container.

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_DB_PASSWORD` | (`CHANGE_ME_public_reader`) | `openssl rand -hex 32`; role created by `init-databases.sh`, which refuses to run without it. `docker-compose.app.yml` builds the container's `GREMION_PUBLIC_DB_URL` from it |
| `GREMION_PUBLIC_DB_URL` | `postgresql://gremion_public_reader:<pw>@postgres:5432/gremion` | The `.env` line carries the same password (`setup.sh` fills both). The compose files do not read this line; they build the container's value themselves |

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

### KEYCLOAK_REALM

| Variable | Default | Notes |
|----------|---------|-------|
| `KEYCLOAK_REALM` | `gremion` | The realm a dev/ops script addresses over the Keycloak Admin API |

No realm is created at boot. Every realm is created by tenant-create and
named after the tenant slug, so a script that talks to the Admin API has to be
told which realm it means — `scripts/configure-keycloak-clients.sh` treats an
unset value as fatal rather than defaulting.

`KEYCLOAK_REALM` and the `/realms/<name>` segment of `AUTH_KEYCLOAK_ISSUER` name
**one** realm. Disagreement is silent and it is a WRITE:
`configure-keycloak-clients.sh` would rewrite the confidential client secrets of
the realm `KEYCLOAK_REALM` names while every login goes to the issuer's realm,
and nothing logs an error. `scripts/check-realm-env.sh` compares them; it runs
from `make validate-env` and from `configure-keycloak-clients.sh` before the
first Admin-API write. It passes when `KEYCLOAK_REALM` is unset (the issuer is
then the only source of truth) and when the issuer is not Keycloak-shaped.

### KC_ADMIN_ALLOWLIST_CIDRS

- **Type:** String (comma-separated CIDRs)
- **Default:** `127.0.0.1/32` (no external request matches)
- **Used by:** the `kc-admin-allowlist` IPAllowList middleware
  (`docker-compose.prod.yml`) that protects the Keycloak admin console + Admin
  REST API at `https://${PLATFORM_DOMAIN}/auth/admin` in production.
- **Impact:** With the default, operators reach the console only via
  `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh ...` or
  `kubectl port-forward`. Set a CIDR list to allow bastion/VPN access, e.g.
  `KC_ADMIN_ALLOWLIST_CIDRS=203.0.113.10/32,198.51.100.0/24`.

### Retired: `KC_REALM_SSL_REQUIRED`

B-01 deleted this knob from `docker-compose.yml` and from the dev override. A
realm's `sslRequired` is no longer an environment variable at all:
`buildTenantRealmDoc` pins it to `all` on every realm it composes
(`gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts`). The internal
HTTPS listener (`KC_HTTPS_*` + cert) is unchanged and still lives in
`docker-compose.prod.yml`.

> **Closed (decision 2026-10-28).** There is no dev-only switch: dev realms are
> created on the server through the regular tooling and served over HTTPS behind
> Traefik, so `all` is correct. A plain-HTTP localhost realm (the
> `scripts/dev-configure.sh` flow) needs a per-session
> `kcadm.sh update realms/<realm> -s sslRequired=external`, which `reconcile`
> reverts. Recorded in `KNOWN_ISSUES.md`.

### OIDC client secrets

Substituted into the composed per-tenant realm document at tenant-create time by
`buildTenantRealmDoc` (not at container start). Both **must** be set —
provisioning throws if either is empty. Generated by `scripts/setup.sh`.

| Variable | Used for |
|----------|----------|
| `GREMION_UI_OIDC_CLIENT_SECRET` | The `gremion-ui` (app shell) OIDC client |
| `GREMION_ADMIN_OIDC_CLIENT_SECRET` | The `gremion-admin` (admin REST) client |

### Admin REST

| Variable | Default | Notes |
|----------|---------|-------|
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | (empty in the template) | Service-account secret `gremion-ui` uses for Keycloak Admin API calls (governance committee provisioning, step-up `hasOtpCredential`). `setup.sh` sets it to the same value as `GREMION_ADMIN_OIDC_CLIENT_SECRET` |

`.env.example` also carries `KEYCLOAK_JWT_PUBLIC_KEY` and `KEYCLOAK_ISSUER_URL`.
No compose file, script or source file in this tree reads either.

---

## App Shell (gremion-ui)

The SvelteKit / Auth.js admin shell that hosts the governance domain.

### Auth.js / OIDC

| Variable | Default | Notes |
|----------|---------|-------|
| `AUTH_SECRET` | (empty; set by `setup.sh`) | Auth.js signing secret (`openssl rand -hex 32`) |
| `AUTH_KEYCLOAK_ID` | `gremion-ui` | OIDC client id |
| `AUTH_KEYCLOAK_SECRET` | (empty in the template) | OIDC client secret. `setup.sh` sets it to the same value as `GREMION_UI_OIDC_CLIENT_SECRET` |
| `AUTH_KEYCLOAK_ISSUER` | `http://keycloak:8080/auth/realms/gremion` | Dev tooling only (the realm-consistency check reads it). gremion-ui does not read it and the app compose does not pass it: the issuer comes from the tenant row |
| `PUBLIC_BASE_URL` | `http://localhost:3000` in `.env.example` | Public base URL of the app shell. Unset, `docker-compose.app.yml` falls back to `https://` + `PILOT_TENANT_HOST`, else `PLATFORM_DOMAIN`; the dev layer sets `http://localhost:3001` |

The compose file also sets server-only OIDC values that are **not** read from
`.env`: `AUTH_KEYCLOAK_INTERNAL` and `KEYCLOAK_ADMIN_URL` point at the internal
TLS listener `https://keycloak:8443` (the dev layer `docker-compose.app.dev.yml`
drops these to `http://keycloak:8080`), and `AUTH_TRUST_HOST=1`.

### STEPUP_FRESHNESS_SECONDS

- **Type:** Integer (seconds)
- **Default:** `300`
- **Used by:** the generic LoA/ACR step-up freshness window — how long a fresh
  LoA-2 elevation stays valid before a re-prompt.

### Database URLs

These are constructed by the compose files from the PostgreSQL variables above;
you do not set them in `.env`:

- `DATABASE_URL` → the application (governance) DB. `docker-compose.app.yml`
  points it at PgBouncer (`pgbouncer-<stack>:6432`); the dev layer
  `docker-compose.app.dev.yml` re-points it to `postgres-<stack>:5432`, because
  the dev stack runs no PgBouncer.
- `CONTROL_DATABASE_URL` → the control-plane DB, always direct to
  `postgres-<stack>:5432` (never PgBouncer). The dev layer does **not**
  override this key.

### Internal server-to-server calls

| Variable | Default | Notes |
|----------|---------|-------|
| `INTERNAL_PUSH_SECRET` | (`CHANGE_ME_internal_push_secret`) | Shared secret the server-only `internalFetch` helper compares (constant-time) on the `Authorization: Bearer` header for same-app internal calls |
| `INTERNAL_BASE_URL` | `http://gremion-ui:3000` in `.env.example` | The in-container origin `internalFetch`'s server-to-server hop targets. `docker-compose.app.yml` sets the container's value itself (`http://gremion-ui-<colour>:3000`) and does not read the `.env` line. **Load-bearing for tenant isolation:** it must be the in-container service name/port, never the public apex — the `X-Forwarded-Host` the helper stamps is the whole tenant selector, and an edge that restated it would aim the self-call at another tenant's data plane |

### Seeding (test fixtures)

| Variable | Default | Notes |
|----------|---------|-------|
| `SEED_TOKEN` | (`CHANGE_ME_seed_token`) | Gates the one-time `POST /api/setup/seed` endpoint; leave empty to disable the endpoint |
| `SEED_USER_PASSWORD` | (`CHANGE_ME_seed_user_pw`) | Password set on every seeded test-fixture user; `scripts/setup.sh` generates a random value |

### Tracing

| Variable | Default | Notes |
|----------|---------|-------|
| `TRACE_EXPORTER` | `log` | Trace exporter selection for the `TracerPort` (`@gremion/ports`). Not in `.env.example`; `docker-compose.app.yml` defaults it |

### Source offer

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_SOURCE_URL` | unset (both shells fall back to upstream) | The AGPL-3.0 section 13 Corresponding Source link both app shells render in their footer. Set it to the repository holding your version if you modified Gremion. Passed to `gremion-ui` and `gremion-public` by `docker-compose.app.yml` |

---

## Public Portal (gremion-public)

The read-only, unauthenticated public portal. It publishes governance content
(committees, protocols, resolutions/Beschlüsse). Locally it is published on
`http://localhost:3002`; this tree carries no public router for it today
([runbooks/tenant-edge.md](runbooks/tenant-edge.md)). Beyond
`PUBLIC_DB_PASSWORD` (see PostgreSQL above), it takes Impressum/contact metadata
for TMG §5 compliance:

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_CONTACT_NAME` | (empty; portal shows "Gremium") | Responsible body name |
| `PUBLIC_CONTACT_ADDRESS` | (empty) | Postal address |
| `PUBLIC_CONTACT_EMAIL` | (empty) | Contact email |
| `PUBLIC_CONTACT_PHONE` | (empty) | Contact phone |
| `PUBLIC_IMPRINT_RESPONSIBLE` | (empty) | Person/role responsible for content |
| `PUBLIC_LEGISLATURE_LABEL` | (empty) | Optional legislature/term label |

`.env.example` ships sample values for the contact fields. The compose file also
derives `PUBLIC_MAIN_APP_URL=https://${PLATFORM_DOMAIN}` and
`ORIGIN=https://public.${PLATFORM_DOMAIN}` for this service; the dev layer sets
them to `http://localhost:3001` and `http://localhost:3002`.

Where the portal is mounted, and an optional link to a site above it:

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_BASE_PATH` | (empty; the portal is served at `/`) | A **build** argument, not a runtime setting: SvelteKit bakes the base path into the bundle, so a change needs a rebuild of `gremion-public` |
| `PUBLIC_APEX_URL` / `PUBLIC_APEX_LABEL` | unset | Back-link strip to a site at the origin root. Rendered only when both are set |
| `PUBLIC_APEX_NOTE` / `PUBLIC_APEX_COLOPHON` | unset | Optional note of the strip and the footer colophon; the colophon needs the URL too |

---

## Outgoing Email / SMTP

**The catcher.** The `dev` profile of the state project runs `mailpit`
(`mailpit:1025`, no auth, TLS off; web UI at `http://localhost:8026`), and what it
receives never leaves the host. No compose default points the app at it:
`gremion-ui`'s SMTP host/port/from come from the in-app **Settings → E-Mail**
form (stored in the tenant's config), **not** from env, and a tenant starts with
SMTP unconfigured. Activation steps: [runbooks/email-smtp.md](runbooks/email-smtp.md).

| Variable | Default | Notes |
|----------|---------|-------|
| `SMTP_TEST_ALLOW_PRIVATE` | unset | `1` lets the SMTP target guard accept a private (RFC1918 / IPv6 unique-local) target and port `1025`, which is what the Mailpit catcher on the container network is. The guard applies to the SMTP test, to saving the settings and to sending. Loopback, link-local, CGNAT and metadata addresses stay refused with it set. Leave it empty in production. Read at container create time (`up -d --force-recreate gremion-ui`). Details: [security/test-smtp-guard.md](security/test-smtp-guard.md) |
| `EMAIL_HOST_PASSWORD` | unset (commented out in the template) | Not read by any kernel code path: `gremion-ui` resolves a tenant's SMTP credential only from the registry `passwordRef` ([runbooks/email-smtp.md](runbooks/email-smtp.md#per-tenant-smtp-resolution)) |

### Platform mail transport (Keycloak realms)

Realm mail (login, password reset, verify-email) is separate from the app
mailer above. `buildTenantRealmDoc` reads these keys at tenant-create time from
the host's `mail.env` (template `infra/host/templates/env/mail.env.tmpl`), via
`mailTransportFromEnv` in
`gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts`. Realm creation
**fails closed**: a realm that opens email login or password reset without a
working sender is refused (`assertSmtpConfiguredForEmailLogin`).

| Variable | Default | Notes |
|----------|---------|-------|
| `MAIL_TRANSPORT` | (none) | `relay` or `stalwart`. No default; unset or unknown throws |
| `PLATFORM_DOMAIN` | (none) | Sender domain for `stalwart`; the `relay` From domain when `RELAY_FROM_DOMAIN` is empty |
| `RELAY_SMTP_HOST` | (none) | `relay` only. Required |
| `RELAY_SMTP_PORT` | `587` | `relay` only. 465 = implicit TLS, any other port negotiates STARTTLS |
| `RELAY_SMTP_USER` | (empty) | `relay` only. Empty = IP-allow-listed relay, no authentication |
| `RELAY_SMTP_PASSWORD_REF` | (none) | Required when `RELAY_SMTP_USER` is set. A secret **reference**, never the password: `secret:<name>` (`<root>/etc/secrets/<name>`, mode 0600) or `file:<absolute path>` |
| `RELAY_FROM_DOMAIN` | `PLATFORM_DOMAIN` | `relay` only. The From domain the relay DKIM-signs |

An inline `RELAY_SMTP_PASSWORD` is **ignored**; the password is only ever read
through its `_REF`. See
[runbooks/email-smtp.md](runbooks/email-smtp.md#platform-mail-transport-relay-or-bundled-stalwart).

---

## Legal Pages (legal)

The static `legal` nginx service serves Impressum/GDPR pages. Its configuration
comes from a dedicated env file rather than the root `.env`:

- **Env file:** `legal/legal.env` (loaded via `env_file` in compose; `setup.sh`
  creates it from `legal/legal.env.example`, and the state project does not
  render without it)
- **Port (local dev):** `127.0.0.1:8083:8080`

In production the config-driven `/legal` pages are served by `gremion-ui`
(Settings → Rechtliches); the `legal` nginx has no `/legal` router, is retained
for the imprint pages and is reached internally by `gremion-ui`.

---

## Logging & Hardening (vector)

The `vector` service tails Traefik access logs, pseudonymises IPs
(ipcrypt-nd), and enforces retention. Retention values are integers in seconds
(days × 86400) with server-side hard caps:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | `1209600` (14 d) | `2505600` (29 d) |
| `LOG_APP_RETENTION_SECONDS` | `2419200` (28 d) | `2505600` (29 d) |
| `LOG_SECURITY_RETENTION_SECONDS` | `2332800` (27 d) | `2505600` (29 d) |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | `2332800` (27 d) | `2592000` (30 d) |

Operator ceiling 30 d [D R29-I6]: the defaults and caps are those of the gremion-ui
retention tiers (`gremion-ui/src/lib/retention-tiers.ts`), 29 d where the daily purge
tick enforces the window and 30 d for the no-PII tier. Only
`LOG_ACCESS_RETENTION_SECONDS` is read by `docker-compose.yml` (Vector's ingest
filter); the other three document the tier defaults, and the application tiers
without a purge consumer change with TASK-033. The edge files, Traefik's own log and
Keycloak's event store already obey the ceiling
([log-retention-policy.md](log-retention-policy.md), "Upper bound").

The IP-pseudonymisation key is supplied to Vector as a Docker secret file
(`./secrets/ipcrypt_key.txt`), not via env.

---

## Backup (restic + rclone)

Read by `scripts/backup.sh` and `scripts/restore.sh` from `.env`
([OPERATIONS.md](OPERATIONS.md#backup--restore)).

| Variable | Default | Notes |
|----------|---------|-------|
| `RESTIC_PASSWORD` | (`CHANGE_ME_restic_repo_password`) | Restic repository password; `setup.sh` generates it |
| `RCLONE_BUCKET` | (empty) | Target bucket. Empty keeps the repository local; set, `backup.sh` also needs `rclone` |

`.env.example` also carries `RCLONE_BACKEND_TYPE`, `RCLONE_ENDPOINT`,
`RCLONE_ACCESS_KEY_ID` and `RCLONE_SECRET_ACCESS_KEY`. `backup.sh` does not read
them: the remote is configured through rclone's own
`RCLONE_CONFIG_<REMOTE>_<KEY>` variables (the script header lists them).

---

## Production Overlay (docker-compose.prod.yml)

The production overlay is **not** auto-loaded. On a host the state project's env
file names it in `COMPOSE_FILE`, so no `-f` is passed:

```bash
docker compose --env-file /opt/gremion/etc/env/state.env <verb>
```

It adds `pgbouncer` and a static `fallback` service and carries the apex routers
of the state project. The app tier is not overlaid here: it is
`docker-compose.app.yml`, one project per colour. One key belongs to it:

### PGBOUNCER_AUTH_PASSWORD

- **Type:** String (`openssl rand -hex 32`)
- **Default:** (`CHANGE_ME_pgbouncer_auth`)
- **Note:** Password for the `pgbouncer_auth` login role (the `auth_query`
  lookup user). **Not** read by compose — `scripts/render-pgbouncer-userlist.sh`
  renders `docker/pgbouncer/userlist.txt` from it, and it is the password the
  role is created with ([runbooks/pgbouncer.md](runbooks/pgbouncer.md)).

---

## Chat module (messaging profile)

Read by `docker-compose.yml` only with the `messaging` profile
(`messaging-postgres` and `matrix`). The passwords ship empty in `.env.example`
and `setup.sh` does not generate them; set both before enabling the profile. A
host generates them (`infra/host/templates/env/state.env.tmpl`).

| Variable | `.env.example` | Notes |
|----------|----------------|-------|
| `MESSAGING_PG_USER` / `MESSAGING_PG_PASSWORD` | `messaging` / (empty) | Superuser of the chat module's database server |
| `SYNAPSE_DB_PASSWORD` | (empty) | Synapse's database password |
| `SYNAPSE_KEYCLOAK_ISSUER_URL` / `SYNAPSE_KEYCLOAK_FETCH_URL` | (empty) | The realm's issuer, blank until the realm exists (Synapse refuses to boot with a blank issuer), and an optional fetch URL (blank derives the in-network one) |

---

## Pilot services (host install)

A host install can run the file, office, chat, video and leaf services of the
pilot (Nextcloud, Collabora, Matrix, LiveKit, Element Call, the calendar,
content and newsletter leaves). They are compose profiles of the state and app
projects, selected per module by `infra/host/module-profiles.json`; the keys
below live in the host env files (`state.env`, `app-<colour>.env`), generated by
`gremion-init-secrets` unless marked operator. Nothing here is read from a dev
`.env`. The service table, ports, routing and the wiring order are in
[ops/pilot-services.md](ops/pilot-services.md).

| Key | Files | Kind | Read by |
|---|---|---|---|
| `PILOT_TENANT_HOST` | state, app | operator | Collabora `server_name`, the `/office` and `/livekit/jwt` public URLs, the Element Call config, the leaves' `PUBLIC_BASE_URL` |
| `NEXTCLOUD_DB_PASSWORD`, `REDIS_PASSWORD` | state | generated | `nextcloud-postgres`, `nextcloud-redis`, `nextcloud` |
| `NEXTCLOUD_ADMIN_PASSWORD` | state, app | generated (one value) | `nextcloud`, gremion-ui, the calendar leaf |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | state, app | generated (one value each) | `livekit` (`LIVEKIT_KEYS`), gremion-ui |
| `INTERNAL_CALENDAR_SECRET`, `INTERNAL_CONTENT_SECRET`, `INTERNAL_NEWSLETTER_SECRET` | app | generated | gremion-ui and the matching leaf |
| `CALENDAR_PG_PASSWORD`, `CONTENT_PG_PASSWORD`, `NEWSLETTER_PG_PASSWORD` | state, app | generated (one value) | the module's database server and its leaf |
| `SYNAPSE_ADMIN_TOKEN` | state, app | placeholder until `gremion-services wire` | gremion-ui (the admin bot's access token, printed once by the bootstrap) |
| `TENANT_SECRETS_DIR` | app | rendered | the per-customer secret files, outside the release tree |

---

## A local `.env`

There is no hand-written minimal `.env`: both compose projects check a list of
required keys on every render (the edge keys, `STACK`, `PLATFORM_DOMAIN`, the app
subnets, the platform role passwords and `TENANT_PROXY_SHARED_SECRET` among
them), so a file with only the application keys does not render. Let `scripts/setup.sh` write
the file from `.env.example`, then add `TENANT_PROXY_SHARED_SECRET`
([LOCAL_TESTING.md](LOCAL_TESTING.md#quick-start)).

---

## Troubleshooting

### `CHANGE_ME` placeholder still in .env

`./scripts/setup.sh` replaces these with random values when it writes the file.
A `.env` you copied by hand keeps them, because the script skips generation when
the file exists:

```bash
# Check which ones are left
grep 'CHANGE_ME' .env
```

### Environment variable not being read

A bare `docker compose` in the repository addresses neither dev project. Use the
two command prefixes from
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#default-services--host-ports-local-dev)
to see the rendered value:

```bash
$DS config | grep VARIABLE_NAME     # state project
$DA config | grep VARIABLE_NAME     # app colour
```

Remember: a `.env` change only lands on a running container via
`up -d --force-recreate <service>`, never a plain `restart`.

### OIDC authentication fails

```bash
# Verify the realm's OIDC discovery document is reachable
curl https://${PLATFORM_DOMAIN}/auth/realms/<realm>/.well-known/openid-configuration

# Both GREMION_UI_OIDC_CLIENT_SECRET and GREMION_ADMIN_OIDC_CLIENT_SECRET must
# be non-empty, or tenant-create fails when buildTenantRealmDoc composes the realm.
grep -cE '^GREMION_(UI|ADMIN)_OIDC_CLIENT_SECRET=.+' .env    # expect 2
```

### A tenant host 404s in production

The host needs both a `tenant_domain` row and its own `Host(...)`-literal
router. An app 404 logs one `tenant.host.rejected` line whose `reason` names the
cause. See [runbooks/tenant-edge.md](runbooks/tenant-edge.md).
