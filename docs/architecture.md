# Architecture

This is the operational/technical layer for the Gremion **governance kernel** — the
component topology, the auth flow, the data layout, and the kernel-internal seams
(module SDK, boundary enforcer, DB pool, auth helpers, nav schema). For the
project's vision, the open-core boundary, and the governance charter, see
[`docs/about-gremion.md`](about-gremion.md) — this document does not duplicate that
material.

Gremion is the open core carved out of the StuRaOS monorepo. Two app names run
through the code and the diagrams below: **`gremion-ui`** (the authenticated
SvelteKit admin shell) and **`gremion-public`** (the read-only public portal).
Both are a **non-normative reference shell** — what the kernel was extracted
with, not a ratified UI contract. The kernel ships only identity, multi-tenancy, the governance domain
(committees, members, the org-unit tree, protocols, resolutions/Beschlüsse, the
public portal), the governance invariant hooks, and the module SDK. Feature
modules — elections, newsletter, calendar, files, messages, board,
users, finance, content, vault, handover — are **not** part of the kernel; each
lives in its own repository and attaches over the module SDK, as an in-kernel
manifest or as a separate service over a stable API.

## Component overview (governance-only stack)

The governance kernel runs as **seven default services**. They are defined in
[`docker-compose.yml`](../docker-compose.yml); the production profile and the prod
overlay add the edge.

```
Internet
    │  HTTPS
    ▼
┌──────────────────────────────────────────────────────────────┐
│  traefik            (profiles:[production]) — TLS, per-tenant  │
│                      Host routing, rate limiting              │
│  docker-socket-proxy (profiles:[production]) — read-only       │
│                      Docker API for Traefik's provider        │
└───────┬───────────────────────┬──────────────────────┬────────┘
        │ /                       │ /auth                 │ public.<domain>
        ▼                         ▼                       ▼
┌────────────────┐        ┌───────────────┐      ┌────────────────┐
│  gremion-ui      │        │   keycloak    │      │  gremion-public  │
│  SvelteKit     │        │  Quarkus JVM  │      │  SvelteKit     │
│  (app shell +  │        │   (OIDC IdP)  │      │  (read-only,   │
│   governance)  │        │               │      │   no auth)     │
└───────┬────────┘        └───────┬───────┘      └───────┬────────┘
        │                         │                      │ read-only role
        │ tenant pool             │ keycloak DB          │
        ▼                         ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│  postgres — control DB (tenant registry + fleet-migration     │
│             ledger) · per-tenant governance DB(s) · keycloak  │
└──────────────────────────────────────────────────────────────┘

  legal    — static legal/portal pages (Impressum, GDPR)
  mailpit  — SMTP catcher for staging/local dev (port 1025)
  vector   — log pipeline with IP pseudonymisation (tails Traefik logs)
```

| Service        | Role |
|----------------|------|
| `postgres`     | All persistent data: the control-plane registry DB, the per-tenant governance DB(s), and the Keycloak DB |
| `keycloak`     | OIDC/SSO identity provider; imports the kernel realm (`--import-realm`), relative path `/auth` |
| `gremion-ui`     | The authenticated SvelteKit app shell — dashboard, settings, system status, and the governance surface (committees, members, protocols, resolutions, portal admin) |
| `gremion-public` | The read-only public portal at `public.<domain>` — no auth, no sessions, connects to the governance DB through a read-only role |
| `legal`        | Static legal/portal pages (Impressum, GDPR) served by a non-root nginx |
| `vector`       | Log pipeline: tails Traefik access logs, pseudonymises IPs, enforces retention |
| `mailpit`      | Local/staging SMTP catcher (`:1025`); flipping to a real relay is a pure `.env` change — see [`docs/runbooks/email-smtp.md`](runbooks/email-smtp.md) |

The **production profile** (`profiles: [production]` in `docker-compose.yml`) adds
`traefik` and `docker-socket-proxy`; the prod overlay
([`docker-compose.prod.yml`](../docker-compose.prod.yml)) further adds `pgbouncer`
and `cloudflared`, and enables internal Keycloak TLS. In local dev these are
skipped and services are reached on direct `127.0.0.1` ports
([`docker-compose.override.yml`](../docker-compose.override.yml)).

