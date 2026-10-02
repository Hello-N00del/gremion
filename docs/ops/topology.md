# Deployment topology

Date: 2026-09-24. Amended 2026-10-02 (§5: second census and dated additions, TRD-352).

TASK-010. Implements PRD-REC-001, PRD-REC-003, PRD-REC-004; TRD-351, TRD-352, TRD-395.

## 1. Running container census (pilot host, first reading)

Recorded 2026-09-24, 12:30 UTC, on the pilot host (the current test environment), per TRD-395:
`docker ps -a` (running containers, docker-reported) diffed against `docker compose config --services`
(compose-declared services) for the one compose project stack running there today.

Method: `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'` against
`docker compose config --services`; image references confirmed per-container with
`docker inspect`/`docker image inspect` for `Config.Image` and `RepoDigests`.

Containers observed (docker-reported), 32 total, all `Up 8 days`:

| Container | Image (as running) | Health |
|---|---|---|
| gremion-public | locally built (first-party image, no registry reference) | healthy |
| gremion-ui | host-local first-party `ui` image, floating `:latest` (built on the host, no registry pull) | healthy |
| messages-service | host-local first-party `messages` image, floating `:latest` (built on the host, no registry pull) | healthy |
| matrix | locally built (first-party image, no registry reference) | healthy |
| content-service | host-local first-party `content` image, floating `:latest` (built on the host, no registry pull) | healthy |
| vault-service | host-local first-party `vault` image, floating `:latest` (built on the host, no registry pull) | healthy |
| newsletter-service | host-local first-party `newsletter` image, floating `:latest` (built on the host, no registry pull) | healthy |
| finance-service | host-local first-party `finance-service` image, floating `:latest` (built on the host, no registry pull) | healthy |
| calendar-service | host-local first-party `calendar` image, floating `:latest` (built on the host, no registry pull) | healthy |
| board-service | host-local first-party `board` image, floating `:latest` (built on the host, no registry pull) | healthy |
| content-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| vault-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| newsletter-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| vector | host-local first-party `vector` image, floating `:latest` (built on the host, no registry pull) | no healthcheck declared |
| finance-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| nextcloud | host-local first-party `nextcloud` image, tag `33-apache` (built on the host, no registry pull) | healthy |
| board-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| mailpit | `axllent/mailpit:v1.30.1` | healthy |
| calendar-postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| helios | host-local first-party `helios` image, floating `:latest` (built on the host, no registry pull) | healthy |
| legal | locally built (first-party image, no registry reference) | healthy |
| files-service | host-local first-party `files` image, floating `:latest` (built on the host, no registry pull) | healthy |
| votes-service | host-local first-party `votes` image, floating `:latest` (built on the host, no registry pull) | healthy |
| collabora | `collabora/code:24.04.10.1.1` | healthy |
| traefik | `traefik:v3.7.1` | healthy |
| fallback | host-local first-party `fallback` image, floating `:latest` (built on the host, no registry pull) | no healthcheck declared |
| pgbouncer | `edoburu/pgbouncer:v1.25.2-p0` | no healthcheck declared |
| keycloak | `quay.io/keycloak/keycloak:26.6.1` | healthy |
| docker-socket-proxy | `tecnativa/docker-socket-proxy:0.1.1` | no healthcheck declared |
| postgres | PostgreSQL 16, Alpine image (upstream official image) | healthy |
| redis | `redis:7-alpine` | healthy |
| nats | `nats:2.12-alpine` | healthy |

Compose-declared services (`docker compose config --services`, same host, 32 services): the same
32 names as the table above, one-to-one.

### Discrepancy list (docker-reported vs. compose-declared)

- **Declared but not running:** none. All 32 compose-declared services have a matching running
  container.
- **Running but not declared:** none. All 32 running containers match a compose-declared service.
- **Required but not observed in this census:** LiveKit (SFU) and its JWT auth-service (TRD-242,
  TRD-395 "as found" list) — neither appears among the 32 running containers or the 32
  compose-declared services on this host today. TRD-242's own inspection criterion (docker-compose
  defines livekit + JWT auth-service) is not met by the current compose files in this worktree,
  which define no `livekit` service. This is a real gap against the target topology (§2), not a
  drift from a prior declaration; it is carried into §2 with its own `[A]` status rather than
  assumed present.
- **Unhealthy:** none observed. Four containers (`vector`, `fallback`, `pgbouncer`,
  `docker-socket-proxy`) carry no healthcheck in the current compose files, so they report no
  health state rather than `unhealthy`; this is a gap against TRD-179 (idle-colour healthcheck
  requirement) to close by TASK-086, not a running-vs-declared mismatch.
- **Floating tags:** eleven first-party service images run on the mutable `:latest` tag rather than
  a version or digest: the host-local `ui`, `messages`, `content`, `vault`, `newsletter`,
  `finance-service`, `calendar`, `board`, `vector`, `helios` and `fallback` images. This is the known gap TRD-350
  gates at re-init (`both · re-init`), not a violation today; it is exactly what §3 below marks
  `[A] to pin at re-init`.
