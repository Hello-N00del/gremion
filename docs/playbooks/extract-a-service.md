# Extract a Service — the Gremion module-to-service playbook

> **What this is.** The reusable kernel-SDK pattern for cutting a Gremion feature
> module out of the in-process app and standing it up as an independently-deployed
> **service** with its own physical store and an async contract over the broker. It
> is the operational/technical companion to the conceptual overview in
> [`docs/about-gremion.md`](../about-gremion.md) — read that first for the kernel
> vision, the open-core boundary (kernel = governance substrate + invariant hooks;
> features = candidate modules), and why a module that stays closed has to be a
> separate service with its own API *and* its own UI rather than in-app routes.
>
> The methodology is **proven**, not theoretical: the first end-to-end run of this
> playbook extracted the newsletter module from the in-process app to a standalone
> leaf service — derived a port, ran a conformance suite across both
> implementations, wired a transactional outbox onto the broker, flipped live on a
> flag, and decommissioned the old store after a rehearsed rollback. The newsletter
> feature itself is a **module** (it lives outside the governance kernel); what
> generalises — and what this file captures — is the kernel SDK methodology that
> any module extraction follows.
>
> **How to use it.** Walk the seven sections in order. Each ends with a
> **checklist** you copy into the extraction's task plan and tick off. Section 4
> (the flip) and Section 5 (decommission) are the highest-risk; do not start
> Section 5 until the rollback rehearsal in Section 4 passes. Read the **Lessons
> from a live cutover** section before you flip — those five gap classes cost real
> live failures and recur on every cross-process extraction if you do not pre-check
> them.

---

## 1. Branch-by-abstraction steps

Never fork the consumers off a `git` branch and rewrite them in place. Introduce
a **port interface** the app already depends on, ship an in-process
implementation behind a flag, convert the consumers behavior-frozen, then swap in
an out-of-process implementation behind the SAME port — proven by a conformance
suite that runs against BOTH implementations.

**Step 1 — derive the port from the grep-enumerated consumers.** Do not invent the
interface; enumerate it. The module's backend port method set must be exactly the
set of store/dispatch functions that the consumer files actually import and call —
derive it by grepping every consumer's imports, and record the derivation verbatim
in the port file header so the next reader can re-verify it. Make the port a
**pure interface with no runtime deps** so it can later host the relocated domain
DTOs once the in-process store module is deleted.

**Step 2 — in-process impl behind ONE env flag through ONE factory.** The original
in-process implementation satisfies the port against the in-process store and is
selected by a single backend flag. A single factory function is the only seam that
reads the flag; document the legacy branch in its header so the eventual removal is
self-explanatory.

**Step 3 — convert the consumers behavior-frozen.** Every route, scheduler, and
tick consumer obtains the backend once per request via the factory and calls
`backend.<method>()` — none import the store directly. Prove the freeze held: if
all non-test consumers already routed through the port, no consumer handler changes
at all.

