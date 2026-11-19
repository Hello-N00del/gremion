# CD proof run sheet

What this is: the steps that prove, on a real host with one placeholder customer and before
the real customer exists, that continuous deployment does what it says. Every step has the
exact command and a "Passed when" block of checks you read off the RUNNING system
(`docker inspect`, `jq` on `state.json`, `curl`, `stat`), never off a config file. The result
proves the mechanism, not the production numbers.

Rules for the whole run:

- Placeholder data only. Nothing of a real customer is read, copied or pasted here. The
  placeholder's slug and host name live in two shell variables (`SLUG`, `CUSTOMER_HOST`) that
  you set by hand in your own terminal; this file never names a real one (it uses example.org).
- One person, one terminal, as the deploy user, on the host. Run the blocks in order.
- Any step whose "Passed when" check fails: stop, note the command and the output, do not
  continue to the next scenario.
- A command that is refused as an unknown verb or flag: stop and report that. Do not improvise.

## 0. Before you start

Shell variables used by every block (set them once per terminal):

```
ROOT="${GREMION_ROOT:-/opt/gremion}"
ST="$ROOT/data/cd/state.json"
BL="$ROOT/data/cd/blocked.json"
HIST="$ROOT/data/cd/history.jsonl"
STACK="$(sed -n 's/^STACK=//p' "$ROOT/etc/env/state.env")"
DUMPDIR="$(sed -n 's/^GREMION_MIGRATION_DUMP_DIR=//p' "$ROOT/etc/env/state.env")"
PROOF="$ROOT/data/cd-proof/proof.git"
SLUG='<placeholder slug>'
CUSTOMER_HOST='<placeholder customer host>'
cid() { docker ps -q --filter "label=com.docker.compose.project=${STACK}-$1" --filter "label=com.docker.compose.service=$2"; }
other() { [ "$1" = blue ] && echo green || echo blue; }
active() { cat "$ROOT/runtime/active-colour"; }
secs() { date -u -d "$1" +%s; }
```

Preconditions, each read off the system:

```
gremion-cd status
jq -r '.phase, (.hold // "none" | tostring)' "$ST"
```

Passed when: `status` exits 0 and prints no PROOF MODE banner yet; `phase` is `idle` and the
hold is `none`; the live release is the one the host runs (`readlink "$ROOT/current"` ends in
the live short SHA of `jq -r .live.sha12 "$ST"`); `jq -r '.live.proof' "$ST"` prints `false`.

Make the proof commits from the live commit (three branches, one commit each, on top of it):

```
bash "$ROOT/current/scripts/cd-proof/make-proof-commits.sh" "$(jq -r .live.sha "$ST")" \
    --repo "$ROOT/data/cd/mirror.git" --out "$PROOF"
```

Passed when: it prints three `proof-...` lines and `CD_PROOF_REPO=<path>`, exits 0; and
`git -C "$PROOF" for-each-ref --format='%(refname:short)' refs/heads | sort` prints exactly
`proof-5xx`, `proof-readiness-fail`, `proof-window-fail`.

Turn proof mode on in `etc/cd.env` (edit by hand; the keys already exist in the file). The
repository value is the `--out` path above, written out (here for the default root):

```
CD_PROOF_MODE=1
CD_PROOF_REPO=/opt/gremion/data/cd-proof/proof.git
CD_WATCH_MINUTES=6
```

Passed when: `gremion-cd status` exits 0 (an exit 2 that names `CD_PROOF_REPO` means the
program does not accept a local path there yet: stop, the proof cannot start), its FIRST line
is the PROOF MODE banner, and it lists `CD_PROOF_MODE`, `CD_PROOF_REPO` and `CD_WATCH_MINUTES`
by name as non-default keys (the value of `CD_PROOF_REPO` is shown as `set`).

## 1. Setup checks and owed measurements

Do these once, before scenario 1. Write each result on paper; none of them is a file in the
repository.