- **Locally built images without a registry digest:** `gremion-public`, `matrix`, `legal` build
  from local Dockerfiles (no upstream registry reference); each carries only a local content
  digest (`docker image inspect` `RepoDigests`), not a pulled digest from a registry. Consistent
  with PRD-REC-004 (one image set, no private manifest) — these stay locally built, not moved to a
  private registry.
- **Already digest-pinned:** `pgbouncer` (`edoburu/pgbouncer:v1.25.2-p0@sha256:7d7a27d9e909…`) is
  the one service whose compose declaration already carries a content digest; every other
  third-party image is declared by version tag only, with the digest shown above resolved from the
  locally cached pull, not from the compose file itself.

No container is declared but absent, and no running container is undeclared. The gaps that exist
are version-pin maturity, not drift: they are the same "unpinned components pinned at build" set
TRD-352 already anticipates.

## 2. Target pilot topology (TRD-440, TRD-352)

Three Compose projects run the pooled stack (PLAN §6, TASK-040, TRD-440): **state**, **app-blue**,
**app-green**. Adding a customer (tenant) adds data — a database, a realm, an account — not a new
container (TRD-440); the pilot stays one pooled stack shared across app-blue/app-green regardless
of tenant count.

Component list and pin status. "pinned" = version fixed today, as the TRD-352 "as found" record
lists it; "`[A]` to pin at re-init" = the rebuild changes this component and its exact tag/digest
is not yet fixed — TRD-352 assigns pinning it to the re-init, owner the operator.

| Component | Kind | Version today (as found) | Status |
|---|---|---|---|
| PostgreSQL (per-module + platform) | database | PostgreSQL 16, Alpine image (upstream official image) | pinned |
| Redis | cache | `redis:7-alpine` | pinned (rebuild replaces with Valkey, below) |
| Keycloak | identity | `quay.io/keycloak/keycloak:26.6.1` | pinned |
| NATS | broker | `nats:2.12-alpine` | pinned |
| Traefik | edge/reverse proxy | `traefik:v3.7.1` | pinned |
| Collabora | document editing | `collabora/code:24.04.10.1.1` | pinned |
| LiveKit + JWT auth-service | video/calls | target `livekit-server:v1.7.2` (digest-pinned) [E TRD-242, TRD §11 "as found"] | `[A]` not observed in §1's census — TRD-242's own compose-definition check fails against this host's current compose files; deploy and pin at re-init |
| PgBouncer | connection pooler | `edoburu/pgbouncer:v1.25.2-p0` (digest-pinned) | pinned |
| Mailpit | dev mail capture | `axllent/mailpit:v1.30.1` | pinned |
| Edge gateway (`docker-socket-proxy`) | ops/socket proxy | `tecnativa/docker-socket-proxy:0.1.1` | pinned |
| Nextcloud | files | host-local first-party `nextcloud` image, tag `33-apache` (built on the host, no registry pull) | pinned |
| host-local first-party images ui, messages, content, vault, newsletter, finance-service, calendar, board, vector, helios, fallback | first-party services | `:latest` (floating) | `[A]` to pin at re-init |
| gremion-public, matrix, legal | first-party, locally built | local content digest | `[A]` to pin at re-init |
| PostgreSQL 18 (native uuidv7) | database | — [D R19-D14] | `[A]` to pin at re-init |
| Node 26 | runtime | — [D R19-D34] | `[A]` to pin at re-init |
| SvelteKit 3 | framework | pinned release candidate if not yet stable [D R20-D5] | `[A]` to pin at re-init |
| Kernel API service (Fastify) | new deployment unit, class-5 | — [D R19-D22] | `[A]` to pin at re-init |
| Governance core service (meeting, Antrag, Beschluss, Protokoll; option G2) | new deployment unit, class-5 | — [D R19-D9] | `[A]` to pin at re-init |
| Valkey | cache tier, class-5, replaces Redis | — [D R20-D31] | `[A]` to pin at re-init |
| Tempo | trace store, class-4 (observability) | — [D R19-D27] | `[A]` to pin at re-init |

The kernel API service, governance service, Valkey and Tempo are north-star/class-4 additions
already decided before the rebuild (TRD-351 §11.5 rounds 19–20); they enter this record at
re-initialisation with their own dated class-5 entry and builder-week figure (kernel API, governance
service, Valkey = class 5; Tempo = class 4), rather than as later pilot-time changes.

Object storage does not run in the pilot (TRD-066); no line for it here.