**Step 4 — out-of-process impl behind the same port.** The HTTP anti-corruption
client implements the identical port against the remote leaf (selected by the
leaf's service URL). Default the factory to the service impl once it is conformance-
proven.

**Step 5 — conformance suite on BOTH impls.** The semantic assertions that ran
against the in-process backend must live on against the surviving impl: a
service-client suite (the ACL impl against the port) plus a flag-resolution
contract test (`unset → service`, `service → service`, the removed in-process value
and any unknown value → throw → `503`). When the in-process backend is removed in
Section 5, migrate any of its semantic assertions that are not store-specific into
these surviving suites rather than deleting them.

> **Anchors in this kernel.** The shared port primitives live in
> [`@gremion/ports`](../../packages/ports/src) — `packages/ports/src/broker.ts`
> (`BrokerPort`) and `packages/ports/src/tracer.ts` (`TracerPort`). The
> module-boundary enforcer that proves "zero direct store imports remain" is the
> boundary backstop (`gremion-ui/src/lib/server/boundary/`,
> `kernel-clean.test.ts` + `rules.ts`).

### Checklist
- [ ] Port interface derived by **grepping every consumer's imports**, not invented.
- [ ] Port is a pure interface (no runtime deps) so DTOs can relocate onto it later.
- [ ] In-proc impl selected by ONE env flag through ONE factory.
- [ ] Every consumer routes through the factory; **zero** direct store imports remain (prove with the boundary backstop).
- [ ] Out-of-proc impl satisfies the IDENTICAL port.
- [ ] Conformance/contract suite runs against the impl that survives the cutover.

---

## 2. Anti-corruption-layer pattern

The leaf does not absorb the kernel's satellite couplings. Operations that need
kernel-only credentials or kernel-only infrastructure **stay kernel-side** and the
leaf reaches them over a narrow, header-stamped HTTP hop with an error-envelope
translation at the boundary.

Decide **per coupling** whether it MOVES with the leaf or STAYS as a guarded kernel
callback — do not default to "move everything". Couplings that depend on
kernel-held credentials or kernel-only infrastructure stay kernel-side as guarded
internal endpoints the leaf invokes; for example:
- **Identity/group resolve** — only the kernel holds Keycloak-admin credentials, so
  a group/role resolve is a kernel callback.
- **Per-tenant outbound transport** — the kernel resolves the per-tenant transport;
  credentials never leave the kernel.

Write the leaf side of the ACL as a **narrow port the leaf's engine depends on**,
with the concrete HTTP client wired only at the process boundary so tests inject a
fake. Every request stamps **tenant + correlation headers** — `x-tenant-id`,
`x-tenant-slug`, and the correlation id (`x-correlation-id`, traceable end-to-end
across the two processes; see `readOrMintCorrelationId` and `CORRELATION_HEADER` in
`packages/ports/src/tracer.ts`) — plus the shared internal-auth secret the inbound
guard validates.

**Error-envelope translation** is the load-bearing ACL behavior: a kernel callback's
typed domain error is returned over the wire as a specific status + error code
(e.g. `503 {error:'…-unconfigured'}`), and the leaf ACL translates that wire shape
into a **typed leaf error with explicit retry semantics** — terminal errors mark
the unit-of-work `failed` (and emit a terminal outbox event), never crash and never
look like a retryable infra error; any other non-ok status becomes a generic
retryable `Error` so the dispatch claim is left in place for stale-takeover.

### Checklist
- [ ] Each satellite coupling either MOVES with the leaf or STAYS as a guarded kernel callback — decide per coupling, do not default to "move everything".
- [ ] Leaf-side ACL is a narrow injectable port; concrete HTTP wired only at the boundary.
- [ ] Every callback stamps tenant + correlation headers + the shared internal secret.
- [ ] Each kernel error shape is translated to a TYPED leaf error with explicit retry semantics (retryable vs terminal).

---

## 3. Outbox wiring (the transactional-outbox idiom)

The leaf owns its events. State changes and the intent-to-publish are co-committed
in ONE transaction (transactional outbox), a relay drains the outbox to the broker,
and the consumer is idempotent. This is the kernel's outbox-saga idiom (see
`@gremion/ports`) applied to the leaf's own physical DB.

**Outbox table + backoff + terminal.** The outbox is a table in the leaf's
per-tenant DB with `status` (`pending`/`ok`/`failed`), `attempts`,
`next_attempt_at`, `first_failed_at`, `last_error`. Use a capped exponential
backoff — e.g. `LEAST(3600, 30 * 2^min(attempts+1,12))` seconds — and a **terminal
age cap**: once `first_failed_at` is older than the give-up window (e.g. 24h) the
row stays `failed` (no further retries, NOT deleted, so an operator can inspect it)
and resets on any successful publish.

**Enqueue-in-state-tx.** The enqueue helper takes the in-progress DB transaction
and inserts the outbox row INSIDE the same tx that transitions the aggregate's
state — never a phantom publish, never a missed publish on crash. Drains use
`SELECT … FOR UPDATE SKIP LOCKED` so concurrent relays never double-publish.

