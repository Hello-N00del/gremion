# Dead letters: find, replay, requeue, rebuild

- Implements: TRD-420 (dead-letter and alert), TRD-421 (apply once), TRD-422 (rebuild from the outbox)
- Package: `@gremion/events` (`packages/events`), the `events` CLI
- Proof: `packages/events/scripts/proof.sh` (TASK-079); the commands below are extracted from this file and run
  by `packages/events/test/live/deadletter.live.test.ts`, so a command that drifts from the CLI fails the proof

Every service database holds an outbox (events it must publish) and an inbox (events it has applied). Three
things can go wrong, and each has an alert (the operator's alerting, see [the operations runbook](../ops/runbook/README.md)):

| Alert | What it means | Where to look |
|---|---|---|
| `OutboxDeadLettered` | the relay gave up on an outbox row after its attempt limit (10 attempts, 2 s doubling to 1 h) | the row, `relay_state = 'dead_lettered'`, `last_error_code` |
| `InboxDeadLettered` | a consumer's handler failed every delivery (5, backing off 1 s, 10 s, 60 s, 300 s) and the message went to the tenant's DLQ stream | the DLQ stream, `events dlq-list` |
| `InboxStalled` | an inbox row has stayed `received` or `failed` for over 10 minutes: a consumer crashed on its last delivery, so no dead letter was published by it | the DLQ stream holds the broker's MAX_DELIVERIES advisory for it |
| `DeadLetterQueueNotEmpty` | the tenant's DLQ stream holds any entry | `events dlq-list` |

A dead letter is not lost: the event itself is stored in the DLQ entry (or in its source stream), the outbox
row of the producer still exists, and nothing is deleted until a replay re-delivers it.

**The DLQ stream keeps an entry for 7 days.** After that the entry is gone; the producer's outbox row is the
authoritative copy, so past 7 days the recovery is the outbox replay (step 4), not the DLQ replay.

All commands run on the host, from the release tree (`cd "$REL"`, see [install.md](../ops/runbook/install.md)),
against the colour that is serving. `<slug>` is the tenant slug (the NATS account and subject token),
`<customer>` the customer id (the UUID of the tenant's databases), `<ctx>` the producing service's context
code, `<service>` the compose service that owns the database, `<n>` a DLQ sequence number from step 1.

## 1. Find the dead letters

```bash
docker compose --env-file /opt/gremion/etc/env/app-blue.env run --rm --no-deps --entrypoint pnpm tenant-create exec events dlq-list --tenant <slug>
```

One JSON line per entry: `seq`, `kind` (`consumer`: the consumer published it at its last delivery;
`advisory`: the broker's note that a consumer exhausted its deliveries, kept for a consumer that crashed),
`eventId`, `error` (the handler's error code; no message text), the original subject, stream and consumer.
Fix the cause first (a handler bug, a missing row it needed, a full disk); a replay of an event whose handler
still fails dead-letters it again, as a new entry.

## 2. Replay after the fix

```bash
docker compose --env-file /opt/gremion/etc/env/app-blue.env run --rm --no-deps --entrypoint pnpm tenant-create exec events dlq-replay --tenant <slug> --seq <n>
```

The entry is published again to its original subject (a `consumer` entry from its stored body; an `advisory`
entry by fetching the original from its stream by `stream_seq`) under the message id `<event id>.r<n>`, and is
deleted **only after** the broker has acknowledged the new publish. The consumer's inbox row (`dead_lettered`)
is claimed again and the event ends `processed`. Re-delivering the same event twice is harmless: the inbox keys
on the event id, so a second copy is acknowledged and ignored.

If the aggregate has moved on to a newer version since (a later event of the same aggregate was applied), the
replayed event ends `skipped_stale`: a newer state is never overwritten by an older one. The command's log line
says so.

The replay reads and deletes as the tenant `admin` and republishes as the publisher of the entry's stream (the
admin may not publish stream subjects); both seeds are in the `tenant-create` container's secrets.

## 3. Requeue a dead-lettered outbox row

When the relay (not a consumer) gave up on a row, the producer's database holds it as `dead_lettered` and it
holds back every later event of the same aggregate. After the cause is fixed (the broker was unreachable, the
subject had no stream), run in the owning service's container:

```bash
docker compose --env-file /opt/gremion/etc/env/app-blue.env exec <service> pnpm exec events outbox-requeue --ctx <ctx> --customer <customer> --event-id <event-id>
```

The row goes back to `pending` with its counters cleared and the relay publishes it on its next pass. The
event id is the `event_id` of the outbox row (the alert's label names the context; read the row for the id).
All three gauges (`gremion_outbox_dead_lettered`, `gremion_inbox_dead_lettered`, `gremion_inbox_stalled`)
return to 0 when nothing is left dead-lettered.

## 4. Rebuild after JetStream was lost

The outbox outlives the stream (TRD-422). If the broker's volume was lost or a stream was deleted, recreate
the streams first, then re-publish every published outbox row; each consumer's inbox ignores what it has
already applied, so the replay only completes what was missing.

```bash
docker compose --env-file /opt/gremion/etc/env/app-blue.env run --rm --no-deps --entrypoint pnpm tenant-create exec nats-auth ensure <slug> --modules <modules>
docker compose --env-file /opt/gremion/etc/env/app-blue.env exec <service> pnpm exec events outbox-replay --ctx <ctx> --customer <customer> --tenant <slug> --identity <identity> --subjects <subjects-file>
```

`<modules>` is the tenant's real enabled module list (`ensure` is declarative: an incomplete list removes the
omitted modules' keys). `<identity>` is the NATS identity the service publishes as (`kernel` for the kernel's
services, the module's name otherwise). `<subjects-file>` is the service's event-type to subject map (shipped
with the service). Add `--since <ISO date>` to re-publish only what was published after that instant. The replay needs
the `published` rows to still exist: the purge keeps them at least as long as the stream's retention plus its
de-duplication window (7 days and 2 minutes).
