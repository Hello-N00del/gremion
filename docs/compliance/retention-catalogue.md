# Retention-window catalogue (input to the Löschkonzept)

> **Status: DRAFT, dated 2026-09-25 under the current reading.** Every window below that
> depends on the university data-protection officer's written answers carries an **[A]**
> reading and is re-dated when those answers arrive [D R21-6, D R21-24]. Nothing here is
> legal advice, and no window with a period here may be configured until its row is marked
> derived in `ops.retention_window` (on-event, cache-TTL and never-deleted rows: see §1.4).
>
> **Change note 2026-09-30 (R29-RETENTION-30):** operator decision [D R29-I6] caps every log
> class at 30 days, pseudonymised logs included. RC-LOG-APP/SEC/FIN/AUD caps are now 30 d and
> regular windows at most 30 d; the security window is 27 d / 30 d; G5 is closed (bound
> 29 d + 2 h 5 min) and G8 reads 29 d (2505600). The documented tier [A-D8] is replaced.
>
> **Change note 2026-10-01 (R29-Q20):** operator decision [D R29-I24] gives the five modules
> without a database (elections, files, handover, messaging, votes) provisional default
> profiles `rp-<ctx>-module-data` so a customer can enable them; their window is the grace
> (30 days) after the module is disabled, pending the DPO's answer (§7.15 RC-MOD-DATA, A-MOD).
> RC-MOD-EXPORT records the six database modules' disable exports on the same window.

| | |
|---|---|
| Task | TASK-070 (plan key L7-14), provides CAP-RETENTION-CATALOGUE |
| Implements | PRD-REG-013, PRD-OPS-007; TRD-143, TRD-144, TRD-145, TRD-146, TRD-147, TRD-163, TRD-172, TRD-191; DB-OPS-RETENTION-PROFILE, DB-OPS-RETENTION-WINDOW, DB-OPS-DELETION-CONCEPT |
| Consumers | L3-15 (TASK-033) generates the German Löschkonzept and configures the five log streams plus the trace store from this file; L3-34 carries the windows into the TOM annex (TRD-140); the go-live Beschlussvorlage (L7-14 summary) cites it |
| Method | DIN EN ISO/IEC 27555:2025-09, with DIN 66398:2016-05 guidance kept wherever it is stricter [D R19-D21] |
| Reading date | 2026-09-25. No DPO written answer has been received on that date. |

Tags: [D Rn-m] operator decision; [A…] assumption under the current reading (§11); [E …]
measured evidence; [D-nc] not yet decided.

---

## 0. What this document is, and what it is not

This is the **catalogue**: one row per stored data category, each with its start event, its
legal basis, the statutory period it relies on, the window derived from them, and the
deletion mechanism that executes it. It is the single source the Löschkonzept is built from.

- **The German Löschkonzept is not a second document.** L3-15 (TASK-033) generates it, per
  customer, from this catalogue and the customer's `ops.retention_window` rows (TRD-145,
  DB-OPS-DELETION-CONCEPT). Changing a window means changing this file and re-deriving
  the row, never editing a generated Löschkonzept.
- **It does not configure anything.** No window with a period here is applied until its
  `ops.retention_window` row carries `derived = true`, a `derived_at` and a `standard_ref`
  (DB-OPS-RETENTION-WINDOW constraint `retention_window_derived_check`). PRD-REG-013: *a
  window with no derivation shall not be applied.* The rows that are not stored as window
  rows at all are named in §1.4.
- **It covers the product, not only this repository.** The kernel repository ships the
  `core` and `governance` manifests; feature modules live in their own repositories
  (see `docs/compliance.md`). The categories of every module a hosted council can enable
  are catalogued here all the same, so one Löschkonzept can name every stored category
  (TRD-145). A module repository cites the row ids below rather than restating a window.
- **Row ids are stable.** Each row carries an id (`RC-...`) and the retention profile
  (`rp-...`) of DB-OPS-RETENTION-PROFILE it governs. The generator and the TOM annex cite
  row ids; a re-dated row keeps its id.

---

## 1. Method

### 1.1 The standard

The derivation follows **DIN EN ISO/IEC 27555:2025-09** as the method. DIN 66398:2016-05
(*Leitlinie zur Entwicklung eines Löschkonzepts*) is withdrawn and replaced by it; where
DIN 66398 guidance is stricter, the stricter rule is kept [D R19-D21]. That 27555 carries
the DIN 66398 Löschklassen method over unchanged has **not** been checked against the
standard's text **[A-M1]**; until it is, every row below is built so that it satisfies
both: a category, a start event, a regular period drawn from a small fixed grid, and the
exceptions (statutory holds, archive offer) stated separately from the regular period.

### 1.2 The derivation steps, per category

1. **Category and purpose.** Name the data category (a cluster of personal data kept for
   one purpose) and the purpose it serves.
2. **Start event (Startzeitpunkt).** The event from which the period runs: an entry
   written, a meeting closed, a term ended, an unsubscribe, the end of a calendar or
   budget year.
3. **Necessity (GDPR Art. 5(1)(e)).** The shortest period after the start event for
   which the purpose still needs the data in identifying form.
4. **Statutory duties.** Any retention duty that forces a longer period (LHO and the
   council's Finanzordnung, HGB § 257 / AO § 147 where they bind, the archive offer
   duty). A duty is a **hold**, not a new purpose: it keeps the data legible for the duty
   only (Art. 17(3)(b)).
5. **Regular period.** The larger of steps 3 and 4, rounded **up** to the next value of
   the standard grid (§1.3), so the number of distinct deletion classes stays small.
6. **Enforcement (Art. 25).** The deletion class K1–K6 (§1.5) and the purge that executes
   the period without administrator action (TRD-144). A category with a cap is enforced
   at the cap regardless of any administrator-set value (TRD-143).

### 1.3 The standard grid

Every regular period below is one of these values. A value outside the grid needs its own
written reason in the row.

| Grid value | Used for |
|---|---|
| on event (0) | Data whose purpose ends with the start event itself (ballot receipts, unverified tokens, a dump after a succeeded switch) |
| 1 hour | Cache entries holding personal data (cap) |
| 24 hours | Short-lived sessions and transient working copies |
| 7 days | Transient plumbing; traces (regular) |
| 14 days | Access logs (regular); traces (cap) |
| 30 days | The standard grace after a purpose ends; every log class (cap, [D R29-I6]); application logs (regular) |
| 27 days | Security, finance and audit/operator-access logs (regular, as configured; [D R29-I6]) |
| 29 days | Identity-provider event and admin-event expiry (2505600 s; [D R29-I6]) |
| 1 year | Evidence whose challenge period is short or unset |
| 2 years | Handover material (two successor terms) |
| 3 years, from the end of the calendar year | Accountability evidence (the "audit window", §2.2) |
| 6 years, from the end of the calendar year | Business letters where HGB/AO bind (HGB § 257(4), AO § 147(3)) |
| 8 years, from the end of the calendar/budget year | Accounting vouchers where HGB/AO bind |
| 10 years, from the end of the calendar/budget year | Minutes, resolutions, books and annual accounts; then the archive offer |
| none (never deleted, redaction only) | Published public records while they stay published (K6) |

### 1.4 How a window reaches the running system