**Relay → broker, with dedup.** The relay drains due rows and publishes via the
`BrokerPort`, assembling the wire subject ONLY via a single subject helper (one
source of truth so the subject can never silently drift from the contract). The
subject grammar is `gremion.{tenantId}.{domain}.{event}` — see
`packages/ports/src/broker.ts` (`provisioningSubject` is the kernel example;
`makeEnvelope` builds the `EventEnvelope`). The NATS/JetStream publish impl sets the
dedup header `Nats-Msg-Id = envelope.eventId` within the broker's dedup window
(`packages/ports/src/nats-broker.ts`).

**Consumer idempotency.** The kernel-side consumer subscribes the domain subject
pattern (e.g. `gremion.*.<domain>.>` — the `>` token matches one-or-more trailing
tokens, valid only as the final token; see `subjectMatches` in `broker.ts`) and,
per event in one DB tx, performs an `INSERT … ON CONFLICT DO NOTHING` into an
`event_consumption (consumer, event_id)` table whose composite PK makes the insert
a true idempotency gate; if 0 rows were inserted the event was already processed →
ack + skip.

### Checklist
- [ ] Outbox row co-committed in the SAME tx as the state change (enqueue-in-tx).
- [ ] Capped exponential backoff + a terminal age cap; terminal rows kept, not deleted.
- [ ] Relay drains with `FOR UPDATE SKIP LOCKED`; subject assembled from ONE helper.
- [ ] `Nats-Msg-Id = eventId` set on publish (broker-side dedup window).
- [ ] Consumer dedups via an `event_consumption (consumer, event_id)` insert-on-conflict gate.

---

## 4. Feature-flag flip protocol

The flag is the cutover lever AND the rollback lever. The canonical order is
**FLIP-FIRST** so the old store freezes with no delta to reconcile; the new-store
scheduler is HELD until the backfill verifies; and the live flip is done through a
PINNED compose invocation with in-container env verification. Capture the order in a
cutover runbook that turns each step into a concrete command — **any reordering is a
plan violation.**

The FLIP-FIRST order:
1. **Scheduler HELD on first deploy** — scheduler disabled, backend flag still on
   the old store. The new leaf is up but dispatches nothing. Confirm the hold took
   INSIDE the container (`printenv`) — a `docker compose restart` will not reload
   `.env`; you must recreate.
2. **Announce the no-send window** (flag still on the old store).
3. **Quiesce in-flight work** per tenant (expect 0 in-progress rows).
4. **FLIP BEFORE backfill** — set the backend flag to `service`. This is what
   freezes the old store: once flipped, all writes go to the new store and the old
   one can take no further delta. Verify in-container (`printenv <flag> → service`).
5. **Backfill per tenant + verify gate + mtime check** — id-preserving backfill
   gated on a per-tenant `BACKFILL OK` line; then a full `--verify-only` re-run must
   be green; then confirm the old store's **mtime is unchanged since the flip**
   (proves nothing was stranded after the flip).
6. **Enable dispatch** — re-enable the scheduler (in-container verify again).
7. **Live smoke** — exercise the real path end-to-end (for a governance module:
   render a committee/protocol view, create a member, run the module's primary
   action), then the **duplicate-action live proof** (re-trigger → idempotent
   result, never doubled), confirm the scheduled path fires from the SERVICE
   scheduler, the audit/correlation id matches across processes, and
   `/healthz/tenants` is green.

**Pinned compose invocation (mandatory).** Run every cutover command against an
explicit file set and explicit services, e.g.
`docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile production <cmd> <explicit services>`.
A bare `docker compose …` resolves `docker-compose.yml` + `docker-compose.override.yml`
— a different file set that recreates services under dev config (a recorded outage
class). Pre-step: inspect the running container's
`com.docker.compose.project.config_files` label and confirm it lists the intended
files or STOP. **Bare `docker compose down` is FORBIDDEN during a cutover.**

