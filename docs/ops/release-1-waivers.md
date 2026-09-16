# Release 1 — waived gate items (P4)

**Release 1 is a deployment bar, not the go-live gate.** Every technical proof
in `docs/ops/go-live-gate.md` that release 1 can prove, it must prove. Six items
cannot be proven before the pilot because they need an operator decision, a
purchase, a DNS edit or a real council's identity. They are waived **by name**
here so that "deployed" is never read as "gated".

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
| `offsite-backup-remote` | §L:2 | G2-RESTORE | the off-site backup remote and the `offsite: true` assertion over it. The measured local restore of §L:2 is **not waived**, and release 1 must record its RTO as a number | the remote is a purchased off-box destination; no credential and no target exist before the pilot | OPERATOR, before G2-RESTORE |
| `external-probe-and-alerting` | §L:6 | G6-OFFBOX | the external uptime probe and the alert vendor, and the deliberate-failure proof over them | an off-box vendor account, outside the distribution | OPERATOR, before G6-OFFBOX |
| `mail-bringup` | §L:4 | G4-MAIL | the mail bring-up asserts 1–6, the real MX record, and SNDS / JMRP / Postmaster enrolment | needs the second address, its PTR and published DNS; the zone still carries the null MX | OPERATOR, before G4-MAIL. The live `gremion-mail-bringup --assert 6b` run (a real reset mail with dkim/spf/dmarc pass) is recorded in this row when it happens; it is not a B2 gate |
| `legal-documents` | §L:1 | G1-LEGAL | Impressum, Datenschutz, DPIA, ROPA, AVV and the accessibility statement as signed documents | they name a legal entity that does not exist until the pilot council signs | OPERATOR, before G1-LEGAL |
| `apex-dns` | §L:5 | G5-TENANT | the apex DNS edits for the production domain | the apex is edited once, at cutover; editing it early points real names at an ungated deployment | OPERATOR, before G5-TENANT |
| `pilot-inputs` | §L:5 | G5-TENANT | the pilot council's identity, real names, wording and legal texts | operator-supplied content; fixtures must not stand in for it | OPERATOR, before G5-TENANT |

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

## Signature

| Field | Value |
|---|---|
| Waived by | the operator, in the decision batch of 2026-09-15 |
| Scope | release 1 only. Each row names the gate that lifts it |
| Review | every row is re-read at the go-live gate; a row still standing then blocks the gate |