Quick start (see also the [Makefile](../Makefile) targets):

```sh
cp .env.example .env
./scripts/setup.sh      # generate secrets, start services
make logs               # follow logs
make health             # check service + endpoint health
```

## Authentication flow (OIDC/SSO)

Authentication is centralised in Keycloak. The app shell uses Auth.js with the
Keycloak OIDC provider.

```
User visits the app shell (gremion-ui)
       │  Not authenticated
       ▼
Keycloak login page (<host>/auth)
       │  User enters credentials
       ▼
Keycloak validates + issues ID token + access token
       │  Redirect back with auth code
       ▼
gremion-ui exchanges the code for tokens at Keycloak
       │  Tokens verified
       ▼
Session established — subsequent visits are auto-authenticated (SSO)
```

Server-to-server OIDC (token / userinfo / JWKS / refresh, plus the Admin REST used
by governance committee provisioning) runs over **internal TLS** in production
(`AUTH_KEYCLOAK_INTERNAL`, `KEYCLOAK_ADMIN_URL` → `https://keycloak:8443/auth`,
realm `sslRequired: all`). The dev override drops these to plain
`http://keycloak:8080` and `sslRequired: external` so local `http://localhost`
login works without per-developer CA trust.

The kernel keeps the full Keycloak **LoA/ACR step-up** plumbing — a fresh
elevation is valid for `STEPUP_FRESHNESS_SECONDS` (default 300) before a re-prompt.
The enforcement *flag* that drove four-eyes finance actions left with the finance
module; the step-up machinery itself is kernel auth.

## Database layout

All data lives in one PostgreSQL instance, partitioned into the control plane, the
per-tenant data plane, and the Keycloak store.

| Database / scope         | Owner            | Contents |
|--------------------------|------------------|----------|
| `control`                | `control` user   | Tenant registry + fleet-migration ledger (`gremion-ui/migrations-control/` — `001_tenant_registry.sql`, `002_tenant_migration_runs.sql`, `003_tenant_uniques.sql`) |
| per-tenant governance DB | `gremion` user     | The governance domain for one tenant: committees, members, the org-unit tree, protocols, resolutions/Beschlüsse, portal content, plus the hash-chained audit log (INV-1) |
| `keycloak`               | `keycloak` user  | Realms, users, sessions, tokens |

The `gremion-public` portal reads the governance DB through a dedicated **read-only
role** (`gremion_public_reader`, `GREMION_PUBLIC_DB_URL`), created by
`docker/postgres/init-databases.sh` because the migration that would otherwise
create it runs as the `gremion` user, which lacks `CREATEROLE`.

There is no Nextcloud database and no separate finance database — those are not in
the kernel. The only application data Keycloak holds is its own realm/session
state.

### Multi-tenancy

`gremion-ui` is multi-tenant. Each tenant is served on its own host
(`<slug>.<domain>`, with the apex as the default tenant). The **tenant resolver**
fails closed: a request lacking an `x-forwarded-host` is 404'd, and — once
`TENANT_PROXY_SHARED_SECRET` is set — a request lacking the edge-injected
`x-proxy-trust` is 403'd. The control-plane registry is the source of truth for the
tenant set and drives fleet migrations across every tenant DB.

The control DB connection (`CONTROL_DATABASE_URL`) deliberately targets
`postgres:5432` **directly** and is not re-pointed through PgBouncer in the prod
overlay — the registry is the direct term in the connection budget and its reads
are cached.

## Database client lifecycle (`getDb()`)

`gremion-ui` reaches Postgres through a **request-scoped, per-tenant** SQL pool, not
a process-global singleton. `getDb()`
([`gremion-ui/src/lib/server/db.ts`](../gremion-ui/src/lib/server/db.ts)) resolves the
canonical tenant from `AsyncLocalStorage` and returns that tenant's pool from a
bounded, draining LRU registry:

```ts
export function getDb(): Sql {
  return getPoolForTenant(requireTenant())
}
```