The access log fields in the edge container (the scenarios below read them):

```
EDGE="$(cid state traefik)"
docker exec "$EDGE" tail -n 1 /logs/access.log | jq -r 'keys[]'
```

Passed when: the keys include `ServiceName`, `entryPointName`, `DownstreamStatus` and
`StartUTC`. If one is missing, adapt the `jq` filters of scenarios 1 and 2 to the real names
before you use them.

The host verification on a host-build install:

```
gremion-verify
echo "exit=$?"
```

Passed when: exit 0.

The build and the snapshot, measured (bytes, seconds, load). The build is read from the
history lines of scenario 1 (`stage_begin` and `stage_ok` of stage `build`, `jq` on `$HIST`).
The snapshot of the main database server and of EACH running module server, one at a time, so
the module part is timed on its own (a `take` runs about six `docker exec` calls):

```
time gremion-migration-dump take --release proof-measure --db gremion
stat -c '%s' "$DUMPDIR"/proof-measure/*
gremion-migration-dump discard --release proof-measure --reason "proof measurement, nothing to keep"
# a module server (repeat for each running one; the role is the module's own name):
time gremion-migration-dump take --release proof-measure --db <module database> \
    --pg-service <module>-postgres --pg-user <module>
gremion-migration-dump discard --release proof-measure --reason "proof measurement, nothing to keep"
```

Passed when: every `take` exits 0, `stat` shows a non-zero size, the dump is gone after the
`discard`, and the journal lines of `journalctl -t premigration-dump --since "-10 min"` for the
module server say `svc=` and no database name. Note bytes, seconds and `uptime` load for each.

One dump restored into a scratch database, timed:

```
gremion-migration-dump take --release proof-restore --db gremion
time gremion-migration-dump restore --release proof-restore --db gremion --accept-loss-since "$(date -u +%FT%TZ)"
gremion-migration-dump discard --release proof-restore --reason "proof measurement, nothing to keep"
```

Run this only against the placeholder installation; the restore replaces the live `gremion`
database with its own dump taken seconds earlier. Passed when: both exit 0 and the
placeholder customer's portal page still answers
`curl -s -o /dev/null -w '%{http_code}\n' "https://${CUSTOMER_HOST}/healthz"` with `200`.

The databases of the main server and of each running module server, compared with the dump
rule (the main server except the login server's database and `postgres`; the module servers
are named, not listed). Output stays on the terminal:

```
PG="$(cid state postgres)"
docker exec "$PG" psql -U "$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/etc/env/state.env")" -Atc \
    "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1"
docker exec "$(cid state <module>-postgres)" psql -U <module> -Atc \
    "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1"
```

Passed when: every database name of the main server is one the dump rule takes or names as
left out, and every module database is one the module step reaches (or is a leaf database).

One commit built twice, the image IDs compared (equal IDs are fine; record the answer):

```
docker image inspect --format '{{.Id}}' "$(docker inspect --format '{{.Config.Image}}' "$(cid "app-$(active)" gremion-ui)")"
```

Read it for the image of the live colour, then build the same commit a second time
(`docker compose --env-file "$ROOT/etc/env/app-$(other "$(active)").env" build --no-cache gremion-ui`,
run from the release tree of that commit) and read the new image's ID the same way.

The next elapse of the backup, purge and Karenz timers against the lock span:

```
systemctl list-timers --all | grep -E 'backup|purge|karenz'
gremion-cd status
```

Passed when: `status` shows the lock span ending before the next backup and purge elapse, and
you have written the next Karenz elapse down.

The anonymous portal request that the compatibility probe uses, and the readiness answer, both
from INSIDE the containers (the secret is read there and never typed):

