# Migration port-back, 2026-09-15

Ten migrations that existed only in the StuRa tree are kernel-owned and were
copied into this repository. Every byte was read from the StuRa tree at the
frozen extraction source `f276af5925abacdcfd05f6613fc11afff2d804c5`
(`git -C <StuRaOS> show <sha>:gremion-ui/migrations/<file>`). The modules
holding repo was not read.

| File | Why it is kernel-owned | Adapted on port |
|---|---|---|
| `003_calendar_schema.sql` | cross-cutting kernel DDL on the module table `calendar_events`; `058` requires the table | verbatim |
| `034_deck_board.sql` | cross-cutting kernel DDL on the module table group `board`/`stack`/`card`; FKs `org_units` (010) and `protocol_action_items` (007) | verbatim |
| `049_org_unit_event_outbox.sql` | unclaimed by any manifest | comment only: the header's example NATS subject named a retired product token, and is now written `<subject-prefix>.<t>.org-unit.<event>`. No executable byte changed |
| `053_notification_read_marker.sql` | unclaimed; the bell aggregates across modules | verbatim |
| `054_resolution_adoption_mode.sql` | unclaimed; extends `042`'s implicit CHECK, so it sorts after `007` and `042` | verbatim |
| `055_resolution_challenges.sql` | unclaimed; creates `resolution_challenges`, which `058` requires — strictly before `058` | the GRANT DO-block's retired role name renamed to `gremion_public_reader` |
| `056_role_assignment_history_recalled.sql` | unclaimed; widens the implicit CHECK from `001:52-53` | verbatim |
| `057_fk_hot_filter_indexes.sql` | unclaimed, purely additive; sorts after `010` | verbatim |
| `058_public_reader_grants.sql` | unclaimed; the fresh-install grant fix, last of the nine | `'news_posts'` dropped from `portal_tables` — kernel `008:4-6` creates no such table. `B4a-news-posts-ownership` gives content its own grant. Its role test already reads `gremion_public_reader` and its `GRANT CONNECT` is already `current_database()`-bound, so neither needed a change; the abort message's historical parenthetical was reworded so no executable line names the retired role, and its `STURA_PUBLIC_DB_URL` reference was corrected to the kernel's `GREMION_PUBLIC_DB_URL` (adaptation 4 below) |
| `migrations-control/004_tenant_domain.sql` | control chain, kernel-owned; sorts after control `003` | the `:104-119` issuer-derived seed is dropped (spec B §T.1) and the rationale block that described it is replaced by a short NOT-PORTED note. The DDL, the `lower(host)` + no-whitespace-no-comma CHECK, `tenant_domain_one_primary` and `tenant_domain_tenant` are unchanged |

## Adaptations beyond spec B's list, and why

Four edits go beyond the adaptations spec B §2 and §T.1 name. All four are
comment or diagnostic text; no DDL or grant statement was altered.

1. **`055`'s retired role name.** StuRa `055:68-71` guards its `GRANT` on the
   retired reader role, and kernel `008:20` creates `gremion_public_reader`, so
   on a kernel install the ported file would have taken the NOTICE branch and
   granted nothing while reporting success. Renamed. `055` is not one of the 46
   basenames shared by both trees, so §3's kernel-bytes-win rule does not reach
   it. Post-condition: `migration-portal-grants.test.ts` asserts that **no**
   executable line in the kernel chain names the retired role. *Spec gap: §2
   lists only `058`. The spec-text edit belongs to
   `B0-spec-docs-and-waiver-ledger`.*
2. **`058`'s abort message.** The message closed with a parenthetical naming the
   retired role literally, which is an executable line (a string literal inside
   `RAISE EXCEPTION`), so the post-condition above would have failed on the
   ported file. The sentence now says "a RETIRED reader-role name" and keeps its
   meaning.
3. **Retired hostnames and the retired product token.** `scripts/kernel-hygiene-check.mjs`
   checks `h2` and `i1` forbid both in any tracked kernel file. The source copies
   of control `004` and `049` carried them in comments — measured: `h2` reported
   8 unwaived carriers and `i1` 7 the moment the files landed. Control `004`'s
   carriers all sat in the rationale for the statement §T.1 drops, so that block
   was replaced rather than waived; `049`'s was one example subject. No waiver
   was added for either.
4. **`058`'s abort message named an env var the kernel does not define.** The
   message told the operator to reuse "the SAME password `STURA_PUBLIC_DB_URL`
   carries". That variable exists only in the StuRa tree; the kernel's is
   `GREMION_PUBLIC_DB_URL` (`.env.example:197`,
   `gremion-public/src/lib/server/public-db.ts:14`), and no `STURA_`-prefixed
   variable is defined anywhere in this repository. An operator hitting the abort
   would have gone looking for something that does not exist, which is the same
   defect class `058` exists to close — a diagnostic that reads plausibly and
   points nowhere. The token is renamed; `migration-portal-grants.test.ts` now
   asserts over the whole chain that no executable line names a `STURA_`-prefixed
   variable, and that `058` names `GREMION_PUBLIC_DB_URL`. It escaped the earlier
   passes because `scripts/kernel-hygiene-check.mjs`'s retired-product-token rule
   matches the retired product token as a whole word, not the bare `STURA_`
   prefix.

## Not ported, deliberately

`050_handover_schema.sql`, `051_handover_event.sql` and
`052_handover_module_binding.sql`. Under **D-01** handover stays private and
unextracted and its migrations ship in no release-1 tree; block 1900–1999 is
reserved and empty. `scripts/check-unshipped-migrations.mjs` fails any tree that
carries one, including the renumbered `1900_` form.

Also not ported: `046_content_publish_ops.sql` and `047_news_posts_content_origin.sql`
(content module), and the twenty finance files plus `044`/`045`, which the modules
holding repo carries.

## Downstream notes

`008_public_portal.sql` **and the nine basenames ported here** are named
exceptions to the byte-equality post-condition of `B6-canonical-migration-bytes`:
B6 adjudicates the 46 basenames shared by both trees at pre-port-back HEAD, and
these are not in that set. After the adaptations above, `049`, `055` and `058`
are by construction not byte-equal to their originals, and so is the content-side
half `B4a-news-posts-ownership` lands.

`CROSS_CUTTING_MIGRATIONS` in `gremion-ui/src/lib/modules/migration-ownership.ts`
keys `034_deck_board.sql` to `deck_board`. That is the board module's ownership
key, not a relation: `034` creates `board`, `stack` and `card`, which is what
`gremion-ui/scripts/fresh-init-proof.sh` asserts against a real Postgres. The
literal is kept because `B7-renumber-ranges-baseline` consumes it as
`ranges.json`'s `kernel.crossCuttingModuleTables`.

The renumber to four digits, the canonical-bytes normalisation and
`migrations/ranges.json` are **not** part of this port-back — see
`B6-canonical-migration-bytes` and `B7-renumber-ranges-baseline`.