Properties this shape guarantees:

- **No connection at import time.** SvelteKit's build / prerender phases never
  touch Postgres; the pool is only materialised inside a request (or an explicitly
  tenant-scoped boot/cron task wrapped in `runWithTenant(ctx, …)`).
- **Fail-closed tenancy.** `requireTenant()` *throws* on an empty
  AsyncLocalStorage store rather than defaulting to tenant #1, so a missing tenant
  context is a hard error, never a silent cross-tenant read.
- **Boot resilience.** `waitForDbReady()` retries transient startup races
  (`isTransientDbStartupError` — SQLSTATE `57P03`, connection-refused, etc.) within
  a bounded budget, so a reboot race where Docker starts `gremion-ui` before Postgres
  is ready recovers instead of latching unhealthy. Genuine faults (bad creds, a
  real schema bug) are rethrown immediately.

Keep using `getDb()` inside handler/service functions, never at module top level —
the same call site works for every tenant because the pool is resolved per request.

### Migrations

**On the numbering.** Migration filenames are inherited from the pre-carve
monorepo and are deliberately non-contiguous: the gaps are files that did not
come across in the extraction — most of them owned by feature modules, some of
them governance-side migrations the product has and this kernel does not. The
chain here is complete and self-consistent on its own (`runMigrations()` applies
files in filename order and never requires contiguity), but it is a strict
subset of the product schema and a fresh kernel install does not reproduce it.
Never renumber: the SHA-256 manifest and the `schema_migrations` bookkeeping are
keyed on these filenames. What is here and what is not is listed file by file in
[`gremion-ui/migrations/README.md`](../gremion-ui/migrations/README.md).

`runMigrations()` applies every pending file from `gremion-ui/migrations/` in
filename order. Two guards harden it:

- **Integrity (G-012).** Before `sql.unsafe(text)` runs a migration, its bytes are
  verified against the build-time SHA-256 manifest (`migrations/manifest.json`) via
  `verifyMigrationIntegrity()`. A swapped or tampered file aborts the boot.
- **Atomicity (G-078).** `applyMigrationFile()` wraps the schema change and the
  `schema_migrations` bookkeeping INSERT in one `sql.begin` transaction, so a crash
  can never leave a migration applied-but-unrecorded.

The same loop is **module-aware**: a disabled toggleable module's migrations are
skipped on a fresh DB, and an OFF→ON re-enable on an initialised tenant is planned
as a catch-up. In the governance-only kernel only `core` and `governance` ship and
neither is toggleable, so every kernel migration always applies. (Dev `*_seed.sql`
files are skipped in production via `GREMION_DISABLE_SEEDS`.)

## Module SDK and the dependency-direction boundary

The kernel is a **module host**. A module is a manifest plus, optionally, its own
schema, routes, nav fragment, and self-registered runtime contributions.

### Manifests and the generated registry

A module declares a `ModuleManifest` (`id`, `order`, `toggleable`, `pages`,
`routePrefixes`, optional `groups` and `nav`). The kernel ships **exactly two**,
both always-on:

- `core` (id `'core'`, `toggleable: false`,
  [`manifests/core.ts`](../gremion-ui/src/lib/modules/manifests/core.ts)) — the
  minimal shell: `dashboard`, `settings`, `systemstatus`, and the platform-wide
  Keycloak group literals (`admin`, `it-admin`).
- `governance` (id `'governance'`, `toggleable: false`,
  [`manifests/governance.ts`](../gremion-ui/src/lib/modules/manifests/governance.ts))
  — the governance flagship: `members`, `committees`, `portal`, `protokolle`,
  `beschluesse`.

No finance / votes / content / calendar / files / messaging manifest exists in the
kernel.

`MODULE_MANIFESTS` is **not** a hand-written array. `scripts/build-module-manifest.mjs`
scans `manifests/*.ts` and emits `index.generated.ts` sorted by each manifest's
`order`. Adding or removing a manifest file and re-running the codegen updates the
registry with zero hand edits; the committed barrel is byte-pinned by
`registry.test.ts`. The barrel is re-exported through
[`manifests/index.ts`](../gremion-ui/src/lib/modules/manifests/index.ts).