A derived row becomes an `ops.retention_window` row per customer and retention profile
(`period_value`, `period_unit`, `derived = true`, `derived_at`, `standard_ref` naming this
catalogue's row id and reading date). A re-derivation supersedes the old row, which stays
frozen as K5 evidence (`rp-ops-retention-evidence`). Log-store and trace-store retention is
re-cited **from the running configuration** before the TOM annex or the Löschkonzept
quotes it (TRD-143); a configured number that no derived row backs fails the check.

Three kinds of row are not stored as `ops.retention_window` rows, because the table allows
only a positive number of days, months or years: (a) **on-event** rows are executed by the
purge on the trigger named in the table comment, and the catalogue row id is their
derivation; (b) the **1-hour cache TTL** (RC-K1-CACHE) is enforced in the cache
configuration and re-cited from it (TRD-143); (c) **never-deleted** K6 and chain rows have
no window row. For **year-end-anchored** periods the start event is the end of the calendar
or budget year, and the purge job, not the window row, rounds to it. If L3-15 needs these
stored, the schema owner adds them expand-only. This catalogue does not change the table.

### 1.5 The six deletion mechanics (K1–K6)

The K classes are the mechanics that execute a derived period (DB-OPS-RETENTION-PROFILE
`deletion_class`). They are not periods; no period lives in the profile table.

| Class | Mechanic |
|---|---|
| K1 transient | Hard delete by the purge job at start event + period: drafts, queues, cache, import files, working sessions |
| K2 operative | Hard delete at start event + period; where an id must survive as a pseudonym, the personal columns are erased in place on an erasure request |
| K3 council record | Kept for the period; an erasure request is answered by a redaction layer, the record itself stays unaltered (§8); at the end, offered to the archive (§2.1) before deletion |
| K4 statutory finance hold | Stays legible until `finance_hold_until`, then falls back to K3 |
| K5 logs and evidence | Append-only for the application role; removed only by the time-based purge |
| K6 public record | Never deleted while published; answered by redaction only |

---

## 2. Legal bases and the periods relied on

### 2.1 Bases

| Basis | What it contributes here | Status on 2026-09-25 |
|---|---|---|
| GDPR Art. 5(1)(e) storage limitation | The upper bound for every row: no longer than the purpose needs | settled |
| GDPR Art. 5(1)(c) minimisation | Collection rules for logs (§4.3); a log must not become a shadow copy of a record | settled |
| GDPR Art. 17, including 17(3)(b) and (e) | What must be erased on request, and where a legal duty or legal claims hold it back | settled; the redaction reading of §8 is [A-L5] |
| GDPR Art. 25 | Why periods are enforced technically (caps, purge jobs), not only written down | settled |
| GDPR Art. 5(2), Art. 24 | Accountability: evidence of erasure requests, DPIA decisions, retention derivations | settled |
| GDPR Art. 32(1)(b), (c) | Availability and restore, the basis of the backup window (§6) | settled; the pilot deviation is DPO question 6, [A-D6] |
| GDPR Art. 33(5) | Documentation of personal-data breaches | settled |
| The Land's **Landeshaushaltsordnung (LHO)**, its administrative regulations, and the council's own Finanzordnung | Retention of budget, cash and voucher records of a public-law student body | **[A-L1]** the concrete period is not confirmed (DPO question 7) |
| **HGB § 257** (commercial retention) | Books, inventories, annual accounts: 10 years; accounting vouchers (Buchungsbelege): 8 years; business letters: 6 years; the period starts at the end of the calendar year the document arose in (§ 257(5)) | **[A-L2]** whether it binds a student body at all is open (DPO question 7); the 8-year voucher period is the 2025 reduction by the Fourth Bureaucracy Relief Act (BEG IV) [E statute, to verify against the consolidated text] |
| **AO § 147** (tax retention) | Books and records: 10 years; vouchers: 8 years; other documents: 6 years; start at year end (§ 147(4)) | **[A-L2]**, as for HGB; applies at most to a commercial activity (Betrieb gewerblicher Art), if any |
| The Land's **archive law (Anbietungspflicht)** | A public body offers records to the competent archive before it deletes them; the archive may take them over | **[A-L3]** whether it applies to the council's records, and which archive is competent, is open (legal question 17; in part DPO question 7) |
| The council's Satzung, Geschäftsordnung and Wahlordnung | Term lengths, challenge periods for elections and resolutions | read per customer; defaults below are [A-L4] |
| BGB §§ 195, 199 (regular limitation, three years from year end) | The period in which claims needing evidence can be raised; basis of the audit window | settled as orientation |
| BSI IT-Grundschutz OPS.1.1.5; BSI minimum standard on logging and detection v2.1 (Nov 2024); NIST SP 800-92 | Orientation for log periods; the BSI minimum standard's ~90-day default binds federal agencies only | orientation, not binding |

### 2.2 Named windows used across rows

| Name | Value under the current reading | Derivation |
|---|---|---|
| **grace** | 30 days after the purpose ends | Lets an erroneous closing, withdrawal or unsubscribe be reversed and a pending request finish; longer is not needed for any purpose in this product [A-G] |
| **audit window** | 3 years from the end of the calendar year of the start event | Art. 5(2) accountability evidence must be producible for as long as a data subject or authority can raise a claim that needs it; the regular limitation period (BGB §§ 195, 199) is the reference [A-G] |
| **record period** | 10 years from the end of the calendar year of the meeting or decision, then the archive offer | Minutes and resolutions authorise spending and are the council's official record; they outlive the finance vouchers they authorise (8 or 10 years, §7), and the archive duty decides what happens after [A-L1, A-L3] |
| **finance hold** | 10 years (books, annual accounts, Haushaltsrechnung) or 8 years (vouchers) from the end of the budget year | LHO/Finanzordnung under the current reading, with HGB/AO periods as the reference values until the LHO period is confirmed; if the confirmed LHO period is shorter and HGB/AO do not bind, the shorter applies [A-L1, A-L2] |
| **challenge window** | as the customer's Wahlordnung or Geschäftsordnung sets it; default 1 month after the result is announced | An election or vote can be contested only within that period; after it, the individual ballot data has no purpose [A-L4] |
| **security window** | 27 days regular, 30 days cap [D R29-I6] | §4.1, row RC-LOG-SEC |

*Audit window* (3 years, accountability evidence) is not the *audit/operator-access log
class* (27 d / 30 d, RC-LOG-AUD). Where a schema comment says 'security/audit window'
(`ops.incident`), this catalogue reads the audit window; where it says 'audit log class'
(`gov.integrity_check`), it reads RC-LOG-AUD.

---

## 3. DPO-dependent readings

Twelve questions were put to the university data-protection officer on 2026-09-23; no
written answer has arrived [D R21-6]. Under [D R21-24] this catalogue is dated under the
current reading before the re-init and re-dated when the answers arrive; the operator
chases questions 4 and 6 before the re-init. Where no answer exists when a dependent task
runs, that task uses the reading recorded here and names the open question; it does not
wait (TASK-016 acceptance).

| Question | Rows it can change | Current reading |
|---|---|---|
| Q4 — which Art. 35(4) list applies to the council | Indirect: a DPIA duty for a module can tighten that module's rows | No row changes; the DPIA decisions are L7-03's [A-D4] |
| Q6 — the pilot runs without backups after one verification | §6 in full | The deviation stands as decided [D R15-1] and is disclosed [A-D6] |
| Q7 — retention of minutes, resolutions and finance records (LHO/Finanzordnung, HGB/AO) | RC-GOV-*, RC-FIN-*, RC-LOG-FIN, the record period and the finance hold | §2.2 values [A-L1, A-L2] |
| Q8 — university defaults for server and access logs | RC-LOG-* | Replaced by the operator decision [D R29-I6]: 30 days for every log class (§4.1) |
| Q9 — erasure against approved minutes, finance-relevant names | §8 | Redaction layer, finance names legible for the hold [A-L5] |
| Q11 — newsletter consent evidence | RC-NWS-* | §7.11 values [A-D11] |
| Legal question 17 (in part DPO question 7) — archive offer duty | Every K3 and K6 row at the end of its period | The offer step is modelled (§8.4) but its applicability is open [A-L3] |
| Module default profiles (put to the DPO by the operator, 2026-10-01) | RC-MOD-EXPORT, RC-MOD-DATA (§7.15) | Grace (30 days) after a module is disabled; the five database-less modules' ids are provisional [D R29-I24, A-MOD] |

**Re-dating procedure.** When a written answer arrives: (1) the affected rows are
re-derived here, with the answer's date and reference in the row; (2) the reading date at
the top changes; (3) each customer's `ops.retention_window` rows are superseded (an
expand-only change, the old rows frozen as evidence); (4) L3-34 carries the new windows
into the TOM annex; (5) a regenerated Löschkonzept replaces the old one. A shortening takes
effect at the next purge run; a lengthening applies only to data not yet purged.

