# NATS wire-root cutover — migrating an existing deployment

> **What this is.** The wire-subject root moved to `gremion`, and the broker
> that ships with it now refuses, at the server, what the old root would have let
> through silently. If you already run a deployment on an older `@gremion/ports`,
> taking this version is therefore not a dependency update: it is a **hard
> cutover of every JetStream stream on every environment**, and the streams have
> to be migrated **before** the new code boots against them. A fresh install has
> nothing to migrate and can skip this page. It lists what changed at the
> interface, and the order of operations. The mechanism — why the server says nothing, what the
> client-side guards are — is in
> [`docs/architecture.md` → "Migrating the wire-subject root"](../architecture.md#migrating-the-wire-subject-root);
> this page does not repeat it.
>
> **Baseline.** The delta below is measured against `c4f7baa`, the kernel commit
> immediately before the rename. If your deployment pins something else, confirm
> what it actually pins before relying on the table — it is a delta, not an
> absolute description of the current interface.

## Why it is a hard cutover

A JetStream stream has one subject filter. Before the migration it captures the
old root; after it, `gremion`. There is no state in which the old code
(publishing and subscribing under the old root) and the new code (under
`gremion`) both work against the same stream:

| Fleet state | Old-code process | New-code process |
|---|---|---|
| Stream still on the old root | works | `ensureStream()` throws refuse-on-drift; `subscribe()` rejects `ready`/`closed` with `StreamCoverError`; `publish()` throws `NoStreamError` |
| Stream repointed to `gremion` | `publish()` gets JetStream's bare "no responders"; `subscribe()` creates a consumer that receives **nothing, silently** (the old class has no cover check) | works |

Every consumer and every producer of a stream therefore moves together, per
stream, with the repoint in between. The leaves that share a stream cannot be
bumped one at a time against a live stream. The kernel's outbox retains events
while the producers are stopped, so the pause loses nothing.

## Interface delta: `c4f7baa` → this commit

### `@gremion/ports/broker` (`packages/ports/src/broker.ts`)

| Symbol | At `c4f7baa` | Now | What you have to do |
|---|---|---|---|
| `SUBJECT_ROOT` | did not exist — the root was a literal in every subject helper and every `STREAMS` filter | `export const SUBJECT_ROOT = 'gremion'`; every helper and filter derives from it | Any literal of the old root **on the wire** (a subject, a stream filter, an AsyncAPI channel address, a test expectation) is now a defect. Kernel-hygiene check `h1` fails this tree on one; a consuming application has no such check — grep for the token followed by a dot. |
| `STREAMS.*.subjects` | `['<old-root>.*.newsletter.>']` and so on | `['gremion.*.newsletter.>']` and so on | This is the filter `ensureStream()` will want the server to hold; see "Order of operations". |
| `BrokerSubscription` | `{ unsubscribe(): void }` | adds `readonly ready: Promise<void>` and `readonly closed: Promise<void>`; the docstring in `broker.ts` is the contract — what resolves, what rejects, and that a cover verdict **outlives** an `unsubscribe()`/`close()` issued during the check | Every **implementation** of `BrokerPort` — a test double, an in-process fake, a copied `InMemoryBroker` — must return both or fail typecheck. Callers may ignore them; a boot path that wants a dead subscription to be fatal awaits `ready`. Read the contract before writing a mock: the `InMemoryBroker` double exhibits **none** of the rejecting cases, so a path that is green against it can still reject against NATS — by design. |
| `StreamCoverError`, `NoStreamError`, `StreamRepointedError`, `StreamGoneError`, `ConsumerGoneError`, `ConsumerStalledError`, `SetupTimeoutError` | did not exist | defined **here**, on the port (re-exported unchanged by `@gremion/ports/nats`) | Match on the class or on `err.name` from the port import alone — no NATS transport is pulled into a mock, a boot path or a jsdom test. |
| `LIVENESS_FAULT_BOUND_MS`, `SETUP_TIMEOUT_MS`, `CLOSE_TIMEOUT_MS` | did not exist | the bounds `NatsBroker` implements (values in `broker.ts`; the real-server proofs import them) | Size a consumer's boot and shutdown timeouts from these constants. Do not restate the numbers: a bound that is pinned in one place and quoted in another is two numbers, and two numbers drift. |
| `InMemoryBroker.subscribe()` | returned `{ unsubscribe }` | returns `{ ready, closed, unsubscribe }` | none |

### `@gremion/ports/nats` (`packages/ports/src/nats-broker.ts`)

| Member | At `c4f7baa` | Now | What you have to do |
|---|---|---|---|
| `ensureStream(name?, subjects?)` | `subjects` defaulted to the NEWSLETTER literal for **every** stream; `streams.update()` moved a live filter without a word; any `streams.info()` error was read as "does not exist" | `ensureStream(name?, subjects?, opts?)`: `subjects` defaults from `STREAMS` for the **bound** stream and an unknown name throws; a filter that differs from the server's **throws** (refuse-on-drift) unless `opts.repointSubjects` is set, and a repoint faults this broker's own live subscriptions; a non-not-found `info()` error is rethrown with its cause | A leaf that passes the subject list explicitly must pass the `gremion` one. A leaf that relied on the default now gets its own domain's filter — the CONTENT/CALENDAR/ORGUNIT streams the old code created carry the **newsletter** filter (step 0 below). |
| `publish()` | published; an uncaptured subject surfaced as JetStream's "no responders" | throws `NoStreamError` (names the subject and the stream) for a subject the server's filter does not capture; the check is answered from a per-broker cache of the server's last answer, re-read before any refusal; one transient publish error is retried once after a re-read | Handlers that matched the "no responders" text should match `NoStreamError`. |
| `subscribe()` | created the consumer unconditionally; a loop that ended resolved silently; `unsubscribe()` flipped a flag the parked loop never re-read | asks the server first — an uncovered pattern rejects `ready`/`closed` with `StreamCoverError` and creates no consumer; each setup round trip is bounded by `SETUP_TIMEOUT_MS` (`SetupTimeoutError`); a live subscription whose stream or consumer is **deleted** rejects `closed` within `LIVENESS_FAULT_BOUND_MS` with `StreamGoneError` / `ConsumerGoneError` (the pull is sized and the consumer's `status()` notifications are consumed, with a server probe on missed heartbeats); one that the server stops heart-beating although both still exist rejects with `ConsumerStalledError`; a closed connection rejects `closed`; every rejection logs one error line; `unsubscribe()` ends the iterator; the cover verdict outlives an `unsubscribe()`/`close()` issued during the check | Await `ready` at boot where a dead subscription must be fatal, and exit non-zero on rejection; log or alert when `closed` rejects — with the class in hand the remedy is known (`StreamGoneError`: recreate the stream; the others: resubscribe). |
| `close()` | drained | stops every subscription first, waits at most `CLOSE_TIMEOUT_MS` for their outcomes (a warning names any still pending), then drains once; concurrent and repeated calls share the one in-flight shutdown; a drain that fails because the connection already closed is tolerated (debug log); any other drain failure rejects **and is forgotten**, so the next `close()` drains again | Teardown code that wrapped `close()` in a catch for the double-close or closed-connection case can drop it; a catch that swallowed a genuine drain failure should log it instead — that rejection is now real and retryable. |
| Exports | `NatsBroker`, `DEFAULT_STREAM` | plus the port errors and bounds above (re-exports from `@gremion/ports/broker`), `EnsureStreamOptions`, `BrokerTimeouts`, and the adapter's own tuning `CONSUME_EXPIRES_MS`, `CONSUME_IDLE_HEARTBEAT_MS`, `STALL_PROBE_LIMIT` | import as needed; prefer the port import for the error classes and bounds |
| Dependencies | `@nats-io/{jetstream,nats-core,transport-node} ^3.4.0` | **unchanged** | `packages/ports/package.json` is byte-identical between the two commits, so your `pnpm-lock.yaml` is not affected by the bump. Prove it before building the image — `pnpm install --frozen-lockfile` in your own checkout with the bumped submodule — because the same command runs inside the image build before the source is copied, and fails there with no credential to recover. |

### Also moved

- `packages/ports/src/subject-match.ts` (new): `subjectMatches`, `filterCovers`,
  `streamCovers` — the one wildcard grammar the cover checks use.
- `contracts/*/asyncapi.*.json`: channel addresses are on the `gremion` root. A
  contract test in your own code that pins the old address fails on the upgrade;
  that is the intended signal, not a test to loosen.
- `packages/ports/scripts/nats-test.sh` and `make test-ports-nats` (new): the
  real-server proof, run from the repo root so it works from Git Bash on
  Windows as well. Your own suites can point `NATS_TEST_URL` at the
  same throwaway server.
- `packages/ports/src/nats-broker.test.ts` (new): pins that the port exports
  the error classes and bounds above — a mock that imports them
  from `@gremion/ports/broker` is covered by name.

## Order of operations — before the bump, per environment

Do this on a staging environment first, in full, and only then on the one that serves users.

0. **Inventory.** For each stream the topology knows — `NEWSLETTER`, `CONTENT`,
   `CALENDAR`, `ORGUNIT` — record the live filter and the message count:
   `nats stream info <NAME> --json | jq '{subjects: .config.subjects, messages: .state.messages}'`.
   Expect the old root everywhere, and expect the non-newsletter streams to
   carry the **newsletter** filter (the old `ensureStream()` default): those
   streams have stored none of their own domain's events, which decides their
   path in step 2.
1. **Prepare your own code** on a branch against the new version and
   get it green **locally** before anything touches a server: implementations
   of `BrokerSubscription` gain `ready`/`closed`; explicit `ensureStream()`
   subject lists move to `gremion`; test expectations and AsyncAPI pins move to
   `gremion`; `pnpm install --frozen-lockfile` passes with the bumped
   submodule. Nothing here is deployable yet.
2. **Migrate each stream** by the procedure in `docs/architecture.md`:
   - zero messages (typical of staging, of every stream that never went live,
     and of the non-newsletter streams found in step 0): `nats stream rm <NAME>`
     — the next boot of the new code recreates it from `STREAMS`;
   - messages present: stop the producers, wait for `nats consumer report
     <NAME>` to show zero pending, then repoint — once, deliberately — either
     through one boot with `{ repointSubjects: true }` or with
     `nats stream edit <NAME> --subjects 'gremion.*.<domain>.>'` (which
     bypasses the client-side guards; nothing running learns of it).
   Do every stream an environment holds in one window: the fleet cannot be
   half migrated (see the table above).
3. **Take the new version and deploy — consumers first, then producers.** A
   consumer created before the repoint is silent for good; only a fresh
   `subscribe()` checks the new filter. Producers last, or they publish into a
   stream nobody reads yet. Read each consumer's log for a `[nats-broker]`
   line: a running process is not evidence of a live subscription. A
   consumer that awaits `ready` and exits non-zero on rejection turns the
   refusal into a restart loop you can see; a subscription that dies later
   (its stream deleted or recreated under it) rejects `closed` within
   `LIVENESS_FAULT_BOUND_MS`, so a consumer that awaits `closed` and exits is
   back on a fresh `subscribe()` — and a fresh cover check — within that
   bound plus its restart time.
4. **Verify against the running system, not the repo.** `nats stream info
   <NAME>` shows the `gremion` filter; `nats sub 'gremion.>'` in one shell while
   a leaf emits one real event; the event arrives at its consumer.

## Rolling back

Rolling the version back after step 2 does not roll the streams back: the old
code against a `gremion`-filtered stream is the silent row of the table above.
A rollback is the same procedure with the filters reversed — stop producers,
drain, repoint to the old root, restart consumers then producers — and the old
code has no client-side guard to tell you when you got it wrong.