### The runtime-registry seam (dependency inversion)

So the kernel never statically imports a module's server internals, modules
**self-register** their runtime contributions at import time into
[`gremion-ui/src/lib/server/modules/runtime-registry.ts`](../gremion-ui/src/lib/server/modules/runtime-registry.ts).
The kernel composition roots invoke the aggregate. Six kinds of contribution:

1. **Server-init hooks** — boot-time workers (schedulers, consumers, drains); run
   by `hooks.server.ts` via `runServerInitHooks()`.
2. **Tenant-evict hooks** — drop a module's per-tenant runtime handle; run by
   `tenant/registry.ts` via `runTenantEvictHooks(tenantId)`.
3. **Provisioning subsystem factories** — a module's external-service adapter
   (e.g. a files or messaging subsystem); built by the governance orchestrator via
   `buildModuleProvisioningSubsystems(kc)`.
4. **Request-time data providers** — keyed read functions the kernel
   shell/dashboard/committees loads invoke as `getDataProvider(key)?.(args)`,
   degrading to an empty state when the module is absent.
5. **Protocol document port** — the single document backend the protocol routes
   drive (`getProtocolDocumentPort()`), undefined when no files module is present.
6. **Setup-wizard health probes** — per-module credential probes the setup-health
   route iterates (`getSetupHealthProbes()`).

A module's `register.server.ts` is loaded for its side effects by the generated
server-init barrel (`scripts/build-module-server-init.mjs`). In a governance-only
kernel these registries are simply empty, and each kernel caller degrades to its
absent-module path.

### The boundary enforcer

The dependency direction is enforced, not merely conventional, by the boundary
engine under
[`gremion-ui/src/lib/server/boundary/`](../gremion-ui/src/lib/server/boundary/):

- **Import rules** (`rules.ts`, `import-scan.ts`) forbid cross-boundary imports
  except from sanctioned **composition roots** (`src/hooks.server.ts` and the
  generated server-init barrel). The core invariant is the kernel ownership
  direction — governance must never import a feature module.
- **Cross-schema FK allowlist** (`sql-fk-scan.ts`) flags any cross-schema foreign
  key in the migration set that is not explicitly listed. In the carved kernel the
  allowlist is empty (the finance→`org_units` FKs left with the finance module), so
  the scan guards the governance-only schema for free.
- **`kernel-clean.test.ts`** is the comprehensive backstop: it asserts the kernel
  has no residual import into a carved-out module. This backstop, not a
  per-surface rule, is what catches stragglers a manual map would miss.

Changing `rules.ts` — especially adding an allow entry — is a reviewable design
decision; the engine additionally flags *unused* allow entries so stale exceptions
cannot linger.

## Authentication helpers (group model)

`gremion-ui` layers a fine-grained, group-based capability check on top of the coarse
role enum. `makeAuthHelpers(session)`
([`gremion-ui/src/lib/auth/group-helpers.ts`](../gremion-ui/src/lib/auth/group-helpers.ts))
reads `session.user.groups` (the Keycloak OIDC `groups` claim) and returns
predicates — `hasGroup`, `hasAny`, and a set of capability predicates resolved
through the composed `CAPABILITIES` map.

Capabilities are **contributed by modules**. The finance-specific predicates
(`canApproveAny`, `canEditBudget`, `canApproveBudget`, `canConfigureFints`,
`canManageSubOrgs`) look up `finance.*` capability ids. In the governance-only
kernel those ids are absent from the composed map, so each predicate degrades to
`false` (the capability is simply ungranted) rather than throwing — they light back
up automatically when the finance module is present. The kernel's own gates use
`hasAny('admin', 'it-admin', …)` against the always-on `core`/`governance` groups.
Full catalog in [`docs/auth.md`](auth.md) §8.

## Sidebar navigation schema (`needs[]` filtering)

The sidebar is a declarative, module-composable schema, not hard-coded per-role
markup
([`gremion-ui/src/lib/components/layout/nav-schema.ts`](../gremion-ui/src/lib/components/layout/nav-schema.ts)).

