# Release cadence

- Status: accepted policy
- Date: 2026-09-25
- Implements: PRD-PLAT-003; TRD-355, TRD-357, TRD-358, TRD-359; FLOW-OPS-010
- Plan unit: TASK-013 (L1-32)

This document is the vendor's published policy for **when** a Gremion release
may reach a hosted council. It does not describe **how** a release is built or
deployed; that is the release/deploy tooling listed under
[Related documents](#related-documents). The release/deploy plan units (L1-14,
L1-19..21, L1-31) implement against this policy, not the other way round.

The policy has four rules. Rules 1 and 2 are the normal regime; rule 3 replaces
them while a named pilot is running; rule 4 overrides all three.

## Terms

| Term | Meaning in this document |
|---|---|
| **Release** | One annotated `dist-vX.Y.Z` tag, deployed through `.github/workflows/deploy.yml` and `infra/host/bin/gremion-deploy`. |
| **Feature release** | A release that changes what users can see or do, or how they work. Every release that is not a security fix is treated as a feature release. |
| **Security fix** | A release whose only purpose is to close a security vulnerability. How a release that also carries feature changes is treated is an open point (see [Open points](#open-points)). |
| **Semester break** | The lecture-free period between two semesters at the hosted council's institution. There are two per year. |
| **Release cycle** | The span from one semester-break release window to the next. |
| **Named pilot** | A pilot with a hosted council that is named in a written pilot agreement and has a stated end date. |
| **Hosted council** | A council whose instance the vendor operates. |

## Rule 1 — at most two feature releases a year, at semester breaks (TRD-355)

Outside a named pilot, feature releases ship **at most twice a year**, each one
**inside a semester break**. A third feature release in the same year is a
policy breach, whatever its size.

Every feature release carries, **before it is announced**:

1. a **dated change list in German and in English**, published with the
   release. The change list is published, not sent: no e-mail or push message
   to members announces it (FLOW-OPS-010, PRD-SUP-004). It is published before
   the traffic switch to the new colour (FLOW-OPS-010, PRD-SUP-004, PRD-SUP-009);
2. **updated training material** covering every change the list names.

A feature release without both artefacts is not announced, and without its
change list it is not switched to.

## Rule 2 — a hosted council may defer one feature release by one cycle (TRD-357)

A hosted council may ask to **defer one feature release by one release
cycle**. The request is made by the council's digital officer (the
`CouncilAdmin` role; FLOW-OPS-010). The deferred release then reaches that
council in the next semester-break window instead.

- Each deferral is **recorded**, dated, with the release tag it defers and the
  cycle it defers to.
- A deferral covers **one** release for **one** cycle. Deferring the next
  release as well needs a fresh request; a second consecutive deferral without
  one is a breach.
- A deferral never delays a security fix (rule 4).

## Rule 3 — the cadence is suspended during a named pilot (TRD-358)

While a named pilot is running, **rules 1 and 2 are suspended by agreement
with the pilot council**, until the pilot's stated end date. Feature releases
may then ship outside semester breaks and more often than twice a year.

- The suspension exists only through a **dated agreement record** with the
  pilot council. No non-security feature release ships during the pilot without
  one.
- The suspension ends on the pilot's stated end date. From then on rules 1 and
  2 apply again.
- The pilot council has said it is wary of repeated process changes [E R2-2].
  The suspension makes more frequent releases *possible*; it is not a mandate
  to ship often.

## Rule 4 — security fixes ship at any time (TRD-359)

A security fix is **exempt from rule 1 and from the deferral right in rule 2**.
It may ship at any time, outside a semester break, and no deferral is checked
before it ships. The suspension in rule 3 is irrelevant to it.

Affected councils are informed about a security fix under PRD-DEP-003, on the
same schedule as the fix itself.

The exemption follows established patch-management practice: ISO/IEC
27001:2022 Annex A control 8.8 (management of technical vulnerabilities) and
BSI IT-Grundschutz OPS.1.1.3 (patch and change management, edition 2023).

## How a release moves (FLOW-OPS-010)

The cadence decides *whether* a release may ship. Once it may, a release
follows FLOW-OPS-010, web only, run by the platform operator. This is the
target flow the release/deploy units implement; the current host tooling (see
below) does not yet take the short-lived dump or write test records:

1. The feature release is prepared and its DE/EN change list is written.
2. If the release carries a schema migration, a short-lived database dump is
   taken first (FLOW-OPS-010; decided for the pilot in [D R18-4]). It is not a
   backup regime.
3. The idle colour is built and its health is checked per container, with no
   manual override (TRD-179, TRD-189). The check writes marked test records
   into the pilot tenant and removes them afterwards.
4. Health failed: traffic stays on the current colour, and the dump is
   restored if the migration failed. Health passed: traffic switches to the
   new colour and the dump is deleted. No step is manual.
5. If the hosted council has deferred this release (rule 2), it waits one
   cycle; otherwise it is active at that council.

A security fix (rule 4) runs steps 1–4 but skips step 5.

The dump in steps 2 and 4 is distinct from the pre-release restic snapshot that
`gremion-deploy` takes and `gremion-rollback` keeps or forgets; see
`docs/ops/host-tooling.md` for the snapshot.

## Evidence an auditor can inspect

| Rule | What must exist | Fails when |
|---|---|---|
| 1 (TRD-355) | For every feature-release tag outside a named pilot: a dated DE/EN change list and updated training material, both in place before the announcement | either artefact is missing or later than the announcement; a third feature release ships in one year |
| 2 (TRD-357) | A deferral record per deferral: date, release tag, the cycle it defers to | a second consecutive deferral exists without its own request |
| 3 (TRD-358) | A dated agreement record with the pilot council covering the pilot period | a non-security feature release ships during the pilot without it |
| 4 (TRD-359) | The security fix shipped outside the window with no deferral check, and the PRD-DEP-003 notice to affected councils | the fix waited for a window or a deferral, or the notice lagged the fix |

Records are kept in the deployment's private annex (see
`docs/ops/go-live-gate.md`), not in this repository.

