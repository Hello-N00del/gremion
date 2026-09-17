# Spec B — Kernel port-back, relocatability and release (design)

Date: 2026-09-15 · Status: draft for operator review · Authority: the 31 decisions of 2026-09-15 (vault: attachments/session-2026-09-15-spec-b-d/decisions-2026-09-15.md) and spec A as amended there.

## Scope, finish line, architecture as spec B leaves it, amendments to spec A

### 0. Purpose and the finish line

#### 0.1 Vocabulary — binding on every section of this spec

**Gremion is the product.** It ships in verticals. **StuRaOS is one vertical** — the StuRa vertical — and the tree at the `StuRaOS` repository (private, `Hello-N00del/StuRaOS`) is "the StuRa tree" or "the StuRaOS repo", never "the product" or "the product tree". "Kernel" means the `gremion` repository, public as `github.com/Hello-N00del/gremion`, `main` at `f7ac826` (`git -C civitas log -1`; the Understand map was taken at `a4b898e`, since moved by a dependency-bump PR only). the `gremion-modules` repository (private) is "the modules holding repo" (private, to be archived). Reviewers reject spec or code text that calls the StuRa tree "the product". `PRODUCT_ONLY` survives only where it names the carve manifest's own classification value; no prose is built on it.

#### 0.2 The finish line (F1)

Spec B is finished when, together with spec D, **the assembled distribution — public kernel + modules from their own `gremion-module-<id>` repos + the StuRa vertical — is deployed on the netcup box through plan A's tooling and passes the login journey, replacing the StuRaOS compose running there today** (F1). That deployment replaces a throwaway test env which is wiped with `docker compose down -v` at cutover; no data is migrated.

Spec B is not writing to a blank page. Its acceptance surface is already merged in the kernel and already failing closed:

| Merged assertion | Where | What spec B must make true |
|---|---|---|
| deploy exits 3 until the colour project exists | `civitas/infra/host/bin/gremion-deploy:164-169` (`require_spec_b_contracts`: `docker-compose.app.yml`, `docker-compose.pins.yml`, `release.json`) | the release tree §2.3 |
| deploy dies when no container carries the evict label | `gremion-deploy:452,464` | `gremion.evict=true` on every evicting service |
| switch dies on anything but 204 from the evict endpoint | `infra/host/bin/gremion-switch:83,110-111` | the `/api/internal/evict` contract |
| every host probes `/healthz` per host | `infra/host/templates/env/state.env.tmpl:72` (`VERIFY_MARKER_PATH=/healthz`) | the endpoint — which does not exist: `find gremion-ui/src/routes gremion-public/src/routes -ipath '*health*'` returns only `api/health` and `api/setup/health` |

#### 0.3 Release-1 posture (P1–P5)

- **P1 — full fidelity.** Two colours, overlap proven, leaf ledgers. Release 1 itself exercises the switch, the switch-back and a rollback by deploying a rebuild to the second colour. `release.json` carries `"overlap": true`. The consolidated critical path P1 refers to is stated in the final chapter, §"Critical path", immediately before §H.
- **P2 — all modules enabled.** Public: elections, newsletter, calendar, files, messages, board, users. Private: finance, content, vault. Handover per D-01 (private, no service, types in the SDK). The counts are three different axes and are reconciled here: **ten app modules** are enabled (the seven public plus finance, content and vault); **ten module repos** exist before the first assembled deploy — one repo per enabled module, with news folded into content (D-04) and elections/polls/votes carried as one repo, see spec D; and **nine leaf images** are built, because users has no leaf. The nine leaves that carry a service and a Postgres server are board, calendar, content, files, finance, messages, newsletter, vault, votes; where this spec says "the nine leaves" it means that set. **Zero handover code is extracted** (D-01): no `gremion-module-handover` repo exists in release 1, migration block 1900–1999 is reserved and empty, and `D16-handover-visibility-record` files the dated decision.
- **P3 — Postgres major is the newest every consumer supports**, fixed by a one-hour spike over Keycloak 26.7, Nextcloud 34, Synapse 1.160 and pgbouncer, recorded with its evidence and pinned. The expectation stated in P3 is 17; the spike, not this spec, sets the number.
- **P4 — acceptance is every technical proof**, with operator items waived by name (§1.4).
- **P5 — storage on release 1 is the tenant-aware seam plus MinIO (quay.io) in the state tier**; N11 ships.

Standing assumptions accepted with the batch: the extraction source is frozen at StuRaOS `f276af59` (§2.4); `gremion-public` ships in release 1; the netcup test env keeps running until the cutover wipe; **every guard is watched RED by a fresh verifier agent, never its author**.

### 1. Scope

#### 1.1 In scope for spec B

The kernel port-back and relocatability work, in the order the later sections own it: the ACME edge and router/middleware layout (spec A §C, §D:165); full-host tenant resolution, `tenant_domain` and the router emitter as a library (§D:166); the **nine** kernel-owned migrations absent from the kernel tree, plus the three handover files, plus control `004` (§D:167 as amended); the migration renumber, ranges and baseline hashes (B-04); `/healthz` and boot determinism (B-05); zero-tenant boot plus the interim `tenant-create` service (B-06); the two-project blue/green compose split and the env contract (§E, B-07, B-08) — including the **§E no-truncate-suite guard**: every harness that truncates or drops refuses to start unless `DATABASE_URL` names a host whose `${STACK}` differs from the production `${STACK}`, asserted from inside the container by `docker exec … env` and watched RED by a fresh verifier who points the harness at a production `DATABASE_URL` (it lands in `B15-env-contract-and-validator`); the `/api/internal/*` contract with ack rows (B-11); leaf migration ledgers (B-12); `getStorageFor(tenant)` and MinIO (B-13, P5); backup scope and host wiring (B-14); worker colour policy and real DB claims (B-15); the zero-module assembler and the release supply chain (B-16, B-17); the control router and the sales site (B-10); healthchecks and the census.

Spec B also produces the **public-safe deployment-architecture document** spec A's own header makes a spec-B deliverable (`netcup-distribution-host-design.md:6`), and the signed waiver ledger of §1.4.

#### 1.2 Out of scope — spec C (F4: B before D before C)

`gremion-control` itself, the admin UI, tenant lifecycle and erasure, the `platform` realm's operator accounts and its bootstrap admin, the DNS pre-flight library, release observation and deploy dispatch, and the §H.3 rehearsal-asset check. B leaves the seams (§2.5) and nothing more.

#### 1.3 Out of scope — spec D

`@gremion/module-sdk`, `module.json`, `migrations/ranges.json`'s schema and its per-module content, the **ten** `gremion-module-<id>` repos, the dist manifest's module resolution, the vertical contract and `verticals/stura/`, the compose-fragment inlining unit (`D13-compose-fragment-inlining`), and the leaf image builds. §2.6 states exactly what D consumes from B.

#### 1.4 Out of scope — operator items waived by P4