- `baseNavSchema` is the **module-neutral base template**: the Arbeitsbereich
  overview, the Gremien section (committees + protokolle/beschlüsse, both
  guest-readable), the Öffentlichkeit portal admin, and the Verwaltung section
  (Mitglieder, Einstellungen, Systemstatus). It declares no feature-module rail
  entries.
- `composeNavSchema(base, MODULE_MANIFESTS)` weaves each module's owned `nav`
  fragment in at its `{ slot: 'module', moduleId }` anchor. A kernel with no
  feature modules simply has no anchors to fill, so `navSchema` is the base alone.
- `filterNavForSession(schema, helpers, roles, disabledModules)` hides items whose
  `role`/`needs` the session fails (and a deselected module's entries outright),
  pruning sections left empty.
- `retermNav(nav, terms)` re-labels items carrying a `termKey` via the active
  tenant's term map (e.g. "Gremien & Referate" → "Ausschüsse & Fraktionen" for a
  Gemeinderat); a tenant with no override resolves to the built-in literal.

Hiding a nav link is **cosmetic, not an access boundary** — every gated page
enforces its own server-side check (the canonical example is the `/members` 403 in
`gremion-ui/src/routes/members/+page.server.ts`). Filtering/reterming are applied in
`gremion-ui/src/routes/+layout.server.ts`. `composeNavSchema` and the predicates are
pinned by the deep golden test (`nav-schema.test.ts`). See [`docs/auth.md`](auth.md)
§8.4–§8.5.

## Shared packages

- **`@gremion/db`** ([`packages/db`](../packages/db)) — pure shared types and the
  `Sql` type, with zero feature references. `gremion-ui/src/lib/server/db.ts`
  re-exports the governance types (`Committee`, `Protocol`, `ProtocolResolution`,
  …) from here so existing `$lib/server/db` imports keep working.
- **`@gremion/ports`** ([`packages/ports`](../packages/ports)) — the inter-service
  contracts for the module-over-API boundary: `BrokerPort` (NATS/JetStream,
  subject grammar `gremion.{tenantId}.{domain}.{event}`), `TracerPort`
  (`x-correlation-id`), anti-corruption callbacks, and the transactional
  outbox + saga primitives.

### Migrating the wire-subject root

`SUBJECT_ROOT` in [`packages/ports/src/broker.ts`](../packages/ports/src/broker.ts)
is the single definition of the wire namespace: `gremion` since the T01 rename,
and before that the product token `sturaos` (kernel-hygiene check `h1` now fails
the tree on any surviving wire literal of it). Every subject helper and every
`STREAMS` filter derives from that constant, so changing it moves the code and
the tests together — but it does **not** move a running server. A deployed
JetStream stream keeps the filter it was created with, and the messages already
stored under the old subjects stay there.

The two sides drift the moment the new code deploys, and **the server reports
neither failure** — verified against nats 2.12 with `@nats-io/jetstream` 3.4:

- **Repointing silences every running consumer.** A consumer whose filter no
  longer overlaps the stream's is not rejected, not deleted and not notified:
  `consumers.get()` and `consume()` keep succeeding, and the consumer simply
  never receives another message. (An earlier revision of this section claimed
  `consumers.get()` starts rejecting. It does not.)
- **Repointing orphans every stored message.** Messages published under the old
  root remain in the stream and are no longer matched by any consumer filter.
  They are not deleted, not redelivered, and not counted as lost.

Because the server says nothing, every signal is produced client-side, by
`NatsBroker` in [`packages/ports/src/nats-broker.ts`](../packages/ports/src/nats-broker.ts):

- `ensureStream()` **refuses** to repoint a live stream's subject filter unless
  you pass `{ repointSubjects: true }`, and names both filters.
