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
| `${STACK}-app-blue` | `docker-compose.app.yml` + pins, `COLOUR=blue` | gremion-ui, gremion-public (+ the `migrate` / `tenant-create` one-shots) |
| `${STACK}-app-green` | the same file, `COLOUR=green` | the same four services, other colour |
| `${STACK}-ops` | `infra/host/ops/docker-compose.yml` | prometheus, alertmanager, node-exporter, cadvisor, blackbox (**non-council**) |
| `${STACK}-mail` | `infra/host/mail/docker-compose.yml` | stalwart, the platform mail server (**non-council**) |

**Tenants cost no containers (TRD-440).** A second tenant adds databases, a
Keycloak realm and an account (`tenant-provision provision <slug>`). It adds no
container and no compose project. The per-tenant column below is 0 on every
row.

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
| keycloak | council | state | `_state`, `_edge` |
| legal, fallback | council (edge) | state | `_edge` |
| traefik | council (edge) | state | `_edge`, `socket` |
| docker-socket-proxy | council (edge) | state | `socket` only (internal) |
| vector | council (logs) | state | `network_mode: none` |
| mailpit | dev only | state, `profiles: [dev]` | `_state` |
| gremion-ui, gremion-public | council app | app-`<colour>` | `_edge`, `_state`, `app` |
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
| state | keycloak | 1.5G | 1.0 | 0 |
| state | legal | 256M | 0.25 | 0 |
| state | fallback | 256M | 0.25 | 0 |
| state | traefik | 512M | 0.5 | 0 |
| state | docker-socket-proxy | 256M | 0.25 | 0 |
| state | vector | 512M | 0.5 | 0 |
| state | mailpit (dev only, not on a host) | 256M | 0.25 | 0 |
| app-`<colour>` | gremion-ui | 1G | 1.0 | 0 |
| app-`<colour>` | gremion-public | 512M | 0.5 | 0 |
| app-`<colour>` | migrate (one-shot) | 1G | 1.0 | 0 |
| app-`<colour>` | tenant-create (one-shot) | 512M | 0.5 | 0 |
| ops | prometheus | 1G | 1.0 | 0 |
| ops | cadvisor | 512M | 0.5 | 0 |
| ops | alertmanager, node-exporter, blackbox | 3 × 256M | 3 × 0.25 | 0 |
| mail | stalwart | 512M | 0.5 | 0 |

### The sum against the host

| Situation | Memory ceiling | CPU ceiling |
|---|---|---|
| state, no module Postgres | 4.5G | 4.0 |
| state, all six module Postgres | 6.0G | 5.5 |
| one app colour (steady state) | 1.5G | 1.5 |
| ops | 2.25G | 2.25 |
| mail | 0.5G | 0.5 |
| **steady state** (state with all modules + one colour + ops + mail) | **10.25G** | **9.75** |
| **deploy window** (+ the second colour + migrate) | **12.75G** | **12.25** |

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

The gremion-ui routers left `docker-compose.prod.yml` with the split. The apex
has no websecure router until TASK-034's 34b labels block lands. **No deploy
may be scheduled between TASK-040 and 34b.** TASK-038's waits carry this.
