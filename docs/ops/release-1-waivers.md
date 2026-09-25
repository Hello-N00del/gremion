# Release 1 — waived gate items (P4)

**Release 1 is a deployment bar, not the go-live gate.** Every technical proof
in `docs/ops/go-live-gate.md` that release 1 can prove, it must prove. Six items
were waived at the 2026-09-15 decision batch because they needed an operator
decision, a purchase, a DNS edit or a real council's identity. They were waived
**by name** here so that "deployed" is never read as "gated".

**Amended 2026-09-24 (PRD §17.1 P4, PRD-REC-006; TASK-011).** Two of the six —
`mail-bringup` and `external-probe-and-alerting` — leave the active table below
and move to "Lifted waivers", dated, per PRD §17.1 P4's ADJUST verdict. A third,
`offsite-backup-remote`, stays active and unchanged in scope — but that is
flagged as an open item and closed the same day by the operator: nothing
was waived over the provider-side item, so nothing is lifted [D R23-3]. Four items remain in the active table:
`offsite-backup-remote`, `legal-documents`, `apex-dns`, `pilot-inputs`. See
"Change log" at the end of this file for the dated detail; rows are never
deleted, only moved and annotated.

**Open items from this amendment (operator/planner sign-off needed, same
visibility for both):**
1. `external-probe-and-alerting` — lifted per the P4 instruction, but no PLAN
   task currently demonstrates PRD-OPS-008. See the "Lifted waivers" row.
2. `offsite-backup-remote` — TASK-011's acceptance text says "the
   provider-side backup remote... leave[s] the waiver list," but the row as
   written on 2026-09-15 never waived a provider-side item — only the true
   off-site (second-provider) copy. TASK-089 demonstrates the provider-side
   restore, but there is no provider-side waiver to remove for it. See the
   row's amendment note for the two ways to close this. **Closed 2026-09-24
   [D R23-3]: the operator chose (a)** — nothing was waived, so nothing is
   lifted; TASK-089's demonstration satisfies PRD-REC-006 for this item.

A waiver is not a pass. `gremion-verify` reads this file out of the release tree
(`current/docs/ops/release-1-waivers.md`) on every run, prints each of the six as
`WAIVED` with its §L item number and its gate id, and never as `OK`; a waived
item is a third state in `runtime/last-verify.json` (`waivers[]`), not a green
one. The table below is therefore a machine contract as well as a document: the
row shape `| \`id\` | §L:n | GATE | … |` is what the verifier parses, and
`test/host/release-1-waivers.bats` pins it.

Authority: spec B §1.4 and §G
(`docs/superpowers/specs/spec-b-kernel-portback-relocatability-release-design.md`),
on the decisions of 2026-09-15. §L item numbers are the go-live sequence of the
private host design; the gate id is the corresponding section of
`docs/ops/go-live-gate.md` — the off-site row's anchor is that document's
`.offsite == true` assertion inside G2-RESTORE (`go-live-gate.md:84`).

| Waiver id | §L item | Gate | What is waived | Why it cannot be proven at release 1 | Lifted by |
|---|---|---|---|---|---|
| `offsite-backup-remote` | §L:2 | G2-RESTORE | the off-site (second-provider) backup remote and the `offsite: true` assertion over it — **unchanged 2026-09-24; the open item on it was closed the same day, nothing to lift [D R23-3] (see "Open items" above)**. The measured local restore (provider-side) of §L:2 is **not waived**, and release 1 must record its RTO as a number; that provider-side drill is demonstrated by TASK-089 (one-off backup verification and provider restore drill, after which both backup jobs are switched off). TASK-011's acceptance text and PLAN §7's B0 reuse line both say "the provider-side backup remote... leave[s] the waiver list," but this row, as written on 2026-09-15, never waived a provider-side item — only the off-site (second-provider) copy, which PRD-OPS-007 keeps outside pilot scope ("the north star, funded once paying councils exist"). So TASK-089 demonstrates the provider-side restore PRD-REC-006 asks for, but there is no provider-side waiver here to lift; whether that satisfies PRD-REC-006 in full, or the row should instead be split so a provider-side line moves to "Lifted waivers" for symmetry with mail and the probe/vendor item, is left to the operator/planner — see delta record §5 | the second-provider remote is a purchased off-box destination; no credential and no target exist before the pilot, and PRD-OPS-007 defers it past the pilot | OPERATOR, before G2-RESTORE |
| `legal-documents` | §L:1 | G1-LEGAL | Impressum, Datenschutz, DPIA, ROPA, AVV and the accessibility statement as signed documents | they name a legal entity that does not exist until the pilot council signs | OPERATOR, before G1-LEGAL |
| `apex-dns` | §L:5 | G5-TENANT | the apex DNS edits for the production domain | the apex is edited once, at cutover; editing it early points real names at an ungated deployment | OPERATOR, before G5-TENANT |
| `pilot-inputs` | §L:5 | G5-TENANT | the pilot council's identity, real names, wording and legal texts | operator-supplied content; fixtures must not stand in for it | OPERATOR, before G5-TENANT |