---

## 4. Log deletion classes (TRD-143, TRD-146, TRD-147, TRD-191)

Logs are not one category [D R16-5]. Six classes, each with its own window: five as
separate log-store retention streams from the log store's first deploy [D R17-25], and
the trace store as the sixth [D R19-D27]. Every start event is *entry written*. Each class
is enforced at its cap independent of any administrator-set value (TRD-143).

### 4.1 The six classes

| Row | Class | Purpose | Legal basis and periods relied on | Regular / cap | Reading |
|---|---|---|---|---|---|
| RC-LOG-ACC | Access (Zugriffsprotokolle) | Abuse and rate-limit detection, short-term attack forensics on pseudonymised addresses | Art. 5(1)(e), 5(1)(c), 32(1); no statutory duty | **14 d / 30 d** | [D R29-I6] Cap 30 d for every log class; two weekly review cycles cover the purpose. Kept only because the derivation yields it [D R15-5] |
| RC-LOG-APP | Application (Anwendungsprotokolle) | Fault diagnosis; covers one monthly release-and-review cycle plus the time to find a slow-surfacing fault | Art. 5(1)(e), 6(1)(e) or (f); no statutory duty | **30 d / 30 d** | [D R29-I6] Cap lowered from 90 d to 30 d |
| RC-LOG-SEC | Security (Sicherheitsprotokolle), including identity-provider login and admin events | Detection of attacks whose dwell time exceeds a month; incident reconstruction | Art. 5(1)(e), 32(1)(d), 33(5); BSI minimum standard v2.1 ~90 d (orientation only; not adopted, [D R29-I6]) | **27 d / 30 d** | [D R29-I6] Pseudonymised logs included; 27 d configured, worst case 29 d + 2 h 5 min |
| RC-LOG-FIN | Finance (Finanzprotokolle) | Misuse detection and incident reconstruction for finance actions; who released and who paid is kept in the finance records themselves (K4), not in this log | Art. 5(1)(e); the HGB/AO/LHO duties attach to the **finance records themselves** (K4, §7.13), not to log lines; a log kept for the finance hold would be a shadow ledger (Art. 5(1)(c)) | **27 d / 30 d** | [D R29-I6, A-L1, A-F1] New derivation on 2026-09-25: the security window, because the log's only independent purpose is misuse detection. Re-check against the head-of-finance answers (TASK-073) |
| RC-LOG-AUD | Audit / operator access (Audit- und Betreiberzugriffsprotokolle) | Evidence of vendor and operator access to a council's data (TRD-092 §4); `rp-oac-access` | Art. 5(1)(e), 5(2), 28(3)(h); TRD-191: **never shorter than the security window** | **27 d / 30 d**, bound to RC-LOG-SEC | [D R29-I6] Outlives a customer's erasure; purged from the oldest entry only |
| RC-LOG-TRC | Trace (trace store) | Latency and fault analysis of individual requests; span attributes carry user ids, so the store is personal data [D R19-D27] | Art. 5(1)(e), 5(1)(c); no statutory duty | **7 d / 14 d** | [A] New derivation on 2026-09-25: stricter than the application class, because traces hold per-request user ids and the application log already covers forensic needs beyond a week |

A value above a cap clamps to the cap; a record older than its class window is absent from
the store while a younger record of another class remains (TRD-143 test).

### 4.2 Operator-side logs

The operator's non-council workloads on the same host run in their own compose project and
network with no route to council data, and their footprint is counted apart (TRD-163).
Their logs are **not** part of any council's Löschkonzept; they fall under the operator's
own record of processing. When a log line of the operator-side observability stack names a
council's data subject, it is that council's data and belongs to the class above that
matches it.

### 4.3 Collection rules that go with the windows

- **Source addresses are pseudonymised before persistence** in every service's access log,
  with the same keyed scheme already applied at the edge (TRD-146). A line that cannot be
  pseudonymised is dropped, never stored raw.
- **Pseudonymisation keys** are rotated daily; a retired key is destroyed once the
  RC-LOG-ACC cap has passed for every line it keyed (current generator, `loeschkonzept.ts`
  §4).
- **Actors are ids, never free text** in application and audit logs and in span attributes:
  the platform's internal user or service-account id, not a field that can carry a name
  (TRD-147). Exempt: a module's own required record and the TRD-092 vendor-access record.
- **Query strings are redacted** before persistence; only security-relevant request paths
  are kept in the processed access log (measured in `docker/vector/process-logs.sh`,
  described in `docs/log-retention-policy.md`).

---

## 5. Cache and transient data (class K1)

