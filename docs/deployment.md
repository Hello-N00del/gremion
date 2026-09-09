# Deployment Guide

This is the operational layer: how to stand up the **Gremion governance
kernel** on a single host or a managed Kubernetes cluster. For the vision,
architecture, and governance charter, see
[About Gremion](./about-gremion.md).

Gremion is an open, self-hostable digital-governance kernel (AGPL-3.0-only). The
kernel ships identity & auth (Keycloak OIDC, role/capability model, LoA/ACR
step-up), multi-tenancy (tenant resolver, control-plane registry, fleet
migrations), the governance domain (committees, members, org-unit tree,
protocols, resolutions/*Beschlüsse*, public portal), the governance invariant
hooks (hash-chained audit log, quorum/decision-rule engine, tenant isolation),
and the module SDK. Feature modules (elections, newsletter, calendar,
files, messages, board, users, finance, content, vault, handover)
are **not** part of the kernel — each lives in its own repository and
integrates over the module SDK, as a separate service over a stable API where
it has its own store.

## What gets deployed

The governance-only kernel runs **7 default services**:

| Service | Image | Role |
|---------|-------|------|
| `postgres` | `postgres:16-alpine` | Database for Keycloak, the app data plane, and the tenancy control plane |
| `keycloak` | `quay.io/keycloak/keycloak` | Identity provider (OIDC/SSO, realms, LoA/ACR step-up) |
| `gremion-ui` | `ghcr.io/hello-n00del/gremion-ui` † | The admin shell — unified SvelteKit app, built from `gremion-ui/` |
| `gremion-public` | `ghcr.io/hello-n00del/gremion-public` † | Read-only public portal (no auth, no sessions), built from `gremion-public/` |
| `legal` | `ghcr.io/hello-n00del/gremion-legal` † | Static legal/imprint pages (Impressum, GDPR), built from `docker/legal/` |
| `vector` | `ghcr.io/hello-n00del/gremion-vector` † | Log pipeline with `ipcrypt-nd` IP pseudonymisation + retention, built from `docker/vector/` |
| `mailpit` | `axllent/mailpit` | SMTP catcher for local/staging mail (swap for a real relay via `.env`) |

> **† First-party images are BUILT here, not pulled.** All five
> `ghcr.io/hello-n00del/gremion-*` images — `gremion-ui`, `gremion-public`,
> `gremion-legal`, `gremion-vector`, and `gremion-fallback` from the production
> overlay — carry a `build:` section in `docker-compose.yml` /
> `docker-compose.prod.yml`, and `make build` (`docker compose build`) produces
> them locally. The kernel has **no image-publish workflow**: nothing under
> `.github/workflows` runs `docker push`, so that coordinate is the name these
> images are *built as*, not one you can pull today. Build them yourself, or
> push them to a registry you control and repoint the reference (Path 2,
> Step 2).
>
> Write the registry host out in full. An unqualified name such as
> `gremion/<service>` resolves to `docker.io/<that same string>` — a Docker Hub
> namespace owned by an unrelated third party, not by this project. A CI guard
> in `.github/workflows/ci.yml` fails the build if a first-party image ever
> loses its `build:` section (which would make it pullable), and
> `scripts/kernel-hygiene-check.mjs` fails `make lint` if a manifest or a doc
> reintroduces the unqualified coordinate.

The **production profile** (`profiles: [production]` in
`docker-compose.yml`) adds two more for edge routing:

| Service | Role |
|---------|------|
| `traefik` | Reverse proxy / TLS termination at the edge |
| `docker-socket-proxy` | Read-only Docker API gateway so Traefik never mounts the raw socket |

And `docker-compose.prod.yml` layers on the production-only services:

| Service | Role |
|---------|------|
| `pgbouncer` | Transaction-pooling front for the app's data-plane connections |
| `cloudflared` | Outbound-only Cloudflare Tunnel connector (no inbound host ports) |
| `fallback` | Friendly "starting" page served while `gremion-ui` is mid-cold-start — the fifth first-party image (`ghcr.io/hello-n00del/gremion-fallback`, built from `docker/fallback/`) |

There are two supported deployment paths:

1. **Single-host Docker Compose** — the primary path. Best for local
   development, evaluation, and self-hosted single-node production behind a
   Cloudflare Tunnel.
2. **Kubernetes (Kustomize)** — the portable reference path, rendered and
   validated on a local k3d cluster. All resources live in the `gremion-system`
   namespace.

---

## Path 1 — Docker Compose

### Prerequisites

- Docker Engine with Compose v2 (`docker compose version`)
- `openssl` (used by `scripts/setup.sh` to generate secrets)
- `make` (optional convenience wrapper around the `docker compose` calls)

### Local development / evaluation

```bash
git clone <your-fork> gremion && cd gremion
cp .env.example .env
./scripts/setup.sh          # or: make setup
```

`scripts/setup.sh` prompts for a domain (press Enter for `localhost`), fills
`.env` from `.env.example`, generates random secrets for every `CHANGE_ME_`
placeholder, mints the internal TLS certs, regenerates the Keycloak realm
export, then builds and starts the core services.

In local dev (`docker-compose.override.yml`, auto-loaded) the services are
published on loopback host ports:

| Service | URL |
|---------|-----|
| `gremion-ui` (admin shell) | <http://localhost:3001> |
| `gremion-public` (portal) | <http://localhost:3002> |
| Keycloak | <http://localhost:8082/auth> |
| Legal pages | <http://localhost:8083/impressum> |
| Mailpit (trapped mail) | <http://localhost:8026> |

> **Host ports bind loopback only (`127.0.0.1` + `[::1]`), deliberately.** The
> tenant resolver selects a tenant from the inbound `x-forwarded-host`; a
> `0.0.0.0` bind would let an off-host client set that header and select any
> tenant. A `check` guard (`gremion-ui/scripts/check-app-port-binding.mjs`)
> enforces the loopback binding.

Common lifecycle commands (see the `Makefile` for the full list):

```bash
make up                 # docker compose up -d
make ps                 # running containers
make logs SERVICE=gremion-ui
make health             # service + endpoint health summary
make down               # stop (volumes preserved)
make validate-env       # fail if .env still has CHANGE_ME_ placeholders
```

### Seeding governance fixtures (optional)

The kernel seeds via a one-time endpoint rather than a script. With
`SEED_TOKEN` set in `.env`:

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" \
  http://localhost:3001/api/setup/seed
```

This provisions the structure-aware governance fixtures (committees, members,
org-units). Leave `SEED_TOKEN` empty to disable the endpoint. In production,
`GREMION_DISABLE_SEEDS=true` keeps dev seed migrations out of the data plane.

### Single-host production

Production loads both compose files explicitly (the prod overlay is **not**
auto-loaded):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Before bringing the stack up, set the production values in `.env`:

- **`DOMAIN`** — your real domain (e.g. `gov.example.org`).
- **`DOMAIN_REGEX`** — the regexp-escaped `DOMAIN` (e.g. `gov\.example\.org`).
  **Required whenever `DOMAIN` is a real domain.** The Traefik wildcard routers
  match tenant subdomains via `HostRegexp`; if `DOMAIN_REGEX` is left empty the
  wildcard leg renders the dead pattern `^[a-z0-9-]+\.$`, which matches **no**
  tenant host — every tenant subdomain then 404s at Traefik while the apex host
  still works and masks the misconfiguration. This is a silent misconfig, not a
  safe fail-closed. `pnpm -C gremion-ui check`
  (`scripts/check-domain-regex.mjs`) fails the build if a real `DOMAIN` is set
  with an empty `DOMAIN_REGEX`.
- **`KC_ADMIN_ALLOWLIST_CIDRS`** — CIDRs allowed to reach the Keycloak admin
  console at `https://${DOMAIN}/auth/admin`. Defaults to `127.0.0.1/32`, so by
  default no external request matches; operators reach the console via
  `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh ...`.
- **`TENANT_PROXY_SHARED_SECRET`** — when set, Traefik stamps an `x-proxy-trust`
  header on every request reaching `gremion-ui`, and the tenant resolver 403s any
  request lacking a match, so `x-forwarded-host` trust no longer rests on
  network topology alone. Unset = the gate is a byte-identical no-op.
- TLS, PgBouncer auth, backup, and tunnel values per the comments in
  `.env.example`.

> **Reload `.env` with a recreate, not a restart.** A plain
> `docker compose restart` does **not** re-read `.env`. After changing an
> environment value, use `docker compose up -d --force-recreate <service>` and
> verify the value inside the container before declaring the change live.

The internal-TLS / Cloudflare-Tunnel topology (Keycloak `:8443` internal
listener, `cloudflared` outbound tunnel to `traefik:443`, the per-tenant edge
routing) is described inline in `docker-compose.prod.yml`. The reference
single-host production deployment terminates TLS at Traefik with a Cloudflare
Origin Certificate and is reached only through an outbound Cloudflare Tunnel —
no inbound ports are opened on the host.

### Updating the legal pages

```bash
make update-legal       # rebuild + recreate only the legal service (~2s)
```

The legal pages read from `legal/legal.env` (copy from
`legal/legal.env.example`).

---

## Path 2 — Kubernetes (Kustomize)

The portable target is a managed Kubernetes cluster using Kustomize overlays;
all services run in the `gremion-system` namespace. The manifests live under
`k8s/` (`base/` + provider overlays in `overlays/`).

### Prerequisites

- `kubectl` 1.28+ configured for your cluster
- `helm` 3.14+
- `docker` with BuildKit enabled (`DOCKER_BUILDKIT=1`)
- A container registry (GHCR, ECR, GCR, or ACR)
- DNS control for your domain

### Step 1 — Clone and configure

```bash
git clone <your-fork> gremion && cd gremion
cp .env.example .env
# Edit .env — fill in all CHANGE_ME values.
# Generate a secret:  openssl rand -hex 32
```

### Step 2 — Build and push images

`k8s/base` pins **four** first-party images — `gremion-ui`, `gremion-public`,
`gremion-legal` and `gremion-vector` — and this repository publishes **none** of
them (`git grep 'docker push' -- .github/ Makefile scripts/` returns nothing).
Build and push **all four**; every one you skip leaves its workload in
`ImagePullBackOff`, and `vector` is a DaemonSet, so that failure lands on every
node.

Tag them with the kernel version (`0.1.0`, from `package.json`) rather than
`:latest` — `k8s/base` pins that version, a mutable tag makes a rollback
unreproducible, and a CI guard rejects `:latest` anywhere under `k8s/`.

```bash
# Admin shell (gremion-ui)
DOCKER_BUILDKIT=1 docker build \
  -f gremion-ui/Dockerfile \
  -t ghcr.io/YOUR_ORG/gremion-ui:0.1.0 .
docker push ghcr.io/YOUR_ORG/gremion-ui:0.1.0

# Public portal (gremion-public)
DOCKER_BUILDKIT=1 docker build \
  -f gremion-public/Dockerfile \
  -t ghcr.io/YOUR_ORG/gremion-public:0.1.0 .
docker push ghcr.io/YOUR_ORG/gremion-public:0.1.0

# Legal / imprint pages
DOCKER_BUILDKIT=1 docker build \
  -t ghcr.io/YOUR_ORG/gremion-legal:0.1.0 docker/legal
docker push ghcr.io/YOUR_ORG/gremion-legal:0.1.0

# Log pipeline (Vector + the ipcrypt-nd pseudonymisation library)
DOCKER_BUILDKIT=1 docker build \
  -t ghcr.io/YOUR_ORG/gremion-vector:0.1.0 docker/vector
docker push ghcr.io/YOUR_ORG/gremion-vector:0.1.0
```

Then repoint the cluster at your tags. The **preferred** way is a kustomize
`images:` block in your overlay — every overlay in `k8s/overlays/` ships a
commented, copy-pasteable example — because it leaves `k8s/base` untouched and
keeps `git pull` conflict-free:

```yaml
images:
  - name: ghcr.io/hello-n00del/gremion-ui
    newName: ghcr.io/YOUR_ORG/gremion-ui
    digest: sha256:<digest of the image you pushed>
  # …and the same three-line entry for gremion-public, gremion-legal and
  # gremion-vector.
```

Editing the `image:` lines in `k8s/base/gremion-ui/deployment.yaml`,
`k8s/base/gremion-public/deployment.yaml`, `k8s/base/legal/deployment.yaml` and
`k8s/base/vector/daemonset.yaml` works too, at the cost of a merge conflict on
every upgrade. See the IMAGE REFERENCES block in `k8s/base/kustomization.yaml`.

### Step 3 — Install cluster prerequisites

```bash
./scripts/install-ingress.sh --email admin@example.org
```

This installs (pinned versions — check for newer releases before a real
deploy):

- `nginx-ingress-controller` (LoadBalancer service)
- `cert-manager` with Let's Encrypt staging + production issuers and a
  self-signed issuer

### Step 4 — Configure DNS

After `install-ingress.sh` finishes, read the load balancer endpoint:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
# Copy the EXTERNAL-IP
```

Create a DNS A/CNAME record pointing your domain at that endpoint and wait for
propagation (usually 5–15 minutes) before continuing.

### Step 5 — Create secrets

**Development** (placeholder Secrets generated from `.env` via the Kustomize
`secretGenerator`):

```bash
kubectl apply -k k8s/overlays/dev/
```

**Production** (SOPS age-encrypted Secrets). The workflow and scripts live in
`k8s/overlays/production/secrets/`:

```bash
# One-time per operator workstation — generates an age key, prints the
# public half, walks the handoff:
bash k8s/overlays/production/secrets/bootstrap-sops.sh

# For each Secret: copy the matching document out of
# secrets/_templates.example.yaml, replace every <PLACEHOLDER>, then:
bash k8s/overlays/production/secrets/encrypt-all.sh
# -> writes secrets/<name>.enc.yaml and removes the plaintext
```

Then uncomment the matching `secretGenerator` block in
`k8s/overlays/production/kustomization.yaml`. **Do not** uncomment a block
until its `.enc.yaml` file exists — `kustomize build` fails otherwise (a CI
grep guard checks for missing `.enc.yaml` paths).

### Step 6 — Deploy

> `k8s/base/kustomization.yaml` intentionally reads a few files from outside
> its own directory tree (`docker/keycloak/realm-export.json` +
> `substitute-realm-secrets.sh`, shared with docker-compose; the dev overlay's
> `secretGenerator`s also read the root `.env` and `legal/legal.env`). Recent
> kustomize/kubectl versions reject that by default
> (`LoadRestrictionsRootOnly`), so every build needs
> `--load-restrictor LoadRestrictionsNone`. `kubectl apply -k` does **not**
> expose that flag, so it cannot build these overlays — always pipe
> `kustomize build` into `kubectl apply -f -` instead (see below).

```bash
# Generic managed cluster (default StorageClass)
kustomize build --enable-alpha-plugins --load-restrictor LoadRestrictionsNone k8s/overlays/production | kubectl apply -f -

# Or a provider overlay (kubectl apply -k CANNOT be used — see note above):
kustomize build --load-restrictor LoadRestrictionsNone k8s/overlays/gke | kubectl apply -f -
kustomize build --load-restrictor LoadRestrictionsNone k8s/overlays/eks | kubectl apply -f -
kustomize build --load-restrictor LoadRestrictionsNone k8s/overlays/aks | kubectl apply -f -
```

> The Keycloak base realm export (`docker/keycloak/realm-export.json`,
> imported via a `configMapGenerator`) contains **no users**. Hard-coded dev
> accounts live only in the `dev` overlay; production overlays must not import
> them. OIDC client-secret sentinels in the realm export are replaced at pod
> start by the `substitute-realm-secrets` initContainer using values from the
> `keycloak-secret` Secret.

### Step 7 — Verify

```bash
kubectl get pods -n gremion-system            # all should be Running
kubectl get ingress -n gremion-system         # ADDRESS should be set
kubectl describe certificate -n gremion-system  # TLS cert should be Ready

curl -I https://YOUR_DOMAIN/auth/health/ready   # Keycloak: 200 OK
curl -I https://YOUR_DOMAIN/                    # admin shell apex
```

### Updating the legal pages (Kubernetes)

```bash
make update-legal-k8s   # re-applies the legal-config Secret, then rolls the deployment
```

This re-applies the Secret first — a `rollout restart` alone would serve stale
values.

---

## Upgrading

**`gremion-ui` and `gremion-public`**: rebuild from source, push the new tag, then
redeploy (Compose recreate, or bump the image tag and re-apply the Kustomize
overlay). SvelteKit migrations — including the tenancy control-plane migrations
and the governance fleet migrations — run automatically on container startup.

**`gremion-legal`, `gremion-vector`, `gremion-fallback`**: the other three
first-party images. They hold no schema and run no migrations, but they are
still built from this repo, so a source change to `docker/legal/`,
`docker/vector/` or `docker/fallback/` needs the same rebuild-and-push before
the new bytes reach a cluster.

### Schema-rename rebuilds

When a SvelteKit service has had a SQL schema rename (column, table, or enum
value) since its last image build, you **must** rebuild the image — even if the
source `.sql` migration file hasn't changed since the last build, and even if
you keep the same image tag. Docker BuildKit's layer cache can serve a stale
baked-in DDL fingerprint that no longer matches the new application code,
producing a container that boots but 500s on the first query against the
renamed surface.

```bash
# Force a fresh build (no cache) after a schema rename:
docker compose build --no-cache <service-name>
```

For Kubernetes deployments the same applies: bump the image tag **and** ensure
the build that produced the new tag was run without a cache hit on the
schema-baking layer (`docker build --no-cache` is the simplest safe option).

See the post-mortem in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) for the
image-staleness incident and analogous cases.

---

## Troubleshooting

| Issue | Command |
|-------|---------|
| Pod won't start (K8s) | `kubectl describe pod -n gremion-system <pod-name>` |
| App returns 503 on every request | Check `gremion-ui` logs — the tenancy control-plane DB (`CONTROL_DATABASE_URL`) must be reachable for boot's `runControlMigrations()` to succeed |
| Tenant subdomains 404 (prod) | Verify `DOMAIN_REGEX` is set to the escaped `DOMAIN` |
| Keycloak DB connection | `docker compose logs keycloak` / `kubectl logs -n gremion-system <kc-pod>` |
| OIDC `iss` mismatch behind a proxy | Confirm Traefik forwards `X-Forwarded-*` and `KC_PROXY_HEADERS=xforwarded` is set |
| TLS cert pending (K8s) | `kubectl describe challenge -n gremion-system` |
| Ingress 404 (K8s) | Verify ingress class: `kubectl get ingressclass` |
| `.env` change didn't take effect | Use `docker compose up -d --force-recreate <service>`, not `restart` |