> **Compose topology in this kernel.** The governance-only stack defaults to 7
> services (`postgres`, `keycloak`, `gremion-ui`, `gremion-public`, `legal`, `vector`,
> `mailpit`). The `production` profile in `docker-compose.yml` adds `traefik` +
> `docker-socket-proxy`; `docker-compose.prod.yml` adds `pgbouncer` + `cloudflared`.
> An extracted leaf adds its own service + Postgres + a broker (NATS) container.

**Rollback rehearsal BEFORE decommission.** The rollback must be rehearsed and
proven real while the old store is still present — Section 5 does not start until it
passes.

### Checklist
- [ ] New-store scheduler HELD until the backfill verifies.
- [ ] Quiesce in-flight work (expect 0) before the flip.
- [ ] FLIP FIRST, then backfill — so the old store freezes with no post-flip delta.
- [ ] Backfill-verify gate (`BACKFILL OK`) + post-flip `--verify-only` re-run + old-store mtime-unchanged check.
- [ ] Pinned compose invocation confirmed; in-container env verified twice (after hold, after flip).
- [ ] Live smoke incl. the duplicate-action proof (re-trigger → result unchanged).
- [ ] Rollback rehearsed and proven BEFORE any decommission.

---

## 5. Old-path decommission checklist

Decommission is **gated** on the operational surfaces already pointing at the new
store. The hard rule: **backup follows the store** — back the new store up, and
re-point backup / crypto-shred / health at the new store, BEFORE you remove the old
one. Removing the old path before the new one is backed up is data-loss-by-omission.

**The backup-follows-the-store step (done *before* removal):**
- **Backup** — the per-tenant backup script gains a step that `pg_dump -Fc`s the
  leaf's per-tenant DB (via `docker compose exec -T <leaf>-postgres`), encrypted
  under the same per-tenant backup key, written next to the kernel artifacts.
  Existence-checked (WARN + skip if the leaf is not provisioned). Prove the
  dump → encrypt → round-trip is lossless before trusting it.