```
COLOUR="$(active)"
PGU="$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/etc/env/state.env")"
XACT='SELECT xact_commit FROM pg_stat_database WHERE datname = $$gremion$$'
docker exec "$PG" psql -U "$PGU" -Atc "$XACT"
docker exec "$(cid "app-$COLOUR" gremion-public)" node -e \
 'require("http").get({host:"127.0.0.1",port:3000,path:process.argv[1]},r=>{console.log(r.statusCode);r.resume()})' \
 "$(sed -n 's/^PUBLIC_BASE_PATH=//p' "$ROOT/etc/env/state.env")/protokolle"
sleep 2
docker exec "$PG" psql -U "$PGU" -Atc "$XACT"
docker exec "$(cid "app-$COLOUR" gremion-ui)" node -e \
 'const s=process.env.INTERNAL_PUSH_SECRET||"";require("http").get({host:"127.0.0.1",port:3000,path:"/readyz",headers:{authorization:"Bearer "+s}},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log(r.statusCode,b))})'
```

Passed when: the portal request prints a status below 500 and the transaction count of the
main `gremion` database is higher after it than before (the page really reads that
database); the readiness request prints `200` and a JSON body with `ready`
`true`, `colour` equal to `$COLOUR`, a `release` and `tenants` counts. It is also expected that
`curl -s "https://${CUSTOMER_HOST}/readyz"` prints exactly `{"ready":true}` and nothing else.

One customer reconcile, timed, with its access-record row read back:

```
time gremion-tenant reconcile "$SLUG" --apply --reason "proof measurement of one reconcile"
docker exec "$PG" psql -U "$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/etc/env/state.env")" -d gremion_platform -Atc \
    "SELECT origin, actor, action, why FROM oac.access_record WHERE customer_slug = '${SLUG}' AND action = 'host_reconcile' ORDER BY at DESC LIMIT 1"
```

Passed when: the reconcile exits 0 and the row exists with origin `host`, the actor equal to
`id -un` of the deploy user, and the fixed reason text. Note the seconds and the login
server's load.

