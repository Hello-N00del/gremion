# Gremion — Local Testing Guide

A hands-on guide to running and smoke-testing the **Gremion governance kernel**
locally with Docker Compose. No domain, no DNS, and no TLS certificates are
required — every service is exposed on a loopback port.

This is the **operational / manual-test** layer. For the vision, the three-layer
open-core architecture, the governance charter and invariants, the module SDK,
and the repo/product family, read **[about-gremion.md](./about-gremion.md)**.
For the in-process developer inner loop (Vite dev server, `pnpm` checks, unit
tests), see **[DEVELOPMENT.md](./DEVELOPMENT.md)**.

> **Governance-only kernel.** This repository ships the kernel and the
> governance domain only — identity & auth, multi-tenancy, the committee /
> org-unit / protocol / resolution model, the public portal, and the governance
> invariants. Feature modules (finance, voting, content, calendar, files,
> messaging, …) live in **separate repositories** and are not present here, so
> there are no setup steps, services, or test flows for them in this guide.

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
there is no reverse proxy in front of the stack. The default (non-production)
profile brings up seven services:

```
Browser
   │
   ├── http://localhost:3001        →  gremion-ui      (admin shell / governance app)
   ├── http://localhost:3002        →  gremion-public  (read-only public portal)
   ├── http://localhost:8082/auth   →  keycloak      (OIDC identity provider)
   ├── http://localhost:8083        →  legal         (static Impressum / GDPR pages)
   └── http://localhost:8026        →  mailpit       (captured-mail web UI)

Internal Docker network (gremion_net):
   postgres:5432   ←  keycloak, gremion-ui, gremion-public
   mailpit:1025    ←  gremion-ui   (SMTP; nothing leaves the host)
   vector          →  tails Traefik access logs (idle in dev — no Traefik)
```

> The admin shell app is **`gremion-ui`**, and the Keycloak realm is still named
> **`sturaos`** — naming debt carried into 0.1.0, see
> [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) — with clients **`gremion-ui`** and
> **`gremion-admin`**. The **production** profile additionally starts Traefik and
> a read-only docker-socket-proxy (`docker-compose.yml`, `profiles: [production]`),
> plus PgBouncer and cloudflared from `docker-compose.prod.yml`. None of those
> run in local dev.

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
then prints the app URL. Open:

- **App (admin shell):** http://localhost:3001
- **Keycloak admin:** http://localhost:8082/auth/admin
- **Public portal:** http://localhost:3002