## Lifted waivers (dated)

Rows below no longer stand in the active table above. A lifted row is never deleted from this
file — it is recorded here with the date it was lifted, the requirement that lifted it, and what now
demonstrates it (or, if nothing yet does, that gap named explicitly).

| Waiver id (former) | §L item | Gate | Lifted | Demonstrated by |
|---|---|---|---|---|
| `mail-bringup` | §L:4 | G4-MAIL | **2026-09-24**, PRD §17.1 P4 / PRD-REC-006 (TASK-011). Condition for the fall — PRD-MTG-002a raised to Must — already holds. | TASK-015 (self-hosted Stalwart mail server on the vendor domain; SPF/DKIM/DMARC pass; inbox delivery to one large consumer mailbox and one university mailbox), per the PRD-REC-006 requirements-traceability row (TASK-011, TASK-015, TASK-089). Originally: the mail bring-up asserts 1–6, the real MX record, and SNDS / JMRP / Postmaster enrolment — needed the second address, its PTR and published DNS; the zone carried the null MX. |
| `external-probe-and-alerting` | §L:6 | G6-OFFBOX | **2026-09-24**, PRD §17.1 P4 / PRD-REC-006 (TASK-011) names it as one of the three that fall. **Open gap, not a clean close**: PLAN's own requirements table scores the corresponding requirement, PRD-OPS-008 (independent status page), as Should and defers it to P4/12-month scope, stating "no other task claims it." PRD-REC-006 is a Must naming the probe/alert vendor as a gate item before the pilot's invitation is accepted. No PLAN task currently demonstrates this item. Flagged for the operator/planner to assign a task, or re-scope PRD-REC-006, before that gate binds. | none yet — gap, see note |

## What is NOT waived

Every other item is a technical proof release 1 must pass against the running
box: the login journey; `gremion-verify` green on the public routers and through
the loopback `internaltest` entrypoint; the reboot gate (§L:3 / G3-VERIFY),
installed and enabled by `infra/host/bootstrap.sh` and asserted after a real
reboot; colour switch, switch-back and rollback exercised on the box; a backup
covering every database, volume and bucket with a **measured** restore
(§L:2 / G2-RESTORE, off-site half excepted above); and the leaf half of the
erasure proof (§L:7 / G7-ERASURE — the tenant-erasure half is spec C's).

## Named residuals (not waivers)

A residual is something release 1 ships **with**, knowingly. It suspends no gate
item, so it is not a row above and `gremion-verify` does not print it.

- **Module-repo installs are not frozen-lockfile reproducible.** During the
  interim the root `package.json` and `pnpm-workspace.yaml` of a module
  repository are written at CI run time and no lockfile is committed there, so
  a module-repo install is not `--frozen-lockfile` reproducible until the D-05
  exit. The committed **assembled** lockfile (B-17), next to the release pins,
  stays the only lockfile that gates an image build.

## Change log

Dated lines only; a change is added here, never substituted for the row it describes.

- **2026-09-24 (TASK-011, PRD §17.1 P4, PRD-REC-006):** `mail-bringup` and
  `external-probe-and-alerting` moved from the active table to "Lifted waivers".
  `mail-bringup` demonstrated by TASK-015. `external-probe-and-alerting` lifted
  per the P4 instruction but flagged as an open gap — no PLAN task currently
  demonstrates PRD-OPS-008 (scored Should, deferred to P4/12-month scope in
  PLAN's own requirements table). `offsite-backup-remote` kept active,
  unchanged in scope; annotated with TASK-089 as the demonstrating task for the
  provider-side (local) restore drill that row already carried as "not
  waived", and with PRD-OPS-007's basis for keeping the true off-site
  (second-provider) copy out of pilot scope. **Flagged as a second open item,
  same visibility as the probe/vendor gap**: TASK-011's and PLAN §7's own
  acceptance text say the provider-side backup remote "leaves the waiver
  list," but nothing was actually waived over it before today, so nothing was
  removed — left for the operator/planner to decide whether TASK-089 already
  satisfies PRD-REC-006 for this item or whether the row should be split for
  symmetry with mail/probe. `apex-dns` unchanged. Full reasoning and the PRD
  §17.1 verdict-by-verdict table: `docs/plan/release-1-delta.md`.
- **2026-09-24 (operator decision R23-3):** the `offsite-backup-remote` open item
  is closed with option (a): nothing was waived over the provider-side item, so
  nothing is lifted, and TASK-089's provider restore drill satisfies
  PRD-REC-006 for it. The off-site (second-provider) copy stays waived. The
  probe/alert vendor gap (PRD-OPS-008) stays open.

## Signature

| Field | Value |
|---|---|
| Waived by | the operator, in the decision batch of 2026-09-15 |
| Amended by | TASK-011, 2026-09-24, per PRD §17.1 P4 and PRD-REC-006 — see Change log |
| Scope | release 1 only. Each row names the gate that lifts it |
| Review | every row is re-read at the go-live gate; a row still standing then blocks the gate |