One module step against a scratch module server, timed, and one `take` with `--pg-service`
and `--pg-user` on a running module server with its restore into a scratch database: run the
`module-upgrade --all` verb of the tenant-create one-shot of the live colour only against a
scratch module server (never against the placeholder's own), then repeat the module `take` of
the measurement above followed by `restore` into the scratch database. Note seconds. Passed
when: the verb's one JSON line shows `failed` equal to `0`, and the restore exits 0.

That kill by label ends a container a killed client left behind, and that a profile-gated leaf
service can be run without `--profile`:

```
cd "$ROOT/current"
ENVF="$ROOT/etc/env/app-$(active).env"
docker compose --env-file "$ENVF" run --rm --no-deps --entrypoint true calendar-service; echo "run-exit=$?"
U="$(cat /proc/sys/kernel/random/uuid)"
timeout -s KILL 8 docker compose --env-file "$ENVF" run --rm --no-deps --label "gremion.request=$U" \
    --entrypoint sleep calendar-service 300; echo "client-exit=$?"
docker ps -q --filter "label=gremion.request=$U" | wc -l
docker ps -q --filter "label=gremion.request=$U" | xargs -r docker kill
sleep 1; docker ps -q --filter "label=gremion.request=$U" | wc -l
sleep 1; docker ps -aq --filter "label=gremion.request=$U" | wc -l
```

Passed when: the first run exits 0 (the profile is on without `--profile`); `client-exit` is
non-zero (the client was killed); the first count is `1` (the container outlived its
client); after the kill both later counts are `0`.

The leaf scheduler is on in the running containers, and a leaf database of the placeholder is
migrated about 30 seconds after the `start` of a new colour: read the first scheduler tick in
the leaf container's log (find the line first; none is assumed here), and take the schema
fingerprint of the leaf database before and after:

```
docker exec "$(cid state calendar-postgres)" pg_dump -U calendar --schema-only -d <leaf database> | sha256sum
docker logs --since 2m "$(cid "app-$(active)" calendar-service)" 2>&1 | head -50
```

Passed when: the log shows the tick within about 30 seconds of the container's
`docker inspect --format '{{.State.StartedAt}}'` and the fingerprint is the same before and
after.

The journal never carries a module database name after `take`, reuse, `switched` and
`restore`:

```
journalctl -t premigration-dump --since "-60 min" | grep -cF -f <(docker exec "$(cid state <module>-postgres)" psql -U <module> -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate")
```

Passed when: it prints `0`.

The database ACL is put back by a restore of a gate database (PUBLIC and the app role, before
and after):

```
Q="SELECT datacl::text, has_database_privilege('<app role>', datname, 'CONNECT') FROM pg_database WHERE datname = '<gate database>'"
docker exec "$(cid state <module>-postgres)" psql -U <module> -Atc "$Q"
# take, restore (as in the measurement above), then the same query again
```

Passed when: both answers are identical: no entry starting with `=` (PUBLIC) before or after,
and the app role's CONNECT is `t` before and after.

One Karenz restore on the old colour after a module-step rollback is owed once a real module
release exists (scenario 4): then run the restore of a blocked database from the old colour
and write down whether it fails as the document says it does.

## 2. Scenario 1 - a release that fails readiness

The proof commit boots, answers `/healthz` 200, and answers `/readyz` 503 for ever.

```
FROM_COLOUR="$(active)"; TO_COLOUR="$(other "$FROM_COLOUR")"
BEFORE="$(sha256sum "$ROOT/etc/edge/active.yml" "$ROOT/runtime/active-colour")"
T0="$(date -u +%FT%TZ)"
SHA="$(git -C "$PROOF" rev-parse proof-readiness-fail)"
gremion-cd release-now "${SHA:0:12}" --ref proof-readiness-fail --unverified
echo "exit=$?"
```

Passed when (every line):

```
# the build ended ok
jq -r --arg t "$T0" 'select(.at >= $t and .stage == "build") | .event' "$HIST"
# the dump set exists before the first container of the new colour started
jq -r --arg t "$T0" 'select(.event == "created" and .at >= $t) | .at' "$DUMPDIR/ledger.jsonl" | head -1
jq -r --arg t "$T0" 'select(.at >= $t and .stage == "start" and .event == "stage_begin") | .at' "$HIST" | head -1
# the gate failed with readiness_failed, the commit is blocked, the hold is set
jq -r --arg s "$SHA" '.[] | select(.sha == $s) | .rule' "$BL"
jq -r '.hold.kind' "$ST"
# the serving colour and the edge file are byte-identical
[ "$BEFORE" = "$(sha256sum "$ROOT/etc/edge/active.yml" "$ROOT/runtime/active-colour")" ] && echo identical
# no public request reached the new colour's route while it was being tried
docker exec "$EDGE" cat /logs/access.log | jq -r --arg t "$T0" \
    'select(.StartUTC >= $t and .ServiceName == "app-next@file" and .entryPointName != "internaltest") | .DownstreamStatus' | wc -l
# the new colour is stopped
docker ps -q --filter "label=com.docker.compose.project=${STACK}-app-${TO_COLOUR}" | wc -l
docker inspect --format '{{.State.Running}}' "$(cid "app-${FROM_COLOUR}" gremion-ui)"
# the old release is still the live one
jq -r '.live.colour, .live.sha12' "$ST"
```

The `created` time is earlier than the `start` stage time; the stage `build` ended `stage_ok`;
the rule is `readiness_failed`; `hold.kind` is `blocked`; `identical` is printed; the access
count is `0`; the second last count is `0`; the serving container's `Running` is `true`; the
live colour and SHA are unchanged. Also:

- The `rejected` mail arrives at the operator address, and no personal data is in it. The
  copies on the host hold none either: `grep -rlF -e "$SLUG" -e "$CUSTOMER_HOST" "$ROOT/data/cd" "$ROOT/runtime/cd"`
  prints nothing.
- A second `gremion-cd release-now "${SHA:0:12}" --ref proof-readiness-fail --unverified`
  is refused (non-zero exit, a message naming the block).
- The dump set is still live (`gremion-migration-dump status --release "pilot-${SHA:0:12}"`
  lists it) and a plain `gremion-cd resume` is refused (non-zero) until
  `gremion-cd resume --discard-dump --reason "proof scenario 1"` is given.

Then clear the proof block so the next scenario can start:
`gremion-cd resume --discard-dump --accept-descendants --reason "proof scenario 1 over"`.

## 3. Scenario 2a - a release that passes readiness and fails in the window

The proof commit makes `/readyz` flip to 503 when `/tmp/cd-proof-fail` exists in the container.

```
FROM_COLOUR="$(active)"; TO_COLOUR="$(other "$FROM_COLOUR")"
SHA="$(git -C "$PROOF" rev-parse proof-window-fail)"
gremion-cd release-now "${SHA:0:12}" --ref proof-window-fail --unverified
```

When `gremion-cd status` shows the release in its watch (the switch is done and the active
colour is the new one), create the flag inside the new colour's gremion-ui:

```
T1="$(date -u +%FT%TZ)"
docker exec "$(cid "app-${TO_COLOUR}" gremion-ui)" touch /tmp/cd-proof-fail
```

Passed when:

```
# the active colour is the old one again
[ "$(active)" = "$FROM_COLOUR" ] && echo old-colour-serves
# the switch back took at most three samples (about 45 seconds), measured in the history
jq -r --arg t "$T1" 'select(.at >= $t) | [.at, .event] | @tsv' "$HIST"
# the old colour is confirmed for all three services, the new colour project is stopped
curl -s "https://${CUSTOMER_HOST}/healthz" | jq -r .colour
docker ps -q --filter "label=com.docker.compose.project=${STACK}-app-${TO_COLOUR}" | wc -l
# blocked with watch_readiness, and the live release never moved
jq -r --arg s "$SHA" '.[] | select(.sha == $s) | .rule' "$BL"
jq -r '.live.sha12' "$ST"
```

`old-colour-serves` is printed; the first rollback line in the history is at most 60 seconds
after `$T1` (`secs`); `healthz` names `$FROM_COLOUR`; the new project count is `0`; the rule is
`watch_readiness`; the live SHA is the one from before. The `rolled_back` mail arrives. Then
clear the block as at the end of scenario 1.

## 4. Scenario 2b - a 5xx spike

A second proof commit makes one public page answer 500 while the flag file exists, and leaves
`/readyz` ready.

```
SHA="$(git -C "$PROOF" rev-parse proof-5xx)"
gremion-cd release-now "${SHA:0:12}" --ref proof-5xx --unverified
```

When the release is in its watch, create the flag in the new colour and send the one bounded
burst (40 requests over 20 seconds from this one process; it refuses a second run within 10
minutes; the host is an argument, never a default):

```
docker exec "$(cid "app-$(other "$(jq -r .live.colour "$ST")")" gremion-ui)" touch /tmp/cd-proof-fail
bash "$ROOT/current/scripts/cd-proof/spike.sh" "$CUSTOMER_HOST"
```

Passed when:

```
jq -r --arg s "$SHA" '.[] | select(.sha == $s) | .rule' "$BL"
curl -s "https://${CUSTOMER_HOST}/readyz"
```

The spike prints `sent=40` and a `5xx` count near 40; the rule is `watch_5xx`; the public
`/readyz` answers `{"ready":true}` all along; the counts in the `rolled_back` mail match the
`5xx` count the spike printed (within the window it saw). Then clear the block.

## 5. Scenario 3 - a good release with a migration (a real merged change)

Not proof mode: proof mode is off for this one (`CD_PROOF_MODE=0`, status shows no banner).
It needs the next real merged pull request that adds a file to a chain that CD applies
(`control`, `kernel-data` or `kernel-api`). Wait for it; do not invent one.

Passed when:

```
# picked up by itself after the checks on main finished (no release-now was typed)
jq -r '.poll.verdict, .poll.tip12' "$ST"
# the dump set exists before the migration ran
jq -r '.at' "$DUMPDIR/ledger.jsonl" | tail -3
jq -r 'select(.event == "stage_begin" and .stage == "migrate") | .at' "$HIST" | tail -1
# at the commit point current, current-tag and previous-tag move; the old colour stops
readlink "$ROOT/current"; cat "$ROOT/runtime/current-tag" "$ROOT/runtime/previous-tag"
# the dump set is deleted, with a ledger line
jq -r 'select(.event == "deleted") | [.at, .reason] | @tsv' "$DUMPDIR/ledger.jsonl" | tail -3
```

The dump `created` time is before the `migrate` stage time of the same release; `current`
names the new tree and the two tag files are the new and the old tag; the `deleted` line is
after the commit; the `released` mail arrives. A change that is only a stored-row fix still
proves the automatic path; the first additive file proves the additive case.

## 6. Scenario 4 - the module step

Needs a real merged change with a new file in a module chain whose class is applied by the
module step. The proof does not invent one (a migration file is permanent, and proof mode
refuses migrations). Until one exists the step is proven by the unit tests and the first real
file is watched by hand: say so in the result. When one exists:

```
jq -c '.live.modules' "$ST"
jq -r 'select(.event == "created" and .pg_service != null) | .at' "$DUMPDIR/ledger.jsonl" | tail -5
jq -r 'select(.event == "stage_begin" and .stage == "migrate") | .at' "$HIST" | tail -1
```

Passed when: the module part of the dump set (the lines that carry `pg_service`) is in the
ledger before the `migrate` stage began; the JSON line shows `failed` equal to `0` and
`files_applied` at least `1`; the old colour served all through it (the `/healthz` colour on
the customer host did not change before the switch); and the new file is in the migration
ledger of one gate database with its phase and the release label (read that table as the
module's owner role; take its name from the chain runner's README).

## 7. Scenario 5 - reconcile after a good release

Scenario 3's release, or any other that commits.

```
jq -c '.live.reconcile' "$ST"
docker exec "$PG" psql -U "$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/etc/env/state.env")" -d gremion_platform -Atc \
    "SELECT count(*) FROM oac.access_record WHERE customer_slug = '${SLUG}' AND action = 'host_reconcile' AND at >= '${T0:-1970-01-01}'"
grep -rlF -e "$SLUG" -e "$CUSTOMER_HOST" "$ROOT/data/cd" "$ROOT/runtime/cd"
journalctl -u 'gremion-cd*' --since "-2 hours" | grep -cF -e "$SLUG"
```

Set `T0` to the time just before the release (`T0="$(date -u +%FT%TZ)"`). Passed when: the
stage ran after the commit point under the cd lock; `live.reconcile` shows `total` `1` and `ok`
`1`; the placeholder has one new `host_reconcile` row (origin `host`, the actor the deploy
user); the `reconciled` mail arrived with counts only; the `grep -rlF` prints nothing and the
journal count is `0`. That the host lock is taken only while a child ran: while the stage
runs, a competing `flock -n "$ROOT/runtime/hostd.lock" true` succeeds in the gap between two
customers (with one customer, in the seconds after the child).

## 8. Scenario 5b - a reconcile that fails

Make the placeholder's realm unreconcilable for the stage: stop the login server for the
duration (`docker stop "$(cid state keycloak)"`), run `gremion-cd reconcile`, and start it
again afterwards.

Passed when:

```
jq -r '.hold.kind, .live.sha12' "$ST"
jq -c '.live.reconcile' "$ST"
jq length "$BL"
```

The release stays committed (the live SHA is the same, the block list length is unchanged);
the hold is `reconcile_failed`; one `reconcile_failed` mail with counts arrived; no new
release starts; after the login server is back, `gremion-cd reconcile` exits 0 and
`jq -r '.hold' "$ST"` prints `null`.

## 9. Scenario 5c - a canary that fails

Make the login page of the probe host answer 500 for the stage: stop the login server for
the stage, or point `CD_PROBE_HOST` at a host that fails, then run `gremion-cd reconcile`.

Passed when: the stage stops after the canary with the reason `canary`, the rest of the
customers show as skipped, the release stays committed (`jq -r '.live.sha12' "$ST"` and
`jq length "$BL"` unchanged), the hold is `reconcile_failed`, the mail names
`gremion-cd rollback`, and nothing rolled back by itself (`readlink "$ROOT/current"` is the
same tree as before). Put the setting back afterwards.

## 10. Scenario 6 - the leaf step

On a host with the calendar, content and newsletter services running and one placeholder
customer with data in each.

Before the release, take the leaf databases' schema fingerprints (as in section 1). Run a
release with a trivial change through the normal path, then:

```
jq -c '.live.leaves' "$ST"
jq -r 'select(.event == "created") | .at' "$DUMPDIR/ledger.jsonl" | tail -5
```

Passed when: the dump set holds the leaf databases of the release label before the leaf entry
ran; the line shows the placeholder customer migrated and `failed` equal to `0`; the leaf
scheduler's first tick after `start` changes no schema (fingerprint before equals after); the
old colour served throughout; `grep -rlF "$SLUG" "$ROOT/data/cd" "$ROOT/runtime/cd"` prints
nothing.

A second pass with a leaf migration file that raises SQL (a scratch image on the host, never
merged): the release stops before the switch, the commit is blocked with `migrate_failed`
and the detail `leaf_migrate`, the old colour is untouched (`active` unchanged, the serving
container still `Running`), and the dump set is live (`gremion-migration-dump status`).

## 11. Scenario 7 - the enable catch-up

First the user-id facts, recorded:

```
docker run --rm --entrypoint id "$(docker inspect --format '{{.Config.Image}}' "$(cid "app-$(active)" gremion-ui)")"
stat -c '%u %g %a' "$DUMPDIR"
id -u
```

On the placeholder customer: switch a gate-database module off, build a release with a
scratch chain file (scratch tree only), run it (the module step skips the blocked database,
counted by state), then switch the module on. Passed when: during the apply the dump of that
one database exists (read the ledger while a long file runs, or stop the apply at the file
with a test hook), and, AS THE DEPLOY USER on the host:

```
gremion-migration-dump status --release "$(jq -r '.live.tag' "$ST")"
sha256sum "$DUMPDIR"/*/<dump file>
```

lists it and its sha256 matches the ledger line; the file is applied; the database is
unblocked; the dump is retired; the next `take` of a release label succeeds.

A second pass with a failing scratch file: the database stays blocked, the dump stays live,
and the next release is held with the dump-series message (`gremion-cd status` shows the
hold); after the Karenz job drops the database (a placeholder row whose final-deletion time
you moved by hand, with the Karenz final-deletion switch on) the dump is gone from the ledger.

A third pass: stop a scratch release after its `snapshot` (a failed release), switch the
placeholder's gate module off and on, and see the dump-series refusal; then
`gremion-cd resume --discard-dump --reason "proof scenario 7"` clears it.

## 12. Also: a held release, a dump failure, the kill switch, the dead-man, a manual rollback

- A held release: a trivial change to a host program; `gremion-cd release-now <sha12> --with-state`
  carries it; the self-test restores the old set when forced to fail
  (`gremion-cd selftest` exits non-zero on the broken copy, and the installed programs are
  byte-identical to before: `sha256sum` of them).
- A dump failure: make the dump directory unwritable (`chmod 500 "$DUMPDIR"`); the release
  does not proceed; the `stopped` mail arrives; restore the mode (`chmod 700 "$DUMPDIR"`)
  and the next tick goes on.
- The kill switch in the middle of a release: `touch "$ROOT/etc/cd.disabled"`; the release
  parks in place (`jq -r .phase "$ST"` stays `watching` and `flock -n "$ROOT/runtime/cd/cd.lock" true`
  fails because a live process holds it); `gremion-cd rollback` still works; remove the file
  and the watch continues.
- The dead-man: `sudo systemctl stop gremion-cd.timer`; the `stalled` mail arrives within
  `CD_STALL_MINUTES`; start the timer again.
- A manual rollback after the commit point: `gremion-cd rollback --reason "proof"` goes back
  one release when the previous colour is still startable; passed when `readlink "$ROOT/current"`
  names the previous tree and the old colour answers `curl -s "https://${CUSTOMER_HOST}/healthz" | jq -r .colour`.
- A crash and a reboot during the reconcile stage: kill the process (`pkill -9 -f gremion-cd`)
  while the stage runs, then reboot; passed when the hold is `reconcile_failed`, the release
  is still committed, and it was never rolled back and the stage was never re-run.

## 13. Also: the worker gate

On a release in its watch (any scenario above that reaches it):

```
for C in blue green; do echo "$C: $(cat "$ROOT/runtime/workers/$C" 2>/dev/null || echo absent)"; done
```

Passed when: the new colour's file is `on` and the old colour's is `off` from the switch on
(`stat -c '%a %y' "$ROOT/runtime/workers/$C"` shows the time of the switch), and back again
(old `on`, new `off`) after a rollback; the old colour's container keeps running while its
workers are off (`docker inspect --format '{{.State.Running}}' "$(cid "app-<old colour>" gremion-ui)"`
prints `true`). Then:

```
docker restart "$(cid "app-$(active)" gremion-ui)"
cat "$ROOT/runtime/workers/$(active)"
sudo systemctl reboot
```

and, after the reboot, the same `cat`: the file still decides (a colour whose file says `off`
stays off after the restart and after the reboot; an absent file means on).

## 14. Also: a reboot of the host in the middle of a window

Start a release (scenario 2a's commit without creating the flag), and reboot the host while
it is in its watch.

Passed when: after the reboot `gremion-cd status` is right (phase and stage), the executor
started only after the release ended (`systemctl show gremion-executor -p ActiveEnterTimestamp`
is later than the end of the release in `$HIST`), and the window was extended
(`jq -r '.release.watch.observed_s' "$ST"` kept counting from its value before the reboot,
not from zero). Write down how long the executor waited.

## 15. Also: a shared-outage pause

During a release's watch, stop the login server for longer than the pause cap plus a minute
(`CD_PAUSE_MAX_MIN` is 15 by default, so 16 minutes):

```
docker stop "$(cid state keycloak)"
sleep 960
docker start "$(cid state keycloak)"
```

Passed when: the watch samples were `paused` while it was down (`jq -r 'select(.event | test("pause"))' "$HIST"`),
and at the cap the release ended in a `parked` mail (the phase is `parked` and `status` says
what serves) or in a rollback: either, and never a silent wait. If it is parked: bring the
login server back and `gremion-cd resume`.

## 16. After the proof

```
# edit etc/cd.env: CD_PROOF_MODE=0 and remove the CD_PROOF_REPO line, then:
rm -rf "$PROOF"
gremion-cd resume --accept-descendants --reason "proof-over"
gremion-cd status | head -5
```

Passed when: `status` exits 0 and mentions neither proof mode nor a proof value (the first
line is not a banner, `status | grep -ci proof` prints `0`), `jq -r '.live.proof' "$ST"`
prints `false`, `stat -c %a "$ST"` prints `600`, and `[ ! -e "$PROOF" ]`. Only then is the
real customer created.

## 17. What this proof does not show

Behaviour under real load; a fault only some users hit; a faulty background job; two workers
racing in the overlap; a shared outage in a real window; a quiet-night window judged only by
probes. Say so in the result, next to the numbers you wrote down.