- `subscribe()` asks the **server** what the bound stream captures before it
  creates a consumer — not the `STREAMS` topology, not the last
  `ensureStream()` argument. A pattern the live filter does not cover rejects
  the subscription's `ready` and `closed` promises with `StreamCoverError`, and
  no consumer is created. That verdict stands even when `unsubscribe()` or
  `close()` arrives while the check is still in flight. `publish()` runs the
  same check against a cache of the server's last answer — read once per
  broker, dropped by `ensureStream()` on the bound stream, and **re-read before
  any refusal and after a transient publish error** (one retry) — so an
  operator's `nats stream edit` can produce neither a false refusal nor a
  silent one; it throws `NoStreamError`.
- **A deleted stream or consumer faults the subscription within
  `LIVENESS_FAULT_BOUND_MS`** (`@gremion/ports/broker` — the constant the
  real-server proofs import and this page names; the number lives there and
  nowhere else). The server volunteers exactly one signal, a 409 "consumer
  deleted" to a *pending* pull, which `abort_on_missing_resource` turns into
  the loop's death; a stream deleted *between* pulls gets no answer, and round
  4 measured that fault at 0 ms or at ~30 s — the library's default pull
  expiry — never in between. `NatsBroker` now sizes the pull
  (`CONSUME_IDLE_HEARTBEAT_MS` / `CONSUME_EXPIRES_MS`) and consumes the
  consumer's `status()` notifications: missed heartbeats trigger a probe of the
  stream and the consumer on the server, and whichever is gone faults the
  subscription — `closed` rejects with `StreamGoneError` / `ConsumerGoneError`
  naming the pattern and the stream, and one error line is logged. Measured
  over the twenty-run proof against nats 2.12: consumer deletion, and the
  answered case of stream deletion, fault in 1–3 ms; the unanswered case
  (four runs of the twenty) faults in about 2 s by the heartbeat path —
  inside the bound, with room. Both still present and still no heartbeat is a stall;
  `STALL_PROBE_LIMIT` consecutive such probes fault with `ConsumerStalledError`.
- An **opt-in repoint faults the repointing broker's own live subscriptions**:
  each one logs at error level and rejects `closed` with
  `StreamRepointedError`. That signal reaches only the process that performed
  the repoint. Subscriptions held by *other* processes — and every
  subscription, when the repoint is done from an operator shell with
  `nats stream edit` — go quiet with nothing said. Step 5 below is therefore
  mandatory, not ordering advice.

**Shortcut — a stream with zero messages.** Check first; it is almost always the
case on staging and for a domain that has not gone live:

```sh
nats stream info NEWSLETTER --json | jq '.state.messages'
```

If that prints `0`, there is nothing to preserve. Delete and let the next boot
recreate the stream from the new `STREAMS` topology — no opt-in flag, no
migration:

```sh
nats stream rm NEWSLETTER          # confirm; then redeploy / restart the leaf
```

**Full procedure — a stream holding messages.** Repointing alone would strand
them, so drain first:

1. **Stop the producers.** Scale the publishing leaf to zero. The kernel's
   outbox retains events for the duration, so nothing is lost by pausing.
2. **Let the consumers finish.** Watch until pending reaches zero:
   `nats consumer report NEWSLETTER`. Messages published under the old root are
   only readable while the old filter is still in place — this is the step that
   cannot be done afterwards.
3. **Deploy the new code, still refusing.** What "refuses" depends on which
   call a process makes, and only one of them throws:
   - A process whose boot path calls `ensureStream()` on the bound stream (the
     leaves, downstream) gets the refuse-on-drift error from that call, naming
     both filters: the `sturaos`-rooted one the server holds and the
     `gremion`-rooted one the code wants. Whether that takes the process down
     is the caller's decision — the broker throws, it does not exit.
   - A process that only `subscribe()`s gets **no throw**. `subscribe()`
     returns normally; the refusal arrives as a rejected `ready`/`closed`
     (`StreamCoverError`) plus one `[nats-broker]` error line on the console,
     and the process stays up holding a subscription that will never deliver
     unless the caller awaits `ready`. In this repo nothing outside the test
     suites calls `ensureStream()` or `subscribe()` — the kernel ships the
     class, its callers live downstream — so "boot fails loudly" is a property
     of the consuming process, not of the kernel.
   - `publish()` from a process on the new code throws `NoStreamError` for
     every event until step 4; the outbox retains them.
   Either signal confirms the stream is the one you think it is, and both are
   expected here. Read the consumer's log for the `[nats-broker]` line — do
   not infer from "the process is running" that its subscription is live. A
   consumer that awaits `ready` and exits non-zero on rejection makes the
   refusal a visible restart loop instead; and once live, a subscription whose
   stream is deleted or recreated under it rejects `closed` within
   `LIVENESS_FAULT_BOUND_MS`, so a consumer that awaits `closed` and exits is
   back on a fresh `subscribe()` — a fresh cover check — promptly.