Waived **by name** until the pilot, and listed in `docs/ops/release-1-waivers.md` so that "deployed" is never read as "gated": the **off-site backup remote** (§J, N14); the **external uptime probe and alert vendor** (N15, §L:6); the **mail bring-up** (§I, §L:4); the **legal documents** — DPIA, ROPA, AVV, accessibility statement, pilot council identity (§L:1); **apex DNS** for the production domain; and **pilot inputs** (the council's names, wording and legal texts). Every other §L item is a technical proof release 1 must pass: the login journey, the reboot gate (§L:3), colour switch + switch-back + rollback exercised on the box, `gremion-verify` green, and a backup covering every database and volume with a **measured** restore (§L:2, §L:7 partially — the erasure proof's tenant-erasure half is spec C's).

#### 1.5 Declined — StuRaOS-only work (F5)

F5 caps StuRa-tree work at what the port-back and the split strictly require. Declined, each with the finding that named it:

| Declined item | Why it is declined |
|---|---|
| Fixing StuRaOS master's red CI (6 pre-existing failures) | F5, verbatim: "not fixed for its own sake" |
| Renaming the StuRa tree's 2510 `sturaos` occurrences across 454 tracked files (measured 2026-09-15: `git -C StuRaOS grep -oi sturaos \| wc -l`) — realm name, `STURA_*` env, `stura-admin`/`stura-mobile` clients, `sturaos.com` | realm digest: "frozen as the archived flavour, not renamed"; renaming it is an L with a live-state window |
| Deleting the ~30 vaultwarden files the carve manifest classes `PRODUCT_ONLY` in the StuRa tree | backup-storage digest: they never travel; only the ~110 references inside MIRRORED files are stripped, and only in the kernel copy |
| Porting `validate-env.sh` | B-08: `infra/host/lib/common.sh` `load_env` is the single reader; the StuRa script reads the first occurrence of a duplicated key (#476 item 12) against compose's last-wins |
| Porting `infra/netcup/bootstrap.sh` | tree-delta finding 19: delete with the archived flavour; plan A's `infra/host/**` supersedes it |
| Re-pinning `diverged-baseline.json` | B-02: a drift instrument inside a tree that is being archived |
| Moving the carve tooling into the kernel | tree-delta decision 3: its job is describing a two-tree relationship that ends at archive. B runs `carve.mjs check` in the StuRa tree during the port-back and lets it die there |
| Fixing #498–#501 in the StuRa tree | batch assumption: fixed in kernel/modules only |
| The 508 vertical/archive paths — 408 docs, 98 `mobile/`, 4 `examples/verticals`, the helios-src pointer | tree-delta finding 20: they stay in the archived flavour. `mobile/` is owned by no spec |
| Reconciling the modules holding repo's 282 drifted files | tree-delta decision: split from the StuRa tree, archive `civitas-modules` untouched after harvesting its `MIGRATION_OWNERSHIP` map |

B writes to the StuRa tree in exactly five places, each named by its unit: the two narrow carve-rule additions of B-02 (`B3-carve-rules-and-portback-guard`), the freeze tag of §2.4 (`B00-extraction-source-freeze`), the shared-migration normalisation commit (`B6-canonical-migration-bytes`), the renumber and its load-bearing references (`B7-renumber-ranges-baseline`), and the storage-seam and leaf-ledger changes whose source files travel into the module repos at the split (`B23-storage-seam`, `B22-leaf-migration-ledger`). Nothing else in the StuRa tree is touched.

#### 1.6 Named gaps this spec does not close

(a) **gremion-public tenant-awareness.** It has no tenant resolution today; release 1's portal therefore serves one tenant's content per host only because release 1 has one tenant. Owner: spec C, with the seam left by B-05's tenant-blind marker. Written residual, not a defect of B.

(b) **The rehearsal record of spec A §F.2** (verify output, migration log, RTO, seed used, published as a release asset on the tag). B's `release.yml` does not produce it; §1.2 leaves both its production and its check to spec C. Consequence stated: until then `gremion-deploy` cannot refuse a release with no green record.

(c) **The §E staging name-resolution guard.** B ships the compose-side `extra_hosts` seam `gremion-render` fills (edge §6); the guard that resolves each name from inside three containers and fails if any answers with a production address belongs to spec A's staging task and is named here so it is not assumed.

### 2. The architecture spec B leaves behind

#### 2.1 The public kernel is the deploy source (N4)

Not a carve artefact. Everything the StuRa vertical has and the kernel lacks is ported into the kernel; modules are consumed from their own repos through the assembler the kernel ships. For the 294 MIRRORED-but-differing files (≈18.1k unexplained lines, up 66% on the July baseline) **kernel wins**, protected by a 43-path do-not-overwrite guard (B-02) — the kernel is ahead on the theme/OKLCH engine, the 12-file dashboard extraction, `source-offer.ts` and five CVE/packaging guards. The app-shell-as-a-package idea is closed and must not be re-attempted: the kernel tree **is** the app and module code is copied in as generated source.

#### 2.2 Two tiers, two colours (§E)

One **state** project (`${STACK}-state`) holds every Postgres server, Keycloak, Traefik, socket proxy, pgbouncer, NATS, Redis, MinIO, vector, legal, fallback, the sales site and the module-owned services; one **app** project per colour (`${STACK}-app-blue` / `-green`) holds `gremion-ui`, `gremion-public`, the nine leaves and `migrate`. App-tier services carry `traefik.enable=false` and colour-suffixed aliases (`test/host/fixtures/release/valid/docker-compose.app.yml:3-12`). §K's "state project" wording means **deploy-time placement, never repo ownership**: the nine leaf service blocks live in `compose/<id>.yml` **in each module repo** and are inlined by the assembler, and the kernel's `docker-compose.app.yml` (`B14-two-project-split`) carries ONLY kernel app-tier services (`gremion-ui`, `gremion-public`) and the shared conventions. Composition is env-file only: `--env-file` is the single permitted flag (N20).

#### 2.3 The release tree — already fixed, not open for design

| Artefact | Contract | Fixed by |
|---|---|---|
| `release.json` | `{tag, overlap: boolean, migrations: [...], distManifestDigest}`, tag equal to the dispatched `dist-vX.Y.Z`; the digest is `"sha256:" + <64 lowercase hex>` of the manifest bytes as read, and both consumers — `.github/workflows/deploy.yml:112` at dispatch and `gremion-deploy:228-229` on the host — reject the bare hex form | `gremion-deploy:217-229`; fixture `test/host/fixtures/release/valid/release.json` |
| `docker-compose.pins.yml` | every first-party service `build: !reset null` + `image: …@sha256:` | fixture `…/valid/docker-compose.pins.yml:4-12` |
| `gremion-migrate` | a **separate first-party image**, `ghcr.io/hello-n00del/gremion-migrate`, pinned like the others | fixture `…/valid/docker-compose.pins.yml:10-12` |
| file names | state: `docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml`; colour: `docker-compose.app.yml:docker-compose.pins.yml` | `state.env.tmpl:22`, `app.env.tmpl:18` |
| manifest identity | `GREMION_DIST_MANIFEST=/opt/gremion/etc/gremion.dist.json`; a release records the **digest**, never the content | `state.env.tmpl:66`, `app.env.tmpl:26` |
| assembled lockfile | the assembled `pnpm-lock.yaml` is **committed into the release tree** next to `release.json` and the pins (B-17), so `--frozen-lockfile` holds inside the image build and two builds of one `distManifestDigest` cannot diverge | B-17 |

Spec B emits exactly these field names. `test/host/deploy.bats` and `deploy-workflow.bats` go GREEN when a real release tree exists; `deploy.bats:243` is RED today.

#### 2.4 The extraction source, frozen

Every module `app/` tree, leaf, compose fragment and migration is extracted from the StuRa tree at **`f276af59`** — which is that repo's current `master` tip (`git -C StuRaOS log -1` = `f276af5925abacdcfd05f6613fc11afff2d804c5`). The SHA is recorded once in the kernel and echoed in every `module.json` as `"extractionSource"` (40 lowercase hex), and the assembler fails when two `module.json` disagree on it (`B00-extraction-source-freeze`), so a ten-repo extraction spread over days cannot silently straddle two source states (map §5 risk 10).

#### 2.5 Seams spec B leaves for spec C

1. **Zero-tenant boot plus the interim `tenant-create`.** B deletes `registerDefaultTenant()`, the boot throw and every env-derived tenant identity, and ships a profile-gated one-shot `tenant-create` compose service wrapping the existing provisioner library (slug, host, vertical). It writes the same control rows and per-subsystem provisioning ledger rows C will write, and renders the tenant router from the 30-line template. It is documented interim and **deleted by spec C** (B-06).
2. **The evict contract.** One internal bearer for evict / modules catalogue / compose-realm; `"*"` clears every cached tenant plus host-resolution and readiness maps and never a cross-tenant singleton; **always 204, empty body**; each evicting process writes an ack row `(tenant, process, colour, epoch)` to the control DB before answering. Leaves mount evict outside the three-clause guard. Fleet-wide across all nine leaves in release 1 (B-11).
3. **`/api/internal/modules` and the compose-realm endpoint**, both with a designed request/response shape — the compose-realm surface has none today.
4. **The reserved `platform` realm.** B-01 deletes the Keycloak boot import together with the default tenant; `realm-export.base.json` becomes only the per-tenant template the provisioner consumes; `platform` stays reserved for spec C's operator realm; the mail tooling's probe realm moves to `master`.

#### 2.6 What spec D consumes from spec B

- **The zero-module assembler** (B-16): B ships `scripts/assemble.mjs` assembling zero modules with every post-condition asserting — in particular the vacuity assertion against the dist manifest's module count, because `build-module-server-init.mjs` scans for `register.server.ts`, finds none in the kernel, emits a comment-only barrel and exits 0. D adds clone-by-ref, `module.json` verification and vertical resolution.
- **Schema ownership**: B's assembler calls the manifest-verification hook; **`D2-module-json-and-dist-schema` owns the `module.json`, `vertical.json` and `migrations/ranges.json` schemas** and the validator they share. `B7-renumber-ranges-baseline` writes `ranges.json`'s content against that schema — `schemaVersion`, `padWidth`, the kernel block with its `crossCuttingModuleTables`, and per module `order`, `block`, `legacy` and `extractedTo` — and does not define the schema; the D2 validator is what checks that `module.json.order`, `ranges.json.modules[id].order` and `ModuleManifest.order` agree, and the same for `notTenantIsolated`.
- **The fragment inlining contract** (B-07): module compose fragments are inlined by the assembler into the two composed files at release build, so the host's `COMPOSE_FILE` lists stay exactly as `state.env.tmpl:22` and `app.env.tmpl:18` fix them. Without it a module's services are silently absent and Traefik drops their routers with no log line. The inlining unit, the fragment contract and the guard set that proves it are spec D's `D13-compose-fragment-inlining`; spec B references it by id and restates nothing. B's own render guard, in `B14-two-project-split`, asserts that union against the assembled pair (edge §5).
- **The migration blocks** (B-04): fixed-width blocks (kernel 0001–0199, modules from 1000 in blocks of 100 allocated in ascending manifest `order:`), one zero-pad width of 4, a guard asserting text order equals numeric order, and `baseline-hashes.json` captured from **git index blobs on Linux after the renumber and before the split**.

#### 2.7 Amendments to spec A, each with its reason

| Spec A location | Amendment | Why |
|---|---|---|
| §C `:80` redirect | an entrypoint-level `:80→:443` redirect is allowed | measured against Traefik 3.7.1: `acme-http@internal` wins over the redirect, so only a hand-written redirect router is a hazard |
| §D:167 | **nine** absent kernel-block migrations (003, 034, 049, 053–058) plus the three handover files (050–052) plus control `004`, not seven | counted in both trees; `004_committee_elections` is already in the kernel |
| §D:169 | backup parity split per B-14: kernel script shrinks to the kernel zone, host tooling owns volumes, buckets and leaf servers | `gremion-backup` already implements the volume and bucket arms; two owners of one enumeration is how a snapshot exits 0 covering nothing |
| §D:177 / N-record row 44 | the storage seam is **spec B's**, on the critical path | B→D→C means C cannot supply a B prerequisite |
| §D:202 | `.gitattributes` per D-03 (`* text=auto eol=lf` + explicit `lf` for SQL/shell/generated), not `* -text` | `-text` permits a CRLF blob that permanently breaks the SHA-256 immutability the same paragraph mandates |
| §E / §K | "state project" means deploy-time **placement**, never repo ownership | module services live in module repos as `compose/<id>.yml` and are inlined at assemble |
| §F.1 | `release.yml` is branch-triggered on `release/<version>` (plus `workflow_dispatch`); the annotated `dist-vX.Y.Z` tag is its output, not its trigger | a workflow cannot be triggered by the tag it creates; `release-npm.yml`'s `v*` trigger does not match `dist-v*`, so there is no collision |
| §F.6 | idempotency is a **build item**, not a verification of existing behaviour | the publish side already sets `Nats-Msg-Id` (`civitas/packages/ports/src/nats-broker.ts:512`) inside a `duplicate_window` stream (`:437`), so the decision's premise is corrected here: the build item is the **consumer-side** idempotency ledger, because the dedup window is time-bounded and does not survive a redelivery outside it. Worker model per B-15; the detail is the Workers chapter §3 and is not restated |
| §G | the validator defect is described backwards — the validator reads the **first** occurrence, compose the **last**; single reader per B-08 | the mitigation aims at the wrong end otherwise |
| §H | bootstrap realm per B-01; the interim `tenant-create` of B-06 writes the provisioning ledger rows | otherwise tenant #1 is the one tenant C's erasure gate cannot enumerate |
| §H.2 "the six leaves without shred paths" | five, named individually: `board`, `files`, `messages`, `vault`, `votes` | nine leaves minus the four that hold per-tenant data; the gate names them individually rather than by count |
| §K health baseline | the unprobed set is `vector`, `pgbouncer`, `fallback`, `docker-socket-proxy` plus `livekit` and `element-call`, all state-tier, not "12 of 13" | all nine leaves carry image-level `HEALTHCHECK`s, which no compose reader can see; building the exemption list from §K's text would encode the wrong baseline |
| §D assembler ownership (§0 vs §L) | split per B-16 | resolves the contradiction in text rather than by silent choice |

### Units in this section

Effort, dependencies, post-conditions, repos touched and the host-contract flag are carried once, in the **consolidated unit registry** (final chapter, "Units in this section"). This table names only what each unit does for this section.

| Unit | Role in this section |
|---|---|
| `B0-spec-docs-and-waiver-ledger` | writes the two spec docs, the public-safe `docs/deployment-architecture.md` with its host-literal hygiene rule, and the waiver ledger of §1.4 |
| `B00-extraction-source-freeze` | tags and records the `f276af59` extraction source of §2.4, makes every `module.json` echo it as `extractionSource`, and makes the assembler fail when two `module.json` disagree |

## Edge, relocatability, env contract, healthchecks, boot determinism

Path prefixes in this section: `civitas/` = the `gremion` repository (the kernel, public `github.com/Hello-N00del/gremion`), `StuRaOS/` = the `StuRaOS` repository (private, `Hello-N00del/StuRaOS`) (the StuRa tree, extraction source frozen at `f276af59`). Spec A §C, §E and §K are the contract this section implements; where spec A and this section disagree, the amendments listed in §2.7 govern.

### 1. Starting position

The host half of §E is merged and tested in the kernel: `infra/host/lib/common.sh` `load_env` (duplicate-key refusal, sentinel refusal, CRLF and compose-quote handling), `infra/host/bootstrap.sh` (`${STACK}_edge`, `${STACK}_state`, `${STACK}_traefik_acme` with post-condition asserts), `infra/host/bin/gremion-deploy` `assert_stack_isolation`, `gremion-switch`, `gremion-verify`, and committed specimens of the files this section must produce (`civitas/test/host/fixtures/release/valid/docker-compose.app.yml` and `.pins.yml`). `civitas/infra/host/mail/docker-compose.yml:16-23` is the merged reference implementation of the §E naming and bind-address idiom (`x-required-env` with `${VAR:?VAR required}`) and is copied, not re-invented.

The compose and edge half is the pre-T04 Cloudflare-tunnel shape. `civitas/docker/traefik/traefik.yml` has one entrypoint (`websecure: ":443"`, :13-15), no `certificatesResolvers`, a single-file provider (`filename: /etc/traefik/dynamic/tls.yml`, :39-40) and trusts all three RFC1918 ranges (:24-28); `civitas/docker-compose.yml:418-444` publishes `"80:80"`/`"443:443"` unbound to a dead port, mounts `./secrets/cf-origin.pem|.key`, and declares no ACME volume (volumes at :510-524). Six routers exist and none carries `tls.certresolver`. `gremion-ui-apexhost` injects a synthetic `X-Forwarded-Host` (`civitas/docker-compose.prod.yml:228-229`) and four routers carry the `HostRegexp` wildcard (:114, :131, :208, :268) — client-controlled tenant selection, in a public repo.

### 2. Static Traefik configuration (B-09 port-back, §C/§E)

`civitas/docker/traefik/traefik.yml` is **replaced wholesale** with the StuRa-tree production file as base (`StuRaOS/docker/traefik/traefik.yml`), not merged, and not derived from `civitas/test/host/fixtures/edge-proto/traefik.yml`, whose own header disqualifies it (no redirect, unreachable `caServer`, insecure API, raw `docker.sock`). The replacement declares:

| Element | Value | Consumer |
|---|---|---|
| `web` | `:80`, `http.redirections.entryPoint` → `websecure`, scheme https, permanent | ACME HTTP-01 + HTTPS redirect |
| `websecure` | `:443` | all public routers |
| `ping` | `:8082`, unpublished, plus top-level `ping.entryPoint: ping` | the container healthcheck |
| `internaltest` | `:8081`, published on `127.0.0.1` only | `gremion-verify` (`civitas/infra/host/bin/gremion-verify:37-38`), `active.yml.tmpl` test routers |
| `api` | `dashboard: false`, published on `127.0.0.1:8080` only | `gremion-switch` `poll_traefik`, `gremion-verify` router enumeration |
| `certificatesResolvers.le-http` | `email: "@ACME_EMAIL@"`, `storage: /letsencrypt/acme.json`, `caServer: "@ACME_CA_SERVER@"`, `httpChallenge.entryPoint: web` | every router's `certresolver` |
| `providers.file` | `directory: /etc/traefik/dynamic` + `watch: true` | per-tenant router files and `etc/edge/active.yml`, which reach Traefik through the state project's bind mount `${GREMION_ROOT:?}/etc/edge:/etc/traefik/dynamic:ro` — read-only, and the only mount of that directory any container holds (the emitter security argument of §T.1) |
| `forwardedHeaders.trustedIPs` | `127.0.0.1/32`, `@EDGE_V4_SUBNET@`, `@EDGE_V6_SUBNET@` | forwarded-header handling on a dual-stack `${STACK}_edge` |

**Bind-mount post-condition:** `docker inspect` on the traefik container shows exactly one mount whose destination is `/etc/traefik/dynamic`, with `RW=false`, and `curl http://127.0.0.1:8080/api/http/routers` lists a router added by writing a file into `etc/edge/` with no container restart.

The entrypoint-level `:80`→`:443` redirect is permitted: spec A §C's apparent self-contradiction is resolved by the amendment, on the measured ground that Traefik's `acme-http@internal` router wins against `web-to-websecure@internal` (`StuRaOS/docker/traefik/traefik.yml:20-25`: `/anything` → 301, `/.well-known/acme-challenge/<tok>` → 404). The prohibition survives for **hand-written** redirect routers, which is why the `www` 301 is websecure-only (§4 below).

**Render-at-start.** Traefik performs no `${}` expansion and, started with `--configFile`, ignores CLI flags and `TRAEFIK_*` env vars (mechanism 3, `StuRaOS/docker/traefik/traefik.yml:27-35`). The marker set is therefore `@ACME_EMAIL@`, `@ACME_CA_SERVER@`, `@EDGE_V4_SUBNET@`, `@EDGE_V6_SUBNET@`, substituted by `sed` into `/tmp/traefik.yml` by the compose entrypoint ported from `StuRaOS/docker-compose.yml:1836-1879`, including its conditional guard (empty `ACME_EMAIL` is fatal only when `TRAEFIK_CERT_RESOLVER` is non-empty, expressed as `${TRAEFIK_CERT_RESOLVER-le-http}` — dash, not colon-dash, so an explicitly empty value means "TLS terminates in front of me").

The `internaltest` entrypoint needs no marker: its in-container address is the literal `:8081` and loopback-only exposure is a compose publish (`127.0.0.1:${INTERNALTEST_PORT}:8081`), not a static-config value — so nothing host-specific enters `traefik.yml`. Post-condition: `grep -E '127\.0\.0\.1|:8081' docker/traefik/traefik.yml` matches only the `forwardedHeaders` loopback entry and the bare `:8081` address, and `gremion-verify` reaches the entrypoint on `127.0.0.1:8081` (`gremion-verify:38`).

The healthcheck is the busybox `wget` form against `:8082/ping`; `traefik healthcheck --ping` cannot see the rendered `/tmp` copy. `StuRaOS/scripts/verify-traefik-acme-wiring.sh` moves into the kernel and is extended to assert all four markers survive the render, against `traefik:v3.7.1`.

**Deleted in the same commit:** `civitas/docker/traefik/dynamic/tls.yml` (the Cloudflare Origin default-certificate store — the most deceptive available TLS failure), both `./secrets/cf-origin.*` bind mounts, and the hardcoded port literals. Not ported: the Cloudflare overlay. The supported "TLS terminates in front of Traefik" mode is `TRAEFIK_CERT_RESOLVER=` (empty), which §E staging needs anyway, and it is documented as such.

**ACME volume:** declared `external: true` with `name: ${STACK}_traefik_acme` and mounted at `/letsencrypt`. Bootstrap already creates it; a hardcoded `name: gremion_traefik_acme` is forbidden by §E.

**Ports:** `- "${EDGE_BIND_IP}:${EDGE_HTTP_PORT}:80"` and the v6/https twins; the API and `internaltest` publishes are loopback-only. An unauthenticated Traefik API on `0.0.0.0` is the whole routing graph.

### 3. Routers, pins and middleware placement (B-09, B-10)

`gremion-ui-apexhost` is deleted and the four `HostRegexp` wildcard legs are deleted in the same change as the full-host resolver (tenant resolution is owned by the tenancy chapter; the edge post-condition is that an unregistered `<label>.<apex>` matches no router). `civitas/gremion-ui/scripts/check-domain-regex.mjs` and `civitas/gremion-ui/tests/unit/check-domain-regex.test.ts` guard `DOMAIN_REGEX`, which dies with the wildcard: both are deleted and their call sites in `civitas/gremion-ui/package.json` and `civitas/docker-compose.prod.yml` removed, so neither a dead nor a broken guard survives.

Per **B-09**: platform pins (`edge-hostpin-apex`, `edge-hostpin-control`, `edge-hostpin-www`, `edge-hostpin-sales`) and every other middleware any router chains are declared on the **Traefik container's own labels** — the only container guaranteed to exist whenever a router does. Per-tenant pins (`edge-hostpin-<tenant>`) are emitted into the tenant's own file in `/opt/gremion/etc/edge/` next to the router they protect, so the two can never be out of step and `gremion-switch` never touches either. No middleware is ever declared in `active.yml` (the switch file rewrites it) or on an app-tier service.

Consequently `gremion-ui-proxytrust` (`civitas/docker-compose.prod.yml:238` — the executable gate `resolve.ts` `isProxyTrusted` reads) and `gremion-ui-starting` (:243-246) move onto the Traefik container's labels. They vanish the instant `traefik.enable=false` lands on the app tier, not at the first colour switch, so the move lands in the same change as §5.

Also in this unit: two HSTS middlewares (`edge-hsts-platform` with `includeSubDomains`, `edge-hsts-custom` without; `preload` never); an `edge-ratelimit` family keyed on the connection address with three tiers (300/100 app hosts, 100/50 `/portal`, 30/10 `/auth/*` — new work, no auth-specific limiter exists in either tree) with `acme-http@internal` exempt, replacing the `CF-Connecting-IP` keying at `civitas/docker-compose.yml:293-301`; `tls.certresolver=${TRAEFIK_CERT_RESOLVER-le-http}` on all six kernel routers and in every emitted file; `gremion-public` re-pointed from `Host(public.${DOMAIN})` (`civitas/docker-compose.yml:288`) to the `Path(/portal) || PathPrefix(/portal/)` split at priority 30, carrying the `/portal-admin` shadowing note verbatim; `ADDRESS_HEADER=x-forwarded-for` + `XFF_DEPTH=1` on both apps.

`gremion-verify` is extended with the three §C assertions it lacks — HSTS per host class, rate-limit presence on every public router, and 403 from an unallowlisted source on `control.<domain>` — and with one §E assertion: **`gremion-verify --colour <new>` additionally asserts from inside the container (`docker exec … env`, `getent hosts`) that `INTERNAL_BASE_URL` and every leaf URL resolve to that colour only and never to a hostname under `PLATFORM_DOMAIN`.** It already implements router classification, cert SAN/validity, the forged-`X-Forwarded-Host` two-host universal and the acme-challenge 404-not-301 probe, and it already accepts `--hosts FILE`, so no work is needed to keep it green before spec C exists. **Post-condition:** every router Traefik's API reports carries a non-empty certresolver, exactly one host-pin middleware naming that router's own literal host, an HSTS middleware and a rate-limit middleware — asserted as a universal over the API's router list, never as a checklist of names.

### 4. Platform routers and the sales site (B-10)

Three routers exist in neither tree and ship in B: the `www` → apex 301 **on websecure only**; the `control.<domain>` router behind `CONTROL_ALLOWLIST_CIDRS` (fail-closed when empty), backed by the existing `fallback` service until `gremion-control` exists; and the sales site, moved out of `Code/Civitas/sturaos-staging` into `civitas/apps/sales-site` (static, built by the release workflow), its 14 `sturaos.com` literals replaced by `${PLATFORM_DOMAIN}`. The fourth repository is archived. All three carry a certresolver, a host pin and HSTS.

B-03 rides in this unit — see the assembler chapter §D.

### 5. The two-project split (§E)

State project = `docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml` (`civitas/infra/host/templates/env/state.env.tmpl:22`), so state-tier work is edits in place; only the app project gets a new file, and its list stays exactly `docker-compose.app.yml:docker-compose.pins.yml` (`app.env.tmpl:18`). `gremion-ui` and `gremion-public` are **removed from the root files entirely** into a new `civitas/docker-compose.app.yml` instantiated twice, as `${STACK}-app-blue` and `${STACK}-app-green`. Leaf databases stay in the state tier.

**`docker-compose.app.yml` carries only kernel app-tier services and the shared conventions.** B14 authors `gremion-ui` and `gremion-public`, the kernel's two one-shots (`migrate`, `tenant-create`), and the conventions every app-tier block inherits. Under F2 the nine leaves are not in the kernel when B14 runs: their service blocks live in `compose/<id>.yml` inside their own `gremion-module-<id>` repos (B-07) and arrive by inlining at assemble. The fragment contract, the per-service `x-gremion-tier` marker that routes a block into this file, and the inlining unit itself belong to **`D13-compose-fragment-inlining`** (spec D §D.1.4); spec B restates none of it. What spec B owns is the set of host-fixed identities every leaf fragment must honour — each is a line of merged host tooling and cannot be renegotiated inside a module repo — and the render guard in `B14-two-project-split` that asserts the union guard set over the assembled render.

**Host-fixed identities every leaf fragment carries:**

| Identity | Exact form | Why it is load-bearing |
|---|---|---|
| no edge labels | `traefik.enable=false` | app-tier services are reached only through `active.yml` |
| network aliases | `<service>-${COLOUR}` on **both** `${STACK}_edge` and `${STACK}_state` | `gremion-deploy:479-487` resolves the evict target by the `-<colour>` alias |
| evict label | `gremion.evict=true` | `gremion-deploy:452,464` dies when no container carries it |
| colour flag | `COLOUR`, `GREMION_ACTIVE_COLOUR_FILE=/run/gremion/active-colour` and the **directory** mount `${GREMION_ROOT:?}/runtime:/run/gremion:ro` | the worker colour gate for timed-job owners (B-15, Workers §1) |
| internal bearer | `INTERNAL_PUSH_SECRET` and the leaf's own `INTERNAL_<LEAF>_SECRET`, referenced as `${INTERNAL_<LEAF>_SECRET:?}` and present in the rendered env | `gremion-switch:98-113` POSTs with that bearer and aborts on anything but 204 |
| image | `image: ghcr.io/hello-n00del/gremion-<module id>:${IMAGE_TAG:?IMAGE_TAG required}`, no `build:` after the pins layer | a composition without pins must fail loudly, never build locally |
| service name and port | exactly as `civitas/infra/host/templates/env/app.env.tmpl:29-40` fixes them — `content-service`, `finance-service`, `files-service`, `votes-service`, `messages-service`, `newsletter-service`, `calendar-service`, `board-service`, `vault-service`, all on `8080`; the leaf image's **lowest exposed TCP port** is the port serving `/api/internal/evict` | `gremion-deploy:491-498` picks the evict port by lowest exposed TCP port; a renamed service or a lower unrelated port kills the deploy at step 8 or the switch at step 10 |

Both bearer keys are declared on the B side: `INTERNAL_PUSH_SECRET` (already at `app.env.tmpl:63`) and one `INTERNAL_<LEAF>_SECRET` per leaf are added to `civitas/infra/host/templates/env/app.env.tmpl` by B14 — the template declares no per-leaf key today — and are covered by the env coverage cross-check against the running project (§6). A leaf fragment that references a key the template does not declare fails the render guard.

**B14's render guard asserts the union** — `D13-compose-fragment-inlining`'s guard set, checked from the B side against the assembled pair, each row watched RED by a fresh verifier against a deliberately broken fragment:

| Assertion over the assembled render | Watched RED by |
|---|---|
| no fragment declares a `name:` key, a `COMPOSE_FILE` entry or a top-level `include:` | a fragment carrying `name: gremion_content` |
| a service name colliding with another fragment or with a kernel block aborts the assemble | two fragments declaring `content-service` |
| every service block carries an `image:` key and a per-service `x-gremion-tier` ∈ {`state`, `app`} that routes it | deleting the marker from one leaf block |
| append order is deterministic — ascending manifest `order:` — and two assembles of one `distManifestDigest` produce byte-identical `docker-compose.yml` and `docker-compose.app.yml` | hashing both files across two runs in one CI job |
| the zero-module and the all-module render both succeed and produce a byte-identical `COMPOSE_FILE` list (`state.env.tmpl:22`, `app.env.tmpl:18`) | a fragment that adds a file to either list |
| the per-service render count equals the sum of every enabled module's declared services, and is non-zero whenever the manifest names a module (vacuity guard) | a fragment silently lost to a YAML merge |
| no leaf fragment references an env key `app.env.tmpl` does not declare | `${INTERNAL_BOARD_SECRET:?}` with no template key |

Guard: `gremion-deploy` step 8 enumerates exactly nine leaf targets on a full-manifest release, watched RED by renaming one fragment service.

The `migrate` one-shot gains `profiles: [migrate]`, which the fixture lacks — without it `up` creates a migrate container and `gremion-deploy:428` kills the deploy on `health=none`.

Every `name: gremion_*` key is stripped from volumes and networks (`civitas/docker-compose.yml:510-528`); only the five §E externals keep a name. Every first-party `image:` becomes `ghcr.io/hello-n00del/gremion-<name>:${IMAGE_TAG:?IMAGE_TAG required}`, including `gremion-public` and `legal`, which declare none today, so a composition without the pins layer fails loudly instead of building locally or pulling the unowned Docker Hub `gremion/*` namespace. `docker-compose.pins.yml` sets `build: !reset null` and `image: …@sha256:…`. The LiveKit media publish is parameterised by `EDGE_BIND_IP`.

The 15 `depends_on` edges that cross the tier boundary are removed; compose refuses to render a project naming a service it does not contain. Each edge becomes either the boot retry class of §7 (already covering `57P03` and the connection-refused family) or a `gremion-deploy` ordering assert — never a silent drop.

**Post-condition:** `gremion-deploy` passes its release-tree checks and `assert_stack_isolation` on both colours; `civitas/test/host/deploy.bats` ("a release tree without `docker-compose.app.yml` exits 3 BLOCKED"), already RED, goes green; the state render contains zero app-tier services, zero `name: gremion_`, zero `image: gremion/`, and no first-party service without an `image:` key; `docker compose --env-file etc/env/app-blue.env config` renders with no unresolved `depends_on`; no app-tier env value names a first-party service without a `-${COLOUR}` suffix.

### 6. Env contract (B-08)

`load_env` in `civitas/infra/host/lib/common.sh` is **the single reader**, extended with an empty-value refusal for keys the template marks secret, and its inverted #476 comment corrected. `StuRaOS/scripts/validate-env.sh` is **not** ported: its four `head -n1` first-occurrence reads are the #476 HIGH defect, and compose takes the last occurrence. A thin `gremion-validate-env` adds only what `load_env` lacks: a compose-file fitness check and alias equality on the six doubly-keyed OIDC secrets. The kernel's two other weak gates (`civitas/scripts/setup.sh` placeholder substitution, the six-line `CHANGE_ME_` grep at `civitas/Makefile:295-303`) fold into it.

The **§E no-truncate-suite guard** lands here: every harness that truncates or drops refuses to start unless `DATABASE_URL` names a host whose `${STACK}` differs from the production `${STACK}`, asserted from inside the container (`docker exec … env`) and watched RED by a fresh verifier who points the harness at a production `DATABASE_URL`.

`DOMAIN` is **not renamed in app code**. It is bound once, in compose, as `${PLATFORM_DOMAIN:?PLATFORM_DOMAIN required}` at the single place each service's environment is assembled; the 20 default-less `${DOMAIN}` compose uses are rewritten to that expression. Every other identity variable gets `:?`, and the 15 silent `:-localhost` defaults are replaced.

`civitas/docker-compose.override.yml` (5 services, 5 fixed loopback publishes; the StuRa tree's is 22 services / 44 mappings) is **deleted**. The §E staging seam replaces it: `EDGE_BIND_IP=127.0.0.1`, ports 8080/8443, `TRAEFIK_CERT_RESOLVER=` empty, compose-side `extra_hosts` for `gremion-render` to fill (no compose file declares `extra_hosts` today), `COMPOSE_PATH_SEPARATOR` pinned per platform. The companion guard that resolves each staging name from inside three containers is spec A's staging task, named in §1.6(c).

CI renders the §E staging unit, through `--env-file` against a rendered staging env file — not `-f`/`--profile`, which `civitas/.github/workflows/ci.yml:158-190` uses today and which the widened N20 guard (`-f`, `--profile`, `-p`) must therefore also cover. **The existing `build:`-required guard at those lines is the repo's only supply-chain check and is kept unchanged**, with a new production-render guard added beside it. Converting `ci.yml`'s invocation to `--env-file` changes how the render is produced, never what the guard asserts; the assertions at `ci.yml:166-186` are moved verbatim.

### 7. `/healthz`, boot determinism, healthchecks

**`/healthz` (B-05).** `GET /healthz` on `gremion-ui` always returns 200 with body `{"ok":true,"tenant":<slug|null>,"colour":"<COLOUR>"}`; `COLOUR` is read once at module scope with an empty default (nothing in `civitas/gremion-ui/src` reads `COLOUR` today). The body is byte-stable per host and host-discriminating, as `gremion-verify:16-27` requires. `gremion-public` gets a tenant-blind marker (a written residual, §1.6(a)) plus a `${PUBLIC_BASE_PATH}` token in `active.yml.tmpl`'s `public`/`public-next` `healthCheck.path`, because `paths.base` is baked at build time. Container healthchecks move off `default.${DOMAIN}` onto `/healthz`, which needs no host header, no proxy-trust secret and no tenant row.

The `colour` field discloses which app-tier project served the request to any unauthenticated caller. That disclosure is **named and accepted** (B-05): `gremion-verify`'s colour assertions and the switch proof of the release procedure both read it, and no tenant data is exposed by it. It is recorded in `docs/deployment-architecture.md` as an accepted disclosure, not as a defect to be closed later.

Two exemptions, and **the exemption set is a closed allow-list**: `/healthz` and the `/api/internal/*` prefix (§T.5) are exempt from `tenantResolveHandle` (ahead of the proxy-trust gate; the unconditional blocker is the 404 at `civitas/gremion-ui/src/lib/server/tenant/resolve.ts:187-188`) and from `authGuard`'s `!_bootComplete` bare-503 branch. The allow-list is a single exported constant; a guard asserts its membership is exactly `['/healthz', '/api/internal/']` and **fails on a third entry**. It is distinct from `publicPaths` at `civitas/gremion-ui/src/hooks.server.ts:317` — which governs the session guard only and is where `/api/health` already sits; `/api/health` is not added to the resolver exemption.

**Boot determinism.** The sticky latch is kernel code, not a port: `_bootPromise` is memoised (`civitas/gremion-ui/src/hooks.server.ts:67-68`), `_bootError` latches (:219), `process.exitCode = 1` is set without exiting (:224), and `authGuard` serves a permanent 503 (:285-287). Change: drop the memoised promise on rejection so the next request re-attempts (the pattern already proven in the leaves at `StuRaOS/services/calendar/src/tenant-store.ts:727-739`), keep the in-flight promise, add exponential backoff with jitter and a larger ceiling in `db.ts`, and make a non-transient failure a real `process.exit(1)` under `restart: unless-stopped`. The transient/non-transient discriminator already exists (`isTransientDbStartupError`) and is preserved unchanged. `civitas/gremion-ui/src/hooks.boot.test.ts` (header :1-25; the control-plane case asserting `process.exitCode === 1`) and `civitas/gremion-ui/src/lib/server/db-startup.test.ts` currently pin the sticky behaviour **green** and are rewritten **in the same commit**; a commit that changes one without the other is rejected at review.

**Healthcheck census (§K).** Spec A §K's baseline is wrong and is corrected before the exemption list is built from it (§2.7): all nine leaves carry image-level `HEALTHCHECK`s; the genuinely unprobed running services are four — `vector`, `pgbouncer`, `fallback`, `docker-socket-proxy` — plus `livekit` and `element-call`. All are state-tier, which `gremion-deploy`'s app-only `wait_healthy` never inspects, so only `fallback` is gated today. The census is a **generated test over the production render plus image inspection** (no compose reader can see an image-level `HEALTHCHECK`), with a committed exemption list as its input; `HEALTH_EXEMPT_SERVICES=minio-mc` (`state.env.tmpl:70`) is the only entry, and a new exemption is a reviewed change. Keycloak's probe becomes honest: a thin kernel Keycloak image (also needed by §E to take the realm export, substitution script and themes off bind mounts), `KC_HEALTH_ENABLED=true`, probing `/health/ready` instead of the bare `/dev/tcp` connect that cannot distinguish "JVM bound a socket" from "realm imported". Synapse's probe asserts the OIDC provider loaded (`GET /_matrix/client/v3/login` containing both `org.matrix.login.jwt` and `"id":"oidc-keycloak"`); the file lives in `gremion-module-messages` and is owned by the Workers chapter §6.

### 8. Guards and how each is watched RED

Every guard below is watched RED by a **fresh verifier agent, never its author**, against the stated pre-change tree, before the fix lands.

| Guard | Watched RED against |
|---|---|
| All-or-nothing `certresolver` per render, including file-provider routers and the sales site | the current tree, where zero kernel routers carry one |
| Host-pin universal over Traefik's API router list | an apex router with its pin removed |
| No middleware referenced by any router is declared on an app-tier service | `proxytrust`/`starting` left on `gremion-ui` |
| Traefik holds exactly one `/etc/traefik/dynamic` mount and it is read-only | a second, writable mount of `etc/edge` on any app-tier service |
| Render-abort on a missing `PLATFORM_DOMAIN` | today's render, which emits ``Host(` `)`` with only a warning |
| No app-tier env value names a first-party service without a `-${COLOUR}` suffix | `INTERNAL_BASE_URL=http://gremion-ui:3000` |
| Fragment render guard — the `D13-compose-fragment-inlining` union asserted over the assembled pair (§5) | a fragment with its `x-gremion-tier` deleted, a second fragment colliding on `content-service`, and a repeat assemble of one `distManifestDigest` that differs byte-wise |
| No leaf fragment references an env key `app.env.tmpl` does not declare | `${INTERNAL_BOARD_SECRET:?}` against the template as merged |
| Duplicate-key refusal in any env file | `StuRaOS/scripts/validate-env.sh` behaviour (first-occurrence read) |
| Truncating harness refuses a production `${STACK}` | the harness pointed at a production `DATABASE_URL` |
| `/healthz` exemption allow-list closed at `['/healthz', '/api/internal/']` | a third entry added to the constant |
| Boot self-heal: a `gremion-ui` started before Postgres serves traffic once Postgres is up, with no container restart | the pre-change memoised `_bootPromise` |
| Census fails when an unprobed service is added | the four currently unprobed state-tier services |
| No `-f` / `--profile` / `-p` outside `--env-file` in `scripts/`, `Makefile`, `.github/workflows/`, `docs/runbooks/` | `ci.yml:158-190` before it is converted |

### Units in this section

Full rows are carried once, in the consolidated unit registry (final chapter).

| Unit | Role in this section |
|---|---|
| `B9-edge-static-config` | replaces `traefik.yml`, the entrypoints, the ACME resolver, the render-at-start markers and the `etc/edge` bind mount (§2) |
| `B10-resolver-fullhost` (edge half) | deletes `HostRegexp`, `apexhost` and the `check-domain-regex` guard pair; resolver half is §T.1 |
| `B11-healthz-and-boot-determinism` | `/healthz`, the closed exemption allow-list, the boot self-heal (§7) |
| `B14-two-project-split` | authors the kernel-owned app-tier blocks and the shared conventions, declares the per-leaf internal secrets in `app.env.tmpl`, and asserts the `D13-compose-fragment-inlining` union over the assembled render (§5) |
| `B15-env-contract-and-validator` | single env reader, `PLATFORM_DOMAIN` binding, staging seam, no-truncate guard (§6) |
| `B16-routers-middlewares-and-verify` | pins/HSTS/rate-limit placement and the three new `gremion-verify` assertions (§3) |
| `B17-platform-routers-sales-site-and-routes` *(B-10 + B-03)* | www/control/sales routers, the sales-site move, and the B-03 route work (§4, assembler §D) |
| `B30-healthchecks-and-census` | the generated census and the honest Keycloak probe (§7) |
| `B32-render-and-boundary-guards` | the guard register of §8 plus the colour-suffix build guard (§5) |

## Tenancy, realm surface, zero-tenant boot, tenant-create, internal API

This section owns the port-back of tenant identity into the kernel, the realm surface after B-01, what a zero-tenant instance does, the interim tenant-create entrypoint of B-06, and the `/api/internal` tree of B-11. `/healthz` itself (body, exemption allow-list, colour disclosure) is owned by the edge chapter under B-05 and is only referenced here. Migration numbering and byte-immutability are owned by the migrations chapter under B-04.

### T.1 Tenant identity port-back

The kernel is still on the pre-D1 subdomain model: `civitas/gremion-ui/src/lib/server/tenant/resolve.ts:36` exports `extractLeftmostLabel`, `:187-188` derives the slug from the leftmost DNS label and 404s without one, and `grep -rn tenant_domain civitas/` returns nothing. The kernel has no `host.ts`, no `leaf-trust.ts`, no `traefik-router.ts`, no `edge-sync.ts`.

| Item | Source | Requirement | Post-condition |
|---|---|---|---|
| `host.ts` | `StuRaOS/gremion-ui/src/lib/server/tenant/host.ts` (133 lines, `normaliseHost` at `:60`, `hostFromIssuer` at `:128`) | Move verbatim with its 205 test lines; it stays pure (no I/O, no env, no DB) and is the single normaliser used by both the read path and `addTenantDomain` | One function normalises on read and on write; a test asserts a host written and a host resolved agree byte-for-byte |
| `assertHost` | `StuRaOS/.../registry.ts:910` | Port the registry's write-path wrapper, not only `host.ts` | Every registry write path calls it |
| Control migration `004_tenant_domain` | `StuRaOS/gremion-ui/migrations-control/004_tenant_domain.sql:24-36` | **Two-file change**: the DDL (`tenant_domain` with the `lower(host)` + no-whitespace-no-comma CHECK, `tenant_domain_one_primary` partial unique index, `tenant_domain_tenant`) **and** the SHA-256 entry in `civitas/gremion-ui/migrations-control/manifest.json`, which today lists only 001–003 and is verified at `control-migrations.ts:21,26`. The 15-line issuer-derived seed at `:104-119` is **dropped** — under zero-tenant boot there is nothing to back-fill, and keeping it preserves the `AUTH_KEYCLOAK_ISSUER` → primary-host derivation this spec deletes | `runControlMigrations()` on a fresh control DB applies 004 and integrity verification passes; a manifest entry missing for 004 fails the run |
| `tenant_domain` accessors | `StuRaOS/.../registry.ts` (~487 lines of delta) | `resolveTenantByHost`, `getTenantStatusByHost`, `addTenantDomain`, `removeTenantDomain`, `listTenantDomains`, `listAllTenantDomains`, `primaryHostForTenant`, preserving the in-transaction owner pre-read (`:931-968`), clear-then-set primary, and `pg_notify` in the **same** transaction as the write (`:893-898`) | A host mutation and its eviction notice commit or roll back together |
| Full-host resolution | `resolve.ts` | Replace `extractLeftmostLabel` with `resolveTenantByHost`, reconciling with the existing readiness gate (`civitas/.../resolve.ts:220`) and the 429/503 ordering (`:237`). In the **same change**, delete the four `HostRegexp` wildcard legs (`civitas/docker-compose.prod.yml:114,131,208,268`) and resolve the call site of `scripts/check-domain-regex.mjs` so neither a dead nor a broken guard survives | An unregistered `<label>.<apex>` has no router and fails at Traefik; `grep -n HostRegexp civitas/docker-compose.prod.yml` returns nothing |
| Evictor parity | `civitas/.../registry.ts:445-461` vs `StuRaOS/.../registry.ts:650-682` | Add the eviction epoch, the `_hostResolutionCache` loop and the per-tenant rate-limit evictor. An un-evicted host-keyed entry is a cross-tenant selection | Evicting a tenant clears both slug- and host-keyed entries — watched RED by a fresh verifier against the current kernel evictor |
| `leaf-trust.ts` | `StuRaOS/.../leaf-trust.ts` (152 lines; the four-condition HARDENING-3 gate at `:1-45`: fixed route allow-list, constant-time per-route `x-internal-auth`, UUID-shaped `x-tenant-id`) | Port **with** `leaf-trust.test.ts`, `leaf-callback-roundtrip.test.ts`, `leaf-callback-select.test.ts`, `internal-hop-roundtrip.test.ts` — they are the only proof the id path cannot be reached without the gate | A leaf callback selects its tenant by id with no synthesised host; each of the four gate conditions has a test that fails when that clause alone is removed |

**Reserved-host refusal.** The refusal lives on `addTenantDomain`, not only in a control-plane form, so no surviving library caller can bypass it (spec A §H.2 places it *before* the DNS pre-flight, because the pre-flight cannot catch names that already point at the platform's own edge). The list is exactly spec A §C's nine platform-reserved names under `PLATFORM_DOMAIN`: the apex itself, `www`, `control`, `rs1`, `mail`, `mta-sts`, `autoconfig`, `autodiscover`, `_dmarc`. It replaces the vaultwarden HARDENING-2 collision check at `StuRaOS/.../registry.ts:957-970`, which dies with the service spec A §D deletes. `RESERVED_SLUGS` (`civitas/.../slug.ts:30-38`) is a *slug* guard and stays as-is; its stale comment calling `stura` "the default tenant's own slug" is corrected in the same commit. Post-condition: a kernel test adds each of the nine names and gets a refusal, and `gremion-verify` asserts no emitted `tenant-*.yml` names a reserved host.

**Router emitter and DNS pre-flight — libraries, off the pre-deploy path (B-06).** `traefik-router.ts` (856 source + 1085 test lines) ports as a library called by the control plane, never a CLI, re-targeting `SVC_APP` from `gremion-ui@docker` to `app@file` (spec A §D, already decided — not re-argued here), moving every pin/HSTS/proxytrust/starting/rate-limit declaration out of the emitted file onto the Traefik container's own labels, classifying each emitted router colour-bound or state-bound per §F.4.10, and adding the N16 per-IP limit. `edge-sync.ts` ports as a library with its security argument intact: the app process must never hold a writable mount of `/opt/gremion/etc/edge` — the only mount of that directory is Traefik's read-only one (edge §2). `edge-plan.ts` is **deleted** (425 lines; `DEFAULT_ORIGIN_SERVER_NAME = 'sturaos.com'` at `:45`; "Cloudflare" appears nowhere in spec A); only `renderNsDelegation`'s operator prose survives as control-plane copy. The DNS pre-flight does not exist as code anywhere and is a new build — a library that checks a candidate tenant host's A **and** AAAA records, distinct from `infra/host/bin/gremion-dns-check`, which verifies the platform zone per edit. Per B-06 neither the emitter nor the pre-flight is on the first-deploy path: tenant-create renders the router from the template instead. Post-condition: an emitted `tenant-<slug>.yml` diffs clean against `civitas/infra/host/templates/edge/tenant-router.example.yml`; no emitted file declares a middleware; `grep -rni vaultwarden civitas` and `grep -rn CF_API_TOKEN civitas` both return nothing.

### T.2 Zero-tenant boot

Today boot is a hard process-wide failure without a default tenant: `civitas/gremion-ui/src/hooks.server.ts:91` calls `registerDefaultTenant()` and `:121-123` throws `'[boot] default tenant not resolvable after registration'`. Deleting the call alone leaves the throw. Both go, with the whole env-derived-identity family:

| Deleted | Location |
|---|---|
| `registerDefaultTenant()` + the boot throw | `civitas/gremion-ui/src/hooks.server.ts:91`, `:121-123`; `src/lib/server/tenant/register-default.ts` and its three suites |
| `DEFAULT_TENANT` | `src/lib/server/tenant/default-tenant.ts:9-12` (`id: 'default'`, `configPath: env.CONFIG_PATH ?? '/app/config/config.json'`) |
| `defaultTenantEnv` seam | `src/lib/server/tenant/default-env.ts:27-29` (+ `default-env.test.ts`) |
| `slug === 'default'` config-path branch | `src/lib/server/tenant/registry.ts:664` |
| `slug === 'default'` auth-external-base branch | `src/lib/server/tenant/registry.ts:675` |
| `tenant.id === 'default'` branch | `src/lib/server/setup-token.ts:20` |
| `STURA_BLUEPRINT@1` literal | `src/lib/server/tenant/register-default.ts:121` (dies with the file; the blueprint default becomes a neutral kernel blueprint, the StuRa value supplied by `verticals/stura/` per D-02) |
| `deployment.mode` wizard gate | `provisioner/wizard-gate.ts`, its call at `provisioner/pipeline.ts:171`, `wizard-gate.test.ts`, the wizard step UI, and the `deployment.mode` schema in `src/lib/server/config.ts` |
| Synthesised tenant host | `provisioner/pipeline.ts:187` — `` `${slug}.${deps.apexDomain}` `` — replaced by the tenant's primary host from `tenant_domain`; `issuerForTenant` (`realm-doc.ts:74-76`) is minted **from that same host**, never configured separately, so `assertIssMatch`'s byte-strict comparison stays true by construction |
| LiveKit room-prefix branch | `StuRaOS/services/messages/src/livekit/livekit-client.ts:16` (`tenantSlug === 'default' ? '' : …`) — module work, lands in `gremion-module-messages`; the kernel has no `lib/server/messages/` twin |

`gen-realm-export.ts` in the kernel (26 lines) carries no host derivation and is unaffected as a *script*; what it generates changes under T.4.

**Semantics.** With zero tenants the app boots to a serving state. An unknown host — one with no `tenant_domain` row — gets **404** from the resolver at the edge of the request path, exactly as a suspended-but-unknown host does today; it never reaches a route handler. The only paths that answer without a resolved tenant are the closed exemption allow-list of B-05: `/healthz` (200, `{ok, tenant: null, colour}`) and the `/api/internal/*` prefix of T.5. The container healthcheck moves off `--header=X-Forwarded-Host: default.${DOMAIN}` (`civitas/docker-compose.yml:222`) onto `/healthz`, in the same commit as the `registerDefaultTenant` deletion — without it the container is permanently unhealthy and Traefik v3 silently drops its routers, the blackout documented at `StuRaOS/docker-compose.yml:693-696`. The **setup wizard becomes nothing**: the `deployment.mode` gate is deleted, the setup-token pattern is retired (spec A §H), and `/api/setup/seed` (`StuRaOS/.../seed/+server.ts:17-21,40`) stays request-scoped and tenant-resolved — it is reachable only *after* a tenant and its router exist, so tenant-create drives it. The ~20 kernel boot-path suites that get their tenant free from `registerDefaultTenant` are rewritten to create an explicit fixture tenant the way tenant-create does; that rewrite is itself the guard that the create path is complete. Post-condition: the app serves with zero rows in `tenant`, and `grep -rn "registerDefaultTenant\|defaultTenantEnv\|DEFAULT_TENANT" civitas/gremion-ui/src` returns nothing.

### T.3 The interim `tenant-create` service (B-06)

A one-shot, profile-gated compose service authored by `B14-two-project-split` into the kernel's `docker-compose.app.yml`, documented as an interim library entrypoint the control plane replaces and **deleted by spec C**:

```
docker compose --env-file etc/env/app-<colour>.env run --rm \
  tenant-create --slug <s> --host <h> --vertical <v>
```

It wraps the existing kernel provisioner library (`provisioner/{pipeline,lifecycle,materialize,realm-doc,reconcile,kc-admin-api}.ts`) and writes, in this order: the `tenant` row and its `tenant_domain` primary host (subject to the T.1 refusal); a `tenant_provisioning_resource` row per subsystem — the ledger already exists at `StuRaOS/gremion-ui/migrations-control/001_tenant_registry.sql:31-40` with `CHECK (subsystem IN ('db','realm','nextcloud','matrix'))`, widened by `B38-leaf-shreds-and-erasure-ledger` — **identical rows to what spec C will write**, so C replaces the caller and not the schema; the per-tenant `services` fields (`matrixUrl`, `livekitUrl`, `heliosUrl`, `synapseServerName`, `smtp`) and `configPath` explicitly, because the `slug === 'default'` env fallbacks are gone and every tenant is equal; the tenant's Keycloak realm, created **through the master bootstrap admin** with the account-console client stripped and subsequent changes applied as **Admin API deltas, never a re-import** (spec A §H); and the tenant router file rendered from `civitas/infra/host/templates/edge/tenant-router.example.yml` — one router, `service: app@file`, `priority: 10`, middlewares referenced as `…@docker`, `tls.certResolver` present or the whole `tls` key absent. It then drives the seed against the tenant's host. Post-condition: on a freshly booted zero-tenant stack one invocation produces a tenant that serves its host and passes the login journey end-to-end through Keycloak; `docker compose up` on the app project starts no `tenant-create` container.

### T.4 The realm surface (B-01)

**No boot-time realm.** The Keycloak boot import is deleted: the `--import-realm` argument (`civitas/docker-compose.yml:335`), the entrypoint's `substitute-realm-secrets.sh … /opt/keycloak/data/import/realm-export.json` wrapper (`:331`) and the two mounts (`:377-378`) go, together with the generated `docker/keycloak/realm-export.json`. Its `REALM_DST="${IMPORT_DIR}/sturaos-realm.json"` at `:80` — the DirImportProvider `{realm}-realm.json` coupling that silently boots a realm-less Keycloak when missed — is deleted with the import path rather than renamed. `realm-export.base.json` becomes **only** the per-tenant template consumed by `buildTenantRealmDoc` (`realm-doc.ts:254-300`), which already overwrites `composed.realm = realmName` (`:271`) and swaps the template authority to the tenant host (`:280`). `platform` stays reserved for spec C's own realm. The mail tooling's probe realm moves to **`master`**: `infra/host/templates/env/mail.env.tmpl:100` becomes `KEYCLOAK_PROBE_REALM=master`, consumed unchanged at `infra/host/bin/gremion-mail-bringup:662,665,669`.

**Rename split (B-01).** Realm identity now, theme and hygiene rule after the first deploy — two units, `B1a` and `B1b`.

**`B1a` — realm identity rename now** (S, on the path), with the exact carriers: `realm-export.base.json:2` `"realm": "sturaos"` → a sentinel that `buildTenantRealmDoc` overwrites; the three display strings in the same file (`:85` "StuRa UI", `:174` "StuRa Admin Service Account", and the "Standard StuRa member" role description); the 22 non-doc, non-test `realms/sturaos` carriers — `.env.example:54,69`, `gremion-ui/.env.example:5`, both compose files, the workflows, `scripts/dev-configure.sh`, `scripts/configure-keycloak-clients.sh` (which hard-codes `REALM="sturaos"` as an Admin-API path segment), `gremion-ui/vitest.integration.config.ts:52-53`, `test/fixtures/.env.test`, `test/configure-keycloak.bats`, `test/integration/health.bats`; and `k8s/base/gremion-ui/configmap.yaml:38,43`. Per-tenant realm naming needs no design: `pipeline.ts:186` already sets `realmName = args.realmName ?? slug`.

**`B1b` — theme rename + hygiene rule after the deploy** (M, off the pre-deploy path): `docker/keycloak/themes/sturaos/` (11 files) → `gremion`, atomically with `loginTheme`, `theme.properties`, `sturaos.v2.css` and the four `<link href=…>` lines — a mismatch falls back to the stock theme with no error; the 19 `sturaos*` message keys; and the eight `${(realm.displayName)!'StuRaOS'}` fallbacks (`login.ftl:10,19`, `error.ftl:10,19`, `login-otp.ftl:8,17`, `login-reset-password.ftl:8,17`), which render the retired name on any realm without a `displayName`. In the same unit, delete the `themes/sturaos/**` carve-out at `scripts/kernel-hygiene-check.mjs:757-769` and add a **bare-token** rule — the existing rule at `:755` requires a trailing dot, which is how these survived the public flip — with an explicit allow-list for `gremion-ui/scripts/install-git-hooks.mjs:29-30`'s installed-hook markers and the four SHA-pinned applied migrations (`008`, `042`, `043`, `048`). The guard is watched RED against the pre-rename tree by a fresh verifier and must report the current tracked-tree hits; `KNOWN_ISSUES.md §T11`'s "why it is not renamed" is overwritten in writing.

**gremion#6** rides in the template: an `smtpServer` block in `realm-export.base.json` with `__SMTP_*__` sentinels, `requireTLS: true` on every non-465 transport, a fail-closed "email login enabled but SMTP unset" check (the export has `loginWithEmailAllowed: true` at `:7` and `resetPasswordAllowed: true` at `:9`), and the matching Admin-API delta for already-created realms. The sentinels are **substituted by `buildTenantRealmDoc` (`realm-doc.ts:254-300`) at composition time, not by the deleted Keycloak entrypoint**: the provisioner is now the only consumer of `realm-export.base.json`, so every `__…__` sentinel — the two existing ones (`__GREMION_UI_OIDC_CLIENT_SECRET__`, `__APEX_DOMAIN__`) and the new `__SMTP_*__` set — is filled in the same pass that swaps the realm name and authority. `substitute-realm-secrets.sh` therefore has no caller and is deleted with the import path. Post-condition: a composed `RealmDoc` for any tenant contains zero `__…__` sequences (already asserted by §T.5's compose-realm post-condition), and `gremion-mail-bringup` assert 6b finds `"smtpServer"` in the release tree's `docker/keycloak/` (`gremion-mail-bringup:633-635`); a fetched login page for a realm with no `displayName` contains `gremion` and zero `StuRaOS`, and its stylesheet resolves 200.

### T.5 The `/api/internal` tree (B-11)

The kernel has no `src/routes/api/internal/` directory at all — this is greenfield. One internal bearer governs the whole tree, verified with the existing tested `isInternalBearerRequest`, which reads `INTERNAL_PUSH_SECRET` (`civitas/gremion-ui/src/lib/server/internal-fetch.ts:213-227`, constant-time, returning false rather than throwing when the secret is unset; five cases at `internal-fetch.test.ts:97-128`) — the same key `gremion-switch` sends (`infra/host/bin/gremion-switch:106`) and the same key every leaf receives, so one value governs the whole fan-out. Post-condition: `docker exec` on gremion-ui and on each leaf shows the identical `INTERNAL_PUSH_SECRET`, and an empty value makes every evict target answer 401, never 204.

A single resolver + boot-503 exemption covers the whole `/api/internal/*` prefix; that exemption and `/healthz` form the **closed** allow-list of B-05, with a guard that fails when a third entry is added (edge §7).

**`POST /api/internal/evict`** — body `{"tenant": "<slug>"|"*"}`, **always 204 with an empty body**, on gremion-ui and on every leaf. For a slug: `evictTenantRuntime(id)`. For `"*"`: a new `evictAllTenants()` that iterates every cached id through `evictTenantRuntime`, then clears `_hostResolutionCache` and the readiness maps `_readiness` and `_retriesInFlight` (`civitas/.../tenant/readiness.ts:31,34`), which `evictTenantRuntime` does not touch. `"*"` never clears cross-tenant singletons; the per-tenant `config.json` needs no evictor (`readConfig()` does a `readFileSync` per call), and `fleet.ts` holds no module-level state. Each evicting process writes an **ack row** `(tenant_id_or_star, process, colour, epoch)` to the control DB **before** answering; the table lands as control migration `005_tenant_evict_ack.sql` in `B19b`, the same two-file change as 004 (SQL + `manifest.json` entry). Contract test: a 200 is **rejected** — written and watched RED by a fresh verifier before the route exists.

**Leaves.** The evict route mounts **outside** `checkGuard`, whose three clauses (per-leaf `INTERNAL_<LEAF>_SECRET` on `x-internal-auth`, `x-tenant-id`, `x-tenant-slug` — `StuRaOS/services/board/src/http/guard.ts:50-64`) the fan-out cannot satisfy, since `{"tenant":"*"}` names no tenant; it mirrors the existing guard-exempt `/healthz/tenants` precedent. The identical contract — `POST /api/internal/evict {"tenant":"*"}` with the bearer returns 204 with an empty body, a 200 fails, the route reachable outside the three-header guard, the ack row written before the answer — is asserted per module repo by the `evict-contract` CI job of `D12-module-repo-ci-and-dependabot-template`, in every repo that ships a `service/`; spec B keeps the host-side proof in `test/host/deploy.bats` and restates nothing else of that job. Secrets reaching module-owned leaves: `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf are declared in `app.env.tmpl` (added by `B14-two-project-split`, covered by the env coverage cross-check); fragments reference them as `${INTERNAL_<LEAF>_SECRET:?}`, and the assembler's render guard fails on a leaf fragment that references an undeclared key. Real `evictTenant(id)` for calendar, content, finance and newsletter over the existing bounded-LRU `endEvictedPool` machinery (`tenant-store.ts:142-150,236`); a 204 no-op for board, vault, files, votes and messages. The dead `/api/internal/push` stub is deleted with its `x-internal-secret` auth shape.

**Labels and the two-colour fix.** `gremion.evict=true` is one of the host-fixed identities every app-tier block must honour: on `gremion-ui` and `gremion-public` it is authored by `B14-two-project-split`, and on the nine leaf blocks it arrives with the module-owned fragments, whose contract and guard set are owned by `D13-compose-fragment-inlining` — spec B references that unit by id and restates neither. `infra/host/bin/gremion-deploy:446-464` enumerates targets for **one** colour's compose project (`--filter label=com.docker.compose.project=${STACK}-app-${colour}`), which cannot satisfy spec A §H.2's "both app colours for as long as either project is up"; B fixes it to enumerate every up `${STACK}-app-*` project, with a bats case in `test/host/deploy.bats` proving that with both colours up the fan-out reaches every process in both projects and gets exactly 204 from each. Until spec C consumes the ack rows, the written residual stands: a 204 alone does not distinguish a partial fan-out from a complete one.

**`GET /api/internal/modules`** — same bearer. The payload is a projection of `module.json` (that schema is owned by `D2-module-json-and-dist-schema`, which also fixes each field's single source), serialised from the generated barrel `civitas/gremion-ui/src/lib/modules/manifests/index.generated.ts:14` (`MODULE_MANIFESTS`): **that barrel is the authoritative payload source for the endpoint**, and D2's validator is what keeps it equal to `module.json`, so the response has no third place to look. Per enabled module it carries:

| Field | Meaning | Consumer |
|---|---|---|
| `id`, `displayName` | module identity | control plane, catalogue UI |
| `order` | the manifest order, equal in `module.json`, `ranges.json` and the TypeScript manifest | deterministic composition and append order |
| `notTenantIsolated` | moves onto the kernel's `ModuleManifest` type (`civitas/gremion-ui/src/lib/modules/types.ts`) | tenant erasure, per-tenant provisioning |
| `realm` fragment | the module's realm contribution | `compose-realm` |
| `migrationBlock` (`[lo, hi]`) — today `migrations[]` is a basename list | block ownership | migrations chapter §5 |
| `extractionSource` | the frozen 40-character lowercase-hex extraction SHA every enabled module agrees on (`B00-extraction-source-freeze`) | release provenance |
| `distManifestDigest` | `"sha256:"` + 64 lowercase hex of the manifest bytes as read, so a control-plane cache entry is keyed on something the response itself states (spec A §H) | control plane |
| `runtime.leafService` | `{ name, port: 8080, postgresService, databases: { control, tenantPattern } }`; `name` and the port are host-fixed by `app.env.tmpl:29-40` | evict fan-out, backup enumeration, erasure |
| `runtime.timedJobs[]` | `{ id, activeColourOnly }` per declared timed job | worker colour policy (Workers §1) |
| `runtime.shred` | `true \| false` — whether the module has an erasure shred arm | the erasure gate (storage §5) |

The whole `runtime` block is consumed by `D10-module-runtime-declarations`. `BACKUP_POSTGRES_SERVICES` and the colour-policy job list are **produced from this catalogue at assemble time** — written into `state.env` / `app.env` by the assembler — and are never hand-maintained; storage §3.4 reads the leaf list from `runtime.leafService.postgresService`.

Post-condition: the payload matches `MODULE_MANIFESTS` exactly, its `notTenantIsolated` entries are exactly board and vault, the projection is asserted **field-for-field against `module.json`**, and an unauthenticated call is refused.

**`POST /api/internal/compose-realm`** — same bearer. Request `{slug, realmName, tenantHost, config, clientSecrets}`; response the composed `RealmDoc` produced by `buildTenantRealmDoc` (`realm-doc.ts:254`), i.e. `composeRealm` over the enabled manifests plus per-tenant realm identity, host swap and client-URI restriction. The shape is named nowhere else and is fixed here. Post-condition: every URI authority in the response equals `tenantHost`, no `__…__` placeholder survives, and the response's `realm` equals the requested `realmName`.

**Carve.** A narrower `MIRRORED` rule for `gremion-ui/src/routes/api/internal/{evict,modules,compose-realm}/**` and `/healthz` must be inserted **before** `product-module-api-routes`, whose include list carries `gremion-ui/src/routes/api/internal/**` with `"relationship": "PRODUCT_ONLY"` (`StuRaOS/scripts/carve/kernel-manifest.json:325,334`) on a first-match-wins basis — otherwise these kernel routes are silently carved out. This is one of the two narrow carve-rule additions of B-02, owned by `B3` (assembler chapter §A(2)(a)); it is a hard dependency of the units below.

### Units in this section

Full rows are carried once, in the consolidated unit registry (final chapter).

| Unit | Role in this section |
|---|---|
| `B1a-realm-identity-and-boot-import` | deletes the boot import and renames realm identity (§T.4) |
| `B1b-theme-rename-and-hygiene-guard` | theme rename and the bare-token hygiene rule, after the first deploy (§T.4) |
| `B2-realm-smtp-block` | the gremion#6 `smtpServer` template block on the `buildTenantRealmDoc` seam (§T.4) |
| `B8-tenant-domains-and-leaf-trust` | `host.ts`, `tenant_domain`, the reserved-host refusal, evictor parity, `leaf-trust` (§T.1) |
| `B10-resolver-fullhost` | full-host resolution (§T.1); edge half in the edge chapter |
| `B12-zero-tenant-boot` | deletes the default-tenant family and rewrites the boot suites (§T.2) |
| `B13-tenant-create-entrypoint` | the interim one-shot of §T.3 |
| `B18-router-emitter-library` | `traefik-router.ts` / `edge-sync.ts` as libraries; `edge-plan.ts` deleted (§T.1) |
| `B19-internal-api-evict-and-modules` | the three internal routes and their contracts (§T.5) |
| `B19b-evict-ack-migration` | control migration `005_tenant_evict_ack.sql` + manifest entry (§T.5) |
| `B20-evict-labels-and-fanout-fix` | both-colour fan-out enumeration in `gremion-deploy` (§T.5) |
| `D2-module-json-and-dist-schema` | spec D unit; owns the `module.json` schema the §T.5 payload projects |
| `D4-evict-on-leaves` | spec D unit; `B20` depends on it |
| `D10-module-runtime-declarations` | spec D unit; consumes the `runtime` block of the §T.5 payload |
| `D12-module-repo-ci-and-dependabot-template` | spec D unit; carries the `evict-contract` CI job cross-referenced in §T.5 |
| `D13-compose-fragment-inlining` | spec D unit; owns the fragment contract the leaf blocks of §T.5 satisfy |

## Migrations: port-back, canonical bytes, renumber, ranges, baseline, migrate job, leaf ledgers

Scope: the data-plane chain (`gremion-ui/migrations`), the control chain (`gremion-ui/migrations-control`), the six leaf chains (`services/<leaf>/migrations`), and the job that applies them. The edge, tenant-create and assembler topics belong to their own chapters; this chapter owns only what those chapters consume: `migrations/ranges.json`, `migrations/baseline-hashes.json`, and the `migrate` compose service contract of spec A §F.4.7.

### 1. Census (measured, not assumed)

| Lane | Location | Files |
|---|---|---|
| Data plane, StuRa tree (authoritative source) | `StuRaOS/gremion-ui/migrations` | 58 `.sql`, `001`–`058`, contiguous, no duplicate numbers, 3 dev seeds |
| Data plane, kernel | `civitas/gremion-ui/migrations` | 22 `.sql` |
| Data plane, modules holding repo | `civitas-modules/gremion-ui/migrations` | 24 `.sql`, no `manifest.json` |
| Data plane, absent from the kernel tree | `StuRaOS/gremion-ui/migrations` minus the kernel's 22, minus the 20 finance-block files and `044`/`045` that `civitas-modules` carries | 14 — `003`, `034`, `046`, `047`, `049`, `050`–`058` (measured 2026-09-15 by `ls` over all three trees; `003` and `034` are absent from the kernel but present in the modules holding repo, `046`–`058` are in the StuRa tree alone); of these, **9** are ported into the kernel block (§2: `003`, `034`, `049`, `053`–`058`), **3** are handover (`050`–`052`) and **do not ship at all** in release 1 (D-01; §4), and **2** are content-module files (`046`, `047`) renumbered in the StuRa tree before extraction and never entering the kernel |
| Control plane, StuRa tree | `StuRaOS/gremion-ui/migrations-control` | `001_tenant_registry`, `002_tenant_migration_runs`, `003_tenant_uniques`, `004_tenant_domain` |
| Control plane, kernel | `civitas/gremion-ui/migrations-control` | the first three only |
| Leaf chains | `StuRaOS/services/{board,calendar,content,finance,newsletter,vault}/migrations` | 1, 3, 3, 2, 1, 2 = 12 |

**Data-plane arithmetic:** the StuRa chain is 58 contiguous files; the kernel holds 22 and the modules holding repo 24 (disjoint sets, kernel ∩ modules = ∅); 36 StuRa files are absent from the kernel tree, of which nine are kernel-owned and are ported into the kernel block in §2 and the remaining 27 are module-owned or handover. The three handover files are ported nowhere: per D-01 they do not ship in release 1 and block 1900–1999 is reserved and empty. After the renumber the kernel block holds 31 files and the module blocks 24 (finance 20, content 4), 31 + 24 = 55 = 58 minus the three handover files — plus the one newly written content migration of §4 (`1200_content_news_posts.sql`), which is created by B rather than renumbered. The leaf chains (12 files under `services/<leaf>/migrations`) are a separate axis and are not part of this arithmetic.

### 2. Port-back: nine data-plane files plus control `004`

Spec A §D:167 names seven and is amended here (§2.7): `057` and `058` postdate it, it wrongly implies `004` is missing — `civitas/gremion-ui/migrations/004_committee_elections.sql` is present — and its arithmetic predates D-01, under which the three handover files enter neither the kernel nor any module repo.

| Port | From | Why it is kernel-tree-bound | Order constraint |
|---|---|---|---|
| `003_calendar_schema` | StuRa tree | cross-cutting kernel DDL on a module table (`calendar_events`) | before `008` |
| `034_deck_board` | StuRa tree | cross-cutting kernel DDL on a module table (`deck_board`) | none |
| `049_org_unit_event_outbox` | StuRa tree | unclaimed by any manifest | with the outbox/relay subsystem (`lib/server/events/` is absent from the kernel) |
| `053_notification_read_marker` | StuRa tree | unclaimed | none |
| `054_resolution_adoption_mode` | StuRa tree | unclaimed | after `007_protocols` |
| `055_resolution_challenges` | StuRa tree | unclaimed | **strictly before `058`** |
| `056_role_assignment_history_recalled` | StuRa tree | unclaimed | none |
| `057_fk_hot_filter_indexes` | StuRa tree | unclaimed, purely additive | after `010_org_units` |
| `058_public_reader_grants` | StuRa tree | unclaimed; the fresh-install grant fix | last of the nine |
| `migrations-control/004_tenant_domain` | StuRa tree | control chain, kernel-owned | after control `003` |

Handover's `050_handover_schema`, `051_handover_event` and `052_handover_module_binding` are deliberately **not** on this list: D-01 keeps handover private and unextracted and its migrations do not ship in release 1 (§4).

**Every ported file comes from the StuRa tree at the frozen extraction source `f276af5925abacdcfd05f6613fc11afff2d804c5` — the `extractionSource` value `B00-extraction-source-freeze` pins and every `module.json` echoes (§2.4). The modules holding repo is read for exactly one artefact — its `MIGRATION_OWNERSHIP` map, harvested as the seed for `ranges.json` (§5) — and for nothing else.**

`058` aborts (`RAISE EXCEPTION`) when any of its seven `portal_tables` is absent — `StuRaOS/gremion-ui/migrations/058_public_reader_grants.sql:58-66,115-131` — and `resolution_challenges` is created by `055`. That is the 055→058 constraint.

`058` is **adapted, not copied**, in two respects. (a) Its rename half is moot in the kernel: `civitas/gremion-ui/migrations/008_public_portal.sql:20` already tests `gremion_public_reader`, while the StuRa `008:37` still tests the retired `stura_public_reader`. (b) Its `GRANT CONNECT` correction is already `current_database()`-bound (`058:105-110`), so **no separate correction migration is written** and the kernel's `008` is not edited — its divergence is carve-mandated and `008`'s bytes are pinned by the SHA-256 manifest.

The remaining adaptation is `news_posts`. The kernel's `008:4-6` records that the `news_posts` table "moved out with the calendar/news modules during the Civitas kernel carve", and the kernel `008` therefore creates no such table — but `058`'s `portal_tables` requires it. Post-condition: the ported `058` grants the kernel-guaranteed subset unconditionally and still aborts on absence, while `news_posts` moves into the content module's own grant, so a content-OFF kernel-only fresh install completes green and a content-ON install still yields a working anonymous portal. Under P2 all modules are on in release 1, so this changes no release-1 behaviour; the guard is the content-OFF case.

The kernel today has **no migration-ownership guard**: `civitas/gremion-ui/src/lib/modules/migration-ownership.test.ts` does not exist and the StuRa original is classified `PRODUCT_ONLY` by the carve manifest. It is reclassified and ported in the same unit as the nine files, extended with the missing board-OFF/`034` fresh-init replay case (the StuRa file covers only the calendar-OFF/`003` and elections-OFF/`004` cases, `migration-ownership.test.ts:27-75`). Without it the port-back can silently adopt module DDL as kernel DDL.

### 3. Canonical bytes (B-02)

**Kernel bytes win** for every file the lanes share. No adjudication is required between kernel and modules because their number sets are disjoint; the rule exists for the kernel-vs-StuRa and modules-vs-StuRa pairs. 19 of the 46 shared basenames differ byte-for-byte at HEAD: kernel-side `004, 005, 006, 008, 009, 024, 033, 048`; modules-side `025`–`032, 034, 035, 036`. 14 StuRa files still carry `-- stura-ui/migrations/…` headers.

**One normalisation commit** lands before the renumber and only for files that need it: it makes every shared basename byte-identical across the three lanes to the kernel's bytes, drops the stale `stura-ui/` headers, and adds `.gitattributes` with explicit `*.sql text eol=lf` to `civitas-modules`, which has none (`civitas/.gitattributes:7` and the StuRa tree already carry it). `008` stays diverged by carve mandate and is exempt by name. Post-condition: on a Linux checkout, `sha256sum` of every shared basename is equal across the three lanes, with `008` the single named exception. The renumber commit that follows is a **pure rename with zero byte edits** — header cross-references that go stale are fixed in a later commit, after the baseline is captured.

### 4. Renumber (B-04)

One zero-pad width of **four digits across every data-plane block**, because both runners sort lexicographically — `civitas/gremion-ui/src/lib/server/db.ts:184` (`readdirSync(...).sort()`) and `civitas/gremion-ui/src/lib/server/tenant/control-migrations.ts:20` — and `tenant/fleet.ts:112` reads the high-water mark with `ORDER BY filename DESC`. Mixed widths would sort `1000_…` before `199_…`.

**Block allocation.** Kernel `0001`–`0199`. Module blocks start at 1000 in blocks of 100, **allocated in ascending manifest `order:`** — the allocation is derived, not chosen, and is **owned by `D2-module-json-and-dist-schema`**; this spec consumes it. The `order:` values are measured in the StuRa tree: `finance.ts:27`=20, `elections.ts:10`=30, `content.ts:22`=40, `newsletter.ts:11`=50, `users.ts:8`=60, `calendar.ts:21`=70, `files.ts:20`=80, `messages.ts:21`=90, `board.ts:22`=100, `handover.ts:28`=110, `vault.ts:22`=115.

| Block | Owner (`order:`) | Assigned |
|---|---|---|
| 0001–0199 | kernel | 31 files |
| 1000–1099 | finance (20) | 20 files, 1000–1019 |
| 1100–1199 | elections (30) | reserved, empty today |
| 1200–1299 | content (40) | 5 files, 1200–1204 |
| 1300–1399 | newsletter (50) | reserved, empty today |
| 1400–1499 | users (60) | reserved, empty today |
| 1500–1599 | calendar (70) | reserved, empty today |
| 1600–1699 | files (80) | reserved, empty today |
| 1700–1799 | messages (90) | reserved, empty today |
| 1800–1899 | board (100) | reserved, empty today |
| 1900–1999 | handover (110) | **reserved and empty**: `050`–`052` do not ship and **no `gremion-module-handover` repo exists in release 1** (D-01), so `ranges.json` records the block with `extractedTo: null`; the dated visibility decision is `D16-handover-visibility-record` |
| 2000–2099 | vault (115) | reserved, empty today |

Kernel files keep their present numeric value, zero-padded, so kernel relative order and every by-number prose reference stay valid: `001→0001 governance_schema`, `002→0002 config_store`, `003→0003 calendar_schema`, `004→0004 committee_elections`, `005→0005 dev_seed`, `006→0006 full_seed`, `007→0007 protocols`, `008→0008 public_portal`, `009→0009 audit_log`, `010→0010 org_units`, `011→0011 org_units_dev_seed`, `012→0012 role_assignment_history_pseudonymize`, `018→0018 sub_org_type`, `024→0024 audit_log_composite_index`, `033→0033 org_unit_child_term`, `034→0034 deck_board`, `037→0037 provisioning_member_ops`, `038→0038 org_unit_kind_catalog`, `039→0039 caucus`, `040→0040 event_consumption`, `041→0041 protocol_resolution_global_nr_unique`, `042→0042 protocol_resolution_required_majority`, `043→0043 audit_log_hash_chain`, `048→0048 resolution_decided_at`, `049→0049 org_unit_event_outbox`, `053→0053 notification_read_marker`, `054→0054 resolution_adoption_mode`, `055→0055 resolution_challenges`, `056→0056 role_assignment_history_recalled`, `057→0057 fk_hot_filter_indexes`, `058→0058 public_reader_grants`.

Finance, in current numeric order: `013→1000`, `014→1001`, `015→1002`, `016→1003`, `017→1004`, `019→1005`, `020→1006`, `021→1007`, `022→1008`, `023→1009`, `025→1010`, `026→1011`, `027→1012`, `028→1013`, `029→1014`, `030→1015`, `031→1016`, `032→1017`, `035→1018`, `036→1019`.

Content: **`1200_content_news_posts.sql` is new** — the `news_posts` table and its published index lifted verbatim from `StuRaOS/gremion-ui/migrations/008_public_portal.sql:14-27`, which is self-contained (no FKs); then `044→1201 content_schema`, `045→1202 content_publish`, `046→1203 content_publish_ops`, `047→1204 news_posts_content_origin` (D-04 folds news into content, migration `047` included). `1204` ALTERs the table `1200` creates, so the two must stay in this order inside the block. Spec B's `B4a-news-posts-ownership` owns the lift; spec D's content row lists all five.

Handover: nothing is renumbered. Migrations `050_handover_schema`, `051_handover_event` and `052_handover_module_binding` **do not ship** (D-01); block 1900–1999 is reserved and empty, its files stay frozen in the archived StuRa tree with the recovery command recorded there, and `ranges.json` carries the reserved block by written rule.

**The three cross-cutting kernel migrations that alter module tables — `0003` (`calendar_events`), `0004` (`committee_elections`), `0034` (`deck_board`) — stay in the kernel block and stay kernel-applied by written rule**, restated in `migrations/README.md` and enforced by the ported ownership test.

Control chain: untouched, `001`–`004` at three digits. The fixed-width rule is **per directory**, because each directory has its own runner and its own sort.

Load-bearing references updated in the same commit (roughly 25–40 files in the StuRa tree, doubled by the pinned `upstream/gremion` submodule copy; the exact set is produced by matching the 58 basenames against `.ts`/`.mjs`/`.json`): the three module manifests, the `readFileSync`-by-name integration tests, and `StuRaOS/gremion-ui/src/lib/server/boundary/rules.ts:9-13`, whose `FK_ALLOWLIST` is keyed on `013_finance_schema.sql`. `services/*/migrations/manifest.json` are independent leaf chains and are **not** touched. `civitas-modules`'s `NEXT_FREE_MIGRATION_NUMBER` (`registry.ts:258`, asserting 58 is free while `058` has shipped) is retired rather than ported; its `MIGRATION_OWNERSHIP` map is harvested as the seed for `ranges.json` and the repo is then archived.

Sequencing is forced and is written into the gate: netcup `down -v` → port-back → normalisation → renumber → regenerate every manifest → capture `baseline-hashes.json` → split module repos. `schema_migrations` is keyed by filename (`db.ts:152-155`), so the window closes at the first durable tenant. On the live box only `gremion` (55 rows) and `control` (4 rows) hold ledger rows, in a declared-throwaway environment. `tenant_migration_run` (control `002`) keeps historical rows naming pre-renumber filenames; it is an audit ledger, not a skip source, and **must not be "repaired"**.

#### 4.1 Guards

| Guard | Post-condition | Watched RED by a fresh verifier |
|---|---|---|
| sort-order | for each migration directory, `readdirSync(dir).filter(.sql).sort()` equals the same list ordered by parsed integer | plant one 3-digit file in a 4-digit directory; the test fails |
| ranges coverage | every shipped data-plane file falls in exactly one `ranges.json` range; no file is uncovered and no two ranges overlap; a reserved block (handover's 1900–1999 among them) contains no shipped file | add a file outside every range, and separately plant one file in 1900–1999; the test fails in both cases |
| ownership | no file claimed by a module manifest sits in the kernel block, and vice versa, except the three named cross-cutting files | move `0034` out of the exception list; the test fails |
| baseline | §5 | §5 |

### 5. `migrations/ranges.json` and `migrations/baseline-hashes.json`

Neither file exists in any repo today. Both live at `gremion-ui/migrations/` in the kernel and both are committed.

**`ranges.json`'s schema is spec D's** (`D2-module-json-and-dist-schema`, spec D's `migrations/ranges.json` schema block) and is not restated here. `B7-renumber-ranges-baseline` writes the file's content against that schema — including each block's `highWater` mark, captured together with the baseline hashes — and D2's validator then checks that `module.json.order == ranges.json.modules[id].order == ModuleManifest.order`, and the same three-way equality for `notTenantIsolated`; any disagreement fails the build. Three fields exist in the file because B reads them, and B7 is their only writer: `kernel.crossCuttingModuleTables = ["calendar_events", "committee_elections", "deck_board"]` (§4's written rule made machine-readable — the three module tables owned by kernel-block `0003`, `0004` and `0034`), and per module `legacy: []` plus `extractedTo: "gremion-module-<id>" | null`. `legacy` stays present and empty: the renumber is what makes it unnecessary, and an empty array is the assertion that it is unnecessary. `extractedTo: null` records a reserved block with no module repo behind it — in release 1 that is handover alone, whose files ship nowhere.

`baseline-hashes.json` is `{ "<published path>": "<sha256 hex of the file's bytes>" }` over every data-plane, control and leaf migration in the assembled tree. **Capture procedure:** on Linux, after the renumber commit and before any `gremion-module-<id>` repo is created, hash **git index blobs** (`git cat-file blob` per `git ls-files -s` entry), never working-tree bytes — `civitas-modules` reports `i/lf w/crlf` for all 24 of its `.sql` files, so a working-tree capture would mark every finance migration tampered at first assembly. Every module repo is created from index blobs and lands `.gitattributes` in its first commit (D-03).

**The assembler's check is out-of-band of the codegen.** `build-migration-manifest.mjs` regenerates `migrations/manifest.json` from whatever is on disk at `pnpm prebuild`, so `manifest.json` can never detect a rename or a line-ending change — that hole is exactly what the baseline fills. Therefore: the assembler hashes the assembled tree's migration bytes **itself**, compares against `baseline-hashes.json` as checked out from the kernel at the release ref, and fails **before** running any codegen; it never reads `manifest.json` for this check. Post-condition: the check still fails correctly with `manifest.json` deleted from the assembled tree. Watched RED by planting a one-byte edit and, separately, a rename in one assembled module.

### 6. The migrate job (spec A §F.4.7, amended)

Contract consumed by the host tooling: `docker compose --env-file etc/env/app-<colour>.env run --rm migrate`, a **separate image** from the app image, exit 0 on success and non-zero on any failure.

Order of operations, in this order: acquire `pg_advisory_lock` on the control database, on each tenant database and on each leaf database → **then** read `schema_migrations`. Today no advisory lock exists anywhere (`grep advisory` over `civitas/gremion-ui/src/lib/server/` returns nothing) and `db.ts:162` reads the applied set as its first act. The same treatment applies to `runControlMigrations` (`control-migrations.ts:12-30`, which additionally does a per-file `SELECT 1` round-trip) and to `runFleetMigrations`' per-tenant loop (`fleet.ts:93-102` runs `runMigrations` once per active tenant, so two colours are 2×N concurrent DDL streams). The ledger insert at `db.ts:242` gains `ON CONFLICT DO NOTHING`; `ON CONFLICT` alone is not the fix, because without the lock the DDL is re-executed before the insert is reached.

**App boot stops migrating in the same commit the lock lands.** Its replacement is a **per-tenant readiness gate**: a tenant with any unapplied, non-skipped file serves the existing D-READY tenant-scoped 503 with lazy retry, and never a strict count or a fleet-wide high-water assertion — P0.2 module skips make two tenants' ledgers legitimately differ and gaps inside one tenant's ledger are expected.

Guard: two `migrate` containers started simultaneously against one database; one applies, the other waits and then no-ops. Watched RED **against the current runner** — today both read the applied set, both apply, and the second fails on the primary key or duplicates non-idempotent DDL. Second post-condition: an app container started against a behind database serves 503 for that tenant and applies no DDL (asserted by `schema_migrations` count unchanged).

### 7. The six leaf ledgers (B-12)

All six leaves get a filename-keyed `schema_migrations`, a `pg_advisory_lock` and an atomic apply **in this release** — not a lock without a ledger. Measured on the live host, every leaf database answers "relation schema_migrations does not exist"; the leaves re-execute every `.sql` on every start behind `IF NOT EXISTS` (`services/vault/src/migrations.ts:44` states this as intent). Under P1's `overlap: true` that is two colours replaying into one leaf database with no lock.

Requirements:

- The `BEGIN`/`COMMIT`-stripping rewrite at `services/finance/src/tenant-store.ts:785-790` (two regexes, then `sql.begin`) is **preserved or explicitly replaced**; `calendar`, `content` and `newsletter` carry the same loop. A ledger retrofit that drops it breaks every migration file that carries its own transaction.
- `board` and `vault` move from lazy request-path DDL — `services/board/src/store/index.ts:99-105` and `services/vault/src/store/index.ts` both call `runMigrations(pgUrl)` inside `getStore()` on first contact — to an **eager migrate entrypoint** the `run --rm migrate` contract invokes.
- The four per-leaf **control** databases (`finance_control`, `content_control`, `calendar_control`, `newsletter_control`, each holding only `tenant_catalog`, created at `services/finance/src/tenant-store.ts:688-695`) are declared a migrated and backed-up surface, with the same ledger.

Post-conditions: after `run --rm migrate`, every leaf tenant database and every leaf control database has a `schema_migrations` table; two concurrent leaf migrate processes apply each file exactly once (watched RED against today's replay loop); a first request executes no DDL. Leaf migration sources travel into their module repos with the split, so this unit stacks on `B21-migrate-job-lock-then-read` and on `D5-remaining-module-repos`; leaf chains keep their own `001…` numbering and their own `manifest.json`.

### 8. Postgres major (P3)

One-hour spike **S14** (new; spec A §M ends at S13), gating the pin: confirm the newest major every consumer supports, checking Keycloak 26.7, Nextcloud 34, Synapse 1.160 and pgbouncer against their own published support matrices, plus the `pg_dump`/`pg_restore` client major used by the backup tooling. Expected 17; the spike records evidence per consumer and the number is not written anywhere until it does.

Where the pin lands (`B37-postgres-major-pin`): the `postgres` service of the kernel base compose (`civitas/docker-compose.yml:20`, `postgres:16-alpine` today), every leaf Postgres declared by a module compose fragment (seven further `postgres:16-alpine` services in the StuRa tree today), and the backup image's client version. A major change means a fresh `initdb`; release 1 needs no `pg_upgrade` path because the box is wiped at cutover, and a written rule states that any later major bump is a dump/restore with a measured RTO. The C-collation requirement for Synapse's database is a separate unit (`B31-postgres-c-collation`) and is unaffected by the major.

### Units in this chapter

Full rows are carried once, in the consolidated unit registry (final chapter).

| Unit | Role in this chapter |
|---|---|
| `B4-migrations-portback-nine` | ports the nine kernel-block files and control `004`, with the ownership test (§2) |
| `B4a-news-posts-ownership` | moves `news_posts` into a content-owned migration (`1200_content_news_posts.sql`) and adapts `058` (§2, §4) |
| `B6-canonical-migration-bytes` | the one normalisation commit (§3) |
| `B7-renumber-ranges-baseline` | the renumber, `ranges.json` content and `baseline-hashes.json` (§4, §5) |
| `B21-migrate-job-lock-then-read` | lock-then-read and the per-tenant readiness gate (§6) |
| `B22-leaf-migration-ledger` | the six leaf ledgers and the eager migrate entrypoint (§7); stacks on `B21-migrate-job-lock-then-read` and on `D5-remaining-module-repos` |
| `B37-postgres-major-pin` | records and pins the P3 major everywhere it appears (§8) |

Consumed here but owned by spec D, by id only: `D2-module-json-and-dist-schema` (the `ranges.json` and `module.json` schemas and their shared validator), `D5-remaining-module-repos`, `D16-handover-visibility-record`.

## Storage seam, MinIO, backups and restore, erasure ledger, shreds

Scope: the tenant-aware object-store seam, MinIO in the state tier, the backup/restore split between the kernel release tree and the host tooling, the erasure ledger and leaf shreds, and the removal of vaultwarden. Migration ledgers are the migrations chapter (B-12); the evict fan-out and the internal bearer are §T.5 (B-11); compose file composition and the two-project split are the edge chapter §5 (B-07).

Authority: B-13, B-14, P5, and the MinIO half of B-07. Spec A §D:169, §D:177, §H.2 and §J are amended by B-14 and §2.7 as written below.

### 1. The storage seam — `getStorageFor(tenant)`

B-13 puts the seam on the critical path in spec B, resolving the written disagreement between spec A §D:177 (spec B) and decision record row 44 (spec C) in favour of spec B; §D:177's N-record row is amended accordingly.

#### 1.1 Signature and semantics

The exported surface becomes `getStorageFor(tenant: TenantId): StorageBackend`, memoised per tenant. Three properties are requirements, each with a post-condition:

| # | Requirement | Post-condition |
|---|---|---|
| S1 | Explicit tenant argument; no zero-arg accessor and no ambient-context read survives | `grep` over the assembled tree finds no export named `getStorage`, and no call site reads `currentTenantId()` inside `lib/server/storage/**` or `services/*/src/store/**` |
| S2 | Fail-closed without a tenant | `getStorageFor(undefined as never)`, `''` and `null` each throw before any I/O; no default, no fallback tenant |
| S3 | Tenant segment in every key | Every handle produced by any backend begins with the tenant segment; a `put()` whose composed key does not start with `<tenant>/` throws inside the backend, not only in the caller |

The seam must be reachable in the process that runs. `FINANCE_BACKEND=service` is a router switch on gremion-ui, not a variable the leaf reads (refuter correction, backup-storage claim 9) — but the conclusion stands: the leaf executes the receipt write (`StuRaOS/services/finance/src/store/index.ts:993`), `services/finance` never links gremion-ui and has no AsyncLocalStorage, so `currentTenantId()` is not linkable there. The tenant therefore arrives as a parameter through the leaf's own request context.

#### 1.2 The three copies change together

| Copy | Path today | State today |
|---|---|---|
| kernel gremion-ui | `civitas/gremion-ui/src/lib/server/storage/index.ts:21,32-47` | module-level `cached` singleton; `build()` throws on any `STORAGE_BACKEND` but `local` |
| StuRa gremion-ui | `StuRaOS/gremion-ui/src/lib/server/storage/index.ts:23,50-66` | same shape plus a Nextcloud backend |
| finance leaf | `StuRaOS/services/finance/src/store/index.ts:993` | key `finance/expense/${expenseId}/${filename}` — no tenant segment |

All three land in one change. A handle written by one process with a tenant segment and read by another without one is unreadable, and the StuRa compose already carries a comment warning that `STORAGE_BACKEND` must agree across processes. The interface in `civitas/gremion-ui/src/lib/server/storage/types.ts:18-25` (`put`/`read`/`delete`, opaque handle) is preserved; only the accessor and the key composition change.

Two writers bypass the seam entirely and are routed through it in the same change: the news-draft route (`StuRaOS/gremion-ui/src/routes/news/[id]/edit/+page.server.ts:11` `const ADMIN_USER = 'admin'`, `:15-16` `news-posts/drafts/<id>.odt`) and `StuRaOS/gremion-ui/src/lib/server/files/protocol-documents.ts:20-22`, which reads `defaultTenantEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'`. The second is tenant-blind through `defaultTenantEnv`, the single-tenant escape hatch the zero-tenant-boot unit deletes — so it is coupled to that unit, not only to the seam.

#### 1.3 The `local` backend refuses an unmounted root

`civitas/gremion-ui/src/lib/server/storage/local.ts:18-22` defaults the root to `./var/storage`, and on the live host `finance-service` has zero mounts, so receipts land in the container's writable layer — ephemeral and invisible to every backup arm, which enumerate only labelled volumes. Requirement: the `local` backend refuses to construct when its configured root (`RECEIPT_STORAGE_DIR`) is not a mount point inside the container. The check is a mount-table read, not a `stat` on the directory, because an empty directory on the container layer looks identical to a mounted one.

#### 1.4 No boot scan, no data migration

B-13 states it: **no boot scan and no data migration** for the zero legacy objects. The four tenant-blind news-draft objects §D names do not exist — the only live environment has neither `news-posts/drafts` nor `protocols/drafts`, and the environment that held them was stopped for good on 2026-09-08. The digest's own refuter notes the live check looked only in `admin/files` and not in `__groupfolders` or the sixteen uuid-named per-user directories; the decision closes the question regardless, and §D:177's "moved by a real data migration" clause is amended to "no migration; zero objects, recorded".

#### 1.5 Guards, and how each is watched RED

Every guard below is watched RED by a fresh verifier agent, never its author.

| Guard | Watched RED against |
|---|---|
| Receipt written from **inside** the finance leaf container (`docker exec`) lands under a tenant-segmented key and is readable by the monolith read path | the pre-change leaf, whose key has no tenant segment |
| `getStorageFor` with no tenant throws | a build that accepts `undefined` |
| `local` backend with no mount at `RECEIPT_STORAGE_DIR` fails to start | today's `finance-service`, which starts happily with zero mounts |
| No zero-arg storage accessor survives anywhere in the assembled tree | the current three copies |

The acceptance criterion is the `docker exec` assertion, not a passing unit test in gremion-ui. The previous plan for this exact fix specified `currentTenantId()` and was unbuildable for that reason.

### 2. MinIO in the state tier

P5 ships N11: release 1 carries the tenant-aware seam **plus** MinIO in the state tier. The kernel has no MinIO service at all (`grep -rli minio` over the kernel returns only host tooling, the two env templates and one doc), so this is a port, not an edit.

#### 2.1 Services and images

Both services are kernel-owned shared infrastructure (B-07) and move into the kernel's own `docker-compose.yml` — `infra/host/templates/` has no compose template of any kind, so that is the only possible home. No module compose fragment contributes a state-tier object store; the fragment contract itself is `D13-compose-fragment-inlining`.

| Service | Image | Notes |
|---|---|---|
| `minio` | `quay.io/minio/minio`, digest-pinned, no `build:` | ported from `StuRaOS/docker-compose.yml:1024-1055`; the Docker Hub image at `:1027` no longer exists (#501), so the repoint happens inside the port |
| `minio-mc` | `quay.io/minio/mc`, digest-pinned | one-shot bucket init, `restart: "no"`, exits 0 by design; ported from `StuRaOS/docker-compose.yml:1056-1075` |

`minio-mc`'s healthcheck-census exemption is already in place — `HEALTH_EXEMPT_SERVICES=minio-mc` at `civitas/infra/host/templates/env/state.env.tmpl:70` — and needs confirming, not adding. MinIO's own probe stays `mc ready local` (no curl in recent images).

#### 2.2 Credentials and bucket layout

The ported compose passes `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` to every consumer. Replace that with **per-service credentials** (§G): the root credential exists only for `minio-mc`'s init run and for `gremion-restore-into`; each consumer (Nextcloud, Synapse, the app seam, the backup mirror) receives its own access key scoped to its own buckets by an `mc admin policy` applied in the same one-shot init.

Bucket layout, created by `minio-mc`: one bucket per subsystem (`nextcloud`, `synapse-media`) plus `gremion-app`, inside which **every object key begins with the tenant segment**. Per-tenant buckets are not used: bucket count then tracks tenant count, which the backup mirror enumerates per run and which no policy in this release needs.

An S3 client is a new dependency — `grep` over `StuRaOS/package.json`, `gremion-ui/package.json` and `services/finance/package.json` finds no `aws-sdk`, `@aws-sdk` or `minio`. This is new code in the seam, not a configuration switch. Its size is not measured here; the assembler's package manifest and the seam's backend count are the inputs, and `B24-minio-state-tier` carries it at M.

Post-condition: the production render starts `minio` and `minio-mc` on a host with no Docker Hub access, and `gremion-backup`'s `mirror_buckets` produces bucket artefacts for a seeded bucket.

### 3. Backups — the zone split (B-14)

#### 3.1 Ownership, written into spec A

Spec A §D:169 names "runtime enumeration, leaf loop, generic volume arm, restore arms" as kernel-side deliverables. **B-14 amends it:** the kernel's `scripts/backup.sh` shrinks to the **kernel zone** — the dumps `gremion-backup`'s header calls "exactly the dumps the release tree's own scripts/backup.sh produces" (`civitas/infra/host/bin/gremion-backup:16-28`) — plus runtime enumeration on the shared Postgres server. **Host tooling owns volumes, buckets and leaf Postgres servers**, which it already does: `enumerate_project_volumes` covers the `${STACK}-state` and `${STACK}-mail` projects, `mirror_buckets` enumerates buckets from the server, and `postgres_services()` loops servers.

#### 3.2 The kernel script's new scope

Today it is the pre-enumeration revision: three literal lines at `civitas/scripts/backup.sh:157-159` (`dump_postgres keycloak` / `gremion` / `control`). It gains runtime enumeration of databases on the one shared server it execs, and loses:

- the bucket phase (host owns buckets; the StuRa copy's hardcoded `OBJECT_STORAGE_BUCKETS` list must not travel);
- its restic/rclone phases. This is the correction the reader missed: `gremion-backup` drives the kernel script against a throwaway repository it then deletes and consumes only the `*.sql.gz` output, so no snapshot the kernel script writes is ever visible on a host. The empty `restore.sh --list-snapshots` is structural, not a tag typo;
- every `stura` literal: `scripts/backup.sh:83` (`RCLONE_REMOTE_PATH="${RCLONE_REMOTE_PATH:-stura-restic}"`), the same default at `:29` in the header, `docs/OPERATIONS.md:118`, `docs/ops/restore-runbook.md:123`. §D's guard — `RCLONE_REMOTE_PATH` carries no `stura` literal in either repo — **lands in the same commit as the fix**, not after it. The host side is already clean (`state.env.tmpl:80` = `gremion-restic`).

**Exactly one literal `docker compose exec -T <service>` line must survive, or `gremion-backup`'s parser is updated in the same commit.** `kernel_pg_service_of` (`civitas/infra/host/bin/gremion-backup:309-315`) sed-parses that literal service name and `resolve_kernel_pg_service` (`:317-331`) refuses ambiguity by claiming no kernel zone — which makes every enumerated database get its own `<service>__<database>` artefact **and** the kernel's bare-named dumps ride along: duplicated work at exit 0. The StuRa script uses a variable there, so a verbatim port silently degrades the host tooling into double-dumping. Post-condition: on a scratch stack, `gremion-backup` resolves exactly one kernel Postgres service and stages no duplicate artefact for any database.

#### 3.3 Guards are rewritten first, watched RED, then the port lands

Five tests in `civitas/test/backup.bats` forbid the change: `:38-42`, `:86-90`, `:117-121` assert the script does **not** contain `nextcloud`, `helios`, `newsletter`; `:96-116` requires one literal `dump_postgres <db>` line per database provisioned by `docker/postgres/init-databases.sh`; `:162-165` asserts on the usage string of `restore.sh`. All five become **behavioural** guards — enumeration count versus the server's own database count, and artefact coverage — in their own commit, watched RED against the current pre-enumeration script by a fresh verifier. Rewriting them after the port lands RED is how the wrong guard gets weakened. Post-condition: `test/backup.bats` contains no string-absence assertion, and `carve.mjs check` no longer reports `scripts/backup.sh`, `restore.sh` or `tenant-backup.sh` in `drift.differs` (they are `mirrored-shared-infra-default` per `StuRaOS/scripts/carve/kernel-manifest.json:836-840`).

`k8s/base/backup/**` (`cronjob.yaml`, `pvc.yaml`, `rclone-secret.yaml`, `restic-secret.yaml`) and its four bats tests are **deleted**: nothing in specs A–D deploys Kubernetes, and the cronjob carries both the three-database blind spot and the `stura-restic` literals.

#### 3.4 Host wiring — env keys the assembler produces, and the coverage cross-check

Both items below land **before the first deploy**, not after.

| Key | Where it comes from | Why |
|---|---|---|
| `BACKUP_POSTGRES_SERVICES` | **produced from the module catalogue at assemble time** and written into `state.env` by the assembler; `infra/host/templates/env/state.env.tmpl` and the env table in `docs/ops/host-tooling.md` document it as assembler-produced, never hand-maintained | `postgres_services()` defaults to the bare `postgres` service (`gremion-backup:374-377`) and the key appears in none of the four templates, so a host built from templates backs up zero leaf databases and reports `ok` |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `BACKUP_MC_IMAGE`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | `infra/host/templates/env/state.env.tmpl` + the same docs table (operator-set, per-service credentials per §2.2) | `mirror_buckets` returns 0 with a reassuring info line when `MINIO_ENDPOINT` is unset (`gremion-backup:554-557`), and `gremion-restore-into:481-485` exits BLOCKED without the root pair |

The leaf list the assembler writes is read from `GET /api/internal/modules` — specifically `runtime.leafService.postgresService` per enabled module, with the per-tenant and leaf-control database names from `runtime.leafService.databases.tenantPattern` and `runtime.leafService.databases.control` (§T.5; the `runtime` block is declared in `module.json` and owned by `D10-module-runtime-declarations`). An operator-maintained string rots exactly where this blind spot already bit, so there is no hand-edited override: a `BACKUP_POSTGRES_SERVICES` value that disagrees with the catalogue fails the cross-check below rather than narrowing the run.

With N11 on, the `MINIO_ENDPOINT`-unset skip **inverts into a refusal**. `assert_dump_coverage` (`gremion-backup:503`) gains a cross-check of the enumerated server list against the services actually running in the compose project, so a leaf server missing from `BACKUP_POSTGRES_SERVICES` fails the run instead of passing a per-pair check vacuously.

#### 3.5 `gremion-snapshot` asserts on the first run

`gremion-deploy` runs `gremion-snapshot` on every deploy, and `assert_class_counts_not_below_last_daily` (`civitas/infra/host/bin/gremion-snapshot:35-47`) prints `no prior daily backup: artefact-class comparison skipped` and returns 0 when `runtime/last-backup-daily.json` is absent — a guard that cannot fail at the one moment it matters. Replace the skip with a **first-run assertion**: every artefact class (`databases`, `volumes`, `buckets`) must be greater than zero, and `databases` must equal the count the running project's Postgres servers report. Watched RED against a snapshot taken with `BACKUP_POSTGRES_SERVICES` unset.

### 4. Restore arms and the measured restore

P4 makes "backup covering every database and volume with a **measured restore**" part of acceptance. Today `civitas/scripts/restore.sh:97-105` has arms for `keycloak|gremion|control` only, `cd`s to its own parent, prompts interactively, and lists snapshots with `--tag stura-os` (`:58-60`). `gremion-restore-into` is already coded to exit BLOCKED naming spec B for exactly this (`:421`, `:423`, `:481`, `:485`).

`restore.sh` gains: arms for every artefact class the two scripts produce (per-tenant `t_*` databases, leaf databases via a service selector, volumes, buckets); `--env-file` targeting of a named project instead of the current directory; snapshot listing from the **host** repository by its `label=`/`class=` tags (`gremion-backup:658-659`), not `--tag stura-os`; and a `--yes` flag replacing `gremion-restore-into`'s `printf 'yes\n'` pipe.

Post-condition: `gremion-restore-into` completes without a BLOCKED exit against a real `gremion-backup` snapshot on a scratch stack; one uploaded file's checksum and one seeded row verify by content; the ACME volume is present; the **measured RTO is recorded in the runbook**. RPO stays 24 hours plus the pre-release snapshot. `B26-restore-and-erasure-proof` depends on `B25-backup-enumeration-and-guards` and `B38-leaf-shreds-and-erasure-ledger`; the `pg_dump`/`pg_restore` client major it relies on is pinned by `B37-postgres-major-pin`.

### 5. Erasure ledger widening and the leaf shreds

This is covered by no reader and no unit in `units-v2.json` — it is a named gap there — and it needs a unit (`B38-leaf-shreds-and-erasure-ledger`).

**Ledger widening.** `civitas/gremion-ui/migrations-control/001_tenant_registry.sql:33` constrains `subsystem` to `('db','realm','nextcloud','matrix')`. A migration widens the CHECK to cover every subsystem the provisioning and erasure pipelines touch: the four above plus one value per leaf that holds tenant data, plus `backup-key` for the key-destruction row. A ledger that cannot name a subsystem cannot record that it was skipped, and §H.2 requires every subsystem including skipped ones.

**Which leaves.** Four of the nine leaves hold per-tenant data: `calendar`, `content`, `finance`, `newsletter` — the only four with `services/<leaf>/src/tenant-store.ts`, and the four with a live leaf control database (`finance_control`, `content_control`, `calendar_control`, `newsletter_control`). The set is **declared, not inferred**: each module's `module.json` carries `runtime.shred` (`true` for those four, `false` for the rest; the field is owned by `D10-module-runtime-declarations`), the erasure gate reads it from `GET /api/internal/modules` rather than from a list in kernel code, and adding a data-holding module later is a manifest change, not a kernel edit. Exactly one of the four has a shred path today: `civitas/gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts:56-70` (`LeafShredExecutor.dropNewsletterDb` / `deleteCatalogRow`), invoked at `:196-206`. §D:170's **three leaf shreds are therefore `calendar`, `content` and `finance`**, each implementing the same idempotent pair (drop the per-tenant database, delete the catalog row) with errors propagating so a real failure aborts before the tombstone.

Spec A §H.2's phrase "the six leaves without shred paths" does not match the tree: nine leaves minus four data-holding leaves leaves **five** — `board`, `files`, `messages`, `vault`, `votes` (the leaf service of module `elections`). This spec names them individually rather than by count (§2.7), and the go-live gate names them individually too.

**Fail-closed rule for the leaves without a shred path.** Erasure of a tenant whose module set enables any module with `runtime.shred: false` — today `board`, `files`, `messages`, `vault` and `votes` — writes a `failed` ledger row for that subsystem with the reason `no shred path: manual teardown required` — the pattern `lifecycle.ts:214-215` already uses for Nextcloud and Matrix — and the erasure **does not report complete**. It is not silently skipped and the tombstone is still written, so the tenant cannot be re-created over half-deleted state; the outstanding manual teardown is the ledger row.

**Non-vacuous erasure proof.** `tenant-backup.sh` exports no leaf database in the kernel copy, so today's erasure proof passes vacuously. Its hardcoded newsletter arm (`StuRaOS/scripts/tenant-backup.sh:191-230`, including the swallowed-stderr `grep -q 1` pattern its own post-mortem comment records) is replaced by the same module-driven leaf list — the `runtime.leafService.databases` names of §3.4 — and the `POSTGRES_DB:-stura` default goes. §J's exclusion of `secrets/tenants/*.backup-key` becomes an **asserted** pattern: list the produced archive, fail if any backup-key path appears. The erasure ledger records the retention horizon date for the tenant's rows in retained restic snapshots (N21). Post-condition: erasing a scratch tenant leaves its export artefacts undecryptable, the artefact set was **non-empty** and covered every leaf database the tenant had, and the ledger names the horizon.

### 6. Vaultwarden deletion

M3 dropped vaultwarden. The kernel is already at zero references (`grep -rli vaultwarden` over `civitas` returns nothing), so there is nothing to delete in the deploy source; the work is to **not port it** and to guard that it stays out.

| Surface | Disposition |
|---|---|
| compose service + `gremion_vaultwarden_data` volume | never ported; they exist only in `StuRaOS/docker-compose.yml`, which is archived with the StuRa tree |
| backup special case | never ported. `StuRaOS/scripts/backup.sh:247-272` is the only volume-archive code path in the StuRa script; §D says the generic volume arm replaces it in the same change, and **that arm already exists in the host tooling** (`gremion-backup`'s `enumerate_project_volumes` / `external_volumes`). §D:169 is amended accordingly: no generic volume arm is written kernel-side |
| ~110 references inside MIRRORED port-back files | stripped **while porting**, not by editing the StuRa tree: `traefik-router.ts` (40, incl. `VAULTWARDEN_ORIGIN` and the elected-host emitter branch), `edge-sync.ts` (10), `registry.ts` (`domain_profile->'vaultwarden'->>'host'`), `module-gate.ts`, `instance-status.ts`. The HARDENING-2 host-collision check that dies with the service is replaced by the platform-reserved-host refusal |
| env keys, `order:` slot (`vaultwarden.ts:20` = 120 in the module manifest), docs (`docs/runbooks/vaultwarden.md`, 83 references) | not ported; the manifest file dies with the archived flavour and its `order:` slot is never allocated a migration block |

Guard: `grep -rni vaultwarden` over the assembled kernel tree (both image sets) returns nothing, watched RED against a tree with the unported `traefik-router.ts`. The ~30 files the carve manifest classes `PRODUCT_ONLY` in the StuRa tree are left alone — F5 (minimal StuRa-tree work) and the tree is being archived.

### Units in this chapter

Full rows are carried once, in the consolidated unit registry (final chapter).

| Unit | Role in this chapter |
|---|---|
| `B23-storage-seam` | `getStorageFor(tenant)`, the three copies, the two bypass writers, the mount refusal (§1) |
| `B24-minio-state-tier` | MinIO + `minio-mc` on quay.io, per-service credentials, bucket layout (§2) |
| `B25-backup-enumeration-and-guards` | the kernel script's new scope and the five rewritten bats guards (§3.1–3.3) |
| `B26-restore-and-erasure-proof` | the restore arms, the measured RTO and the non-vacuous erasure proof (§4, §5); depends on `B25-backup-enumeration-and-guards` and `B38-leaf-shreds-and-erasure-ledger` |
| `B27-backup-host-wiring` | the assembler-produced env keys, the coverage cross-check and the `gremion-snapshot` first-run assertion (§3.4, §3.5) |
| `B38-leaf-shreds-and-erasure-ledger` | the widened `subsystem` CHECK, the three shred paths and the five fail-closed leaves (§5) |

Spec D units this chapter reads, by id only: `D10-module-runtime-declarations` (the `module.json` `runtime` block — `leafService.postgresService`, `leafService.databases`, `shred` — that §3.4 and §5 consume) and `D13-compose-fragment-inlining` (the leaf compose fragments whose Postgres services the backup enumeration counts).

Vaultwarden removal carries no unit of its own: it is post-condition text inside `B8-tenant-domains-and-leaf-trust` (the HARDENING-2 collision check → reserved-host refusal) and `B18-router-emitter-library` (`grep -rni vaultwarden civitas` returns nothing), per §6 above.

## Workers in overlap, exactly-once proof, state-tier services, Synapse on Postgres

Scope: what background work runs in each colour during an overlap window, which claims make the two irreversible jobs safe, the harness that proves exactly-once, which services compose the state tier and who owns their files, Synapse's move onto Postgres, and the release-1 procedure that proves the switch. The migrate job's lock-then-read contract is owned by the migrations chapter (B21) and the leaf ledgers by B22; this chapter consumes both and does not restate them. The edge switch file and the evict fan-out are owned by the edge and tenancy chapters.

### 1. The hybrid worker model (B-15)

Spec A §E ("Two tiers") and §F.6 duplicate the app project **and all nine leaves** per colour against one state tier; only the databases are shared. So during an overlap window every timed job and every event consumer exists twice. Decision B-15 resolves that as a hybrid: **event consumers and outbox relays run in both colours; timed jobs run only in the active colour.**

| Class | Runs in | Why |
|---|---|---|
| NATS consumers (`calendar-audit`, `content-audit`, `newsletter-audit`, finance `org-unit-consumer`) | both colours | Ephemeral ordered consumers with no queue group (`packages/ports/src/nats-broker.ts:41`, `:761`); each is already idempotent through an `(consumer, event_id)` PK ledger — see §3 |
| Outbox relays (kernel org-unit relay; calendar/content/newsletter leaf relays) | both colours | Already `FOR UPDATE SKIP LOCKED` + publish dedup |
| Postgres `LISTEN/NOTIFY` evict subscriber (`gremion-ui/src/lib/server/tenant/evict-listener.ts:24-27`) | both colours | At-least-once delivery to every process is the required behaviour |
| Timed jobs: provisioning cron, audit-retention tick, audit-integrity tick, notification scheduler, CalDAV drain, content drains, newsletter/content leaf schedulers | active colour only | Gated per tick (below) |

**The flag.** `gremion-switch` already writes the active colour, atomically and last — after Traefik reports the new server URL (`infra/host/bin/gremion-switch:184`, `:191`): `printf '%s\n' "$colour" | atomic_write "$(gremion_root)/runtime/active-colour" 0644`. That file **is** the flag B-15 names; B adds the read path, not a new flip. The switch must stay a seconds-long operation (spec A §F.5(a)), so the flag may not be an env value — an env change recreates containers and destroys the fast rollback.

`gremion-ui` and every leaf that registers a timed job (`calendar`, `content`, `newsletter`) carry:

```yaml
    environment:
      COLOUR: ${COLOUR}
      GREMION_ACTIVE_COLOUR_FILE: /run/gremion/active-colour
    volumes:
      - ${GREMION_ROOT:?}/runtime:/run/gremion:ro
```

The remaining six leaves take the mount too, so that a later scheduler cannot be added without the flag, and a guard asserts every app-tier service declares `GREMION_ACTIVE_COLOUR_FILE` — watched RED by removing it from one service. The kernel-owned blocks (`gremion-ui`, `gremion-public`) are authored by `B14-two-project-split`; the leaf blocks are **module fragments, never blocks of `docker-compose.app.yml`**, and every leaf fragment carries these two keys because the fragment contract — owned by `D13-compose-fragment-inlining` — names `COLOUR` and `GREMION_ACTIVE_COLOUR_FILE` for timed-job owners among the host-fixed identities a fragment must honour.

The mount is the **directory**, never the file. `atomic_write` renames `<path>.tmp` over `<path>` (`infra/host/lib/common.sh:128-146`), so a single-file bind mount would pin the pre-switch inode and the flag would never change inside the container. Guard: after a switch, `docker exec <gremion-ui-old> cat /run/gremion/active-colour` prints the new colour; watched RED against a single-file mount.

**Who reads it.** One kernel seam and one leaf seam, both as a per-tick predicate, never as a boot-time registration:

- `gremion-ui/src/lib/server/tenant/worker-fleet.ts` — `forEachActiveTenant` returns without work unless the file's content equals `process.env.COLOUR`. Every kernel tick already goes through it: `hooks.server.ts:175` (audit retention), `:200` (audit integrity), `governance/provisioning/worker.ts:90` (`cron.schedule('* * * * *')`), `calendar/notification-scheduler.ts:50`, `calendar/caldav-sync.ts:109`, `content/register.server.ts:35,:48`.
- each leaf's `startScheduler` tick body (`services/newsletter/src/scheduler.ts`, and the calendar and content equivalents).

**Where the policy list comes from.** Each module declares its timed jobs in `module.json` as `runtime.timedJobs: [{ id, activeColourOnly: true }]`, consumed by `D10-module-runtime-declarations` and serialised per enabled module by `GET /api/internal/modules` (tenancy §T.5). The colour-policy job list is **produced from that catalogue at assemble time** and written into `app.env` by the assembler, never hand-maintained.

`SCHEDULER_ENABLED` / `<LEAF>_SCHEDULER_ENABLED` keep their present boot-time semantics as the operator kill switch (`services/newsletter/src/scheduler.ts:172-181` reads them; the six compose lines exist only in the archived StuRa tree at `docker-compose.yml:1129,1133,1376,1380,1479,1483` and must be re-authored into the module fragments). They are not the colour gate.

The misleading headers on `worker-fleet.ts` and each leaf scheduler — which describe an in-process `Set`/boolean as a single-flight guard — gain the sentence `provisioning/mutex.ts:3-4` already carries: in-process only, no cross-container guarantee.

Post-condition (B28): with both colours up, `docker exec` on the inactive colour shows its NATS consumers attached and **no** timed worker having executed a tick since boot (a counter or structured log line per tick, asserted); after `gremion-switch`, the same assertion holds with the colours exchanged. At no instant do both colours consider themselves active, because the file holds exactly one value written by one atomic rename.

### 2. The two irreversible jobs and their exact claims

Decision B-15 puts **real DB claims** on the two jobs whose double-run is irreversible; the rest are covered by the colour gate. There is no advisory lock anywhere in either tree today (the only `pg_advisory_*` is inside a trigger body, `gremion-ui/migrations/043_audit_log_hash_chain.sql:55`).

**(a) Org-unit provisioning worker** — kernel code (`gremion-ui/src/lib/server/governance/provisioning/worker.ts:90`), runs every minute, creates Keycloak groups, Matrix rooms and Nextcloud folders. Its own mutex declares itself single-replica-only (`provisioning/mutex.ts:1-4`). Required:

- `withUnitLock(key, fn)` is replaced by `SELECT pg_advisory_xact_lock(hashtext($1))` on `org_unit_id`, taken **inside** the provisioning transaction, so the lock releases with the transaction and no unlock path can leak.
- `listDueOrgUnitIds()` (`provisioning/ledger.ts:93-100`) and `listDueMemberOps()` (`provisioning/member-ops.ts:23-30`) — both plain `SELECT` today — gain `FOR UPDATE SKIP LOCKED`. `listDueOrgUnitIds` currently returns `SELECT DISTINCT org_unit_id`; `DISTINCT` and a row lock are incompatible, so it becomes a locking select over `provisioning_resources` with the distinct applied in the caller.

**(b) Notification mail** — `processDueNotifications` reads, sends, then marks (`calendar/notification-scheduler.ts:18-32`). `markNotificationSent` is a bare `UPDATE scheduled_notifications SET sent_at = now() WHERE id = ${id}` (`governance/governance-db.ts:131-134`). Required: the claim moves **before** the send and becomes

```
UPDATE scheduled_notifications SET sent_at = now()
WHERE id = $1 AND sent_at IS NULL
RETURNING id
```

with the scheduler sending only when a row comes back, and `markNotificationFailed` clearing `sent_at` on a send failure so a retry is possible. `listDueNotifications` (`governance-db.ts:123-129`) is unchanged — it is a candidate list, not a claim.

Guard for both, watched RED by a fresh verifier with the claim reverted in a scratch tree: two app processes against one database, both ticking in the same second, produce exactly one Keycloak group, one Matrix room and one Nextcloud folder per org unit, and exactly one mail per `scheduled_notifications` row.

### 3. Publish-side dedup and the per-leaf idempotency tables

**Correction to the amendment list.** The decision batch's §F.6 note says "no `Nats-Msg-Id` exists anywhere". The repo contradicts it and the area digest's refuter upholds the repo: `packages/ports/src/nats-broker.ts:512` sets `h.set('Nats-Msg-Id', event.eventId)` on every JetStream publish, and the stream is created with `duplicate_window: DEDUP_WINDOW_NS` (`:437`, documented as 2 minutes at `:486`), with an integration test at `nats-broker.integration.test.ts:386`. **The publish side needs no build work.** What is a build item is the consumer side: the dedup window is time-bounded and does not survive a redelivery outside it, so the idempotency-key table is the real guarantee. §2.7's `§F.6` row carries this correction into the amendment list.

| Leaf | Idempotency ledger today | Where |
|---|---|---|
| content | yes | `services/content/migrations/001_init.sql:196-199`, leaf-local `event_consumption` |
| finance | yes | `services/finance/migrations/002_org_unit_mirror.sql:57-62`, `finance.event_consumption` |
| calendar | no leaf table — its consumer dedups in the kernel tenant DB (`gremion-ui/migrations/040_event_consumption.sql`) | `services/calendar/src/store/audit.ts:7` states this explicitly |
| newsletter | no | consumer runs kernel-side; leaf has no `event_consumption` |
| board, vault, votes, files, messages | no — and no consumers | `grep event_consumption` over each returns zero |

Because both colours share the state tier, a kernel-side ledger in the tenant database is as effective as a leaf-local one; what B-15 forbids is a ledger in a per-colour store. Post-condition: an assertion enumerates, for every consumer registered in the release, the database its ledger lives in, and fails if that database belongs to an app-tier project. **Watched RED by a fresh verifier who points one consumer's `event_consumption` ledger at a per-colour store (a table created in the app project's own database): the assertion must fail and the release must be forced to `overlap: false`, never pass with a warning.** A leaf with a consumer and no ledger in the state tier forces `overlap: false` in `release.json` (spec A §F.6 gives `overlap` no default).

### 4. The exactly-once harness (B29)

Composition per decision B-15: **a thin kernel smoke plus an SDK test helper module repos reuse.** The kernel smoke runs two app colours and two leaf sets against one state tier, publishes one event, and asserts five side effects — spec A §F.6's four plus the fifth it does not name:

| # | Side effect | Asserted |
|---|---|---|
| 1 | Instagram publish | exactly one Meta Graph call for one `content.publish_ops` row (`services/content/src/store/publish-ops.ts:128`) |
| 2 | CalDAV push | exactly one PUT/DELETE and exactly one `attempts` increment (`services/calendar/src/store/caldav-queue.ts:62`) |
| 3 | send-mail | exactly one newsletter dispatch per recipient |
| 4 | org-unit mirror row | exactly one row in the finance mirror |
| 5 | term-expiry notification mail | exactly one mail per `scheduled_notifications` row (§2b) |

Outbound calls are captured by a stub endpoint that counts requests; the count, not an exit code, is the assertion. The harness is **watched RED with the idempotency check disabled** — the `ON CONFLICT DO NOTHING` ledger insert and the §2 claims removed — by a fresh verifier agent, never the author.

`@gremion/module-sdk` (decision D-01, unit `D1-module-sdk-package`) ships `testing/exactly-once.ts`: a helper that takes a job function and a side-effect counter, runs it from two processes against one Postgres, and asserts a caller-supplied count. Three of the five effects live in code spec D moves into module repos, so each module repo reuses the helper for its own job rather than depending on the kernel harness.

### 5. The state tier: composition and ownership (B-07)

**Kernel base compose owns**: postgres, pgbouncer, keycloak, traefik, docker-socket-proxy, vector, legal, fallback, NATS, Redis, MinIO (+`minio-mc`), sales site. The kernel's `docker-compose.yml` today defines postgres, mailpit, gremion-ui, gremion-public, keycloak, legal, traefik, docker-socket-proxy and vector only, so NATS, Redis, MinIO and the sales site are additions (MinIO by B24, repointed to quay.io images).

**Module repos own, as compose fragments**: Synapse, Nextcloud, Collabora, Helios, LiveKit, Element Call, and the nine leaves with their Postgres servers — each as `compose/<id>.yml` in `gremion-module-<id>`, with profile `<id>`. The kernel's `docker-compose.app.yml` (`B14-two-project-split`) carries only the kernel app-tier services — `gremion-ui`, `gremion-public` — and the shared conventions; no leaf service block is authored there.

**Inlining contract with the assembler.** The assembler **inlines every fragment into the two composed files at release build**, so the host's file list is fixed: the state project's `COMPOSE_FILE` (`state.env.tmpl:22`) and the app project's `COMPOSE_FILE` (`app.env.tmpl:18`) name the same paths for every release regardless of which modules are enabled. The fragment contract and its full guard set have **one owner, `D13-compose-fragment-inlining`** (spec D §D.1.4); spec B references that unit by id and restates neither the contract nor its guards. Spec B's own render guard, in `B14-two-project-split`, asserts that union. Two points in this chapter's scope rest on it:

- **provable at B34, before any module repo exists:** a release built with zero modules renders and its `COMPOSE_FILE` list is byte-identical to the template's;
- **asserted once the module repos land:** the all-nine render also succeeds and its `COMPOSE_FILE` list is byte-identical to the zero-module one.

Every module-owned app-tier fragment satisfies the same contract, whose host-fixed identities are set out in edge §5: the nine leaf service names and port 8080 from `app.env.tmpl:29-40`, the `<service>-${COLOUR}` alias on both externals, the lowest exposed TCP port serving `/api/internal/evict`, and the `gremion.evict=true` label. The secrets that reach module-owned leaves follow the same split: `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf are **declared in `app.env.tmpl`** (added by `B14-two-project-split`, covered by the env coverage cross-check); fragments reference them as `${INTERNAL_<LEAF>_SECRET:?}`; and the assembler's render guard fails on a leaf fragment that references an undeclared key.

**Placement, not ownership.** Spec A §K and §E place Synapse, Nextcloud, Collabora, Helios, LiveKit and Element Call in the "state project". Per B-07 that sentence is amended in writing (§2.7): *"state project" names deploy-time compose-project placement and never repo ownership.* `scripts/carve/kernel-manifest.json` keeps `docker/synapse/**`, `docker/nextcloud/**`, `docker/livekit/**` and `docker/element-call/**` as module infrastructure; the kernel ships none of them.

### 6. Synapse on Postgres (B-07, N10)

Fresh-install only. N10 moves Synapse while its store is empty and the netcup box is wiped at cutover, so there is **no `synapse_port_db` step, no dual write and no cutover window**; the path is: create the database, start with an empty `/data`, re-run bootstrap.

| Item | Contract |
|---|---|
| Server | the **shared** `postgres` service, database `synapse`, own role |
| Creation | `create_db_and_user` in `docker/postgres/init-databases.sh` gains an optional locale path emitting `CREATE DATABASE … TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`. The bare form at `civitas/docker/postgres/init-databases.sh:35` inherits the cluster locale, and the live cluster is `en_US.utf8`, so Synapse's startup check fails — certain, not hypothetical (unit B31) |
| Image | base pin unchanged. `psycopg2 2.9.10` is already in the pinned `matrixdotorg/synapse:v1.124.0`; no `pip install` for the driver, no retag of the base |
| `homeserver.yaml` | `docker/synapse/homeserver.yaml:9-13` hardcodes `name: sqlite3` with no `${VAR}`, so `render-homeserver.sh`'s `envsubst` cannot switch it. The block becomes `name: psycopg2` with `args: {user, password, database, host, port, cp_min, cp_max}` from `${SYNAPSE_DB_*}`. `envsubst` has no `${VAR:-default}`, so every key is exported with a default by the entrypoint shim |
| Owner | `gremion-module-messages`, seeded from the StuRaOS copy, **not** the stale `civitas-modules` fork (which lacks the `synapse-s3-storage-provider==1.6.1` line). `compose/messages.yml` carries synapse, element-call, livekit and the `depends_on` to the shared postgres |
| Image ownership | synapse, element-call and livekit are module-contributed images, declared in `gremion-module-messages`'s `module.json` `images` array as `role: sidecar` entries — `ghcr.io/hello-n00del/gremion-synapse` and siblings, `context` the module repo's own `docker/<name>/` (moved there by D3/D5) — and built by the same interim release pass as the leaves (D-05) |
| Media | file volume for release 1; N11's S3 path is declared slipped in writing until the storage seam's S3 backend lands (B23/B24) |
| Backup | free, by enumeration: `gremion-backup` lists every database on every server in `BACKUP_POSTGRES_SERVICES` (`infra/host/bin/gremion-backup:374-376`, `:486`), which defaults to `postgres`. That list is **produced from the module catalogue at assemble time** out of each module's `runtime.leafService.postgresService` and written into `state.env` by the assembler, never hand-maintained — and Synapse is not a leaf, so a dedicated `synapse-postgres` service would appear in no catalogue entry and would need a hand edit nothing enforces. This is the reason the shared server wins |
| Probe | `GET /_matrix/client/v3/login` asserting both `org.matrix.login.jwt` and `"id":"oidc-keycloak"`; the present probe hits `/_matrix/client/versions`, which answers even when the entrypoint disabled JWT login because Keycloak's key fetch failed |

Post-condition: on a fresh stack, `psql -c "SELECT datcollate FROM pg_database WHERE datname='synapse'"` returns `C` **before** Synapse's first boot; no `/data/homeserver.db` exists; `gremion-backup` produces a `synapse` artefact with no `state.env` edit. Watched RED: Synapse pointed at a database created by the bare helper fails to start.

### 7. The release-1 overlap proof (P1)

P1 requires release 1 to exercise the switch and the rollback. The procedure, run on the netcup box after the first deploy, with what is asserted at each step:

1. **Deploy release 1** (`overlap: true`), no previous colour present (spec A §F.7). Assert: `gremion-verify --colour blue` green; `runtime/active-colour` is `blue`; the login journey passes.
2. **Deploy a rebuild to green.** Same tag content, new image digests. Assert: the migrate job runs and applies nothing (lock-then-read, B21); green is healthy while blue still serves; `gremion-verify --colour green` green through the loopback test entrypoint, including its `INTERNAL_BASE_URL`/leaf-URL colour resolution assertion (edge §3); the exactly-once harness's five side effects each fire exactly once with both colours up; `docker exec` on green shows no timed worker tick and its consumers attached.
3. **Switch to green.** Assert: evict fan-out acknowledged before the file is written; Traefik's API reports `gremion-ui-green`; `runtime/active-colour` is `green`; within one tick interval green has ticked and blue has not, read from both containers' logs.
4. **Switch back to blue.** Same assertions with the colours exchanged, and the elapsed time recorded — this is the fast-rollback path of spec A §F.5(a).
5. **Roll back** via `gremion-rollback` to the previous tag. Assert: the pins file reverts, the pulled digests match the previous release, `gremion-verify` is green, and the measured RTO is written into the release record.

A failure at any step blocks the cutover; a leaf without a state-tier idempotency ledger forces `overlap: false` and step 2 is then not available for that release.

### Units in this chapter

Full rows are carried once, in the consolidated unit registry (final chapter).

| Unit | Role in this chapter |
|---|---|
| `B28-worker-safety-and-colour-gating` | the colour flag read path and the two real DB claims (§1, §2) |
| `B29-two-colour-exactly-once-proof` | the five-side-effect harness and the SDK helper (§3, §4) |
| `B31-postgres-c-collation` | the `LC_COLLATE 'C'` path in `init-databases.sh` (§6) |
| `D7-synapse-on-postgres` | spec D's unit; referenced here by id only |
| `D13-compose-fragment-inlining` | spec D's unit (§D.1.4); referenced here by id only |
| `D6-leaf-images-and-compose-fragments` | spec D's unit; referenced here by id only |
| `D10-module-runtime-declarations` | spec D's unit; referenced here by id only |
| `D1-module-sdk-package` | spec D's unit; referenced here by id only |

## Assembler (zero modules), release supply chain, sales site, guards, acceptance, units

### A. Tree direction and the do-not-overwrite guard (B-02, owner unit B3)

Kernel-wins is the direction for all 294 MIRRORED-but-differing paths. It is decided; no per-file adjudication and no re-pin of the drift baseline (the baseline instruments a tree that `D11-archive-holding-repo-and-stura-tree` archives). The 8 drifted shared migrations need no adjudication because kernel ∩ modules migration numbers = ∅.

Two mechanisms make kernel-wins safe, and both land in B3 before a single file is ported:

1. **The 43-path do-not-overwrite set.** `verify-manifest --json` `mirroredMissingInProduct` is 43 paths the kernel holds and the StuRa tree does not: the 12-file `gremion-ui/src/lib/components/dashboard/**` extraction plus `committee/CommitteeCard.svelte`, `source-offer.ts` + 2 tests, four guard tests, five `scripts/*.mjs` packaging/CVE guards, `check-domain-regex.mjs`, `ThemeToggle.svelte`, `docker/traefik/dynamic/tls.yml` and 13 k8s paths. B3 freezes that list as a machine-readable file consumed by every port-back step. Post-condition: a deliberate **StuRa-tree-wins** copy of `instance-theme.ts` or of the dashboard directory is **refused**, watched RED by a fresh verifier before any port-back step trusts the guard.
2. **Two narrow carve-rule additions.** (a) A MIRRORED rule for `gremion-ui/src/routes/api/internal/{evict,modules,compose-realm}/**` and `/healthz`, inserted **before** `product-module-api-routes` at `StuRaOS/scripts/carve/kernel-manifest.json:325` — the manifest is first-match-wins, so without it the new internal routes classify `PRODUCT_ONLY` and the kernel's own deliverables read as leaks. Post-condition: all three internal route directories and `/healthz` classify MIRRORED, asserted by `verify-manifest --json`. (b) Rule lines for the three kernel-only documents that make `productOnlyInKernel` non-zero (`docs/TRADEMARK.md`, `docs/compliance/controller-processor-split.md`, `docs/security/test-smtp-guard.md`); `docker/kustomization.yaml` is present in both trees and mis-ruled by `product-hosted-ops`, and its ownership is decided in B3 rather than papered with a rule line.

Post-condition for B3: `verify-manifest` prints `productOnlyInKernel 0`.

### B. `scripts/assemble.mjs` at zero modules (B-16 first half, owner unit B34)

No assembler exists in any repo (`ls civitas/scripts/` returns 13 files, none of them `assemble.mjs`). B ships the zero-module path only; clone-by-ref, `module.json` verification and vertical resolution are `D9-assembler-module-resolution` and `D8-stura-vertical`.

**Inputs.** `GREMION_DIST_MANIFEST`, already injected at `civitas/infra/host/templates/env/state.env.tmpl:66` and `app.env.tmpl:26` and read by nothing today, and documented at `civitas/docs/ops/host-tooling.md:90`. The assembler **fails closed** when the variable is unset, when the path does not exist, or when the file does not parse — never defaulting to `gremion.dist.example.json`, which is committed for public contributors and names public modules only. A release records `release.json.distManifestDigest` as `"sha256:" + <64 lowercase hex>` of the manifest bytes **as read**, never the manifest content; both consumers reject the bare hex form (`civitas/.github/workflows/deploy.yml:112` at dispatch, `civitas/infra/host/bin/gremion-deploy:228-229` on the host).

**The four codegens**, all of which already exist in the kernel and three of which scan directories rather than reading a list, so a copied-in module wires itself in with no edit:

| Codegen | Path | Assembler post-condition |
|---|---|---|
| module manifest index | `gremion-ui/scripts/build-module-manifest.mjs` | `MODULE_MANIFESTS.length` == manifest module count + kernel built-ins |
| server-init barrel | `gremion-ui/scripts/build-module-server-init.mjs` | import count == number of modules declaring `register.server.ts` |
| migration manifest (×2: `migrations/`, `migrations-control/`) | `gremion-ui/scripts/build-migration-manifest.mjs` | key count == files present in the assembled tree |
| realm base composition | `gremion-ui/scripts/gen-realm-export.ts` | invoked **explicitly** — it is not in `prebuild` (`gremion-ui/package.json:8` chains only the first three) |

**Why the counts, not the exit codes.** `build-module-server-init.mjs` scans for `register.server.ts`; the kernel has zero of them, so it writes a comment-only barrel and exits 0 — verified: `grep -c '^import' civitas/gremion-ui/src/lib/server/modules/server-init.generated.ts` returns **0**. An assembler that trusts exit codes ships an app with no module registered and no error. Every codegen invocation asserts against the manifest's module count.

**Boundary lint on the assembled tree.** `civitas/gremion-ui/scripts/boundary-lint.ts:2-8` already has an `--all` whole-tree mode; nothing in CI runs it (it is wired only into the pre-commit hook). The assembler calls `--all` on the assembled tree and asserts a **non-zero scanned-file count** — a lint over a tree it fails to find returns clean.

**Acceptance harness.** `gremion-ui/src/lib/modules/add-a-module.proof.test.ts` already exists in both trees and asserts that a throwaway manifest composes into nav, `PAGE_ACCESS`, capabilities, realm, route-prefixes and `defaultModulesConfig` with zero shared-file edits. It is reused, not rebuilt. Each B34 post-condition is watched RED by a fresh verifier who deletes one manifest file and one `register.server.ts` and confirms the assemble fails.

### C. Release supply chain — `release.yml` (B-16, B-17, D-05; owner unit B35)

**There is no image supply chain today.** Nothing in any of the three repos runs `docker push`; every CI docker job builds a throwaway local tag and discards it, and the kernel says so in-tree at `civitas/k8s/base/kustomization.yaml:46-48`. `ghcr.io/hello-n00del/gremion-*` is a coordinate images are built *as*, never one that can be pulled. **What closes it is B35 and nothing else**: GHCR login with `packages: write`, a `docker buildx build --push` matrix, per-image digest capture, and the pins file.

**Trigger.** `release.yml` runs on a `release/<version>` **branch** (and `workflow_dispatch`), not on a tag: it assembles, builds, pushes, writes `docker-compose.pins.yml`, `release.json` and the assembled `pnpm-lock.yaml` into the tree, commits them, and only then creates and pushes the **annotated** tag `dist-vX.Y.Z` at that commit. Spec A §F.1 contains both statements and ends "Tag-triggered only"; that half is a self-contradiction (a tag trigger cannot create its own tag) and is overwritten here and in §2.7. `release-npm.yml:50-53` triggers on `v*`, which `dist-v*` does not match, so there is no collision.

**The manifest source (B-16).** A private `gremion-dist` repo (`D14-gremion-dist-repo`), checked out in the runner with the per-run GitHub App installation token of N23 — versioned, diffable and reviewable, which a repository secret is not. The token stays in the runner; only the assembled tree is passed to `docker build`.

**The App-token fallback, written as a testable requirement (owner B35).** Post-condition: with `GREMION_DIST_TOKEN` unset the release workflow assembles from the public kernel plus every module repo the runner's default token can read, and **the run summary names each module it could not fetch**. Watched RED by unsetting the token against a manifest that names a private repo. The same posture covers the case where the `@gremion` npm scope is not ready at release 1.

**Two passes.** Full set from the full manifest, OSS set from the public-only manifest, sharing the pnpm store and BuildKit cache. A single artefact cannot serve both: a tag alias would ship private module code to self-hosters under an AGPL label. **OSS-set membership is computed at release build from the dist manifest's `visibility` field, never hard-coded**, so no guard is edited when a module's visibility changes. All images publish under `ghcr.io/hello-n00del/`: the OSS set as `gremion-ui-oss` and `gremion-public-oss` to the public package registry, the full set as `gremion-ui` and `gremion-public` to the private one, and every private-module image as a private package. Elections' repo is created private and flips public when kernel issue **#353** (Helios licence compliance) closes; until then elections and `gremion-elections` are in the full set only.

| Module | `visibility` | Full set | OSS set |
|---|---|---|---|
| board, calendar, files, messages, newsletter, users | public | yes | yes |
| elections | **private until #353** | yes | only once #353 closes |
| content, finance, vault | private | yes | no |
| handover | reserved id, no code in release 1 (D-01) | — | — |

**Guard:** the OSS artefact is inspected for private-module paths (`app/**` of every module whose manifest `visibility` is `private`, and `verticals/*` marked private per D-02); **watched RED by building the OSS image set from the full manifest** and confirming the guard fails.

**The lockfile (B-17).** Each release commits the assembled `pnpm-lock.yaml` into the release tree next to `release.json` and the pins. The order inside `release.yml` is fixed: **assemble → SDK-specifier check → `pnpm install` → commit `pnpm-lock.yaml` into the release tree.** Inside the assembled tree the SDK resolves as `workspace:*` — the kernel's `pnpm-workspace.yaml` globs `packages/*`, `civitas/gremion-ui/package.json` carries `"@gremion/module-sdk": "workspace:*"` (owned by `D1-module-sdk-package`), and each module repo's `service/package.json` already declares `"@gremion/module-sdk": "workspace:*"` (D-05 interim: per-repo CI resolves it by cloning the kernel at `module.json.kernelRef` into `.kernel/`), so there is one specifier form and nothing to rewrite — the assembler asserts the specifier and fails on any other form. **The committed assembled lockfile is the only lockfile that gates an image build.** A plain `pnpm install` per build would make two builds of the same `distManifestDigest` produce different dependency trees, destroying the meaning of the digest; committing it keeps `--frozen-lockfile` inside the image build and keeps `check-cve-floors.mjs` meaningful over the merged override blocks (kernel 7 entries vs StuRa tree 18).

**GHCR image names — every first-party image in release 1.** All take the flat form `ghcr.io/hello-n00del/gremion-<name>`, which is the merged kernel convention (`gremion-ui`, `gremion-public`, `gremion-migrate`) and the one `civitas/.github/workflows/ci.yml:169` guards by prefix. Base compose `image:` keys are rewritten to `…:${IMAGE_TAG:?IMAGE_TAG required}` so a composition without the pins layer fails loudly instead of pulling the unowned Docker Hub `gremion/*` namespace (15 refs, `StuRaOS/docker-compose.yml`, `docker-compose.prod.yml:598`). Module-owned images are declared by their module's `module.json` `images: [{ "id": "<name>", "image": "ghcr.io/hello-n00del/gremion-<name>", "context": "<path in repo>", "role": "leaf" | "sidecar" }]` array, at most one `role: leaf` per module (`D2-module-json-and-dist-schema`; the single-string `leafImage` field is removed, because it cannot express a module that contributes several images), and `release.yml` builds exactly what those arrays declare — leaves and sidecars alike, in the same interim pass (D-05).

| Service | GHCR name | Source | Exists as an image today |
|---|---|---|---|
| gremion-ui | `gremion-ui` | kernel `gremion-ui/Dockerfile` | built, never pushed |
| gremion-public | `gremion-public` | kernel `gremion-public/Dockerfile` | built, never pushed |
| legal | `gremion-legal` | kernel `docker/legal/Dockerfile` | built, never pushed |
| vector | `gremion-vector` | kernel `docker/vector/Dockerfile` | built, never pushed |
| fallback | `gremion-fallback` | kernel `docker/fallback/Dockerfile` | **no `image:` key** (`docker-compose.prod.yml:255-258`) |
| migrate | `gremion-migrate` | kernel, separate image (§2.3) | does not exist |
| sales site | `gremion-sales-site` | kernel `apps/sales-site` (B17) | does not exist |
| keycloak (thin) | `gremion-keycloak` | kernel, B30 honest probe | does not exist |
| nine leaves | `gremion-board`, `gremion-calendar`, `gremion-content`, `gremion-files`, `gremion-finance`, `gremion-messages`, `gremion-newsletter`, `gremion-vault`, `gremion-elections` | each module repo's `module.json` `images[]` entry with `role: leaf`, context declared there | Docker Hub `gremion/*` today |
| nextcloud | `gremion-nextcloud` | `gremion-module-files`, `images[]` `role: sidecar`, context `docker/nextcloud` (moved there from the StuRa tree by D3/D5) | Docker Hub `gremion/*` today |
| helios | `gremion-helios` | `gremion-module-elections`, `images[]` `role: sidecar`, context `docker/helios` (moved there by D3/D5) | Docker Hub `gremion/*` today |
| element-call | `gremion-element-call` | `gremion-module-messages`, `images[]` `role: sidecar`, context `docker/element-call` (moved there by D3/D5) | Docker Hub `gremion/*` today |
| synapse | `gremion-synapse` | `gremion-module-messages`, `images[]` `role: sidecar`, context `docker/synapse` (moved there by D3/D5) | Docker Hub `gremion/*` today |
| livekit | — | module-contributed by `gremion-module-messages`, declared in its `images[]` as a `role: sidecar` entry with `"context": null` because `docker/livekit/` carries configuration only (`find StuRaOS/docker -name 'Dockerfile*'` lists element-call, fallback, helios, legal, nextcloud, synapse and vector, and no livekit); nothing is built for it and `pin-images.sh` resolves the declared third-party reference to a digest | third-party |
| collabora | — | module-contributed by `gremion-module-files`, same treatment: a `role: sidecar` entry with `"context": null`, no build context anywhere in the StuRa tree, pinned by digest through `pin-images.sh` | third-party |

**The votes/elections member is settled in one place:** the module id is `elections`, so the image is `ghcr.io/hello-n00del/gremion-elections`, while the **compose service name stays `votes-service`**, fixed by the merged `civitas/infra/host/templates/env/app.env.tmpl:34` (`VOTES_SERVICE_URL=http://votes-service-${COLOUR}:8080`). The evict leaf list therefore reads: `board-service`, `calendar-service`, `content-service`, `files-service`, `finance-service`, `messages-service`, `newsletter-service`, `vault-service`, `votes-service` — nine services, nine images, one of which is named for its module rather than its service.

Of the six module-owned sidecars, the four with a build context — synapse, element-call, nextcloud, helios — are built by the kernel's release workflow alongside the nine leaves; livekit and collabora are declared but only pinned, as **a named interim with a dated operator exit condition (D-05)**, because every leaf Dockerfile takes the repo root as context and depends on the pnpm workspace root plus `packages/ports` (`StuRaOS/services/calendar/Dockerfile:2-5,20`).

**The D-05 exit issue.** Exit date **2026-11-30** — an orchestrator proposal, for the operator to confirm or change at the review gate. That date and the three conditions — the `@gremion` npm scope claimed, the trusted publisher registered (`civitas/.github/workflows/release-npm.yml:14-21`), and `@gremion/db`, `@gremion/ports` and `@gremion/module-sdk` published — live in a tracked kernel issue created at plan dispatch, which both specs reference as **the D-05 exit issue**. The guard is `check-interim-expiry`: it fails the release workflow after the date while `scripts/release/build-leaves-interim.mjs` still exists, so the interim cannot go dormant unnoticed. After the packages exist, module repos build their own leaves and the interim path is **deleted**, not disabled.

**Dependabot.** §K's claim that Dependabot covers every Dockerfile is false today: `civitas/.github/dependabot.yml`'s docker `directories:` list names `/docker/legal`, `/docker/vector` and `/gremion-ui` (plus `/gremion-public` in its own entry), so `docker/fallback/Dockerfile` sits in no configured directory. B35 adds a `docker` ecosystem entry per first-party Dockerfile in the kernel, `docker/fallback` included. Each `gremion-module-<id>` repo carries its own config for its own Dockerfiles (`D12-module-repo-ci-and-dependabot-template`). Post-condition: a generated test enumerates `**/Dockerfile` in the kernel and fails on any path absent from `.github/dependabot.yml`, watched RED by adding a Dockerfile and not the entry.

**Digest recording.** First-party digests come from `docker buildx build --push` output. Third-party refs are pinned by reusing `civitas/infra/host/ops/pin-images.sh` verbatim, which resolves a tag to its published multi-arch index digest and rewrites `image:` lines in place. Every line in `docker-compose.pins.yml` carries `@sha256:` and `build: !reset null`.

**The consuming handshake is already merged and is the acceptance test.** `civitas/.github/workflows/deploy.yml:76` enforces `^dist-v[0-9]+\.[0-9]+\.[0-9]+$`, `:91` requires `release.json` and `docker-compose.pins.yml` at the tag tree root, `:108-112` requires `release.json` to parse with `.tag` equal to the dispatched tag, a boolean `.overlap`, an array `.migrations` and `distManifestDigest` matching `^sha256:[0-9a-f]{64}$`. On the host, `infra/host/bin/gremion-deploy:164-166` blocks on `docker-compose.app.yml`, `docker-compose.pins.yml` and `release.json`; `:228-229` rejects a bare-hex digest; `:233-251` rejects an unpinned image, the `gremion/` namespace, a real `build:` key and an empty pin set. `infra/host/templates/env/state.env.tmpl:22` and `app.env.tmpl:18` fix the exact filenames. **B35 must emit these field names, not redesign them.** `test/host/deploy.bats` and `test/host/deploy-workflow.bats` go GREEN against a real release tree instead of fixtures.

### D. Sales site and the platform routers (B-10, B-03; owner unit B17)

The sales site moves out of the fourth repo `Code/Civitas/sturaos-staging` into `apps/sales-site` in the kernel (no `apps/` directory exists today), static, base image swapped to `nginxinc/nginx-unprivileged` on :8080, built and pushed by `release.yml`, with its **14** `sturaos.com` occurrences (`grep -rn sturaos.com site/` = 14; the html-only count of 5 is an under-measure) replaced by `${PLATFORM_DOMAIN}`. The fourth repository is **archived** in the same unit.

Two routers ship with it: **www → apex 301 on `websecure` only** — a redirect on the `web` entrypoint is the one thing measured to shadow `acme-http@internal` on Traefik 3.7.1 — and the **control router** behind `CONTROL_ALLOWLIST_CIDRS`, **backed by the `fallback` service** until `gremion-control` exists in spec C. All three routers carry a certresolver, a host pin and HSTS declared on the Traefik container's own labels.

**B-03 rides in this unit:** the English route segments and the `/dashboard` topology are ported onto the kernel's core+governance split here. The governance #320 contestability port (B5) moves **off** the critical path — before go-live, not before the SDK — and `D1-module-sdk-package` no longer depends on it.

### E. Guard register

| Guard | What it asserts | How it is watched RED | Owner unit |
|---|---|---|---|
| do-not-overwrite (43 paths) | no port-back step overwrites a kernel-ahead path | a StuRa-wins copy of `instance-theme.ts` / `dashboard/` is attempted and refused | B3 |
| carve totality | `productOnlyInKernel == 0`; all three internal route directories and `/healthz` classify MIRRORED | remove the new rule, re-run `verify-manifest` | B3 |
| assembler codegen counts (×4) | manifest/server-init/migration counts match the dist manifest | delete one manifest file and one `register.server.ts`, assemble | B34 |
| assembler boundary-lint vacuity | `--all` scanned a non-zero file count | point the lint at an empty directory | B34 |
| manifest fail-closed | assemble aborts with `GREMION_DIST_MANIFEST` unset or unparseable | unset the variable in CI | B34 |
| OSS artefact purity | OSS image set contains no private module or vertical path; membership derives from `visibility`, never a hard-coded list | build the OSS set from the **full** manifest | B35 |
| release-token fallback | with `GREMION_DIST_TOKEN` unset the release assembles from the public kernel plus every readable module repo, and the run summary names each module it could not fetch | unset the token against a manifest naming a private repo | B35 |
| interim expiry (`check-interim-expiry`) | the release workflow fails after **2026-11-30** while `scripts/release/build-leaves-interim.mjs` still exists | run the workflow with the clock past the date and the interim script present | B35 |
| pins completeness | every first-party service has `image: …@sha256:`, no `gremion/`, no real `build:` | hand-edit one pin back to a tag | B35 |
| Dependabot Dockerfile coverage | every `**/Dockerfile` in the kernel appears in `.github/dependabot.yml` | add a Dockerfile and not the entry | B35 |
| production-render build-absence | production render has `build:` absent or `!reset null`, with an independent vacuity count | run it against the dev render | B35/B32 |
| dev-render build-presence (`ci.yml` guard kept unchanged; only its compose invocation is converted to `--env-file`) | dev/base render still builds every first-party image | delete a `build:` from the base compose | B35 |
| reproducible dependency tree | two builds of one `distManifestDigest` produce identical trees | drop the committed lockfile, rebuild | B35 |
| migration baseline hashes | git **index** blob SHA-256 per shipped migration | plant a one-byte edit and a renumber | B7 |
| text-order == numeric-order | `ls migrations \| sort` equals numeric order | plant a mixed-width number | B7 |
| nav-anchor presence | a fragment naming an absent anchor fails the assemble instead of vanishing | remove the anchor from `baseNavSchema` | B33 |
| kernel-clean backstop | one planted violating import per module goes RED, 10 for 10 | plant them | B33 |
| evict 204-only contract | `/api/internal/evict` returns 204 with an empty body; a 200 is rejected | run the contract test before the route exists | B19 |
| evict label presence | some container carries `gremion.evict=true` (`gremion-deploy:464`) | deploy with the label removed | B20 |
| two-colour fan-out | fan-out reaches every process in **both** `${STACK}-app-*` projects | run against the pre-fix `write_evict_targets` (`gremion-deploy:446-464`) | B20 |
| leaf-target enumeration | `gremion-deploy` step 8 enumerates exactly nine leaf targets on a full-manifest release | rename one fragment service | B20 |
| backup coverage | artefact count equals enumerated database/volume/bucket count | run against the current pre-enumeration `scripts/backup.sh:157-159` | B25 |
| consumer-ledger tier | every registered consumer's idempotency ledger lives in a state-tier database | point one consumer's `event_consumption` at a per-colour store | B29 |
| storage fail-closed | write with no tenant throws; `local` with no mount refuses to start | remove the mount, assert from inside the finance leaf container | B23 |
| erasure ledger admits every subsystem | the control-DB `subsystem` CHECK admits every leaf and `backup-key` | run against today's four-value CHECK, which rejects the row outright | B38 |
| migrate lock-then-read | two concurrent migrate containers: one applies, one no-ops | run against today's read-then-apply runner | B21 |
| env duplicate/empty refusal | duplicated or empty secret key refused; missing `PLATFORM_DOMAIN` aborts the render | run against current `load_env` | B15 |
| no-truncate suite | a truncating harness refuses a production `${STACK}` | point the harness at a production `DATABASE_URL` | B15 |
| colour-suffix env | no app-tier env value names a first-party service without a `-${COLOUR}` suffix | `INTERNAL_BASE_URL=http://gremion-ui:3000` | B32 |

Every row is watched RED **by a fresh verifier agent, never its author** (accepted with the P-batch).

### F. Acceptance for release 1 (P4) — assertions against the running box

1. **Login journey.** A tenant created by `docker compose --env-file etc/env/app-blue.env run --rm tenant-create --slug <s> --host <h> --vertical stura` (B13), then a real browser reaches `https://<h>/dashboard` authenticated through Keycloak on the realm composed from `realm-export.base.json`. Post-condition: an authenticated page render, not a 200 on `/healthz`.
2. **Verify contract.** `gremion-verify` exit 0 against the public routers and `gremion-verify --colour <new>` through the loopback internaltest entrypoint; every router Traefik reports carries a certresolver, an HSTS and a rate-limit middleware; the forged-`X-Forwarded-Host` two-host universal passes; and `INTERNAL_BASE_URL` plus every leaf URL resolve, from inside the container, to that colour only.
3. **Reboot gate.** `reboot`; then `systemctl is-active gremion-verify.service` is `active` and `gremion-verify` exits 0 without manual intervention.
4. **Colour switch, switch-back, rollback.** A rebuild deployed to the second colour with `overlap: true`; `gremion-switch <new>` then `gremion-switch <old>` both succeed with a 204 from every evict target; `gremion-rollback` redeploys `previous-tag`. `cat runtime/active-colour` and `runtime/previous-tag` confirm each transition.
5. **Backup and measured restore.** `gremion-backup` produces one artefact class per enumerated database, per state- and mail-project volume, and per MinIO bucket, cross-checked against the running project; `gremion-restore-into` restores into a scratch stack, one uploaded file's checksum and one seeded row verify, and the **RTO is recorded as a number**.
6. **Supply chain.** `docker buildx imagetools inspect ghcr.io/hello-n00del/gremion-ui@<digest from release.json's pins>` resolves from a machine with no repo checkout; `/root/.docker/config.json` and `/home/gremion/.docker/config.json` contain no `auths` entry after the deploy.
7. **Erasure proof.** A scratch tenant erased; its per-tenant export artefacts undecryptable; the export non-vacuously covered every leaf database the tenant had (B26); a tenant with `board`, `files`, `messages`, `vault` or `votes` enabled yields a `failed` ledger row per such leaf and does not report complete (B38).

### G. Waived until the pilot, by name (P4)

Off-site backup remote · external probe/alert vendor · mail bring-up (§I asserts 1–6, MX, SNDS/JMRP/Postmaster) · legal documents (Impressum, Datenschutz, DPIA, ROPA, AVV, accessibility statement) · apex DNS edits · pilot inputs (the named council's identity and real names). These are §L gate items 1, 4 and 6 and part of 5; **release 1 is a deployment bar, not the go-live gate**, and `docs/ops/release-1-waivers.md` (B0) is the signed statement that says so. `gremion-verify` prints each of the six as `WAIVED` with its §L item number, never as `ok`.

### Critical path

The consolidated path starts from the 28 units of `units-v2.json`'s `critical_path` and is amended by today's decisions: `B5-governance-320-subsystem` was already off that list and stays off; `B20-evict-labels-and-fanout-fix` was already on it; `B22`, `B23`, `B25` and `B27` move onto it from that file's off-path list, taking the inherited count to **32**; `B1-realm-and-theme-rename` is split into `B1a-realm-identity-and-boot-import` (in place of `B1`, on the path) and `B1b-theme-rename-and-hygiene-guard` (after the first deploy, so it adds nothing to the count). Spec B adds six units that were not in that count — `B0-spec-docs-and-waiver-ledger`, `B00-extraction-source-freeze`, `B4a-news-posts-ownership`, `B19b-evict-ack-migration`, `B37-postgres-major-pin` (all S) and `B38-leaf-shreds-and-erasure-ledger` (M) — so the path is **38 units**. Each unit's effort is the value carried in the consolidated registry below; this spec does not restate a per-effort split for the 32 units it inherits, because their efforts live in `units-v2.json` and not here. Every other unit in the registry is required before the go-live gate but not before the first deploy.

### H. Lanes and stacking

**Lane 1 — edge/host** (stacking order): B0 → B9 → B14 → B15 → B16 → B17 → B32 → B30 → B20 → B24 → B25 → B26 → B27 → B18. Cross-lane: B14 needs B11 (lane 2); B32 needs B14 and B16; B20 needs B19 and D4 (modules-seam) and B14; B24 needs B23 (lane 2); B26 needs B38 (lane 2); B27 needs B19; B18 is off the pre-deploy path per B-06 (the interim `tenant-create` renders the tenant router from the 30-line template) but lands before go-live.

**Lane 2 — data/runtime**: B00 → B1a → B2 → B4 → B4a → B6 → B7 → B8 → B10 → B11 → B12 → B13 → B21 → B22 → B23 → B38 → B28 → B29, then the post-deploy tail **B1b**. Off to the side: B5 (off the critical path; D1 no longer depends on it) and the pair B31 + B37, which ride with `D7-synapse-on-postgres` and are not scheduled on their own. Cross-lane: B10 needs B9; B14 needs B11; B21 needs B7 and B14; B22 needs B21 and D5; B29 needs B22 and B28.

**Lane 3 — modules-seam**: B3 → B19 → B19b → D1 → D2 → D12 → B34 → B33 → D3 → D5 → D9 → D8 → B35 → D6. Cross-lane: B3 gates every port-back in lanes 1–2; B19 gates D4 and B20; B34 needs D1 and D2; D3 needs D2, D12 and B7; D5 stacks off D3's tip, never fanned out; D4 needs B19 and D5; D9 needs B34 and D5; D8 needs D2 and D5; B35 needs B34, B7 and B14; D6 needs D5 and B35 and is the D-05 interim leaf build; `D13-compose-fragment-inlining` stacks on D9, D6 and B14.

Every `D`-prefixed unit named in these lanes is spec D's to write (§1.3); it appears here only because the single stacked unit graph spans both specs, and this spec names it by id alone — its post-condition, effort and flags live in spec D's registry.

### Units in this section — the consolidated unit registry

This table is the complete spec-B unit inventory: every unit with a `B` prefix named anywhere in this spec appears here exactly once, and the per-chapter tables above are pointers into it. Units with a `D` prefix are spec D's; their rows live in spec D's own registry and are not duplicated here.

| Unit | Effort | Depends on | Post-condition | Repos | Host-contract |
|---|---|---|---|---|---|
| `B0-spec-docs-and-waiver-ledger` | S | — | `docs/superpowers/specs/spec-b-*.md` and `spec-d-*.md` exist in the kernel; `docs/deployment-architecture.md` is public-safe and a new host-literal rule in `scripts/kernel-hygiene-check.mjs` fails on any IPv4/host literal drawn from spec A §A, watched RED by a fresh verifier who inserts one such literal; `docs/ops/release-1-waivers.md` names the six P4 waivers and the §L items they map to, and `gremion-verify` asserts that no waived item is treated as a passing gate: each of the six appears in its output as `WAIVED` with its §L item number, never as `ok` | civitas | no |
| `B00-extraction-source-freeze` | S | — | StuRaOS carries an annotated tag at `f276af59`; the kernel records the SHA in `docs/ops/extraction-source.md`; every `module.json` created by D3/D5 carries it under the key `"extractionSource"` as 40 lowercase hex, identical across every enabled module, and the assembler fails the build when two `module.json` files disagree, watched RED by a fresh verifier who edits one `module.json` to a different SHA | civitas, StuRaOS (tag only) | no |
| `B1a-realm-identity-and-boot-import` | S | — | Boot import deleted (`--import-realm`, both mounts, generated `realm-export.json`); `realm-export.base.json` used only by `buildTenantRealmDoc`; zero `realms/sturaos` in the 22 non-doc carriers; `KEYCLOAK_PROBE_REALM=master` and `gremion-mail-bringup`'s probe still green | civitas | yes |
| `B1b-theme-rename-and-hygiene-guard` | M | first deploy complete | A fetched login page for a realm with no `displayName` contains `gremion` and zero `StuRaOS` and its stylesheet resolves 200; the `themes/sturaos/**` hygiene carve-out is gone and the new bare-token rule reports the current tracked-tree hits, watched RED against the pre-rename tree by a fresh verifier | civitas | no |
| `B2-realm-smtp-block` | S | `B1a` | `gremion-mail-bringup` assert 6b no longer exits 3 (`gremion-mail-bringup:633-635`); a provisioned realm sends a real reset mail over TLS with dkim/spf/dmarc pass; a composed `RealmDoc` contains zero `__…__` sequences | civitas | yes |
| `B3-carve-rules-and-portback-guard` | S | — | `verify-manifest` prints `productOnlyInKernel 0`; all three internal route directories (`evict`, `modules`, `compose-realm`) and `/healthz` classify MIRRORED, asserted by `verify-manifest --json`; a StuRa-wins copy of `instance-theme.ts` or of the dashboard directory is refused, watched RED | StuRaOS, civitas | no |
| `B4-migrations-portback-nine` | L | `B3` | Fresh init on empty Postgres applies the full kernel chain with each module OFF (calendar, elections and board cases asserted); a kernel-sourced fresh install serves the anonymous portal; the kernel's number set is a superset of every unclaimed StuRa number; `055` precedes `058`; control `004` present with its `manifest.json` entry; the three handover files `050`–`052` enter neither the kernel tree nor any module repo (D-01), and a guard fails the port-back if any of the three basenames appears in the assembled tree, watched RED by a fresh verifier who plants `050_handover_schema.sql` in the kernel migrations directory | civitas | no |
| `B4a-news-posts-ownership` | S | `B4` | `news_posts` is created by a content-owned migration; a content-OFF kernel-only fresh init completes green and the ported `058` grants only kernel-guaranteed tables while still aborting on absence; content-ON serves the anonymous portal | civitas | no |
| `B5-governance-320-subsystem` *(off the critical path)* | L | `B4` | `server-init.generated.ts` has at least one real import and byte-equals a fresh codegen run | civitas | no |
| `B6-canonical-migration-bytes` | M | `B4a` | On a Linux checkout, `sha256sum` of every shared basename is equal across kernel, modules-holding and StuRa lanes, with `008` the single named exception; `civitas-modules` carries `.gitattributes` with `*.sql text eol=lf`; no `-- stura-ui/migrations/…` header survives | civitas, civitas-modules, StuRaOS | no |
| `B7-renumber-ranges-baseline` | L | `B6`, netcup `down -v` | `readdirSync(dir).filter(.sql).sort()` equals numeric order in every migration directory; `ranges.json` covers every shipped file with no gap and no overlap, carries `kernel.crossCuttingModuleTables = ["calendar_events", "committee_elections", "deck_board"]` — the three module tables owned by kernel-block `0003`, `0004` and `0034` — and per module `legacy: []` + `extractedTo`; `baseline-hashes.json` captured from Linux git index blobs; a planted rename and a planted one-byte edit each fail the baseline check, watched RED | civitas, civitas-modules, StuRaOS | no |
| `B8-tenant-domains-and-leaf-trust` | L | `B3` | A tenant is created, a host added and resolved by host; each of the nine reserved platform names is refused by `addTenantDomain`; evicting a tenant clears both slug- and host-keyed entries, watched RED against the current kernel evictor; a leaf callback selects its tenant by id with no synthesised host and each of the four gate clauses has a test that fails when that clause alone is removed | civitas | no |
| `B9-edge-static-config` | M | — | `docker compose --env-file etc/env/state.env config` renders a traefik service whose every publish is bound to `EDGE_BIND_IP` or `127.0.0.1` and never `0.0.0.0`; the container is healthy via `:8082/ping`; `curl http://127.0.0.1:8080/api/http/routers` answers from the host and from no other interface; `docker inspect` shows exactly one mount whose destination is `/etc/traefik/dynamic`, `RW=false`, and a file written into `etc/edge/` adds a router with no container restart; `verify-traefik-acme-wiring.sh` passes all three measured claims plus the four markers against `traefik:v3.7.1`; `grep -E '127\.0\.0\.1\|:8081' docker/traefik/traefik.yml` matches only the `forwardedHeaders` loopback entry and the bare `:8081` address | civitas | yes |
| `B10-resolver-fullhost` | M | `B8`, `B9` | An unregistered `<label>.<apex>` matches no router and fails at Traefik; `grep -n HostRegexp civitas/docker-compose.prod.yml` returns nothing; `check-domain-regex.mjs`, its test and both call sites are gone; the resolver suite is green on host-keyed selection | civitas | no |
| `B11-healthz-and-boot-determinism` | M | `B10` | `/healthz` returns 200 with `"tenant":null` during and after boot with no host header and no proxy-trust header; two requests for one host are byte-identical and two registered hosts differ; the exemption constant's membership is exactly `['/healthz', '/api/internal/']` and a third entry fails the guard; the container is Docker-healthy with zero tenants; `public@file` is UP with `PUBLIC_BASE_PATH=/portal`; a `gremion-ui` started before Postgres serves traffic once Postgres is up with no container restart; the rewritten boot tests were watched RED | civitas | yes |
| `B12-zero-tenant-boot` | L | `B11`, `B8` | The app serves with zero rows in `tenant`; `grep -rn "registerDefaultTenant\|defaultTenantEnv\|DEFAULT_TENANT" civitas/gremion-ui/src` returns nothing; an unknown host gets 404 from the resolver; the full suite is green with every test tenant created explicitly | civitas | no |
| `B13-tenant-create-entrypoint` *(B-06 interim, deleted by spec C)* | M | `B12` | One `run --rm tenant-create` on a freshly booted zero-tenant stack produces a tenant that serves its host and passes the login journey end-to-end through Keycloak; `docker compose up` on the app project starts no `tenant-create` container; a `tenant_provisioning_resource` row exists for every subsystem | civitas | yes |
| `B14-two-project-split` | XL | `B9`, `B11` | `deploy.bats` "release tree without `docker-compose.app.yml` exits 3 BLOCKED" (`deploy.bats:243`) goes green; `assert_stack_isolation` passes on both colours; the state render has zero app-tier services, zero `name: gremion_`, zero `image: gremion/` and no first-party service without an `image:` key; `up` on the app project creates no migrate container; both app renders resolve every `depends_on`; no app-tier env value names a first-party service without a `-${COLOUR}` suffix; `app.env.tmpl` declares `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf, covered by the env coverage cross-check, and the render guard fails on a leaf fragment that references an undeclared key; the app-tier fragment contract (§5) is published and machine-checkable; the render guard is authored here and asserts the full guard set of `D13-compose-fragment-inlining` (referenced by id, restated nowhere) in two phases — at B14 it asserts the set over the zero-module render and its `COMPOSE_FILE` list is byte-identical to the template's; the all-nine half of the same guard is asserted when `D13-compose-fragment-inlining` lands and is that unit's post-condition, not this one's | civitas | yes |
| `B15-env-contract-and-validator` | L | `B14` | A duplicated key in any env file is refused (bats case watched RED); an empty value for a secret-marked key is refused; a missing `PLATFORM_DOMAIN` aborts the render; the production render's first-party service env contains zero `localhost`; the render-vs-template variable diff is empty; `docker-compose.override.yml` is absent and the staging seam renders; every harness that truncates or drops refuses to start unless `DATABASE_URL` names a host whose `${STACK}` differs from the production `${STACK}`, asserted from inside the container by `docker exec … env` and watched RED by a fresh verifier pointing it at a production `DATABASE_URL` | civitas | yes |
| `B16-routers-middlewares-and-verify` | L | `B9`, `B14` | The forged-`X-Forwarded-Host` two-host universal passes and was watched RED against an un-pinned apex router; every router Traefik reports carries a non-empty certresolver, exactly one host-pin middleware naming that router's own literal host, an HSTS middleware and a rate-limit middleware; no middleware referenced by any router is declared on an app-tier service | civitas | yes |
| `B17-platform-routers-sales-site-and-routes` *(B-10 + B-03)* | L | `B16` | `http://www.<domain>/.well-known/acme-challenge/probe` returns 404 from `acme-http@internal`, never a 301; `https://www.<domain>/` 301s to the apex; an unallowlisted source gets 403 on `control.<domain>`; `gremion-verify` classifies all three routers as state-bound; the sales site serves from `apps/sales-site` with zero `sturaos.com` literals; the English route segments and the `/dashboard` topology serve on the kernel's core+governance split; the fourth repository is archived | civitas, sturaos-staging | yes |
| `B18-router-emitter-library` *(off the pre-deploy path)* | L | `B8`, `B16` | An emitted `tenant-<slug>.yml` diffs clean against `infra/host/templates/edge/tenant-router.example.yml`; no emitted file declares a middleware; no emitted file names a reserved host; `grep -rni vaultwarden civitas` and `grep -rn CF_API_TOKEN civitas` both return nothing; `edge-plan.ts` is deleted | civitas | yes |
| `B19-internal-api-evict-and-modules` | M | `B8`, `B11`, `B3` | `{"tenant":"*"}` returns exactly 204 with an empty body on gremion-ui and on every leaf, and a contract test rejects a 200 (watched RED before the routes exist); a stale readiness entry is cleared; an ack row is written before the answer; the modules payload matches `MODULE_MANIFESTS` and is asserted field-for-field against `module.json`, its `notTenantIsolated` entries being exactly board and vault; the compose-realm response carries `tenantHost` as every URI authority, no `__…__` placeholder and the requested `realmName`; an unauthenticated call is refused; `docker exec` shows the identical `INTERNAL_PUSH_SECRET` on gremion-ui and every leaf and an empty value makes every evict target answer 401 | civitas | yes |
| `B19b-evict-ack-migration` | S | `B8` | Control migration `005_tenant_evict_ack.sql` and its `manifest.json` entry apply on a fresh control DB; a missing manifest entry fails the run | civitas | no |
| `B20-evict-labels-and-fanout-fix` | S | `B19`, `D4`, `B14` | `gremion-deploy` step 8 completes and enumerates exactly nine leaf targets on a full-manifest release, watched RED by renaming one fragment service; with both colours up a bats case in `test/host/deploy.bats` proves the fan-out reaches every process in **both** `${STACK}-app-*` projects and gets exactly 204 from each | civitas | yes |
| `B21-migrate-job-lock-then-read` | L | `B7`, `B14`, `B12` | Two migrate containers started simultaneously against one database: one applies, the other waits then no-ops, watched RED against today's read-then-apply runner; an app container started against a behind database serves 503 for that tenant and applies no DDL, asserted by an unchanged `schema_migrations` count | civitas | **yes** (`docker compose --env-file etc/env/app-<colour>.env run --rm migrate`, §F.4.7) |
| `B22-leaf-migration-ledger` | XL | `B21`, `D5` | Every leaf tenant database and every leaf control database has `schema_migrations` after `run --rm migrate`; two concurrent leaf migrate processes apply each file exactly once, watched RED against today's replay loop; a first request executes no DDL; the `BEGIN`/`COMMIT`-stripping rewrite is preserved or explicitly replaced | StuRaOS, civitas, gremion-module-* | **yes** (same contract) |
| `B23-storage-seam` | L | `B12` | Asserted from inside the finance leaf container (`docker exec`): a receipt written by the leaf lands under a tenant-segmented key and is readable by the monolith read path; a write with no tenant throws before any I/O; a `local` backend with no mount at `RECEIPT_STORAGE_DIR` fails to start — all three watched RED; no zero-arg storage accessor survives in the assembled tree and no `currentTenantId()` read remains under `lib/server/storage/**` or `services/*/src/store/**` | civitas, StuRaOS | no |
| `B24-minio-state-tier` | M | `B23`, `B14` | The production render starts `minio` and `minio-mc` on a host with no Docker Hub access; per-service credentials are in use, the root pair only for init and restore; `gremion-backup`'s `mirror_buckets` produces bucket artefacts for a seeded bucket | civitas | yes |
| `B25-backup-enumeration-and-guards` | L | `B14` | The five rewritten `test/backup.bats` guards were watched RED against the current pre-enumeration script; `gremion-backup` resolves exactly one kernel Postgres service and stages no duplicate artefact on a scratch stack; `carve.mjs check` no longer lists `scripts/backup.sh`, `restore.sh` or `tenant-backup.sh` in `drift.differs`; `test/backup.bats` contains no string-absence assertion; no `stura` literal survives in either repo; `k8s/base/backup/**` and its four bats tests are deleted | civitas | yes (§J) |
| `B26-restore-and-erasure-proof` | L | `B25`, `B38` | `gremion-restore-into` completes without its spec-B BLOCKED exit against a real `gremion-backup` snapshot on a scratch stack; one uploaded file's checksum and one seeded row verify by content; the ACME volume is present; the measured RTO is recorded in the runbook; erasing a scratch tenant leaves its export artefacts undecryptable over a **non-empty** artefact set covering every leaf database it had, no backup-key path appears in the archive, and the ledger names the retention horizon | civitas | yes (§J, §L.2, §L.7) |
| `B27-backup-host-wiring` | M | `B25`, `B19` | A host bootstrapped from the templates alone backs up every leaf database, asserted by artefact count against the running compose project; object storage configured-but-unreachable **fails** rather than skips; `assert_dump_coverage` cross-checks the enumerated server list against the running services; `gremion-snapshot` asserts on its first run instead of skipping, watched RED against a snapshot taken with `BACKUP_POSTGRES_SERVICES` unset | civitas | yes (§J, §K backup-age alert) |
| `B28-worker-safety-and-colour-gating` | L | `B14` | Two app processes on one database, ticking in the same second, produce exactly one Keycloak group, one Matrix room and one Nextcloud folder per org unit and exactly one mail per `scheduled_notifications` row, watched RED with the claims reverted; the inactive colour has ticked no timed worker since boot while its consumers are attached; `docker exec … cat /run/gremion/active-colour` reflects a switch (directory mount, watched RED against a single-file mount); every app-tier service declares `GREMION_ACTIVE_COLOUR_FILE`, watched RED by removing it from one service | civitas | yes — reads `runtime/active-colour` written by `gremion-switch:191` |
| `B29-two-colour-exactly-once-proof` | L | `B28`, `B22` | The harness is green with the ledgers and claims enabled and was watched RED with them disabled, over all five side effects; every registered consumer's ledger database is proven state-tier, watched RED by pointing one at a per-colour store; a leaf with a consumer and no state-tier ledger forces `overlap: false` in `release.json` | civitas, gremion-module-* | yes — its output is the `overlap: true` precondition of §F.6 |
| `B30-healthchecks-and-census` | M | `B14`, `B11` | Render plus image inspection shows every service either probed or on the committed exemption list, whose only entry is `minio-mc`; a Keycloak whose realm failed to import reads unhealthy; the census test fails when a new unprobed service is added | civitas | yes |
| `B31-postgres-c-collation` *(rides with `D7`)* | S | — | `SELECT datcollate FROM pg_database WHERE datname='synapse'` returns `C` on a freshly initialised stack, asserted before Synapse's first boot; mirrored into the k8s init-job copy per the file's three-way mirroring contract | civitas | no |
| `B32-render-and-boundary-guards` | L | `B14`, `B16` | Each guard in §E owned by this unit was watched RED against the pre-change tree and is green after; a router added later without a pin, without a resolver, or chaining a middleware declared on an app-tier service fails the build; a build guard fails any app-tier env value naming a first-party service without a colour suffix, watched RED against `INTERNAL_BASE_URL=http://gremion-ui:3000`; the N20 guard covers `-f`, `--profile` and `-p` and `ci.yml` passes it; the boundary lint reports a non-zero scanned-file count or fails | civitas | no |
| `B33-assembled-tree-guards` | M | `D1` | A fragment naming an absent nav anchor fails the assemble instead of vanishing, watched RED by removing the anchor from `baseNavSchema`; the kernel-clean backstop goes RED on one planted violating import per module, 10 for 10 | civitas | no |
| `B34-assembler-zero-modules` | L | `D1`, `D2` | A zero-module assemble is bootable; all four codegen counts match the empty manifest and each was watched RED by deleting one manifest file and one `register.server.ts`; the assemble aborts with `GREMION_DIST_MANIFEST` unset or unparseable and never falls back to `gremion.dist.example.json`; the boundary lint's scanned-file count is non-zero; the migration-baseline check runs before any codegen and still fails correctly with `manifest.json` deleted; a release built with zero modules renders and its `COMPOSE_FILE` list is byte-identical to the template's | civitas | no |
| `B35-release-supply-chain` | L | `B34`, `B7`, `B14` | `test/host/deploy.bats` and `deploy-workflow.bats` are green against a real `dist-v` tag tree rather than fixtures; two builds of one `distManifestDigest` produce identical dependency trees, watched RED by dropping the committed assembled lockfile, which is the only lockfile that gates an image build; the OSS-purity guard is watched RED by building the OSS set from the full manifest, membership being computed at release build from each dist-manifest entry's `visibility` and never hard-coded; with `GREMION_DIST_TOKEN` unset the release workflow assembles from the public kernel plus every module repo the runner's default token can read and the run summary names each module it could not fetch, watched RED by unsetting the token against a manifest that names a private repo; every pins line carries `@sha256:` and `build: !reset null`; a generated test enumerates `**/Dockerfile` in the kernel and fails on any path absent from `.github/dependabot.yml`, `docker/fallback` included; the §E guard row `check-interim-expiry` fails the release workflow after the D-05 exit date (2026-11-30, tracked in the D-05 exit issue) while `scripts/release/build-leaves-interim.mjs` still exists, watched RED with the clock past that date | civitas | yes |
| `B37-postgres-major-pin` | S | spike `S14` closed | The major is recorded with per-consumer evidence and pinned in the kernel base compose, in every leaf Postgres declared by a module compose fragment, and in the backup image's `pg_dump`/`pg_restore` client; a guard fails on any unpinned or mismatched `postgres:` tag | civitas, gremion-module-* | yes (image pins in the composed files) |
| `B38-leaf-shreds-and-erasure-ledger` | M | `B23`, `B12` | The control-DB `subsystem` CHECK admits every leaf plus `backup-key`, watched RED against today's four-value CHECK, which rejects the row outright; `calendar`, `content` and `finance` each have an idempotent shred path exercised by a test, with errors propagating before the tombstone; erasing a tenant with `board`, `files`, `messages`, `vault` or `votes` enabled writes a `failed` ledger row per such leaf with the reason `no shred path: manual teardown required` and does not report complete | civitas | no (feeds §L.7) |

**B-side edges into spec D's registry**, stated here so a planner stacking off this table does not lose them: `B20` ← `D4-evict-on-leaves`, which itself stacks on `B19-internal-api-evict-and-modules` and `D5-remaining-module-repos`; `B22` ← `D5-remaining-module-repos`; `B33` ← `D1-module-sdk-package`; `B34` ← `D1-module-sdk-package` + `D2-module-json-and-dist-schema`; `B35` → gates `D6-leaf-images-and-compose-fragments`; `D7-synapse-on-postgres` ← `B31`; `D10-module-runtime-declarations` ← `B19`, `B27`, `B28`; `D13-compose-fragment-inlining` ← `B14`.