Vaultwarden is not a line in the table above: it is not a running or pinned component of this
topology. TRD §11 reads PRD §12.1a as the council's own externally-operated Vaultwarden instance —
not a bundled container on this host — so TRD-263's SSO demonstration exercises that external
instance, and §1's census correctly shows no Vaultwarden container. Which instance TRD-263 actually
scores against (the council's own vs. the bundled `vaultwarden` compose profile) is an open item
(⚑ Q-2.5, TRD-351/TRD-263), owner the operator, closing at the Beschluss; this record makes no
running/pinned claim about it either way.

## 3. One image set; tasks board and password vault stay disabled

The release produces one image set and does not require a private manifest (PRD-REC-004): every
first-party image above is a `gremion/*` image or a locally built image, none held in a private
registry manifest separate from this record.

The tasks board and the password vault (native Vaultwarden alternative) are **not enabled** for any
council under decision P2 (PRD-REC-003). Both stay off until PRD-PLAT-012's cross-tenant isolation
test passes for that module:

- Tasks board: off, blocked on the isolation proof (PRD-PLAT-012). The test environment runs
  it as a dated, test-only exception (R29-I1); see §5.4. The pilot configuration stays off.
- Native password vault: off by default; may be enabled later in the pilot once its isolation test
  passes [D R19-D13, D R19-D37]. Vaultwarden (the council's own externally-operated instance, per
  TRD §11's reading of PRD §12.1a) remains the supported alternative credential tool for the pilot
  [D R4-5]; it is not a component of this host's topology (§2) and its status does not change here —
  see §2's note on the open Q-2.5 item.

## 4. Deployment-unit addition rule (TRD-351)

No new deployment unit is added during the pilot unless it falls into one of the five §11.5
exception classes:

1. A logged security fix (PRD-DEP-003).
2. A fix needed to clear F1/F2.
3. A dated exception naming the PRD §14.3 Must it serves.
4. The observability stack [D R11-2].
5. An additive north-star step, dated [D R11-5].

Classes 1–2 may only fix what already exists; classes 3–5 may create a new unit. Anything outside
these five waits for the verdict. A class-5 addition records the builder-weeks it consumes against
PRD §14.1 (TRD-351). Each release's change list is checked against this record; an addition is
either named with its exception class and dated entry, or none was made.

## 5. Dated amendments (TRD-352)

Each change to the deployed topology after the 2026-09-24 publication is entered here with its date
(TRD-352: the deployed topology stays consistent with this record; each change dated). The target
in §2 is unchanged by these entries. Hosts are described by role: "the pilot host" is the current
test environment.

### 5.1 Second census, 2026-10-02 (TRD-395, second reading)

Read-only census of the pilot host on the evening of 2026-10-02. Deployed state at the time: the
host marker records the StuRaOS master `87c004a8` (kernel gitlink `a21c1740`), extracted
2026-10-02 00:07 (UTC+2).

**34 containers were up, in 3 compose projects:**

| Compose project | Containers | What it is | First recorded |
|---|---|---|---|
| the main stack project | 32 | the same 32 services as the §1 table, one-to-one by service name | §1, 2026-09-24 |
| `gremion-panel` | 1 | the operator control panel (§5.3) | §5.3, 2026-10-01 |
| `gremion-site` | 1 | the public marketing site (§5.2) | §5.2, 2026-09-29 |

- Health: every container that declares a healthcheck reported healthy.
- The main stack project still has exactly the 32 services of §1. Nothing was added to it and
  nothing removed. The LiveKit gap recorded in §1 is therefore unchanged.
- Not re-taken tonight: the per-container image and pin readings of §1 and the §2 pin status. The
  2026-09-24 reading stands for them until the re-init.
- What changed since the first reading is the project count, from one to three. The two entries
  below are the whole difference.

### 5.2 2026-09-29: compose project `gremion-site` (marketing site)

- A compose project of its own with one container, serving the public marketing site. Live since
  2026-09-29.
- Plan basis: the target keeps the sales site as its own compose project with no route to council
  data (TRD-415, TASK-118 note). That property was not re-verified in the 2026-10-02 census.
- Exception class (§4 / TRD-351): **[A] not yet assigned.** Pending the operator. Until assigned,
  this addition has no exception class and is open against the §4 rule.

### 5.3 2026-10-01: compose project `gremion-panel` (operator control panel)

- A compose project of its own with one container: the first-party control-panel image, tagged
  `r29-d7722921` (the tag suffix names the build commit). Source in this repository:
  `apps/control-panel` and `compose/control-panel`. Live since 2026-10-01.
- Exception class (§4 / TRD-351): **[A] not yet assigned.** Pending the operator. Classes 3 to 5
  may create a new unit; which one applies (if any) is the operator's call, and none is claimed
  here.

### 5.4 2026-09-30: tasks board enabled on the test environment only (R29-I1)

- Under R29-I1 (board opt-in now, per-tenant store) the board runs on the test environment: the
  board service is up and healthy, and its databases are per-tenant (`board_control` and
  `board_default`), with counts and checksums equal to the legacy store at cut-over. Opted in on
  the test environment on 2026-09-30 (single-tenant exception); the per-tenant store went live with
  the same evening's redeploy.
- This is a test-environment exception. §3 is unchanged for the pilot: the tasks board stays off
  until PRD-PLAT-012's cross-tenant isolation proof passes (PRD-REC-003). No new deployment unit
  is involved: the board service is one of the 32 services in §1.
- The native password vault is unchanged: off at the application level (the web app's environment
  carries no vault backend key) while its container remains one of the 32.
