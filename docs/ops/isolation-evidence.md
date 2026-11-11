# Isolation evidence: producing it on the host, what it proves

A module can be enabled for a customer only when its latest cross-customer
isolation result passed on the release tip being run (TASK-044, TRD-060/063).
This page is where that result comes from on a host built from one pinned
commit, and what a pass does and does not mean.

## The chain

```
verify --only isolation:tenant      the producer: runs the cases, writes the stamped file
  scripts/verify/out/isolation/<sha40>.json  (+ <sha40>/<module>.vitest.json, the reports it hashes)
gremion-isolation run               the same, on the host, in a toolchain container against a clean clone
gremion-isolation record <file>     imports it through the container verb isolation-record
plt.isolation_test_result           one cross_customer row per module, against the release tip
the enable gate                     reads the LATEST row per module (enable-gate/gate.ts)
```

The file is exactly what `parseIsolationEvidence` accepts
(`packages/tenant-store/src/lifecycle/enable-gate/record.ts`): `produced_by:
verify`, `tree_clean: true`, `release_tip_sha`, a `verify_record` of the suite
`isolation:tenant` with `passed == collected` and no failure, and one result per
module whose `evidence_ref` is `sha256:<hash of that module's vitest report>
<proof kind> <test files>`. A skipped case makes `passed != collected`, so no
case may skip. `packages/tenant-store/test/isolation-evidence-producer.test.ts`
runs the producer's output through the parser, the import and the gate.

## The cases

The backend decides the case: each case exercises the code the pilot runs, not a
leaf that is not deployed. The compose side is pinned in
`scripts/check-app-compose-env.test.mjs`.

| Module | Pilot backend | Proof kind | Test file |
|---|---|---|---|
| calendar | leaf service | `real-pg-leaf`, a throwaway Postgres | `modules/calendar/test/tenant-isolation.integration.test.ts` |
| content | leaf service | `real-pg-leaf` | `modules/content/test/tenant-isolation.integration.test.ts` |
| publishing | leaf service | `real-pg-leaf` | `modules/publishing/test/tenant-isolation.integration.test.ts` |
| votes | in-process | `fake-upstream-app`, a recording fake Nextcloud | `modules/votes/app/lib/server/polls/polls-tenant.test.ts` |
| files | in-process | `fake-upstream-app`, a recording fake WebDAV | `modules/files/app/lib/server/files/tenant-isolation.test.ts` |
| messaging | in-process | `fake-upstream-app`, a recording fake Synapse | `modules/messaging/app/lib/server/messages/tenant-isolation.test.ts`, `matrix-synapse.tenant.test.ts`, `livekit.tenant.test.ts` |
| board | in-process | `real-pg-app`, two real tenant databases on the throwaway Postgres | `modules/board/app/lib/server/board/tenant-isolation.integration.test.ts` |

There is no result for `elections`, `finance`, `vault` or `handover`: a result for
a module that is not enabled would be evidence for code that is not running. The
board is served in-process from the customer's own kernel database; its case
proves that path, not the board leaf (`BOARD_BACKEND=service`, test environment
only), which has its own suite and is not what the pilot runs.

The board case runs the real route handlers (`/api/board`, `/api/board/[id]`,
`.../cards`, `.../promotable`, `.../promote` and the `/tasks` load), the real scope
resolver, the real `getDb()` and the real per-tenant pool registry against two
physically separate databases with the kernel migration chain applied. Nothing
between the handler and the database is mocked; only the Keycloak display-name
lookup is replaced. The fixtures are written and the before/after fingerprints
are read over separate administrative connections, so the proof that B's data did
not change does not depend on the code under test. It covers the board leaf's
vectors 1 to 9 and H in both directions (A on B, then B on A), with positive
controls, plus a scan that no board file opens its own connection. It needs
`ISOLATION_TENANT_PG_URL` like the leaf cases; the runner then states
`GREMION_PRODUCTION_STACK=none` for that case only, after checking the server is
loopback and not port 5432, and derives the harness database URLs from it. The same
file also runs in the shared integration lane, where it uses the server of the
lane's own `DATABASE_URL`.

Every case runs a positive control first (each customer reaches its own data),
then the attempts of customer A against customer B's record. The files case
derives its routes from `modules/files/app/routes/api/files/**` and from every page
load under `modules/files/app/routes/files/**` that reaches Nextcloud (the editor
page), and fails when one has no control or no attempt, or when there is no
attempt at all.

## What a pass means, and what it does not

Honest labelling, because the proof kinds differ:

- `real-pg-leaf`: the leaf's own two-tenant suite against a real Postgres. A
  tenant's data is in a database of its own, and the tenant binding refuses a
  mismatched id and slug.