4. **Repoint once, deliberately.** Set `{ repointSubjects: true }` on the single
   boot call performing the migration — the only path that faults that
   process's own subscriptions. `nats stream edit NEWSLETTER --subjects
   'gremion.*.newsletter.>'` from an operator shell moves the same filter but
   **bypasses every client-side guard**: nothing that is running learns of it.
   Either way, do not leave the flag in the deployed code — the next accidental
   drift would then be silent again, which is the whole failure this guard
   exists for.
5. **Restart every consumer, then the producers — mandatory.** A consumer
   created before the repoint is silent for good (see above), whether or not it
   was faulted; only a fresh `subscribe()` checks the new filter. Consumers
   first, then producers: the reverse order publishes into a stream nobody is
   reading yet.
6. **Verify against the running system, not the repo.** `nats stream info
   NEWSLETTER` shows the new filter, and a real publish must arrive:
   `nats sub 'gremion.>'` in one shell while the leaf emits one event.

The kernel's proof that these paths behave is `make test-ports-nats`
([`packages/ports/scripts/nats-test.sh`](../packages/ports/scripts/nats-test.sh)),
which starts a throwaway JetStream container and runs the whole `@gremion/ports`
suite against it. The real-server proofs are in
[`packages/ports/src/nats-broker.integration.test.ts`](../packages/ports/src/nats-broker.integration.test.ts):
the server-truth cover check and its precedence over a clean stop,
`NoStreamError`, all four `ensureStream()` paths including the opt-in repoint
and the faulting it causes, and the termination semantics (`unsubscribe()`, a
closed connection, a deleted stream and a deleted consumer — each inside
`LIVENESS_FAULT_BOUND_MS`, imported by the proof — publish after a deleted
stream, and `close()`, which is idempotent and bounded by `CLOSE_TIMEOUT_MS`). The target asserts
the post-condition rather than the exit code — vitest exits 0 on a skipped file
— by counting that file's passing tests in the verbose output and failing below
a pinned minimum. The same paths are specified against doubles in
[`packages/ports/src/nats-broker-subscribe.integration.test.ts`](../packages/ports/src/nats-broker-subscribe.integration.test.ts),
which runs under the plain `pnpm --filter @gremion/ports test`.

An existing deployment that upgrades past the rename faces a hard cutover of
every stream at once. The interface delta and the order in which the streams
must be migrated **before** the upgrade are in
[`docs/playbooks/nats-root-cutover.md`](playbooks/nats-root-cutover.md).

## Decision log

| Decision | Rationale |
|----------|-----------|
| Keycloak OIDC for SSO | One identity provider for the app shell (Auth.js) and any module/service; standards-based, supports MFA/step-up, no custom auth code |
| One PostgreSQL instance, three scopes | Control plane, per-tenant governance data, and Keycloak in a single engine — one StatefulSet/container to operate and back up |
| Module SDK + dependency-direction boundary | The kernel hosts modules without importing them; the boundary engine enforces the ownership direction so the open-core line is mechanical, not conventional |
| Codegen'd manifest registry | Adding/removing a module is a file + codegen step, not a hand-edited array — the carve is a clean subtraction |
| Request-scoped per-tenant DB pool | Fail-closed tenancy: a missing tenant context throws instead of silently reading tenant #1 |
| Per-tenant Host routing (Traefik) | Each tenant on its own host preserves the CSRF origin check and lets the resolver select the tenant from the inbound Host header |
| Mailpit for local/staging mail | Traps outbound mail; switching to a real relay is a pure `.env` change, no compose edit |
