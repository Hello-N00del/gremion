# Run record

Every run of a procedure leaves one record. Its fields are exactly the columns
of the procedure-run record the platform keeps (DB-OPS-RUNBOOK-PROCEDURE-RUN),
so a record written by hand today and a row written by the control plane later
carry the same facts. Records are filed in the deployment's private annex, never
in this repository; this page holds the template and no dated record.

| Column | What goes in it |
|---|---|
| `procedure_kind` | `install`, `upgrade`, `backup` or `restore` |
| `scope` | `platform` or `customer` |
| `customer_id` | the customer's id; empty when `scope` is `platform` |
| `performed_by_kind` | `person`, `operator` or `external` |
| `performed_by` | a pseudonymous id, never a name (R12-11); empty when `performed_by_kind` is `external` |
| `non_vendor` | `true` when the person is not the vendor; always `false` when `performed_by_kind` is `operator` |
| `started_at` | when step 1 began, UTC, ISO 8601 |
| `finished_at` | when the post-condition was asserted, UTC, ISO 8601 |
| `wall_clock_minutes` | derived from `started_at` and `finished_at`, never typed in |
| `post_condition_met` | `true` only when every post-condition line read as the procedure says |
| `published_ref` | `docs/ops/runbook/<procedure>.md@<version>+<commit>`, at most 500 characters |

## What a record also carries

The columns say whether a run worked. The annex entry that carries a record also
keeps what the procedure asks to be kept: the output of every post-condition
block as it was read, every `MANUAL:` step's recorded time, every step recorded
as blocked by a pending dependency (`BLOCKED:` and the task named), and for a
restore the measured figures (arm A: restore start to host available; arm B: the
`RTO-SECONDS=` value; arm C: boot to gate pass, to the first good probe and to
the first sign-in). A run whose post-condition was not met is still recorded,
with the step that failed and why.

## Template

```text
procedure_kind:
scope:
customer_id:
performed_by_kind:
performed_by:
non_vendor:
started_at:
finished_at:
wall_clock_minutes:        (derived)
post_condition_met:
published_ref:
```