- **Crypto-shred** — tenant lifecycle gains a leaf-shred executor (`DROP DATABASE`
  of the leaf's per-tenant DB + catalog-row delete), invoked AFTER the data-plane DB
  drop and BEFORE realm delete; pin the ordering with unit tests. A configured-leaf
  shred failure must ABORT the delete — no silent data remanence.
- **Health** — the tenant health probe gains a `leaf` check (`GET /healthz/tenants`
  on the leaf); a failing leaf flips the tenant UNHEALTHY.

Only once those three surfaces address the leaf DB does removal run.

**Removal + boundary-rule + contract + env cleanup:**
- Remove the in-process source (store, scheduler, sender, availability helpers) and
  the in-process-coupled tests (their non-store-specific semantic assertions live on
  in the service/port suites per Section 1).
- **Flag default flipped** — factory: unset → `service`; the removed in-process flag
  value now throws (resolve → `503`). Mirror the default in `docker-compose.yml`.
- **Boundary rule** — update the module's boundary rule to "dir = port + ACL
  client"; remove the now-unused allow entries. The backstop flags unused allows, so
  their removal proves the coupling is genuinely gone (see
  `gremion-ui/src/lib/server/boundary/rules.ts` + `kernel-clean.test.ts`).
- **Contract** — note in `contracts/README.md` that the leaf is now the only
  backend; the kernel contracts under `contracts/kernel/` stay governance-only.
- **Env cleanup** — remove the in-process store's env vars from the tenant-env
  guard; remove the in-process copy step from the backup script (keep the leaf PG
  dump); drop now-unused dependencies — but if anything else still imports a
  dependency (e.g. backfill tooling), leave it and note why.

**Re-walk the tenancy DoD against the new store.** Re-walk every data-lifecycle
sub-item against the new store: backup produces the leaf artifact, crypto-shred
drops the leaf DB key-first, health covers the leaf, and "leaf not configured" is
non-fatal everywhere. A cascade caveat that recurs: **do not delete a shared
mount/volume just because the leaf used it** — a shared `/data` volume also holds
per-tenant `config.json`, so keep the mount and remove only the module-specific env
and comments.

### Checklist
- [ ] **Backup follows the store**: new store backed up + backup/crypto-shred/health re-pointed at it BEFORE removal.
- [ ] Crypto-shred drops the new store key-first; ordering unit-tested; configured-leaf shred failure aborts the delete.
- [ ] Old source + its now-redundant tests removed; semantic assertions confirmed to live on in the surviving suites.
- [ ] Flag default flipped to the new path; the old value throws (fail-closed).
- [ ] Boundary rule updated; unused allow-entries removed (the backstop proves the coupling is gone).
- [ ] Contract doc + env-guard + dependency cleanup done; shared mounts/volumes NOT deleted.
- [ ] Tenancy-DoD re-walk completed against the new store.

---

## 6. Dual-deploy authoring (Compose + k8s)

Author BOTH deploy manifests together and keep them in sync with a **drift test
written FIRST**. The leaf must deploy independently on Compose AND on k8s.

**Compose + kustomize together.** Define the leaf, its Postgres, and its broker in
`docker-compose.yml` (+ overlays `docker-compose.prod.yml` /
`docker-compose.override.yml`) and mirror them in the kustomize base
(`k8s/base/<broker>/` service + statefulset and `k8s/base/<leaf>/` deployment,
service, configmap, secret, postgres-statefulset/service/secret).

**Drift test FIRST.** A deploy-drift test asserts the k8s manifests stay in sync
with `docker-compose.yml` on three axes: image tag, env-var KEY NAMES (compose env
block vs k8s configmap + secret stubs), and readiness probe path + port. Write or
extend it before you hand-edit either manifest so a divergence fails CI instead of
leaking to deploy.

**k3d acceptance with the loopback rule.** Local k8s acceptance uses a
self-contained overlay (its own namespace; deploys ONLY the broker + leaf-postgres +
leaf service, with kernel callbacks stubbed via a `KERNEL_BASE_URL` pointing at an
unreachable stub so startup does not need the kernel). On Windows the cluster MUST
be created with the loopback flag —
`k3d cluster create <name> --api-port 127.0.0.1:<port>` — or `kubectl` cannot
connect.

**Dry-run fallback policy.** If k3d is unavailable or flaky, the fallback is
`kubectl apply -k <overlay> --dry-run=server` against the k3d API — and it MUST be
**flagged to the operator in the PR**, never a silent weakening of the
"independent deploy on k8s" gate.

### Checklist
- [ ] Compose and kustomize manifests authored/edited together.
- [ ] Drift test written FIRST; asserts image tag + env key names + probe path/port.
- [ ] Self-contained k3d acceptance overlay (leaf + its deps only; kernel stubbed).
- [ ] `k3d cluster create … --api-port 127.0.0.1:<port>` (mandatory loopback flag).
- [ ] Dry-run fallback only if k3d unavailable, and FLAGGED in the PR.

---

## 7. Rollback

Rollback is **flag-off**, and it stays real only until decommission. Rehearse it in
Section 4; understand its data semantics before you rely on it.

**Flag-off semantics.** Set the backend flag back to the old store, recreate the
kernel with the SAME pinned compose invocation (`… up -d --force-recreate gremion-ui`),
and verify the old path serves (`printenv <flag> → <old store>`). Because the
cutover was FLIP-FIRST with the old store frozen and mtime-verified, the old-store
snapshot is exactly the pre-flip state — rollback returns to a known-good store.

**What the window loses.** Rows created or modified in the new store during the
service window are NOT back-ported to the old store and WILL be lost from the active
path. Make this an explicit operator acknowledgement and provide the enumeration: a
`--verify-only` run against the still-frozen old source prints per-table
count/checksum lines, so any `old ≠ new` delta is exactly a new-store-only write
that rollback drops. A clean `BACKFILL OK` means the two stores match (no
divergence → rollback loses nothing).

**When the window closes.** The rollback window is alive ONLY while the old store is
present — i.e. until the Section 5 decommission. Once decommissioned, the only
recovery is restore-from-backup (the encrypted leaf PG dump from Section 5). This is
why the rollback rehearsal is a **gate before** decommission, not an afterthought.

### Checklist
- [ ] Rollback = flag-off + force-recreate via the pinned invocation (verify in-container).
- [ ] Operator acknowledges the new-store-only writes the window drops; `--verify-only` enumerates them.
- [ ] Window is open ONLY while the old store exists — closes at decommission.
- [ ] Rollback rehearsed before decommission; post-decommission recovery = restore-from-backup only.

---

## Lessons from a live cutover (what the live end-to-end proof caught)

A dress-rehearsal on synthetic data can be green while the LIVE cutover's
end-to-end proof surfaces real bugs — each a cross-process or deploy-packaging gap
that the in-process tests structurally cannot see. The first newsletter extraction
surfaced **five such gap classes**; they recur on every cross-process extraction.
Frame each as a pre-cutover check.

**(a) The new service's Dockerfile must COPY every workspace package it imports.**
If the image build omits a workspace dependency (e.g. `@gremion/ports`), the SSR
build cannot resolve it and fails — even though a local `pnpm build` passed.
→ **Check:** before cutover, build BOTH images from the repo-root context and
confirm every workspace dependency the leaf/kernel imports is `COPY`'d into the
image. A passing local `pnpm build` does NOT prove the container build.

**(b) A kernel callback the leaf invokes must have its dependencies configured in
the live environment.** A retained kernel callback throws if a service URL or
credential it needs is unset in the live kernel container.
→ **Check:** before cutover, enumerate every env var each retained kernel callback
needs and verify it is set IN the live container (`printenv`), not just in `.env`.

**(c) Cross-process callbacks must PROVE proxy-trust, and async consumers resolve
the tenant by the envelope's real key type.** The kernel's tenant resolver runs
BEFORE the internal-auth guard, so a server-to-server callback that omits the
proxy-trust header and `x-forwarded-host` is rejected at the edge. Separately, an
async consumer that resolves the tenant by slug will ack-skip every real event when
the envelope's `tenantId` is a UUID — resolve by ID. (See `EventEnvelope.tenantId`
in `packages/ports/src/broker.ts` and `readOrMintCorrelationId` for the UUID
grammar in `tracer.ts`.)
→ **Check:** before cutover, prove a callback traverses the live edge's trust gate
(the resolver runs BEFORE your auth guard), and confirm async consumers resolve the
tenant by the envelope's actual key type (UUID), not by slug.