- `real-pg-app`: the app half's real handlers and database layer run against two
  real tenant databases. This shows that every board statement a customer causes
  reaches that customer's own database and no other, and that the other customer's
  rows are neither readable nor writable from there. It is the same guarantee as
  the kernel's own protocols and members, which share the `getDb()` seam; it says
  nothing about the board leaf and nothing about members of one customer seeing
  each other's boards (that is the within-customer scope, covered by the board's
  own route tests).
- `fake-upstream-app`: the real route handlers and clients run against a
  recording fake of the shared upstream. This shows app-layer scoping against
  ONE shared Nextcloud and ONE shared Synapse: every upstream request a caller
  causes carries that caller's own credentials and stays in that caller's folder
  or rooms, and an administration action on another customer's room is refused
  before any write. It does not exercise Nextcloud's or Synapse's own
  authorisation.

So the evidence supports enabling the modules for a **single-customer install**.
It does not show that a second customer could be added to a running
installation, and it must not be cited for that. A live probe with two real
customers on the running stack is owed and replaces the `fake-upstream-app`
proofs when it exists.

## Running it on the host

After the host build of the pinned commit, with the release tree clean:

```bash
gremion-isolation run                      # prints <root>/data/isolation-evidence/<tip>.json
gremion-isolation record <that file>       # imports it, then reads the rows back
```

The tenant-create one-shot's `gate-status` verb (run through the active colour's
compose project) should then list no unproven enablement.

`run` starts the kernel's own pinned Postgres as `gremion-iso-<tip8>` with no
published port, inside its own network namespace, and joins a toolchain
container (`test/isolation/tenant/Dockerfile`, no repository content) to that
namespace, so nothing else can reach the server. The container takes the release
tree read-only, `git clone`s it (an untracked file such as an in-tree secrets
directory is never copied in), checks the tip out detached, installs with
`--frozen-lockfile` and runs `verify --only isolation:tenant`. Both containers and
the temporary directory are removed on every exit path.

`record` refuses a file that is not stamped by a clean verify run, names another
tip, carries a `scratch-fixture:` reference or does not name exactly the pilot
modules. It asserts the post-condition in the database, not the exit code of the
import: for each module the latest `cross_customer` row, by the gate's ordering,
must be a pass on this tip. Exit codes follow `infra/host/README.md`.

Three things to keep in mind:

1. **A later commit invalidates the pass.** A pass is recorded against a tip. Any
   commit after the run, a docs-only commit included, makes the gate answer
   `ISOLATION_STALE_TIP`. Run it after the host build of the commit you will run.
2. **The stamp is forgeable by hand** until TASK-046 signs it as a release
   attestation (`record.ts`). The producer narrows how a wrong file is made; it
   is not an attestation.
3. **A failing run writes nothing.** The producer writes the file only when the
   part passed on a clean tree at an unmoved HEAD. A failing module is named in
   the output.

## Rehearsing it away from the host

```bash
# a throwaway Postgres on localhost, a port other than 5432 (the leaves' own guard refuses anything else)
ISOLATION_TENANT_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
  node scripts/verify/verify.mjs --only isolation:tenant
```

The suite part is not in `required-suites.txt` (it needs the Postgres); it is
reachable through `--only` only. Before it, the overlay is prepared
(`node gremion-ui/scripts/interim-module-overlay.mjs`, `svelte-kit sync`, the
i18n compile); the output is gitignored, so the tree stays clean.

## Why the cases cannot pass for the wrong reason

`test/isolation/tenant/mutation-proof.sh` breaks the isolation code in a scratch
clone and requires the producer to fail, write no file and name the failing test
of that module: a shared database name, a removed identity binding, a poll scope
that serves any poll, one Matrix client or token cache for every tenant, an
administration route that trusts the room id in the URL, a path guard that lets
`..`, a `..` hidden behind a `?x` or `#x` suffix or a space, a backslash, a control
character or an upload id of `.` through, an editor page that builds its WebDAV
path without the shared guard, a fixed bearer, and one pool serving every customer's
`getDb()` (the board case). A control run on the unmutated clone must first pass and write the
file, and each mutation is committed in the clone, because verify refuses a dirty
tree and an uncommitted mutation would "fail" for that reason alone.
Each mutation names its target line literally, so a refactor of that line would stop
a full pass half way; `mutation-proof.sh --check-targets` (no Postgres, no clone) checks
that every target still occurs exactly once, and
`scripts/check-isolation-mutation-targets.test.mjs` runs it in the unit suite.
`scripts/verify/isolation-tenant.test.mjs` pins the producer's own refusals: a
leaking store, nothing collected, a skipped case, a missing module, a dirty tree
and a HEAD that moves during the run each write no file.