## Open points

These are not decided by the sources below and are left open rather than
guessed:

- **Counting basis for "twice a year".** Calendar year or any twelve-month
  span is not stated. Until decided, both readings must hold.
- **Non-security bug fixes.** The sources distinguish only feature releases
  and security fixes. This policy therefore treats a bug-fix release as a
  feature release (see [Terms](#terms)); a separate fast lane for bug fixes
  would need an operator decision.
- **Where the change list and training material are published**, and where the
  deferral and agreement records are filed, is for the release/deploy units to
  fix.
- **Unconfirmed parts.** The bilingual change list and updated training
  material (TRD-355), the deferral right (TRD-357) and the pilot suspension
  (TRD-358) are marked in the TRD as not yet confirmed by the operator
  [D-nc]; only the cadence itself and the security-fix exemption rest on a
  confirmed decision [D R5-2].
- **Mixed releases.** Whether a security fix bundled with feature changes may
  use the rule 4 exemption is not stated in the sources.

## Related documents

- `.github/workflows/deploy.yml` — the only path a release tag takes to a host.
- `infra/host/bin/gremion-deploy`, `gremion-switch`, `gremion-rollback` — the
  host half: blue/green colours, health wait, switch and rollback.
- `docs/ops/host-tooling.md` — the host tooling, including the pre-release
  snapshot.
- `docs/ops/go-live-gate.md` — the gate an instance passes before real users.
- `docs/ops/release-1-waivers.md` — what release 1 waived from that gate.
- `docs/architecture/decision-log.md` — DL-002, the dump-before-migration rule.
- `SECURITY.md` — how security issues are reported.

## Sources and decisions

| Rule | Requirement ids | Decision basis |
|---|---|---|
| 1 | PRD-PLAT-003, TRD-355 | cadence of two feature releases a year at semester breaks, security fixes any time [D R5-2]; dated bilingual change list and training material [D R18, PRD 15.1 A5], marked not yet confirmed in TRD-355; change fatigue is a stated council concern [E R2-2]. TRD-105 and TRD-186..188 retire into TRD-355, TRD-357, TRD-358, TRD-359. |
| 2 | PRD-PLAT-003, TRD-357, PRD-DEP-003 | deferral right [D R18, PRD 15.1 A5]; not yet confirmed in TRD-357 [D-nc] |
| 3 | PRD-PLAT-003, TRD-358 | pilot suspension [D R18, PRD 15.1 A5]; not yet confirmed in TRD-358 [D-nc] |
| 4 | PRD-PLAT-003, PRD-DEP-003, TRD-359 | [D R5-2]; ISO/IEC 27001:2022 Annex A 8.8; BSI IT-Grundschutz OPS.1.1.3 (edition 2023) |
| Flow | FLOW-OPS-010; PRD-SUP-004, PRD-SUP-009; TRD-179, TRD-189 | one dump before each schema migration, deleted after a successful switch, not a backup regime [D R18-4] |