**(d) The leaf's kernel-client must use the FULL callback path.** A wrong base path
(e.g. omitting the framework's `/api` route prefix) returns the SPA's HTML 404,
which the client then fails to JSON-parse — a confusing parse error, not a clean
404.
→ **Check:** before cutover, assert each callback returns valid JSON (not HTML)
against the real route path.

**(e) Per-tenant resources the leaf depends on must be configured for a tenant
before its action works.** If a tenant's onboarding step for a per-tenant resource
(e.g. its outbound transport) is still pending, the kernel callback correctly
returns a typed terminal error and the unit-of-work goes `failed` — a config gap,
not a code bug.
→ **Check:** before cutover, confirm the target tenant's per-tenant resources are
configured, and run the live proof against a tenant whose onboarding is complete; a
pending wizard step surfaces as a typed terminal failure.

### Pre-cutover checklist (the five live-caught checks)
- [ ] (a) Both images build from repo-root context with every workspace dep COPY'd in.
- [ ] (b) Every retained kernel callback's env (URLs/credentials) verified IN-container.
- [ ] (c) Callbacks prove proxy-trust through the live edge; async consumers resolve tenant by the envelope's real key type.
- [ ] (d) Each callback returns valid JSON against the FULL real route path.
- [ ] (e) Target tenant's per-tenant resources configured before running the live proof.