# The pooled stack: layout, limits and the cost record

TASK-040 · PRD-PLAT-005 · TRD-440, TRD-038, TRD-177, TRD-045, TRD-227.
Status of every number here: **[A]**. The numbers are assumptions until
TRD-226's footprint measurement exists. The guard is
`scripts/check-pooled-stack.mjs` (`make lint-pooled-stack`). The running proof
is `test/host/integration/pooled-stack-proof.sh`.

## One stack per host, five compose projects

| Project | Compose files | What it holds |
|---|---|---|
| `${STACK}-state` | `docker-compose.yml` + `docker-compose.prod.yml` + pins | every database and volume, keycloak, the edge (traefik, its socket proxy, fallback, legal), vector |
| `${STACK}-app-blue` | `docker-compose.app.yml` + pins, `COLOUR=blue` | gremion-ui, gremion-public, control-panel (+ the `migrate` / `tenant-create` one-shots) |
| `${STACK}-app-green` | the same file, `COLOUR=green` | the same five services, other colour |
| `${STACK}-ops` | `infra/host/ops/docker-compose.yml` | prometheus, alertmanager, node-exporter, cadvisor, blackbox (**non-council**) |
| `${STACK}-mail` | `infra/host/mail/docker-compose.yml` | stalwart, the platform mail server (**non-council**) |

**Tenants cost no containers (TRD-440).** A customer adds databases (its
kernel database and one per enabled module), a Keycloak realm, a broker
account and its first accounts (`gremion-tenant create <slug> ...`, TASK-043).
It adds no container and no compose project, and `create` fails if the
container count or any project's `config --services` moved. The per-tenant
column below is 0 on every row.

**The tenant-create environment contract (TASK-043 G3).** Every variable is
checked before the one-shot connects anywhere, and a missing one is a named
exit-2 failure, never a default:

| Variable | Value | Why |
|---|---|---|
| `PLATFORM_DATABASE_URL` | direct `postgres-${STACK}:5432/gremion_platform`, as `PLATFORM_DB_USER` (the platform owner) | `assertPlatform` / `migratePlatform`; the one runner refuses the pooler |
| `KERNEL_PG_ADMIN_FILE` | `etc/secrets/tenant-create/kernel_pg_admin` (the kernel server's `POSTGRES_USER` URL) | `ensureKernelDatabase` needs CREATEDB, CREATEROLE and the `pg_shadow` read of `pgbouncer.get_auth` |
| `MODULE_PG_ADMIN_<ID>_FILE` | one per module server (`MODULE_POSTGRES_IDS`), `etc/secrets/tenant-create/module_pg_admin_<id>` | `ModuleServer.admin` of `enableModule` |
| `MODULE_APP_PASSWORD_<ID>_FILE` | one per module server, generated once by `gremion-tenant init` | the module's app role password (`secrets.appPassword`) |
| `TENANT_EXPORT_DIR` | `/var/lib/gremion/exports` | `enableModule`'s export target (tenant-create never exports) |
| `GREMION_DISABLE_SEEDS` | `"true"` | the kernel migration tenant-create runs must never apply a `*_seed.sql` |
| `PANEL_DB_USER` / `PANEL_DB_PASSWORD` | `gremion_panel` and a generated secret (`app.env`) | `init` makes the control panel's READ-ONLY role (`ensurePanelReader`: LOGIN, SELECT on `tenant`, `tenant_domain`, `plt.provisioning_step` only); the `control-panel` block connects as it, never as a database owner |

`gremion-tenant init` writes the `etc/secrets/tenant-create` files (0600) from
`state.env`; the compose file mounts that directory read-only into
`tenant-create` only.

**A colour owns no data (TRD-038).** The only volumes an app colour mounts are
the two stack-scoped externals `${STACK}_config_data` and
`${STACK}_tenant_config_data`. `infra/host/bootstrap.sh stage_networks` creates
them, and `gremion-backup` lists them among its externals. A blue to green
switch starts and stops app containers only. Every state container ID and every
state volume stays the same.

## Placement (the TRD-045 contract)

The guard reads this table from `PLACEMENT` in `scripts/check-pooled-stack.mjs`,
and that code is the authoritative copy.

| Service | Class | Project | Networks |
|---|---|---|---|
| postgres, 6 × `<id>-postgres`, pgbouncer | council store | state | `_state` |
| nats (TASK-024: nkey auth, one account per tenant) | council store | state | `_state` |
| keycloak | council | state | `_state`, `_edge` |
| legal, fallback | council (edge) | state | `_edge` |
| traefik | council (edge) | state | `_edge`, `socket` |
| docker-socket-proxy | council (edge) | state | `socket` only (internal) |
| vector | council (logs) | state | `network_mode: none` |
| mailpit | dev only | state, `profiles: [dev]` | `_state` |
| gremion-ui, gremion-public | council app | app-`<colour>` | `_edge`, `_state`, `app` |
| control-panel (TASK-043 Q12: no port, no Traefik route; `gremion-tenant panel` prints the `ssh -L` line) | council app | app-`<colour>` | `_state`, `app` |
| migrate / tenant-create | council one-shot | app-`<colour>` | `_state` / `_state` + `_edge` |
| prometheus, alertmanager, node-exporter, cadvisor, blackbox | **non-council** | ops | `ops` |
| stalwart | **non-council** | mail | `mail` |
| sales site (R26-1, other repo) | **non-council** | its own | its own |

No non-council service shares a network with any service on `${STACK}_state`.
That also keeps them off `${STACK}_edge`, because keycloak and the app tier sit
on both. Every compose project on the host outside `{state, app-blue,
app-green}` must be non-council. The running proof enumerates the projects by
label and probes each state-network container's IP and port from every
non-council network.

cloudflared is removed. It is not in the TRD topology (PRD §10.2, "Edge CDN:
none"), and Traefik is the first hop.

## Limits (TRD-177)

Every container declares both `deploy.resources.limits.memory` and `.cpus`.
Compose applies them outside swarm as `HostConfig.Memory` and
`HostConfig.NanoCpus`. Sizes (Q4): `s` = 256M / 0.25, `m` = 512M / 0.5, `l` =
1G / 1.0. Keycloak gets 1.5G / 1.0. The Keycloak 26 guide "Concepts for sizing
CPU and memory resources" gives a 1250 MB base with 300 MB non-heap at a 70 %
heap share, so (1250 − 300) / 0.7 ≈ 1.36 GB, rounded up. The proof's idle-RSS
check catches a limit set too low: every container must idle below 80 % of its
limit.

| Project | Service | Memory | CPUs | Per tenant |
|---|---|---|---|---|
| state | postgres | 1G | 1.0 | 0 |
| state | 6 × `<id>-postgres` (profile-gated, only enabled modules start) | 6 × 256M | 6 × 0.25 | 0 |
| state | pgbouncer | 256M | 0.25 | 0 |
| state | nats | 512M | 0.5 | 0 |
| state | keycloak | 1.5G | 1.0 | 0 |
| state | legal | 256M | 0.25 | 0 |
| state | fallback | 256M | 0.25 | 0 |
| state | traefik | 512M | 0.5 | 0 |
| state | docker-socket-proxy | 256M | 0.25 | 0 |
| state | vector | 512M | 0.5 | 0 |
| state | mailpit (dev only, not on a host) | 256M | 0.25 | 0 |
| app-`<colour>` | gremion-ui | 1G | 1.0 | 0 |
| app-`<colour>` | gremion-public | 512M | 0.5 | 0 |
| app-`<colour>` | control-panel | 512M | 0.5 | 0 |
| app-`<colour>` | migrate (one-shot) | 1G | 1.0 | 0 |
| app-`<colour>` | tenant-create (one-shot) | 512M | 0.5 | 0 |
| ops | prometheus | 1G | 1.0 | 0 |
| ops | cadvisor | 512M | 0.5 | 0 |
| ops | alertmanager, node-exporter, blackbox | 3 × 256M | 3 × 0.25 | 0 |
| mail | stalwart | 512M | 0.5 | 0 |

### The sum against the host

| Situation | Memory ceiling | CPU ceiling |
|---|---|---|
| state, no module Postgres | 5.0G | 4.5 |
| state, all six module Postgres | 6.5G | 6.0 |
| one app colour (steady state, with the control panel since TASK-043) | 2.0G | 2.0 |
| ops | 2.25G | 2.25 |
| mail | 0.5G | 0.5 |
| **steady state** (state with all modules + one colour + ops + mail) | **11.25G** | **10.75** |
| **deploy window** (+ the second colour + migrate) | **14.25G** | **13.75** |

These are ceilings, not usage. A CPU limit caps each container and reserves
nothing, so a CPU sum above the host's core count means contention under load,
not a failure to start. The memory ceiling is the number to hold against the
host's RAM. The pilot host's CPU, RAM and disk tier is unstated (TRD §5 gap,
closes at the re-init). Record it here after the re-init, with TASK-038's
proof output.

## TRD-227: the per-customer budget

The target is ≤ €500 per customer per year for the marginal infrastructure
cost (TRD-227; measured by TRD-226). This layout contributes the one number it
controls: **the marginal container cost of a customer is zero**. Every
container above is shared platform overhead. Per TRD §2.2, the ops and mail
stacks count as shared overhead outside the per-customer figure. The target is
not falsifiable until TRD-226's measurement exists. Until then this page states
the layout's contribution and makes no cost claim.

## Deploy ordering hazard

The app tier carries no docker-provider router (`traefik.enable=false`), so
two websecure routers left the compose files with the split:

- **the apex** (`gremion-ui`, `Host(${DOMAIN})` in `docker-compose.prod.yml`),
  with its `gremion-ui-proxytrust` / `gremion-ui-starting` chain, whose two
  middlewares now sit on the traefik container as interim names;
- **the public portal** (`gremion-public`, `Host(public.${DOMAIN})` in
  `docker-compose.yml`, with `public-ratelimit@docker`, which also moved onto
  the traefik container).

The former `gremion-ui-apexhost` middleware (the apex tenant injection) is not
restored anywhere: TASK-041's edge host model deleted it and its guard
(`lint-edge-host`, rule R3) keeps it out of the app files too.

Neither host has a websecure router until TASK-034's 34b block lands (its
`edge-*@docker` middlewares and the static `app` / `portal` routers onto
`app@file` / `public@file`; `active.yml` today routes only the loopback
`internaltest` entrypoint).
**No deploy may be scheduled between TASK-040 and 34b**: the apex and
`public.<domain>` would both answer 404. TASK-038's waits carry this.

## Scratch proof record (2026-09-27, [A] numbers, NOT yet at the merge commit)

`test/host/integration/pooled-stack-proof.sh` ran phase by phase on a scratch
stack (`STACK=t040-fa154764`, Docker 29 on Docker Desktop) and then tore it
down. The full ledger is kept outside the repository with the unit's review
material.

**Status of this record.** It comes from an older TASK-040 tree: before the
TASK-041 merge (app services moved into `docker-compose.app.yml`, host rules),
the `PLATFORM_DOMAIN` binding and the cold-state phase. It is therefore not
the brief's "proved on a scratch stack from the merge commit". The kept
ledger's `limits.tsv` and `rss.tsv` were later overwritten by the guard-efficacy
runs (the starved-Keycloak re-break: keycloak `521.2MiB / 600MiB`, 86 %), so
the TRD-177 numbers below have no surviving green ledger. A green
`pooled-stack-proof.sh all` at the merge commit, with efficacy runs under
their own `POOLED_OUT`, replaces this section (owner: the orchestrator's
merge train, before TASK-038's live re-run; see Named residuals).

- **TRD-177:** 16 running containers were inspected (state, app-blue, ops,
  mail). Every one had `HostConfig.Memory` > 0 and `NanoCpus` > 0. Idle RSS
  was reported at most 31 % of the limit (keycloak, 487 MiB of 1.5 GiB), every
  other container at or below 6 %; the ledger for these numbers is gone (see
  above).
- **TRD-045:** 2 non-council projects (ops, mail) were found on 2 networks,
  and neither network shares a member with `_state`. Each of the 5
  state-network targets (postgres, pgbouncer, keycloak, and the colour's
  gremion-ui and gremion-public) answered from `_state` (positive control).
  Every target was CLOSED from both non-council networks.
- **Finding:** a *published* host port on a `_state` service made that service
  reachable from the non-council networks. Postgres answered `pg_isready` from
  the ops network while its port was published and stopped answering once the
  port was removed. The guard therefore refuses any `_state` service that
  publishes a port. The dev override still publishes postgres and mailpit, and
  no host renders that override.
- **TRD-440:** tenants `t040-b` and `t040-c` were added through the
  `tenant-create` one-shot. The per-project service counts, the running
  containers, `docker compose ls` and the stack's container count were
  identical before and after each add. The database `t_t040-c` and the realm
  `t040-c` exist.
- **TRD-038:** the switch from blue to green (migrate, then up, green healthy,
  then blue removed) left all 16 state container IDs and volume `CreatedAt`
  lines unchanged. After a cold restart of the state tier, the green
  gremion-ui answered `{"ok":true,"tenant":null,"colour":"green"}` on
  `/healthz`. That is liveness only and does not prove the boot retry; the
  cold-state phase now stops state, re-boots the app against it and asserts
  readiness on `/api/health` once state returns. `/api/health` is not
  resolve-exempt (403 without `x-proxy-trust`, 404 without a registered
  forwarded host), so the phase first registers the proof host for the
  default tenant in `control.tenant_domain` and probes the way the edge does:
  `x-proxy-trust` from the container's own `TENANT_PROXY_SHARED_SECRET`
  (never on the host's argv or in the ledger) with a matching
  `x-forwarded-host` and `Host`. A positive control on the running app comes
  before state is stopped. The shim in `test/host/pooled-stack-proof.bats`
  models the resolver, so a bare probe goes RED there. Its first scratch run
  is still to be recorded here.

## Named residuals

Left open by TASK-040, each with its owner:

- **Docs sweep (docs owners).** Several operator and developer pages still show
  single-project commands against `gremion-ui` (`docker compose build|up|logs|
  restart|exec gremion-ui`): `docs/DEVELOPMENT.md`, `docs/LOCAL_TESTING.md`,
  `docs/OPERATIONS.md`, `docs/TROUBLESHOOTING.md`,
  `docs/security/test-smtp-guard.md`. The app services now live in
  `docker-compose.app.yml` under the `<stack>-app-<colour>` project (dev: `make
  up`, project `dev-app-blue`).
- **check-postgres-major (TASK-019's owner).** With `name: gremion_*` stripped,
  `scripts/check-postgres-major.mjs` compares volume keys, so its
  forbidden-name check goes quiet. `check-pooled-stack` asserts that no
  rendered name matches `gremion_*`; hardening the postgres check itself stays
  with its owner.
- **`docker/cloudflared/origin-ca-root.pem`** is orphaned by the cloudflared
  deletion. It is outside this unit's files and stays until its owner removes
  it.
- **gremion-public `/healthz`** carries no colour field (gremion-ui's does).
- **NATS account per tenant** (TRD-440 lists it): closed by TASK-024. The
  state project's `nats` admits clients only by per-module nkey inside one
  account per tenant (`packages/nats-auth`); a tenant add reloads it, never
  adds a container. TASK-043 drops its publishing -> newsletter alias; the
  live host re-runs the proof under TASK-038.
- **Dev loop proof (Q6; orchestrator or operator).** `make up` serving
  `127.0.0.1:3001` / `:3002` has not been run and recorded; only the dev
  render is guarded (loopback-only binds). `make up` brings up the base
  compose file, which unit agents may not run: run it once in a scratch
  `DEV_STACK` and record `curl` of both ports, or accept this residual
  explicitly.
- **Running proof at the merge commit (orchestrator's merge train).**
  `bash test/host/integration/pooled-stack-proof.sh all` on
  `STACK=t040-<sha8>` of the merge commit, including cold-state, with the
  green `limits.tsv`, `rss.tsv`, `isolation.txt`, `trd440-*`,
  `state-*-switch.txt` and `cold-state.log` saved to the unit's ledger. The
  state project renders the base `docker-compose.yml`, which unit agents may
  not run under `docker compose`.
