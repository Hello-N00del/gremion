# Release-1 delta record

Date: 2026-09-24
Requirement basis: PRD-REC-002, PRD-REC-006, PRD-REC-007, PRD-REC-008 (PRD §17.5); verdicts carried
from PRD §17.1; unit table from PLAN §7.
Owning task: TASK-011.

This record is the PRD-REC-007 gate. Per PLAN §7 step 1 ("P0: touch nothing. Only the dated delta
and pause records are written"), no other release-1 unit is re-cited in the implementation plan
before this record exists.

## 1. State-of-record facts (git-verified 2026-09-24)

**civitas `release-1/local-integration` @ `ceba66c`.** `git log --merges --oneline ceba66c` lists
nine merges: eight release-1 units plus one hygiene fix, in merge order (oldest first):

| SHA | Merge |
|---|---|
| `acfa3d0` | B00-extraction-source-freeze |
| `2469bb8` | B37-postgres-major-pin |
| `71511c9` | B1b-theme-rename-and-hygiene-guard |
| `b9ebbf9` | B1a-realm-identity-and-boot-import |
| `69734d0` | B0-spec-docs-and-waiver-ledger |
| `1aa96ba` | B2-realm-smtp-block |
| `e1d621e` | fix/k1-token-boundary (host-inventory-name token-boundary fix; not a unit) |
| `f4ef216` | B3-carve-rules-and-portback-guard |
| `ceba66c` | B4-migrations-portback-nine (tip) |

Eight unit merges (B00, B37, B1b, B1a, B0, B2, B3, B4) match PLAN §7's verdict table exactly: "8
merged (B0, B00, B1a, B1b, B2, B3, B4, B37)" under KEEP.

**StuRaOS (orchestrator-observed, not independently re-checked in this worktree — the StuRaOS repo
is not present here):** local master `b412f083` carries B3's StuRaOS half merged locally and not
pushed; `origin/master` `f276af59` is what the test environment currently runs.

**B5 salvage branch.** `git branch -a --list '*B5*'` shows two candidates:

| Branch | Tip | Commits (`rev-list --count`) |
|---|---|---|
| `unit/B5-governance-320-subsystem/r3` | `5d751c3` | 134 |
| `unit/B5-governance-320-subsystem/r3b` | `5f0d420` | 142 |

`r3b` at `5f0d420` is the named salvage reference: it matches the SHA PLAN §7 cites for B5 ("Worktree
at 5f0d420 ... all 12 tasks are committed"). `r3` is a prior revision of the same unit, superseded by
`r3b`. Neither branch merges; both stay as history, per PLAN §7 step 5.

## 2. PRD §17.1 verdict table

One row per verdict in PRD §17.1. "Owner" is the PLAN §7 task that carries the corresponding
unit(s) where §17.1 or PLAN §7 names or clearly identifies that unit by content; otherwise "operator"
(a scope/policy call with no dedicated implementation unit). "State today" is read from §1's git
evidence and PLAN §7's per-unit status column, not asserted independently.

| # | §17.1 decision | PRD verdict | Deciding section | Unit(s) carrying it (PLAN §7) | Owner | State today |
|---|---|---|---|---|---|---|
| 1 | F2 — every module its own repo before deploy | DEFER to §6.4 | [D-nc R5-defaults] | D3, D5, D6, D9, D11, D12, D13, D14, D15, D16 (all PAUSE) | operator (resume decision); paused units carried by TASK-011 | paused, not started — see §3 |
| 2 | F3 — verticals live in-tree, out-of-tree resolution deferred | KEEP | [D R18-§15.1 F6] | D8-stura-vertical (ADAPT) | TASK-031, TASK-080, TASK-129 | not started |
| 3 | F4 — B before D, control plane out of scope, with B-06 interim `tenant-create` service | KEEP | [D R18-§15.1 F6] | pilot-customer creation path (PLAN §7 planner decision: "through the orchestrator, with the interim service as the fallback") | TASK-043 (orchestrator), TASK-051 (interim service = B-06) | not started |
| 4 | F5 — minimal StuRa-tree work | KEEP | [D R18-§15.1 F6] | none — scope statement only | operator | n/a |
| 5 | P1 — full two-colour fidelity, raised to the pilot's deploy path | RAISED to pilot deploy path | [D R17-18, D R17-19] | B29-two-colour-exactly-once-proof (PAUSE, named explicitly in §17.3); B28-worker-safety-and-colour-gating (ADAPT, claims); B4a-news-posts-ownership (PARTIAL KEEP, worktree `794bae9`) | TASK-011 (B29 pause record), TASK-094 (B28), TASK-028/054 (B4a) | B29 paused; B28 not started; B4a partial |
| 6 | P2 — all nine modules enabled | OVERTURN | PRD §0, PRD-PLAT-012, PRD-OPS-003 | none — board/vault stay non-isolated; finance off | operator | n/a (policy) |
| 7 | P3 — Postgres major pin | ADJUST (PostgreSQL 18, native uuidv7) | [D R19-D14, D R20-D38] | B37-postgres-major-pin (MERGED KEEP) | TASK-019; decision-log row TASK-014 | merged at `2469bb8` |
| 8 | P4 — acceptance waivers | ADJUST (three of six fall) | [D R13-4, D R15-1, D R15-6, D R20-D26-1, D R20-D26-2] | B0-spec-docs-and-waiver-ledger (MERGED KEEP; this amendment) | TASK-011 | amended today — see §5 |
| 9 | P5 — tenant-aware storage seam | KEEP | [D R18-§15.1 F6] | B23-storage-seam (ADAPT) | TASK-117 | not started |
| 10 | B-01 — no boot-time default council | KEEP | [D R18-§15.1 F6] | B12-zero-tenant-boot (KEEP) | TASK-042 | not started |
| 11 | B-02 — kernel wins, 294 divergent files | KEEP | [D R18-§15.1 F6] | B3-carve-rules-and-portback-guard (MERGED KEEP) | TASK-018, TASK-047, TASK-118 | merged at `f4ef216` |
| 12 | B-04 — migration renumbering + index-blob baselines | KEEP | [D R18-§15.1 F6] | B4-migrations-portback-nine (MERGED); B7-renumber-ranges-baseline (ADAPT); B6-canonical-migration-bytes (PAUSE) | TASK-020/054/080 (B4); TASK-029 (B7); TASK-011 (B6) | B4 merged at `ceba66c`; B7 not started; B6 paused |
| 13 | B-05 — health-probe contract | KEEP | [D R18-§15.1 F6] | B11-healthz-and-boot-determinism, B30-healthchecks-and-census (both KEEP) | TASK-023, TASK-036 | not started |
| 14 | B-08 — single env reader, domain bound once, raised priority | KEEP, raise priority | [D R18-§15.1 F6] | B15-env-contract-and-validator (KEEP) | TASK-028 | not started |
| 15 | B-11/B-12 — evict fan-out (nine leaves), migration ledgers (six leaves) | ADJUST — scope to modules a council actually enables | [D R18-§15.1 F6] | D4-evict-on-leaves (ADAPT), B19b-evict-ack-migration (KEEP), B20-evict-labels-and-fanout-fix (ADAPT), B22-leaf-migration-ledger (ADAPT) | TASK-026/035 (D4); TASK-035 (B19b, B20); TASK-020 (B22) | not started |
| 16 | B-13 — tenant-scoped storage seam | KEEP | [D R18-§15.1 F6] | B23-storage-seam (ADAPT) | TASK-117 | not started |
| 17 | B-14/B-17 — backup split, committed lockfile | KEEP | [D R18-§15.1 F6] | B25/B26/B27 (backup, ADAPT), B35-release-supply-chain (ADAPT) | TASK-089 (B25/B26/B27), TASK-046 (B35) | not started |
| 18 | B-15 — exactly-once worker claims | KEEP claims; DEFER two-colour proof | [D R18-§15.1 F6] | B28-worker-safety-and-colour-gating (ADAPT, claims); B29-two-colour-exactly-once-proof (PAUSE, proof) | TASK-094 (B28); TASK-011 (B29) | B28 not started; B29 paused |
| 19 | B-16/D-05 — two image sets, private manifest, artefact guard | OVERTURN for the pilot | [D R3-3] | D15-oss-artefact-guard (PAUSE); B35-release-supply-chain (ADAPT, drops the two-image-set and OSS-purity-guard tasks) | TASK-011 (D15); TASK-046 (B35) | D15 paused; B35 not started |
| 20 | D-01 — module SDK kept; handover visibility record deferred | KEEP SDK; DEFER visibility record | [D R18-§15.1 F6] | D1-module-sdk-package (ADAPT); D16-handover-visibility-record (PAUSE) | TASK-030/078 (D1); TASK-011 (D16) | D1 not started; D16 paused |
| 21 | D-02 — vertical = data; OSS image free of private verticals | KEEP data-shape; DEFER artefact guard | [D R18-§15.1 F6] | D2-module-json-and-dist-schema (ADAPT), D8-stura-vertical (ADAPT); D15-oss-artefact-guard (PAUSE, guard half) | TASK-030 (D2); TASK-031/080/129 (D8); TASK-011 (D15) | D2, D8 not started; D15 paused |
| 22 | D-03/D-04 — repos from index blobs; news folded into content | KEEP as policy; D-03 units defer with F2 | [D R18-§15.1 F6] | D3-first-module-repo-users (PAUSE) | TASK-011 | paused |
| 23 | M3 — Vaultwarden dropped from the split (2026-09-08) | OVERTURN — kept as a supported, profile-gated option | [D R8-4] | B18-router-emitter-library (ADAPT, drops hygiene rule j1) | TASK-034 | not started |

Rows 3, 5, 12, 13, 15, 17–22 name more than one unit because PRD §17.1 states a policy-level verdict
that several PLAN §7 units implement in parts; the "unit(s)" and "owner" columns are the full set of
carriers PLAN §7 names for that verdict, matched by explicit PLAN §7 cross-reference or by PLAN §7's
own content description (e.g. B-01's "no boot-time default council" matches B12-zero-tenant-boot's
description verbatim: "delete registerDefaultTenant, DEFAULT_TENANT ... the 'default' string
branches"). Where PLAN §7 assigns no single unit — F2, F4 (as a whole), F5, P2, P4 (as a whole),
B-16/D-05 (the M-image-set half already dropped without a residual task) — the owner is "operator"
or the task named directly above.

## 3. Paused units — dated records (PRD-REC-002)

All 12 dated 2026-09-24. Deciding section and on-resume reuse are quoted from TASK-011's own
"Release-1 reuse" line and PLAN §7's per-unit table; PLAN §7's reuse text is truncated at source for
three units (B6, B29, D9) and is quoted only as far as the source document gives it, marked "(source
excerpt)".

| Unit | Deciding section | On resume, reusable now |
|---|---|---|
| B6-canonical-migration-bytes | PRD-REC-002; this section (TASK-011). Resumes only after PRD §6.4, re-verified against the then-current base (PRD-REC-008). | The byte-parity checker design (`verify-migration-byte-parity.mjs`) and the measured census (19 of 46 shared basenames diverge) stay valid (source excerpt). |
| B29-two-colour-exactly-once-proof | This section (TASK-011). Resumes only after PRD §6.4, re-verified against the then-current integration branch (PRD-REC-008). | The outbound stub counter harness (assert counts read back, never exit codes) and the consumer-ledger state-tier check are reusable designs (source excerpt). |
| D3-first-module-repo-users | PRD §17.3; PRD-REC-002. Resumes only after PRD §6.4, re-verified per PRD-REC-008. | The blob-identity extraction proof and extraction driver design. |
| D5-remaining-module-repos | PRD §17.3; PRD-REC-002. | Stacking discipline (never fan out) and the extraction-map vacuity guard. |
| D6-leaf-images-and-compose-fragments | PRD §17.3. | The healthcheck part is already salvaged into B30-healthchecks-and-census (TASK-036, KEEP). |
| D9-assembler-module-resolution | PRD §17.3; PRD-REC-002. | Artefact-level count assertions (`MODULE_MANIFESTS`, server-init imports, migration keys, nav anchors) and clone-hygiene checks (source excerpt). |
| D11-archive-holding-repo-and-stura-tree | This section (TASK-011). The StuRa tree stays the test environment via the submodule; archiving it now would break kernel-first merges. | Harvest `MIGRATION_OWNERSHIP` before archiving; `ARCHIVED.md` naming the extraction source. |
| D12-module-repo-ci-and-dependabot-template | PRD §17.3; PRD-REC-002. | Test and boundary-lint vacuity guards per repo, the same fail-closed principle as TRD-444. |
| D13-compose-fragment-inlining | PRD §17.3; PRD-REC-002. | Fragment rules (no `name:`, no `include:`, every block carries `image:` and a tier label, deterministic order, collision aborts). |
| D14-gremion-dist-repo | PRD §17.3; PRD-REC-004. | Nothing to reuse now. |
| D15-oss-artefact-guard | PRD §17.1 (B-16/D-05 overturned for the pilot); PRD-REC-002. | The guard inspects the built artefact, never the source; membership is computed from visibility, never hard-coded. |
| D16-handover-visibility-record | PRD §17.1 (D-01's visibility record, deferred to §6.4). | The docs-lint that fails when `CONTRIBUTING`'s private-module list diverges from the visibility set. |

**Resume rule (PRD-REC-008), stated once for all 12:** a paused unit that resumes is re-verified
against the integration branch as it is then (the current `release-1/local-integration` tip at
resume time), never against its original base or the base recorded in this delta.

## 4. Dropped units — dated records (PRD-REC-002)

Both dated 2026-09-24.

**B5-governance-320-subsystem.** Deciding section: PLAN §7 step 5 — superseded by D9 (the governance
core as its own service, TRD-408) and D22 (the kernel API owns tenancy, bodies, grants and the
outbox relay, TRD-407). Does not merge. Salvage reference: branch `unit/B5-governance-320-subsystem/r3b`
at `5f0d420` (kept, not deleted; see §1). Its outbox and relay commits are reused only once they pass
TASK-079's target-service tests; its governance rules and tests are reused only once they pass
TASK-083's and TASK-145's target-service tests. Each salvage path is a re-verification against the
target service, not a straight cherry-pick.

**B24-minio-state-tier.** Deciding section: superseded by TRD-066 (the pilot deploys no object
storage, no object-storage component or profile on the pilot host) and TRD-354 (remove dormant
minio/minio-mc references). Nothing carries forward for the pilot; the per-service access-key
scoping idea (root pair only for init and restore) is recorded as north-star input for later object
storage, owned by TASK-048 as a note, not a build task.

## 5. Waiver ledger amendment (PRD §17.1 P4, PRD-REC-006)

`docs/ops/release-1-waivers.md` is amended today; see that file's own change log for the row-level
changes. Summary:

- **Mail delivery** leaves the waiver list. Demonstrated by TASK-015 (self-hosted Stalwart mail
  server on the vendor domain, SPF/DKIM/DMARC pass, inbox delivery to a large consumer mailbox and a
  university mailbox) per the PRD-REC-006 requirements-traceability row (TASK-011, TASK-015,
  TASK-089). Condition for the fall — PRD-MTG-002a is Must — already holds (PRD §8.8 table).
- **The backup remote — flagged, not cleanly closed, same visibility as the probe/vendor gap below.**
  TASK-011's own acceptance text and PLAN §7's B0 reuse line both say "the provider-side backup
  remote... leave[s] the waiver list." The ledger's one backup-related row (`offsite-backup-remote`,
  written 2026-09-15) never waived a provider-side item to begin with: it waived only the off-site
  (second-provider) copy and its `offsite: true` assertion, and already stated the *local* restore
  "is not waived." So read literally, there is nothing in the active table for the provider-side
  item to leave — it was outside the waiver before this amendment. PRD-REC-006's own text points
  the same way for what release 1 demonstrates: PRD-REC-006 says "the backup remote demonstrated
  is the [pilot-host]-side backup the first restore drill restores from" (quoting PRD-REC-006,
  which names the pilot host's hosting provider; that name is not repeated here per this task's
  rule against naming hosting providers in committed docs) "... An off-site copy at a second
  provider is the north star and is not demonstrated in the pilot." I.e. PRD-REC-006 demonstrates
  the provider-side restore (TASK-089: one-off backup verification and provider restore drill, after which both
  backup jobs are switched off) and leaves the off-site copy waived, unchanged. That satisfies
  PRD-REC-006's "demonstrated working" half for the provider-side item, but not its "removed from
  the waiver list" half, because there is no waiver row over that item to remove. This record does
  not resolve that mismatch unilaterally: it surfaces it for operator/planner sign-off, same as the
  probe/vendor item. Two ways to close it, named for the operator/planner to choose: (a) treat
  TASK-089's demonstration as satisfying PRD-REC-006 in full for this item, since nothing was ever
  waived to lift; or (b) read the `offsite-backup-remote` row as needing a split — the off-site
  (second-provider) copy stays active/waived, and a separate provider-side line is added to "Lifted
  waivers" naming TASK-089, purely for symmetry with how mail and the probe/vendor item are shown,
  even though nothing in the active table's scope actually changes. Neither choice changes the
  active table until the operator/planner picks one; `docs/ops/release-1-waivers.md`'s ledger
  records the same open item under `offsite-backup-remote` and its change log.
  **Closed 2026-09-24 [D R23-3]: the operator chose (a).** TASK-089's demonstration satisfies
  PRD-REC-006 for the provider-side item; the off-site copy stays waived; the active table is unchanged.
- **The probe/alert vendor** — flagged, not cleanly closed. PRD §17.1 P4 names it as one of the three
  that fall, but PLAN's own requirements table scores its requirement, PRD-OPS-008 (the independent
  status page), as Should and defers it to P4/12-month scope, stating explicitly "no other task
  claims it." PRD-REC-006 is a Must that names the probe/alert vendor as a gate item before the
  pilot's invitation is accepted; today no PLAN task demonstrates it. This delta record does not
  invent a task to close that gap. The waiver row is removed per the P4 instruction, but the gap is
  recorded in the waiver ledger's own change log as open, owner operator/planner, due before
  PRD-REC-006's gate binds (before the pilot invitation is accepted).
- **Apex DNS** stays waived — unchanged, no operator decision yet.
- Legal documents and pilot inputs are untouched by this amendment; PRD §17.1 P4 un-waives them at
  §6.5's first invoice from the business, not today.

## 6. Superseded repositories — dated records

- **2026-09-25 — `gremion-modules` (local folder `civitas-modules`) archived, read-only [D R23-17].** The
  drift map of 2026-09-24 found the StuRaOS product repository ahead of this snapshot on every module,
  with one change unique to it: `1295a40` (governance notification-failure logging). That change was
  ported to StuRaOS (only the scheduler half; the room-listing half does not apply there, as its own
  commit message records), reviewed, and merged on 2026-09-25. The repository README now carries a
  "superseded" banner, and the repository is archived. The module sources move into this repository's
  `modules/` directory under TASK-205; nothing is taken from the archived snapshot.