| Row | Category | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-K1-CACHE | Cache entries holding personal data (application cache tier) | entry written | Art. 5(1)(e), 25; TRD-436: tenant-prefixed keys, short TTL, personal data only if unavoidable | **TTL at most 1 hour**; purged at once on an erasure request for the person the key names. Enforced in the cache configuration, not as a window row (§1.4) | [A] The cache exists to shed peak load; an entry older than an hour no longer serves that purpose better than a fresh read. Entries without personal data are outside this catalogue [D R20-D31] |
| RC-K1-HTTP | HTTP caching of public pages and PDFs | response cached | Art. 5(1)(e) | follows the public record it caches; revalidated on redaction | [D R20-D31] |
| RC-K1-PLUMB | Outbox, inbox, applied-version and scheduled-task rows per context (`rp-<ctx>-plumbing`) | published, redelivery horizon passed, or job done/cancelled/dead; for applied-version rows also source aggregate erased | Art. 5(1)(e), 25 | **7 days** after the start event (for scheduled tasks the schema's '+ grace' is this 7-day value, not the 30-day grace) | [A] Covers the de-duplication and inspection period; after a broker loss the outbox is the replay source, and with no backups in the pilot that is its only purpose beyond delivery |
| RC-K1-SESS | Working sessions: file edit sessions (`rp-fil-editsession`), call sessions (`rp-msg-callsession`) | closed or expired | Art. 5(1)(e), 25 | **24 hours** (edit session); **7 days** (call session metadata) | [A] |
| RC-K1-DRAFT | Protocol autosaves (`rp-gov-autosave`), attendance forecasts (`rp-gov-forecast`), branding drafts (`rp-idt-drafts`) | protocol recorded; meeting closed; draft superseded or discarded | Art. 5(1)(e) | **on event** (autosave, forecast); **grace** (branding draft) | [A] |
| RC-K1-RCPT | Ballot receipts (`rp-gov-ballot-receipt`), unverified public-submitter tokens (`rp-gov-public-submitter-unverified`) | poll tallied; token expiry | Art. 5(1)(e); ballot secrecy | **on event** | settled by purpose |
| RC-K1-IMPORT | Import files and import rows (`rp-idt-import-file`, `rp-idt-import-rows`) | job reaches a terminal state | Art. 5(1)(e), 25 | file **on event**; rows **7 days** (report-download window) | [A] |
| RC-K1-DERIVED | Rebuilt projections: calendar occurrences (`rp-cal-occurrence-cache`), identity-provider projection (`rp-idt-projection`) | rebuilt or synced | Art. 5(1)(e) | **on event** (replaced when rebuilt) | settled by purpose |
| RC-K1-TEST | Records marked test data | test run ends | Art. 5(1)(e) | hard delete by `test_run_id`, **on event**, whatever the class | [D R20-R18-6] |

---

## 6. Backup window (TRD-172, PRD-OPS-007)

TRD-172 requires the backup retention window to be derived by the same method and
recorded in the TOM annex **before** any retention configuration cites a number.

| Row | Category | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-BAK-PILOT | Backups of council data during the pilot, and the verification artefact | verification artefact: RC-BAK-VERIF records the outcome | Art. 32(1)(b)(c); [D R15-1] | **No backup regime exists.** The mechanism is verified exactly once (the hosting provider's restore drill onto the host, and the platform's own dump proven restorable); after that no backups of any kind run for the rest of the pilot, both jobs installed and disabled. The **verification artefact** (the dump and any drill snapshot) is deleted **on event**, once RC-BAK-VERIF records the verification's outcome, and the deletion is logged; only the record survives. No calendar window applies after that, because no backup set exists for it to act on | [A-D6]; artefact deletion [A] |
| RC-BAK-DUMP | Pre-migration safety dump (`rp-ops-migration-dump`, K1) | blue/green switch succeeds | Art. 5(1)(e), 32(1)(c); [D R18-4]; TRD-206 | **on event**: deleted, and `deleted_at` logged, the moment the switch succeeds; restored only when a migration fails before or at the switch | settled |
| RC-BAK-VERIF | The single verification record (`rp-ops-backup-manifest`) | superseded by the next run | Art. 5(2) | kept as the single verification record until the re-init; then the audit window | settled |
| RC-BAK-POST | Backups after the pilot (off-site at a second provider, the north star) | backup written | Art. 5(1)(e), 17, 25, 32(1)(c) | **not derived yet.** Outline of the derivation, to be completed before the mechanism is switched back on: the shortest window that covers the detection latency of silent data loss (the chain-integrity check runs every 6 hours today) plus one monthly review; erasures are replayed on any restore. No number is set by this row [D R15-4] | open |

**The consequence, stated once and cited elsewhere** (PRD-OPS-007): during the pilot a
host, disk, migration or operator failure outside the narrow pre-migration-dump case loses
the council's data unrecoverably, and the council holds no export of its own data before
the offer [D R22-13]. The Grundsatzbeschluss text names this.

**Measured: backup numbers in the code today have no derivation behind them** and must not
be cited by a Löschkonzept or a TOM annex (TRD-172): the per-tenant config default
`backups.retention_days: 30` with a floor of 7 (`gremion-ui/src/lib/server/config.ts`),
`BACKUP_LOCAL_RETENTION_DAYS` default 30 (`scripts/backup.sh`),
`TENANT_BACKUP_RETENTION_DAYS` default 30 (`scripts/tenant-backup.sh`), the same 30-day
`--keep-within` default in `k8s/base/backup/cronjob.yaml`, `BACKUP_RETENTION_DAILY=14`,
`_WEEKLY=8`, `_MONTHLY=6` (`infra/host/templates/env/state.env.tmpl`),
`local_retention_days: 30`, `remote_retention_days: 365` and
`financial_retention_days: 3650` in `infra/hardening/values.yaml` (which calls itself the
single source of truth), and the generator's fixed rows "30 Tage lokal / 365 Tage Remote"
and "3650 Tage Remote" for finance backups (`gremion-ui/src/lib/server/loeschkonzept.ts`).
The same numbers are restated, with a fixed legal basis in place of a derivation, in
`docs/compliance.md`, `docs/compliance/controller-processor-split.md`,
`docs/OPERATIONS.md` and `docs/ops/host-tooling.md`. See §10.

---

## 7. Module content categories

Profiles and start events are those of the schema's table comments (`<DB-id> | <class> |
<rp id> | trigger`), which the purge job and the generator read. Where the schema says
"+ grace", "+ retention window" or "+ n", the value is the one given here.

### 7.1 Tenancy and customer (tnt, core)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-TNT-CUST | Customer registry, realm reference (`rp-tnt-customer`) | customer erased | Art. 5(1)(e), 5(2) | data plane dropped, per-tenant keys shredded (see `docs/compliance.md` §3); the tombstone (id, slug, erased_at, report reference) is kept for the life of the installation so a slug is never reissued | settled |
| RC-TNT-DOM | Domain bindings (`rp-tnt-domain`) | binding retired or customer erased | Art. 5(1)(e) | **grace** | [A-G] |

### 7.2 Identity and membership (idt)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-IDT-PERSON | Person, preferences (`rp-idt-person`) | administrative erasure, subject request, or the end of the person's last membership | Art. 17, 5(1)(e) | **on event** for an administrative erasure or a subject request; **grace** after the end of the last membership (scheduled `person.retention_erase`, cancelled if a new membership starts); personal columns erased in place, `person_id` and pseudonym survive | settled; the grace value [A-G] |
| RC-IDT-STRUCT | Bodies, org units, seats, Wahlperioden (`rp-idt-structure`) | customer erased | Art. 5(1)(e); institutional record | archived, never deleted individually; dropped with the customer | settled |
| RC-IDT-TENURE | Tenures (`rp-idt-tenure`) and governance memberships (`rp-idt-membership-governance`) | term ended | Art. 5(1)(e); Satzung; the records that name the office-holder | **record period**; pseudonymised on request (TRD-160) | [A-L1, A-L4] |
| RC-IDT-HELPER | Non-governance memberships, helpers and initiatives (`rp-idt-membership`) | valid_until | Art. 5(1)(e) | **grace** | [A-G] |
| RC-IDT-CONFIG | Customer settings, roles, capabilities, org-unit kinds (`rp-idt-customer-config`) | customer erased; a retired entry is kept while referenced | Art. 5(1)(e) | with the customer | settled |
| RC-IDT-GRANT | Authorisation grants, expired or revoked (`rp-idt-grant`, `rp-idt-grant-history`) | valid_until or revoked_at | Art. 5(2) | **audit window** | [A-G] |
| RC-IDT-CORR | Corrections (`rp-idt-correction`) | target record purged | Art. 16, 5(2) | with the target | settled |
| RC-IDT-IMPORT | Import jobs (`rp-idt-import`) | terminal state | Art. 5(1)(e) | **grace** (files and rows: RC-K1-IMPORT) | [A-G] |

### 7.3 Meetings, minutes and resolutions (gov)

| Row | Category (profile) | Start event | Basis and periods relied on | Window | Reading |
|---|---|---|---|---|---|
| RC-GOV-MEET | Meetings, agendas, invitations, attendance, quorum checks, attachments, notice overrides (`rp-gov-meeting-record`) | meeting closed | Art. 5(1)(e), 6(1)(e); LHO and Finanzordnung where the meeting authorises spending; archive duty | **record period**, then the archive offer | [A-L1, A-L3] |
| RC-GOV-PROT | Protocols, revisions, parts, approvals, action items, the release log (`rp-gov-protocol-record`) | meeting closed | as RC-GOV-MEET | **record period**, then the archive offer | [A-L1, A-L3] |
| RC-GOV-RES | Resolutions, tallies, named votes, circular resolutions, recorded polls, register entries, electorates, numbering schemes, curing bases (`rp-gov-resolution-record`) | adoption, rejection or recording | as RC-GOV-MEET; Beschlüsse that authorise spending must outlive the vouchers they authorise | **record period**, then the archive offer | [A-L1, A-L3] |
| RC-GOV-CHAIN | Register chain, field commitments, commitment keys, redactions (`rp-gov-register-chain`) | end of the record life of the entries it anchors | Art. 5(1)(e); integrity of the record (PRD-TRU-010) | **never deleted while any entry of the chain is retained**; erasure answered by redaction (§8); then the archive offer | settled |
| RC-GOV-PUB | Released public artefacts, public protocol and register views, public chain anchors (`rp-gov-public-record`, K6) | — | Art. 5(1)(e), 6(1)(e); publication purpose | **never deleted while published**; redaction only; removed on withdrawal or supersession | settled; DPO Q10 may narrow what is published |
| RC-GOV-FINOV | Finance overlay on external references (`rp-gov-finance-overlay`, K4) | end of the budget year of the referenced finance record | LHO, Finanzordnung; HGB § 257 / AO § 147 class | **finance hold**, then back to RC-GOV-MEET | [A-L1, A-L2] |
| RC-GOV-UNPL | Unplaced proposals, lapsed motions (`rp-gov-proposal-unplaced`, `rp-gov-motion-lapsed`) | meeting closed; withdrawal or deferral lapse | Art. 5(1)(e); purpose achieved | **grace** | [A-G] |
| RC-GOV-INVEV | Invitation-recipient evidence (`rp-gov-invitation-evidence`) | end of the challenge window for the meeting's resolutions | Art. 5(1)(e); per-recipient delivery detail while a resolution can be contested | **grace** | [A-L4] The meeting's own invitation record (RC-GOV-MEET) keeps the proof of proper Ladung for the record period; this row holds only per-recipient delivery detail |
| RC-GOV-SECRET | Secret ballots and secret-poll electorates (`rp-gov-secret-ballot`, `rp-gov-secret-electorate`) | result recorded | Art. 5(1)(e); ballot secrecy | **challenge window**; only the tally stays in the record | [A-L4] |
| RC-GOV-OPEN | Open-poll answers (`rp-gov-open-poll-answer`), unrecorded polls (`rp-gov-poll-unrecorded`) | poll closed | Art. 5(1)(e) | **grace**; only the counts stay in the register | [A-G] |
| RC-GOV-CORRQ | Correction requests on protocols (`rp-gov-correction`) | protocol approved | Art. 5(1)(e) | **grace** | [A-G] |
| RC-GOV-SUBM | Public submitters of motions (`rp-gov-public-submitter`) | motion decided or withdrawn, or granted erasure | Art. 5(1)(e), 17 | **grace** | [A-G] |
| RC-GOV-PROJ | Body and member projections, body settings, number counters (`rp-gov-projection`, `rp-gov-body-config`) | body archived; term ended or person erased | Art. 5(1)(e) | **grace** | [A-G] |
| RC-GOV-INTEG | Integrity-check results (`rp-gov-integrity-log`, K5) | check run | Art. 5(2), 32(1)(d) | **security window** (with the audit/operator-access class, RC-LOG-AUD; now 27 d / 30 d) | [D R29-I6] |

### 7.4 Handover (hnd)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-HND-TRACK | Handover tracks and records (`rp-hnd-track`, `rp-hnd-record`, `rp-hnd-record-content`) | office term end | Art. 5(1)(e); the handover purpose ends once two successor terms have had the material | **2 years**; record content erasable in place on request, the commitment stays | [A-L4] Sets the schema's undecided "+ n years" placeholder [D-nc] under this reading |
| RC-HND-SNAP | Continuity snapshots, commitments, redactions, checkpoints (`rp-hnd-snapshot`, K3) | the owning track's RC-HND-TRACK window ends | Art. 5(1)(e); proof of chain integrity only, no content | **audit window** from the end of the owning track's RC-HND-TRACK window; the purge removes the oldest link only after writing a `hnd.chain_checkpoint`; commitments only, never content | [A-G] The schema's own-window placeholder [D-nc] is set here |

### 7.5 Calendar (cal)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-CAL-EVENT | Calendar events (`rp-cal-event`) | event end | Art. 5(1)(e); the council record of a meeting lives in RC-GOV-MEET, so the calendar copy is planning data only | **30 days** (grace) | [A-G] Sets the schema's undecided "+ retention window" placeholder [D-nc] under this reading |
| RC-CAL-ICS | ICS subscriptions (`rp-cal-ics-subscription`) | revoked, or body archived | Art. 5(1)(e) | **grace** | [A-G] |

### 7.6 Files (fil, links to the council's own file store)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-FIL-BIND | Folder bindings (`rp-fil-folderbinding`) | module disabled, or body archived | Art. 5(1)(e) | **grace** | [A-G] |
| RC-FIL-COPY | Filed copies of released documents (`rp-fil-filedcopy`) | release withdrawn, or module disabled | Art. 5(1)(e), 17 | **grace** | [A-G] |

The file contents themselves live in the council's own file store, not in this platform;
their deletion rules are the file store operator's and are out of this catalogue's scope.

### 7.7 Chat and calls (msg)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-MSG-ROOM | Chat rooms (`rp-msg-room`) | hard delete by an ITAdmin; module disabled for the customer; body archived (+ grace, [A], see §9) | Art. 5(1)(e), 17 | **on event**. Archiving a room by an admin starts **no** period (§9) | [D R23-4, D R23-5]; the body-archived trigger [A] (§9) |
| RC-MSG-LINK | Call links (`rp-msg-calllink`) | the owning meeting's window ends | Art. 5(1)(e) | with the meeting | settled |
| RC-MSG-POLL | Chat poll usage (`rp-msg-pollusage`) | verdict recorded | Art. 5(1)(e) | **grace** | [A-G] |

### 7.8 Board, password vault (brd, pwd/vlt; the vault is off by default in the pilot)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-BRD | Boards and cards (`rp-brd-board`, `rp-brd-card`) | module disabled, body archived, or end of the Wahlperiode | Art. 5(1)(e) | **1 year** after the Wahlperiode ends (the successor board's first year); **grace** after disablement | [A-L4] Sets the schema's undecided "+ n" placeholder [D-nc] under this reading |
| RC-PWD | Vault items, collection references, instance configuration (`rp-pwd-native-item`, `rp-pwd-collectionreference`, `rp-pwd-instanceconfig`) | item deleted; body archived; module disabled (export first) | Art. 5(1)(e), 25, 32 | item **on event**; otherwise **grace** | [A-G] |

### 7.9 Public portal (pub)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-PUB-CONT | Content items, publication index, feeds, portal site (`rp-pub-*`) | retraction, feed disabled, module disabled, or customer erased | Art. 5(1)(e) | **grace** after retraction (off the public site at once) | [A-G] |
| RC-PUB-CONTACT | Contact-form submissions (`rp-pub-contactsubmission`) | handled; or received and never handled | Art. 5(1)(e) | **grace** after handling; **90 days** after receipt if never handled | [A] |
| RC-PUB-OFFICE | Published office-holder listing (`rp-pub-officeholder-listing`) | release revoked, or tenure ended | Art. 5(1)(e), 7(3), 17 | off the public site at once; row **grace** | [A-G]; published only after the person releases it [D R21-18] |

### 7.10 Mail (mail)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-MAIL-CONN | Mailbox connectors, send-as grants (`rp-mail-connector`, `rp-mail-sendas-grant`) | disconnected, revoked or expired | Art. 5(1)(e), 5(2) | **grace**; a grant is kept while delivery evidence references it | [A-G] |
| RC-MAIL-EVID | Delivery evidence (`rp-mail-deliveryevidence`) | submitted | Art. 5(1)(e), 5(2); per-recipient delivery detail | **grace** after the challenge window of the meeting it served (as RC-GOV-INVEV); on granted erasure the recipient is pseudonymised | [A-L4, A-G] |

### 7.11 Newsletter (nws)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-NWS-SUB | Subscribers (`rp-nws-subscriber`) | unsubscribe | Art. 5(1)(e), 7(1) (proof of consent) | address **grace** after unsubscribe; the consent evidence (keyed address hash, timestamps) **audit window** | [A-D11] Needs a schema change the newsletter owner makes (evidence split out of `nws.subscriber` or a per-row profile); until then the schema deletes the evidence at grace |
| RC-NWS-ISSUE | Issue content (`rp-nws-issue-content`) and issue facts (`rp-nws-issue-fact`), recipient sends (`rp-nws-recipientsend`) | sent | Art. 5(1)(e), 5(2) | content **1 year** (subject and body set to NULL); facts and recipient sends **audit window** | [A-D11] |
| RC-NWS-TOKEN | Newsletter send tokens (profile id to be confirmed with the newsletter schema owner) | token issued | Art. 5(1)(e) | token expires after **7 days**; expired tokens swept in bulk at **90 days** | [A] Measured as stated in `docs/compliance/controller-processor-split.md` |
| RC-NWS-LIST | Lists (`rp-nws-list`) | list retired | Art. 5(1)(e) | **grace** | [A-G] |

### 7.12 Notifications (ntf)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-NTF-NOTE | Notifications (`rp-ntf-notification`) | read; account erased; or created and never read | Art. 5(1)(e) | **grace** after read; **on event** at account erasure; **90 days** after creation if never read | [A] |
| RC-NTF-OPTIN | E-mail opt-ins (`rp-ntf-emailoptin`) | membership ends, or account erased | Art. 5(1)(e) | **on event** | settled |

### 7.13 Finance and elections (fin, ele; private modules)

| Row | Category (profile) | Start event | Basis and periods relied on | Window | Reading |
|---|---|---|---|---|---|
| RC-FIN-BOOKS | Books, Haushaltsrechnung, annual accounts (finance module, K4) | end of the budget year | LHO and its administrative regulations, the Finanzordnung; HGB § 257(4) / AO § 147(3) as reference | **finance hold: 10 years**, then K3 and the archive offer | [A-L1, A-L2] |
| RC-FIN-VOUCH | Vouchers and payment records (K4) | end of the budget year | as above; the 8-year voucher period of HGB/AO as reference | **finance hold: 8 years**, unless the LHO or Finanzordnung sets longer | [A-L1, A-L2] |
| RC-FIN-CORR | Finance correspondence (K4) | end of the calendar year | HGB § 257(4) business letters, 6 years, where HGB binds | **6 years** (grid value, §1.3) | [A-L2] |
| RC-ELE | Election data (elections module): ballots and electorates follow RC-GOV-SECRET; results follow RC-GOV-RES | result announced | Wahlordnung; ballot secrecy | as the cited rows | [A-L4] |

The schema's `fin` and `ele` contexts carry plumbing tables only (RC-K1-PLUMB); their
content tables belong to module repositories, which cite these rows.

### 7.14 Operations and platform (ops, oac, plt)

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-OPS-ERAS | Erasure requests and per-module reports (`rp-ops-erasure-request`, `rp-ops-erasure-report`) | reported | Art. 5(2), 12, 17 | **audit window**; a subject request is never deleted while it is the sole evidence of the decision | [A-G] |
| RC-OPS-DPIA | DPIA decisions (`rp-ops-dpia-decision`) | superseded for the (customer, module) pair | Art. 5(2), 35 | **audit window** | [A-G] |
| RC-OPS-INC | Incident log (`rp-ops-incident-log`) | confirmed | Art. 33(5), 5(2) | **audit window** (the schema's "security/audit window", §2.2) | [A-G] |
| RC-OPS-RET | Superseded retention windows (`rp-ops-retention-evidence`) | superseded | Art. 5(2) | **audit window**; the current row is never deleted | [A-G] |
| RC-OPS-RUN | Runbook evidence (`rp-ops-runbook-evidence`), provisioning steps and job runs (`rp-plt-provisioning-log`, `rp-plt-job-run-log`) | finished | Art. 5(2), 32(1)(d) | runbook evidence **audit window**; provisioning steps and job runs with RC-LOG-APP | [A-G, D R29-I6] |
| RC-OPS-EXP | Export requests and manifests (`rp-ops-export-request`, `rp-ops-export-manifest`) | delivered, or the 30-day bound elapsed | Art. 5(1)(e), 20 | **on event** | settled |
| RC-OPS-DOCS | Generated Löschkonzepte (`rp-ops-deletion-concept`), release and test records (`rp-ops-release-record`), sub-processor notices (`rp-ops-subprocessor-notice`), continuity disclosures (`rp-ops-continuity-disclosure`), retention catalogue versions (`rp-ops-retention-catalogue`) | superseded; relationship ends | Art. 5(2), 28 | superseded versions kept as history while referenced; sub-processor notices **audit window** after the relationship ends | [A-G] |
| RC-OAC-OPER | Operator identities (`rp-oac-operator`) | engagement ends | Art. 5(1)(e), 5(2) | deferred until the last access entry naming the operator passes RC-LOG-AUD | settled |
| RC-PLT-CAT | Module, version, event-type and contract catalogues; enablements; scheduled-job definitions (`rp-plt-scheduled-job`); vendor domains (`rp-plt-vendor-domain`); the other `rp-plt-*` catalogue profiles | withdrawn, deprecated, or disabled | not personal data except actor ids | with the catalogue entry | settled |
| RC-PLT-ISO | Isolation evidence (`rp-plt-isolation-evidence`) | superseded by the next isolation check | Art. 5(2), 32(1)(d) | **audit window** | [A-G] |

### 7.15 Module default profiles (`plt.module_version.retention_profile_default_id`)

Every in-tree module carries one default profile, `rp-<ctx>-module-data` (TASK-021 Q1,
TASK-077 Q14). The six modules with their own database declare it in `module.json`
`runtime.export.retentionProfile`; the five without a database cannot declare an export
and take a **provisional** id from the operator decision [D R29-I24] (2026-10-01), held in
`packages/provisioning/src/catalogue-rows.ts` until the DPO answers. The ids stay when the
answer arrives; only the windows below are re-dated (§3).

| Row | Category (profile) | Start event | Basis | Window | Reading |
|---|---|---|---|---|---|
| RC-MOD-EXPORT | The (customer, module) `pg_dump` taken before a module database is dropped (TRD-424): board `rp-brd-module-data`, calendar `rp-cal-module-data`, content `rp-pub-module-data`, finance `rp-fin-module-data`, publishing `rp-nws-module-data`, vault `rp-pwd-module-data` | export verified (the module is disabled for the customer) | Art. 5(1)(e); a mistaken disable can be reversed from the export | **grace** (30 days), then the export is deleted; where the export holds K4 finance records, their RC-FIN-* hold prevails and the export is kept until it ends | [A-G, A-MOD] |
| RC-MOD-DATA | Module data the platform still holds for a module **without its own database** when that module is disabled for a customer: elections `rp-ele-module-data`, files `rp-fil-module-data`, handover `rp-hnd-module-data`, messaging `rp-msg-module-data`, votes `rp-gov-module-data` | module disabled for the customer | Art. 5(1)(e), 17 | **provisional: grace** (30 days), then deleted. Categories with their own row keep it: election results and recorded votes (RC-ELE, RC-GOV-RES, RC-GOV-SECRET), handover tracks (RC-HND-TRACK, 2 years), chat rooms (RC-MSG-ROOM, on event); file contents stay in the council's own file store (§7.6) | [D R29-I24] provisional, [A-MOD]; re-dated on the DPO's answer |

---

## 8. Erasure against retention duties (K3, K4, K6)

The reading of [D R15-10] as TRD-160 states it:

1. **The record chain is never altered** (PRD-TRU-010).
2. An erasure request against a person named in an approved protocol, a resolution or the
   chain is answered by a **redaction layer** applied to every served and exported view;
   the redaction is itself a new chain entry.
3. **Exception:** a name that a finance-relevant record must keep legible for its statutory
   duty (HGB § 257 / AO § 147 class, and the LHO under the current reading) stays legible
   until the finance hold ends; the refusal is recorded with its reason and the hold's end
   date (PRD-REG-011). Which record types count as finance-relevant is open [D-nc].
4. Personal data outside chained records is deleted per module, with a per-module report
   (TRD-196).
5. **Archive offer [A-L3].** At the end of a K3 record period, and before any K3 deletion,
   the record set is offered to the competent archive; what the archive declines is
   deleted, what it accepts leaves the platform. Until legal question 17 (and, in part,
   DPO question 7) is answered the offer step is modelled but its applicability is
   unconfirmed.
6. Crypto-shredding is **not** relied on as erasure: no German supervisory authority is
   known to accept key destruction as erasure for a hash-chained record [A]; PRD-REG-012's
   disclosure of what cannot yet be erased stands.

K6 public records follow the same redaction logic, with no deletion period while they stay
published.

---

## 9. Chat rooms: archiving is not erasure

Decided on 2026-09-24 [D R23-4, D R23-5], and required in the Löschkonzept:

- CouncilAdmin and ITAdmin create, rename and **archive** rooms. Archiving is the normal
  path and cannot be undone; members stay joined, history is kept, the room becomes
  read-only and moves to the web list's archive. **Archiving starts no deletion period.**
- **Hard delete** (purge and block) is the erasure path: ITAdmin only, behind a confirm
  dialog, with an audit entry.
- The Löschkonzept names two states for a room: active or archived, where archiving by an
  admin starts no deletion period, and hard-deleted (the act that executes erasure). An
  archived room's history is otherwise kept until the module is disabled for the customer
  or the customer is erased; that this indefinite keeping satisfies Art. 5(1)(e) is [A] and
  goes to the operator and DPO with the other [A-G] readings.
- **Open, not overridden:** the `msg.room` table comment names 'body archived + grace
  period' as a trigger. R23-4/R23-5 decide room archiving by an admin, not what happens
  when the owning body is archived. The messaging schema owner decides whether that
  trigger stays; until then RC-MSG-ROOM lists it as a start event under [A].

---

## 10. Measured gaps in the current code (for L3-15)

Measured in this repository at `release-1/local-integration` @ `1c27e4f` on 2026-09-25.
None of these is fixed by this document; each is an input for TASK-033 (L3-15) or the
owner named.

| # | Finding | Where | Consequence |
|---|---|---|---|
| G1 | The generator prints fixed backup rows ("30 Tage lokal / 365 Tage Remote", finance "3650 Tage Remote") that no derivation backs, and it describes running backups although the pilot runs none | `gremion-ui/src/lib/server/loeschkonzept.ts` §3, §4 | Violates TRD-172 and PRD-OPS-007 as generated; must be replaced by RC-BAK-* |
| G2 | Backup retention figures in config and scripts (30 d, floor 7; 30 d; 14/8/6 generations; 30/365/3650 d) have no derivation | `config.ts`, `scripts/backup.sh`, `scripts/tenant-backup.sh`, `infra/host/templates/env/state.env.tmpl`, `infra/hardening/values.yaml` (30/365/3650), `k8s/base/backup/cronjob.yaml`; restated in `docs/compliance.md`, `docs/compliance/controller-processor-split.md`, `docs/OPERATIONS.md`, `docs/ops/host-tooling.md` | Must not be cited (TRD-172); in the pilot the jobs are disabled |
| G3 | The per-tenant retention config knows four tiers (access, app, security, security without personal data); it has no finance class, no audit/operator-access class and no trace class | `GremionConfig.retention` in `config.ts` | TRD-143's six classes are not yet configurable; L3-15 adds them |
| G4 | The "security without personal data" tier (27 d, cap 30 d since R29-RETENTION-30-K; formerly 90 d, cap 365 d) is not a category of this catalogue | `config.ts`, generator row 4 | Data proven free of personal data is outside the Löschkonzept; anything else falls under RC-LOG-SEC. The former 365-day cap must not apply to entries that name a person |
| G5 | **Closed by R28 + R29 (R29-RETENTION-30).** Formerly: the processed security log and the date-partitioned retention sink aged out after 31 days | `docker/vector/logrotate.conf` | Edge logrotate now keeps access and Traefik logs 14 d, the pseudonymised security log and `retained-*` 27 d (plus `prune-retained.sh`); the worst case across all rules is 29 d + 2 h 5 min (`test-edge-retention-bound.sh`), inside the 30-day cap [D R29-I6] |
| G6 | The kernel's hash-chained `audit_log` table is purged every 24 h at the security window, while `docs/log-retention-policy.md` stated (until R29-RETENTION-30-K) that it is never auto-expired | `gremion-ui/src/hooks.server.ts` (audit-retention tick), `audit-db.ts` `purgeAuditLogsOlderThan` | The two statements contradicted each other; the policy now records the purge (window `security_logs_days`, 27 d default, 29 d cap) and leaves the classification open. Under this catalogue a governance record chain is K3 (RC-GOV-CHAIN), and an access/audit log is K5 (RC-LOG-AUD); L3-15 must still decide which the table is and align the code and the policy |
| G7 | Formerly the generator cited a single fixed legal basis per log tier (a Bavarian DPA recommendation, the BSI minimum standard) instead of the derivation; R29-RETENTION-30-K replaced those citations with the operator ceiling [D R29-I6] and a hint on the tiers no purge consumer enforces. The per-row derivation is still open | `loeschkonzept.ts` §3 | TRD-145 requires the derivation (category, basis, duty, window) per row; this catalogue supplies it |
| G8 | No log store or trace store is configured in this repository yet; identity-provider events expire at 29 d (`eventsExpiration` and `attributes.adminEventsExpiration`: 2505600 s; formerly 7776000 = 90 d, with no admin-event expiry) | `docker/keycloak/realm-export.base.json` | 29 d sits inside the 30-day cap of RC-LOG-SEC [D R29-I6]; Keycloak event lines are off container stdout; the other log streams arrive with L1-20 and L3-15 |

---

## 11. Register of [A] readings

| Id | Reading | Resolved by |
|---|---|---|
| A-M1 | DIN EN ISO/IEC 27555:2025-09 keeps the DIN 66398 Löschklassen method unchanged | Reading the standard's text before the first real Löschkonzept is issued |
| A-L1 | The LHO and the council's Finanzordnung period for minutes, resolutions and finance records | DPO question 7; the head-of-finance answers (TASK-073) |
| A-L2 | Whether HGB § 257 / AO § 147 bind the council at all, and which record types are finance-relevant | DPO question 7 |
| A-L3 | Whether an archive offer duty applies, and which archive is competent | DPO question 7 (in part); legal question 17 |
| A-L4 | Challenge periods and term-based defaults (1 month, 1 year, 2 years) | Each customer's Satzung, Geschäftsordnung and Wahlordnung |
| A-L5 | The redaction reading of Art. 17 against the record chain | DPO question 9 |
| A-G | The grace (30 days) and audit window (3 years) values | Operator and DPO confirmation (op_hours of TASK-070) |
| A-D4 | No catalogue row changes for DPIA reasons | DPO question 4 |
| A-D6 | The pilot's no-backup posture is compatible with Art. 32(1)(b)(c) when the council adopts it knowingly | DPO question 6 |
| A-F1 | The finance log needs only the security window | Head-of-finance answers (TASK-073) |
| A-D8 | Superseded by [D R29-I6]: 30 days for every log class, pseudonymised logs included (formerly the documented tier 14/30, 30/90, 90/180) | DPO question 8 |
| A-D11 | Newsletter consent evidence kept for the audit window | DPO question 11 |
| A-MOD | The five database-less modules' default profiles (RC-MOD-DATA) run on the grace window after a module is disabled; ids provisional under [D R29-I24] | The DPO's written answer, which the operator forwards; then §3's re-dating procedure |
| A | Unlabelled [A] rows (trace, cache TTL, plumbing, working sessions, drafts, import rows, unread notifications, contact forms, verification-artefact deletion) | Operator confirmation; re-dated with the rest |

---

## 12. Sources and decisions

- **PRD:** PRD-REG-013 (derived windows, six log classes, per-customer Löschkonzept);
  PRD-OPS-007 (the pilot backup deviation and its single consequence statement);
  PRD-REG-011, PRD-REG-012, PRD-TRU-010 (erasure against the record).
- **TRD:** TRD-143 (six log classes, derivation, caps), TRD-144 (scheduled purges),
  TRD-145 (generated Löschkonzept), TRD-146 (address pseudonymisation), TRD-147 (actor ids,
  no free text), TRD-163 (non-council workloads apart), TRD-172 (backup window derived and
  recorded in the TOM annex before any number is cited), TRD-191 (vendor-access log never
  shorter than the security window); cited: TRD-140 (TOM annex), TRD-160 (redaction
  reading), TRD-170, TRD-171 (the single verification run), TRD-196, TRD-206, TRD-436.
- **Schema:** DB-OPS-RETENTION-PROFILE, DB-OPS-RETENTION-WINDOW, DB-OPS-DELETION-CONCEPT,
  and the retention comment of every table (`<DB-id> | <class> | <rp id> | trigger`).
- **Operator decisions:** R15-1 (no backups in the pilot after one verification), R15-4
  (retention derived, not set; the "35 nightly + 1 weekly" figure withdrawn), R15-5
  (access-log tier stands only if derived), R15-10 (finance names stay legible), R16-5
  (several log classes), R17-25 (five log streams from the first deploy), R18-4
  (pre-migration dump), R19-D21 (DIN EN ISO/IEC 27555:2025-09, DIN 66398 kept where
  stricter), R19-D27 (trace store as the sixth class), R20-D31 (cache class K1), R20-R18-6
  (test data hard-deleted by test run), R21-6 (DPO questions open), R21-18 (office-holder
  listing by release), R21-24 (date now, re-date on the DPO answers; chase Q4 and Q6),
  R22-13 (no council export before the offer), R23-4 and R23-5 (room archive and ITAdmin
  hard delete).
- **Plan:** TASK-070 (L7-14) acceptance; TASK-033 (L3-15) as the generator and stream
  configuration; TASK-016 (L7-01) for the DPO answers; TASK-073 for the finance answers.
- **Repository, measured 2026-09-25:** `docs/compliance.md`,
  `docs/compliance/controller-processor-split.md`, `docs/OPERATIONS.md`,
  `docs/ops/host-tooling.md`, `docs/log-retention-policy.md`,
  `gremion-ui/src/lib/server/config.ts`, `gremion-ui/src/lib/server/loeschkonzept.ts`,
  `gremion-ui/src/hooks.server.ts`, `gremion-ui/src/lib/server/audit-db.ts`,
  `docker/vector/logrotate.conf`, `docker/keycloak/realm-export.base.json`,
  `scripts/backup.sh`, `scripts/tenant-backup.sh`, `infra/host/templates/env/state.env.tmpl`,
  `infra/hardening/values.yaml`, `k8s/base/backup/cronjob.yaml`.
- **Statutes and standards:** GDPR Art. 5, 7, 12, 16, 17, 20, 24, 25, 28, 32, 33, 35;
  HGB § 257; AO § 147; BGB §§ 195, 199; the Land's LHO and archive law; DIN EN ISO/IEC
  27555:2025-09; DIN 66398:2016-05; BSI IT-Grundschutz OPS.1.1.5; BSI minimum standard on
  logging and detection v2.1; NIST SP 800-92.
