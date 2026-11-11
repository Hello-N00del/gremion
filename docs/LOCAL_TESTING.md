# Gremion — Local Testing Guide

A hands-on guide to running and smoke-testing the **Gremion governance kernel**
locally with Docker Compose. No domain, no DNS, and no TLS certificates are
required — every service is exposed on a loopback port.

This is the **operational / manual-test** layer. For the vision, the three-layer
open-core architecture, the governance charter and invariants, the module SDK,
and the repo/product family, read **[about-gremion.md](./about-gremion.md)**.
For the in-process developer inner loop (Vite dev server, `pnpm` checks, unit
tests), see **[DEVELOPMENT.md](./DEVELOPMENT.md)**.

> **Governance walkthrough.** This guide walks the kernel and the governance
> domain — identity & auth, multi-tenancy, the committee / org-unit / protocol /
> resolution model, the public portal, and the governance invariants. The feature
> modules (calendar, content, files, messaging, …) live under `modules/` in this
> tree ([modules.md](./modules.md)), are switched on per customer and bring their
> own services only when enabled, so the default local stack runs none of them and
> this guide has no test flows for them; each module README has its own.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Architecture Overview](#architecture-overview)
3. [Quick Start](#quick-start)
4. [What `setup.sh` Does](#what-setupsh-does)
5. [Verifying the Stack](#verifying-the-stack)
6. [Setting Up a Tenant](#setting-up-a-tenant)
7. [Testing the Governance Surfaces](#testing-the-governance-surfaces)
8. [Public Portal](#public-portal)
9. [Smoke-Test Checklist](#smoke-test-checklist)
10. [Common Issues & Fixes](#common-issues--fixes)
11. [Make Commands Reference](#make-commands-reference)
12. [Credentials](#credentials)
13. [Cleanup](#cleanup)

---

## Prerequisites

### Required

| Tool | Version | Notes |
|------|---------|-------|
| Docker Desktop | 4.x+ | Windows/macOS; or Docker Engine 24+ on Linux |
| Docker Compose | v2 (plugin) | Included with Docker Desktop; check `docker compose version` |
| `make` | any | macOS/Linux built-in; Windows via [choco](https://chocolatey.org) or [scoop](https://scoop.sh) |
| `openssl` | any | Used by `setup.sh` to generate secrets; macOS/Linux built-in, Windows via WSL2 or Git Bash |
| `git` | any | To clone the repository |
| `bash` | any | `setup.sh` is a bash script (Git Bash / WSL2 on Windows) |

### System Resources

- **RAM:** 4 GB available to Docker is comfortable for the governance-only stack.
- **Disk:** ~6 GB free for images, volumes, and build cache.

---

## Architecture Overview

In local development mode each service is bound to a **loopback host port** —
there is no reverse proxy in front of the stack. `make up` starts two compose
projects (the pooled stack, TASK-040): the state project `dev-state` and the blue
app colour `dev-app-blue`:

```
Browser
   │
   ├── http://localhost:3001        →  gremion-ui      (admin shell / governance app)
   ├── http://localhost:3002        →  gremion-public  (read-only public portal)
   ├── http://localhost:8082/auth   →  keycloak      (OIDC identity provider)
   ├── http://localhost:8083        →  legal         (static Impressum / GDPR pages)
   └── http://localhost:8026        →  mailpit       (captured-mail web UI)

External Docker networks (created by `make dev-networks`):
   dev_state: postgres-dev:5432 ← keycloak, gremion-ui, gremion-public, kernel-api, control-panel
              governance-postgres, nats
              mailpit:1025 ← gremion-ui  (SMTP; nothing leaves the host)
   dev_edge:  keycloak, legal, gremion-ui, gremion-public
   vector     → tails Traefik access logs (idle in dev — no Traefik)
```

> The admin shell app is **`gremion-ui`**. The Keycloak realm is named by the last
> path segment of `AUTH_KEYCLOAK_ISSUER` (`<realm>` below), with clients **`gremion-ui`** and
> **`gremion-admin`**. The **production** profile additionally starts Traefik and
> a read-only docker-socket-proxy (`docker-compose.yml`, `profiles: [production]`),
> plus PgBouncer and the fallback page from `docker-compose.prod.yml`. None of those
> run in local dev. The command prefixes used below (`$DS` for the state project,
> `$DA` for the app colour) are defined in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#default-services--host-ports-local-dev):
> a bare `docker compose` in the repository addresses neither project.

---

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url> gremion
cd gremion

# 2. Create your env file and run the setup script.
#    setup.sh copies .env.example → .env if needed, generates all secrets,
#    builds the images, and starts the core services.
cp .env.example .env        # optional — setup.sh does this for you if .env is absent
./scripts/setup.sh          # or: make setup
# When prompted for a domain, press Enter to use localhost.
```

The script waits for `gremion-ui` to report healthy (~60–90 s on first run) and
then prints the app URL. If `make up` stops on
`required variable TENANT_PROXY_SHARED_SECRET is missing a value`, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#setup-aborts-before-starting-containers).
Open:

- **App (admin shell):** http://localhost:3001
- **Keycloak admin:** http://localhost:8082/auth/admin
- **Public portal:** http://localhost:3002

A freshly-initialised kernel has no tenant yet, so every host answers **404**
(`/healthz` answers `200`) until a tenant is created and its host bound — see
[Setting Up a Tenant](#setting-up-a-tenant). There is no first-run setup wizard.

---

## What `setup.sh` Does

`scripts/setup.sh` (or `make setup`) is idempotent on the `.env` file and:

1. Checks for `docker`, `docker compose`, and `openssl`.
2. Prompts for a **domain** — press **Enter** for `localhost`.
3. Copies `.env.example` to `.env` (mode `600`) and generates random secrets for
   every `CHANGE_ME_*` placeholder, plus `AUTH_SECRET`, the OIDC client secrets,
   `SEED_TOKEN`, `SEED_USER_PASSWORD` and `RESTIC_PASSWORD`. (If `.env` already
   exists it is left untouched — delete it to regenerate.) It creates
   `legal/legal.env` from its example.
4. Makes the helper scripts executable.
5. Mints the internal TLS CA + Keycloak server cert (the app project bind-mounts
   `internal-ca.pem`, so dev needs it too), renders the PgBouncer userlist, and
   runs the bind-mount preflight (`scripts/check-bind-sources.sh --all`).
6. B-01: prepares no realm. Keycloak starts with `master` only; the
   governance-only realm (the `gremion-ui` and `gremion-admin` clients) is
   composed from `docker/keycloak/realm-export.base.json` and created at
   tenant-create time. `CONFIG_PATH=… make gen-realm` writes a vertical's
   composed template to the gitignored `docker/keycloak/realm-export.json` for
   inspection only.
7. Creates the external networks and shared volumes (`make dev-networks`),
   builds the images (`make build`) and starts the state project, then the blue
   app colour (`make up`), then waits for `gremion-ui` to become healthy. There
   is no cross-project `depends_on`: `gremion-ui`'s own boot retry waits for
   Postgres.

`make up` is also the way to start the stack again later (`make down` stops it and
keeps the volumes).

---

## Verifying the Stack

```bash
# Container status and ports
make ps

# Endpoint health checks (gremion-ui :3001, Keycloak :8082, legal :8083)
make health

# Follow logs (all services, or a single one)
make logs
make logs SERVICE=gremion-ui
make logs SERVICE=keycloak
```

Expected from `make ps` — all containers `running`/`healthy`:

```
NAME                          STATUS          PORTS
dev-state-postgres-1          healthy         127.0.0.1:5433->5432/tcp
dev-state-keycloak-1          healthy         127.0.0.1:8082->8080/tcp
dev-state-legal-1             healthy         127.0.0.1:8083->8080/tcp
dev-state-mailpit-1           healthy         127.0.0.1:8026->8025/tcp
dev-app-blue-gremion-ui-1     healthy         127.0.0.1:3001->3000/tcp
dev-app-blue-gremion-public-1 healthy         127.0.0.1:3002->3000/tcp
```

(plus `governance-postgres`, `nats`, `vector`, `control-panel` and `kernel-api`,
which publish no port. The ports above are what `docker-compose.override.yml` and
`docker-compose.app.dev.yml` bind.)

Quick endpoint probes:

```bash
# Keycloak readiness
curl -sf http://localhost:8082/auth/health/ready          # → {"status":"UP"}

# Keycloak OIDC discovery for the realm named by AUTH_KEYCLOAK_ISSUER
curl -s http://localhost:8082/auth/realms/<realm>/.well-known/openid-configuration \
  | python3 -m json.tool | grep -E '"issuer"|"authorization_endpoint"'
# issuer → http://localhost:8082/auth/realms/<realm>

# Legal pages
curl -sf http://localhost:8083/impressum | grep -q Impressum && echo OK
```

> **Why the discovery document returns `localhost:8082` URLs.** The dev override
> sets `KC_HOSTNAME=http://localhost:8082/auth`, so the browser-facing redirect
> URLs in the discovery document are reachable from your host. Server-to-server
> token exchange inside the Docker network uses the internal `keycloak:8080`
> hostname instead (`AUTH_KEYCLOAK_INTERNAL`).

---

## Setting Up a Tenant

The kernel is multi-tenant and **fail-closed**: with no provisioned tenant the
resolver answers **404** on every host. The first-run Setup wizard and the
`default` tenant are gone (TASK-042, TRD-075); a tenant exists only after a
`create` request has run and bound its host. On a host that is the control panel's
"Neuer Mandant" request, run by the host executor
([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md), "Create a tenant").
This guide does not carry a verified local tenant-creation procedure: the
lifecycle one-shot needs the secret files and environment contract in
[ops/pooled-stack-layout.md](ops/pooled-stack-layout.md), which `make up` does not
create.

### The seed endpoint (test fixtures)

For repeatable smoke tests on a stack that has a bound tenant, seed a governance
fixture set (org-unit tree, committees, members, and a published protocol /
*Beschluss*) via the one-time seed endpoint. It is gated by `SEED_TOKEN` from
your `.env` and runs in the tenant context of the request's forwarded host:

```bash
# Token was generated into .env by setup.sh
SEED_TOKEN=$(grep '^SEED_TOKEN=' .env | cut -d= -f2)

curl -X POST \
  -H "X-Seed-Token: ${SEED_TOKEN}" \
  -H "X-Forwarded-Host: <a host bound to a tenant>" \
  http://localhost:3001/api/setup/seed
```

It answers `409` when `org_units` is not empty. Every seeded user is created in
Keycloak with the password from
`SEED_USER_PASSWORD`. `scripts/setup.sh` generates that value into your `.env`
and prints it once in its closing summary; re-read it at any time with
`grep '^SEED_USER_PASSWORD=' .env`. These fixtures are for local and demo use
only — never seed them into a real deployment (`GREMION_DISABLE_SEEDS=true`,
which `docker-compose.app.yml` already sets).

---

## Testing the Governance Surfaces

After seeding, sign in at **http://localhost:3001** (through the tenant's bound
host) with a seeded user (e.g. `dev.admin`) and the `SEED_USER_PASSWORD` from your
`.env`, then walk the governance domain:

| Surface | What to verify |
|---------|----------------|
| **Members** | The directory lists seeded members; roles/capabilities render; a member can be opened and edited per the role model. |
| **Org-unit tree / committees** | The council → committee → group hierarchy from the seed renders; committees show their assigned members. |
| **Protocols** | A committee's protocols (*Protokolle*) list and open; a draft can be created and saved. |
| **Resolutions / *Beschlüsse*** | Resolutions attached to a protocol display; publishing a *Beschluss* appends to the **hash-chained audit log (INV-1)** — the chain must stay verifiable. |
| **Decision rule / quorum (INV-5)** | A resolution records its quorum / decision-rule outcome; the engine rejects a decision that fails its rule. |
| **No tenant** | On a fresh volume (no tenant) every host answers 404 and `/healthz` answers `200`; a provisioned tenant makes the surfaces above reachable. |

> Use **governance** examples for any manual test data — committees, members,
> protocols, resolutions. The finance, voting, file and messaging surfaces belong
> to the feature modules, which the default local stack does not run.

The SSO round-trip is part of every surface test: clicking **Sign in** should
redirect to `http://localhost:8082/auth/realms/<realm>/...`, accept the seeded
credentials, and return you to the app authenticated.

---

## Public Portal

`gremion-public` (http://localhost:3002) is the **read-only**, unauthenticated
portal. It connects to Postgres as the dedicated `gremion_public_reader` role and
has no sessions. After seeding, verify that **published** protocols and
resolutions appear publicly while drafts do not, and that the Impressum / contact
fields (set via the `PUBLIC_CONTACT_*` env vars) render.

PDF links on the public portal redirect the browser to the main app
(`PUBLIC_MAIN_APP_URL`), which holds the document credentials — the anonymous
portal deliberately holds none.

---

## Smoke-Test Checklist

### Infrastructure
- [ ] `make ps` shows all default services `healthy`
- [ ] Postgres reachable: `$DS exec postgres pg_isready -U postgres`
- [ ] Keycloak ready: `curl -sf http://localhost:8082/auth/health/ready` → `{"status":"UP"}`
- [ ] `gremion-ui` reachable: `make health` reports `gremion-ui (3001): OK`
- [ ] Control-plane and app databases migrated (no boot 503 from missing migrations in `make logs SERVICE=gremion-ui`)

### Identity
- [ ] Keycloak admin UI at http://localhost:8082/auth/admin is accessible
- [ ] The `<realm>` realm exists with the `gremion-ui` and `gremion-admin` clients
- [ ] SSO login from the app redirects to Keycloak and back

### Governance domain (after Setup / seed)
- [ ] Tenant provisioned (its host no longer answers 404)
- [ ] Members directory loads and reflects the seeded roles
- [ ] Committee / org-unit tree renders
- [ ] A protocol can be opened and a draft saved
- [ ] Publishing a resolution appends to the audit chain (INV-1) and the chain verifies
- [ ] A quorum/decision-rule outcome is recorded (INV-5)

### Public portal
- [ ] http://localhost:3002 loads
- [ ] Published protocols/resolutions are visible; drafts are not
- [ ] Impressum / contact fields render

---

## Common Issues & Fixes

### Every host answers 404

**Cause:** No tenant has been provisioned on a fresh volume, or the request's
host is not bound to one — this is the expected fail-closed state, not an error.

**Fix:** Create a tenant and bind its host
([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md)), then send that
host as `X-Forwarded-Host` (and `x-proxy-trust` when `TENANT_PROXY_SHARED_SECRET`
is set). A tenant whose stored config lacks a brand identity answers a
tenant-scoped 503 instead, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-tenant-answers-503-incomplete-brand-identity).

---

### SSO redirect goes to an unreachable URL

**Symptom:** After clicking sign-in you land on `keycloak:8080/...` (not
resolvable in the browser).

**Cause:** `KC_HOSTNAME` is not set, so the discovery document advertises the
internal Docker hostname.

**Fix:** Ensure `docker-compose.override.yml` is present (it is auto-loaded) — it
sets `KC_HOSTNAME=http://localhost:8082/auth` and runs Keycloak in `start-dev`.
Then `$DS restart keycloak`.

---

### Keycloak: "Invalid redirect_uri"

**Cause:** The client's valid redirect URIs in the realm don't match the app's
callback.

**Fix:** In Keycloak Admin → the `<realm>` realm → **Clients** → `gremion-ui`, confirm
the app's callback URL is listed under **Valid redirect URIs**. The defaults come
from `docker/keycloak/realm-export.base.json` and are stamped into the realm when
tenant-create composes it (B-01: nothing is imported at boot, so re-running
`make setup` does not restore them) — add the URI in the console, or recreate
the realm.

---

### `gremion-ui` health check times out / boot 503

**Cause:** The control-plane registry database wasn't created, so
`runControlMigrations()` fails and every request 503s; or Postgres was not yet
reachable when `gremion-ui` started (it has no `depends_on` on the state project;
its boot retry waits up to the 60-attempt budget, and a non-transient failure
restarts the container).

**Fix:**
```bash
make logs SERVICE=gremion-ui            # read the actual boot error
$DS exec postgres pg_isready -U postgres
$DA restart gremion-ui
```
On an existing Postgres volume that predates the control DB, follow the one-shot
in `docs/runbooks/tenant-edge.md` to create the `control` database, then restart.

---

### Port conflicts

**Symptom:** `make up` fails with "port is already allocated".

**Fix:** Free the conflicting port or change the host port in
`docker-compose.override.yml` (Keycloak, Mailpit, Postgres) or
`docker-compose.app.dev.yml` (`gremion-ui`, `gremion-public`). Default loopback
bindings: `3001` (gremion-ui), `3002` (gremion-public), `8082` (Keycloak), `8083`
(legal, from `docker-compose.yml`), `8026` (Mailpit web UI), `5433` (Postgres).

```bash
# Linux/macOS
lsof -ti:3001 | xargs kill -9
```

---

### No mail arrives

**Cause:** In local dev all outbound mail is captured by **Mailpit**, not sent.

**Fix:** Read trapped messages at http://localhost:8026. Switching to a real
relay is a `.env`-only change (see `docs/runbooks/email-smtp.md`).

---

## Make Commands Reference

### Service lifecycle
```bash
make setup              # First-run: generate secrets, build, start both projects
make up                 # Start the state project, then the blue app colour
make down               # Stop both projects (preserve volumes)
make build              # Build the custom images (tagged dev)
make rebuild            # Rebuild and force-recreate both projects
make ps                 # Show running containers of both projects
make health             # Endpoint health checks
make dev-networks       # Create the external dev networks and shared volumes (idempotent)
make update-legal       # Rebuild + recreate only the legal service
```

### Logs & shells
```bash
make logs                       # Follow all service logs (both projects)
make logs SERVICE=gremion-ui      # Follow one service
make shell-kc                   # bash inside the Keycloak container
make shell-db                   # psql inside Postgres (as postgres)
```

### Keycloak & dev
```bash
make keycloak-configure   # Sync OIDC client secrets from .env into Keycloak
make dev-configure        # Patch gremion-ui/.env.local + KC redirect URIs for the Vite dev server
make dev-ui               # Start the Vite dev server (after dev-configure) — see DEVELOPMENT.md
make gen-realm            # Write the module-composed realm template to realm-export.json (needs a config.json; inspection only)
```

### Validation & tests
```bash
make validate-env         # Fail if .env still has CHANGE_ME_ placeholders
make lint                 # shellcheck + yamllint + JSON + `docker compose config`
make test                 # bats unit tests (no running stack needed)
make test-all             # unit + integration + NATS/events proofs (the integration part needs a running stack)
```

---

## Credentials

All credentials are generated into `.env` by `make setup`. Read them with:

```bash
grep -E '^(KEYCLOAK_ADMIN|POSTGRES_PASSWORD|SEED_TOKEN|SEED_USER_PASSWORD)' .env
```

| What | URL / Host | Username | Password variable |
|------|-----------|----------|-------------------|
| App (gremion-ui) | http://localhost:3001 | seeded users (e.g. `dev.admin`) | `SEED_USER_PASSWORD` |
| Keycloak admin | http://localhost:8082/auth/admin | `admin` | `KEYCLOAK_ADMIN_PASSWORD` |
| PostgreSQL | localhost:5433 | `postgres` | `POSTGRES_PASSWORD` |
| Seed endpoint | `POST /api/setup/seed` | — (header) | `SEED_TOKEN` (sent as `X-Seed-Token`) |

> **Never commit `.env`.** It is git-ignored and holds every secret. `setup.sh`
> writes it `0600`.

---

## Cleanup

```bash
# Stop services, keep all data
make down

# Stop and DELETE all data (full reset of the project-scoped volumes)
make down && $DS down -v && $DA down -v

# Also remove the locally-built images
$DS down -v --rmi local && $DA down -v --rmi local

# Clean slate — then re-run setup
make down && $DS down -v --rmi local && $DA down -v --rmi local
rm .env
./scripts/setup.sh
```

`down -v` deletes the project-scoped volumes of the state project
(`dev-state_pg-data`, `dev-state_mailpit-data`, the log volumes and the module
database volumes). The external volumes (`dev_config_data`,
`dev_tenant_config_data`, `dev_nats_accounts`, `dev_nats_secrets`,
`dev_traefik_acme`) and the networks `dev_state` and `dev_edge` stay; remove them
with `docker volume rm` / `docker network rm` for a full reset. The compose files
in this repository no longer name the old global `gremion_*` volumes or the
`gremion_net` network, so data from before the two-project split is not reachable
(the dev stack re-seeds).

---

## Production Deployment

A production host is not set up with `setup.sh`. It is built with
`infra/host/bootstrap.sh`, its env files are rendered by `gremion-init-secrets`
for the real domain, and a release is brought up with `gremion-deploy`
([deployment.md](deployment.md#single-host-production),
[ops/runbook/install.md](ops/runbook/install.md)). The production profile adds
Traefik + the docker-socket-proxy, and `docker-compose.prod.yml` adds PgBouncer,
the fallback page and the internal-TLS Keycloak listener. Production wiring
(tenant edge routing, internal TLS, PgBouncer, SMTP, backups) is covered in
`docs/runbooks/` and `docs/ops/runbook/`.