A freshly-initialised kernel has no tenant yet, so the app responds with a
**503 "incomplete brand identity / Setup needed"** until you provision one — see
[Setting Up a Tenant](#setting-up-a-tenant).

---

## What `setup.sh` Does

`scripts/setup.sh` (or `make setup`) is idempotent on the `.env` file and:

1. Checks for `docker`, `docker compose`, and `openssl`.
2. Prompts for a **domain** — press **Enter** for `localhost`.
3. Copies `.env.example` to `.env` (mode `600`) and generates random secrets for
   every `CHANGE_ME_*` placeholder, plus `AUTH_SECRET`, the OIDC client secrets,
   `SEED_TOKEN`, and `RESTIC_PASSWORD`. (If `.env` already exists it is left
   untouched — delete it to regenerate.)
4. Makes the helper scripts executable.
5. Mints the internal TLS CA + Keycloak server cert (used only by the production
   overlay; harmless to pre-generate in dev).
6. Ensures `docker/keycloak/realm-export.json` exists. The kernel ships a
   committed **governance-only** realm (the `gremion-ui` and `gremion-admin` clients
   only); it is only regenerated from module manifests when a vertical's
   `config.json` is supplied (`CONFIG_PATH=… make gen-realm`).
7. Builds the images and starts `postgres`, `keycloak`, and `gremion-ui`, then
   waits for `gremion-ui` to become healthy.

To start the remaining default services (public portal, legal, mailpit, vector)
as well, run `make up` after setup.

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
NAME                STATUS          PORTS
gremion-postgres    healthy         127.0.0.1:5433->5432/tcp
gremion-keycloak    healthy         127.0.0.1:8082->8080/tcp
gremion-gremion-ui    healthy         127.0.0.1:3001->3000/tcp
gremion-gremion-public healthy        127.0.0.1:3002->3000/tcp
gremion-legal       healthy         127.0.0.1:8083->8080/tcp
gremion-mailpit     healthy         127.0.0.1:8026->8025/tcp
```

(Container names depend on your compose project name; the ports above are what
`docker-compose.override.yml` binds.)

Quick endpoint probes:

```bash
# Keycloak readiness
curl -sf http://localhost:8082/auth/health/ready          # → {"status":"UP"}

# Keycloak OIDC discovery for the sturaos realm
curl -s http://localhost:8082/auth/realms/sturaos/.well-known/openid-configuration \
  | python3 -m json.tool | grep -E '"issuer"|"authorization_endpoint"'
# issuer → http://localhost:8082/auth/realms/sturaos

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
resolver returns a Setup-needed response. There are two ways to bring a tenant
up locally.

### Option A — the Setup wizard (interactive)

Open **http://localhost:3001** and follow the in-app Setup flow to create the
default tenant's brand identity, org root, and first administrator. This is the
path a real operator uses on a fresh deployment.

### Option B — the seed endpoint (test fixtures)

For repeatable smoke tests, seed a governance fixture set (org-unit tree,
committees, members, and a published protocol / *Beschluss*) via the one-time
seed endpoint. It is gated by `SEED_TOKEN` from your `.env`:

```bash
# Token was generated into .env by setup.sh
SEED_TOKEN=$(grep '^SEED_TOKEN=' .env | cut -d= -f2)

curl -X POST \
  -H "X-Seed-Token: ${SEED_TOKEN}" \
  http://localhost:3001/api/setup/seed
```

Every seeded user is created in Keycloak with the password from
`SEED_USER_PASSWORD`. `scripts/setup.sh` generates that value into your `.env`
and prints it once in its closing summary; re-read it at any time with
`grep '^SEED_USER_PASSWORD=' .env`. These fixtures are for local and demo use
only — never seed them into a real deployment (`GREMION_DISABLE_SEEDS=true`,
which the dev override already sets).

---

## Testing the Governance Surfaces

After seeding (Option B) or completing the wizard (Option A), sign in at
**http://localhost:3001** with a seeded user (e.g. `dev.admin`) and the
`SEED_USER_PASSWORD` from your `.env`, then walk the governance domain:

| Surface | What to verify |
|---------|----------------|
| **Members** | The directory lists seeded members; roles/capabilities render; a member can be opened and edited per the role model. |
| **Org-unit tree / committees** | The council → committee → group hierarchy from the seed renders; committees show their assigned members. |
| **Protocols** | A committee's protocols (*Protokolle*) list and open; a draft can be created and saved. |
| **Resolutions / *Beschlüsse*** | Resolutions attached to a protocol display; publishing a *Beschluss* appends to the **hash-chained audit log (INV-1)** — the chain must stay verifiable. |
| **Decision rule / quorum (INV-5)** | A resolution records its quorum / decision-rule outcome; the engine rejects a decision that fails its rule. |
| **Setup wizard** | On a fresh volume (no tenant) the app returns Setup-needed; completing the wizard makes the surfaces above reachable. |

> Use **governance** examples for any manual test data — committees, members,
> protocols, resolutions. There are no finance, voting, file, or messaging
> surfaces in the kernel.

The SSO round-trip is part of every surface test: clicking **Sign in** should
redirect to `http://localhost:8082/auth/realms/sturaos/...`, accept the seeded
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
- [ ] Postgres reachable: `docker compose exec postgres pg_isready -U postgres`
- [ ] Keycloak ready: `curl -sf http://localhost:8082/auth/health/ready` → `{"status":"UP"}`
- [ ] `gremion-ui` reachable: `make health` reports `gremion-ui (3001): OK`
- [ ] Control-plane and app databases migrated (no boot 503 from missing migrations in `make logs SERVICE=gremion-ui`)

### Identity
- [ ] Keycloak admin UI at http://localhost:8082/auth/admin is accessible
- [ ] The `sturaos` realm exists with the `gremion-ui` and `gremion-admin` clients
- [ ] SSO login from the app redirects to Keycloak and back

### Governance domain (after Setup / seed)
- [ ] Tenant provisioned (no Setup-needed 503)
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

### App returns 503 "incomplete brand identity" / Setup needed

**Cause:** No tenant has been provisioned on a fresh volume — this is the
expected fail-closed state, not an error.

**Fix:** Complete the Setup wizard at http://localhost:3001, or seed fixtures via
`POST /api/setup/seed` (see [Setting Up a Tenant](#setting-up-a-tenant)).

---

### SSO redirect goes to an unreachable URL

**Symptom:** After clicking sign-in you land on `keycloak:8080/...` (not
resolvable in the browser).

**Cause:** `KC_HOSTNAME` is not set, so the discovery document advertises the
internal Docker hostname.

**Fix:** Ensure `docker-compose.override.yml` is present (it is auto-loaded) — it
sets `KC_HOSTNAME=http://localhost:8082/auth` and runs Keycloak in `start-dev`.
Then `docker compose restart keycloak`.

---

### Keycloak: "Invalid redirect_uri"

**Cause:** The client's valid redirect URIs in the realm don't match the app's
callback.

**Fix:** In Keycloak Admin → `sturaos` realm → **Clients** → `gremion-ui`, confirm
the app's callback URL is listed under **Valid redirect URIs**. The committed
`realm-export.json` includes the defaults; if it was overwritten, re-run
`make setup` (regenerates nothing if `.env` exists but re-imports on a clean
Keycloak volume) or add the URI manually.

---

### `gremion-ui` health check times out / boot 503

**Cause:** The control-plane registry database wasn't created, so
`runControlMigrations()` fails and every request 503s; or Keycloak/Postgres were
not yet healthy when `gremion-ui` started (it has `depends_on: service_healthy`,
but a half-initialised volume can still trip it).

**Fix:**
```bash
make logs SERVICE=gremion-ui            # read the actual boot error
docker compose exec postgres pg_isready -U postgres
docker compose restart gremion-ui
```
On an existing Postgres volume that predates the control DB, follow the one-shot
in `docs/runbooks/tenant-edge.md` to create the `control` database, then restart.

---

### Port conflicts

**Symptom:** `docker compose up` fails with "port is already allocated".

**Fix:** Free the conflicting port or change the host port in
`docker-compose.override.yml`. Default loopback bindings: `3001` (gremion-ui),
`3002` (gremion-public), `8082` (Keycloak), `8083` (legal), `8026` (Mailpit web
UI), `5433` (Postgres).

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
make setup              # First-run: generate secrets + realm, build, start core services
make up                 # Start all default services
make down               # Stop services (preserve volumes)
make build              # Build the custom images
make rebuild            # Rebuild and force-recreate all services
make ps                 # Show running containers
make health             # Endpoint health checks
```

### Logs & shells
```bash
make logs                       # Follow all service logs
make logs SERVICE=gremion-ui      # Follow one service
make shell-kc                   # bash inside the Keycloak container
make shell-db                   # psql inside Postgres (as postgres)
```

### Keycloak & dev
```bash
make keycloak-configure   # Sync OIDC client secrets from .env into Keycloak
make dev-configure        # Patch gremion-ui/.env.local + KC redirect URIs for the Vite dev server
make dev-ui               # Start the Vite dev server (after dev-configure) — see DEVELOPMENT.md
make gen-realm            # Regenerate realm-export.json from module manifests (needs a config.json)
```

### Validation & tests
```bash
make validate-env         # Fail if .env still has CHANGE_ME_ placeholders
make lint                 # shellcheck + yamllint + JSON + `docker compose config`
make test                 # bats unit tests (no running stack needed)
make test-all             # unit + integration tests (requires a running stack)
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

# Stop and DELETE all data (full reset of named volumes)
docker compose down -v

# Also remove the locally-built images
docker compose down -v --rmi local

# Clean slate — then re-run setup
docker compose down -v --rmi local
rm .env
./scripts/setup.sh
```

`down -v` deletes the kernel's named volumes (`gremion_pg_data`,
`gremion_mailpit_data`, `gremion_config_data`, `gremion_tenant_config_data`, and
the log volumes). The Docker network is `gremion_net`.

---

## Production Deployment

When you are ready to deploy against a real domain, regenerate `.env` with that
domain and bring the stack up with the production profile:

```bash
rm .env
./scripts/setup.sh
# Enter your domain when prompted, e.g. gov.example.org
```

The production profile adds Traefik + the docker-socket-proxy, and
`docker-compose.prod.yml` adds PgBouncer + cloudflared and the internal-TLS
Keycloak listener. Production wiring (tenant edge routing, internal TLS,
PgBouncer, SMTP, backups) is covered in `docs/runbooks/`.