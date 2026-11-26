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
| board | the router: in-process for a customer located `kernel`, the board service for a customer located `module` | `real-pg-app`, three real customers (one `kernel`, two `module`) and the real board service on the throwaway Postgres | `modules/board/app/lib/server/board/tenant-isolation.integration.test.ts` |

There is no result for `elections`, `finance`, `vault` or `handover`: a result for
a module that is not enabled would be evidence for code that is not running. The
board is served by the router (`getBoardBackend()` in its default `auto` mode),
which reads the customer's location flag per call: a customer whose board has not
moved is served in-process from its own kernel database, a customer whose board
lives in the board module's own database (`t_<hex32>__board`) is served by the
board service. The case proves both paths in one run, so the evidence is for the
code that serves a customer after a move as well as before it. The board
service's own two-tenant suite (`modules/board/test/isolation*`) is not what the
producer records, and no required gate runs it: it is run by hand with
`pnpm --filter board-service test:integration` against a throwaway Postgres
(`BOARD_TEST_PG_URL`). It proves the same vectors at the service's own routes and
adds three: the erasure of one person who holds cards in two tenants, the delete of
an org unit's boards that both tenants have boards on, and the block of one
tenant's database (the module's app role loses `CONNECT`), which must leave the
other tenant served. The first two are also in the recorded case, made through the
kernel's own erasure hook and org-unit cleanup (see below); the block is not,
because the recorded case's board service connects as the server's administrative
role, for which a revoked `CONNECT` has no effect.

The board case runs the real route handlers (`/api/board`, `/api/board/[id]`,
`.../cards`, `.../promotable`, `.../promote` and the `/tasks` load), the real scope
resolver, the real router, the real `getDb()` and the real per-tenant pool registry
against three customers with physically separate kernel databases (the kernel
migration chain applied to each): customer A is located `kernel` and holds its
board rows in its kernel database; customers B and C are located `module`, hold no
board rows in their kernel databases, and are served by the real board service
(its own factory, listening on loopback) from a module database each, migrated by
the module's own runner. Nothing between the handler and the database is mocked;
only the Keycloak display-name lookup is replaced. The fixtures are written and
the before/after fingerprints are read over separate administrative connections
(the kernel database and, for B and C, the module database), so the proof that
another customer's data did not change does not depend on the code under test.
It covers the board service's vectors 1 to 9 and H for every ordered pair of the
three customers (so the two customers that share the board service are judged
against each other as well), with positive controls (including that a module
customer is answered over HTTP by the board service and a kernel customer is
not), plus the two calls the kernel itself makes into the board: the erasure of a
person (the board's erasure hook) and the removal of an org unit's boards. Each is
made as every customer for every other customer's person and org unit (nothing
anywhere may change) and then for the customer's own (the change lands in the
store the flag names and in no other, a kernel customer making no call to the board
service). The case also scans that no board file opens its own connection. It needs
`ISOLATION_TENANT_PG_URL` like the leaf cases; the runner then states
`GREMION_PRODUCTION_STACK=none` for that case only, after checking the server is
loopback and not port 5432, and derives the harness database URLs from it. The same
file also runs in the shared integration lane, where it uses the server of the
lane's own `DATABASE_URL`.

Every case runs a positive control first (each customer reaches its own data),
then the attempts of customer A against customer B's record (the board case, in
every direction for every pair of its customers). The files case
derives its routes from `modules/files/app/routes/api/files/**` and from every page
load under `modules/files/app/routes/files/**` that reaches Nextcloud (the editor
page), and fails when one has no control or no attempt, or when there is no
attempt at all.

## What a pass means, and what it does not

Honest labelling, because the proof kinds differ:

- `real-pg-leaf`: the leaf's own two-tenant suite against a real Postgres. A
  tenant's data is in a database of its own, and the tenant binding refuses a
  mismatched id and slug.
- `real-pg-app`: the app half's real handlers, router and database layer run against
  real tenant databases and, for a customer located `module`, the real board
  service. This shows that every board statement a customer causes reaches that
  customer's own database (its kernel database or its module database, as its
  flag says) and no other, and that another customer's rows are neither readable
  nor writable from there. It says nothing about members of one customer seeing
  each other's boards (that is the within-customer scope, covered by the board's
  own route tests). A kernel copy that a move leaves behind is not represented: the
  `module` customers of the case start with no board rows in their kernel
  databases.
- `fake-upstream-app`: the real route handlers and clients run against a
  recording fake of the shared upstream. This shows app-layer scoping against
  ONE shared Nextcloud and ONE shared Synapse: every upstream request a caller
  causes carries that caller's own credentials and stays in that caller's folder
  or rooms, and an administration action on another customer's room is refused
  before any write. It does not exercise Nextcloud's or Synapse's own
  authorisation.

So the recorded evidence supports enabling the modules for a **single-customer
install**. It does not show that a second customer could be added to a running
installation, and it must not be cited for that. Two things sit beside it for the
second customer, and neither feeds the enable gate:

- the messaging case file (`tenant-isolation.test.ts`) also runs two customers
  on ONE shared homeserver in the namespaced identity (`MATRIX_IDENTITY`), still
  against the recording fake Synapse: the same unit name and the same username in
  both customers give two rooms and two accounts, a room found behind an alias is
  adopted only with the customer's own marker, room administration derives the
  same aliases provisioning gave, meeting rooms and Karenz are per customer, and a
  token of one customer is refused in the other's scope;
- `gremion-isolation-live`, the probe of the RUNNING stack below. It does not
  replace the `fake-upstream-app` proofs and is not a gate input: it is a report
  an operator reads, and a host run of it on the install that uses a second
  customer is still owed. Nothing in this repository records one.

## The live probe: two customers on the running stack

```bash
gremion-isolation-live <slugA> <slugB> [--unit NAME] [--user NAME]
```

Run on the host, after both customers are created and wired and the operator has
made the fixture (an org unit `isoprobe` with its chat room and files folder, a
member whose name starts with `isoprobe`, a file `isoprobe-<slug>.odt` in the
folder, a poll and a calendar event titled `isoprobe-<slug>`; the header of
`infra/host/bin/gremion-isolation-live` has the full list). It acts as that one
fixture user in both realms, through the public edge and the in-network
services, in both directions. It sets a password on the fixture user and creates
a temporary direct-grant client per realm, and deletes the clients on every exit
path; no secret is on an argv. It writes nothing into the other customer: a
refused write cannot be told from a successful one without trying it, so writes
are not attempted.

Every denial needs a positive control on the customer's own resource first (a 2xx
on its own room, folder, file, poll, event or token), else the section is FAIL.
A refusal is the exact code named below; an error (5xx), a 401 or no answer is not
a refusal.

| Section | A PASS shows | It does not show |
|---|---|---|
| chat | the same unit name gives different room ids and the same username different Matrix user ids in the two customers (what the namespaced identity gives; the legacy identity would not); A's Matrix token reads A's room and is refused (403) on B's room messages and on a send into it | message delivery between members; Synapse's behaviour for rooms other than the fixture unit's |
| files | each customer's unit folder has its own group-folder id (read with `occ` through the fixture user's groups, never by the mount name, which is the unit name in both) and is the only folder of that name in that user's groups; A's own folder lists and serves A's file; A's bearer on B's user root and the app API for B's file answer 403 or 404 | other units, groups the fixture user is not in, writes; the WebDAV refusal alone proves user-root isolation only, which Nextcloud gives whether or not a folder is shared |
| office | the own editor URL is on the customer's own host; the editor URL for the other customer's file is refused (403 or 404, no URL); it passes only on a release that maps a missing document to 404 and a refused one to 403 (a 500 or 502 reads as FAIL) | save and close of the editor: they stay unproven until a person opens a document of each customer by hand on its own host |
| calendar | own event 200; the other customer's event id on A's host 404 and not in A's listing | the CalDAV mirror in the shared Nextcloud |
| polls | own poll 200; the other customer's poll id on A's host 404 and not in A's listing | Nextcloud's own authorisation: the scoping is the app's title marker |
| call | a LiveKit token for the other customer's room is refused (403); for the own room it is minted and the room name starts with the customer's namespace | media paths, the TURN relay, anything past the token |
| cross-host | A's token on B's host answers 401 (the same route on A's host answers 200) | any other credential type |

**Verdicts.** Per section PASS, FAIL, NOT-READY or NOT-ENABLED. A FAIL is a
finding and outranks the rest. NOT-READY means a fixture part or a token or host
precondition is missing (for example the fixture user has no Nextcloud account
under the id the probe looks it up by, which is the Keycloak subject; a secondary
customer whose accounts carry derived ids is expected to read NOT-READY here, see
"Nextcloud account addressing" in [pilot-services.md](pilot-services.md)).
NOT-ENABLED means the section's module is off for a customer, a route takes no
Bearer on this release, or the Matrix client API is not reachable through the edge.
**NOT-ENABLED and NOT-READY are not a pass**: nothing was probed for that
section, and the run exits 3, not 0. A pair of customers of which one has no chat
reads NOT-ENABLED for chat and call by design. Exit codes: 0 every section PASS;
1 any FAIL; 2 usage; 3 any NOT-ENABLED or NOT-READY, a stop before the verdict
(`RESULT: ABORTED`), or an all-PASS run whose temporary client could not be
confirmed deleted (`RESULT: CLEANUP-FAILED`: delete it by hand); 130 or 143 when
stopped by a signal. Keep the output next to the host run.

**Shims versus a host run.** `test/host/isolation-live.bats` runs the program
against `test/host/fixtures/isolation-live/fake-stack.sh`, shell shims for
`docker` and `curl` that play a two-customer stack from the URL, the token and
switch files. It proves the program's own logic: each section's decision on
scripted answers, the exit codes, the NOT-ENABLED and NOT-READY paths, the
clean-up trap, that no secret reaches an argv. It proves nothing about Keycloak,
Nextcloud, Synapse, LiveKit or the edge, and a green bats run is not isolation
evidence. Only a run on the host reads the running system, and that run is
owed.

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
