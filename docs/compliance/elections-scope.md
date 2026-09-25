# Elections module: sanctioned scope and wording rules

> **Status: standing rule (TASK-005).** Last reviewed: **2026-09-25**.
> This page fixes what the optional elections module (the Helios overlay on the votes
> module) is for, what may never be said about it, and the check that runs at every
> Helios bump. It applies whether the module is enabled or not.

## 1. Sanctioned scope

- **Internal, non-statutory polling only.** The module may be used by a council for its
  own internal votes and polls. It is **not** for the statutory election of a student
  body, a council or any other elected organ.
- **Statutory elections are a non-goal.** They are run by the university, usually through
  the university's own election service; the platform does not take them over and does
  not compete with them.
- **Off for the pilot.** No council is planned to hold a real election through Helios; the
  module stays switched off for the pilot council.
- **Off by default everywhere else.** For every newly provisioned council the module is
  disabled until an administrator explicitly enables it (PRD-ELE-001; the provisioning
  behaviour and its test belong to TRD-030, not to this page).
- **Honest-scope notice.** Wherever the module is enabled, it shows a notice that it does
  not run the university's statutory election and that it is optional and off by default
  (PRD-ELE-002). Suggested wording:
  - DE: „Dieses Modul führt keine satzungsgemäßen Wahlen der Hochschule durch. Es ist
    optional und standardmäßig ausgeschaltet."
  - EN: "This module does not run the university's statutory elections. It is optional
    and switched off by default."

## 2. What no material may say

Applies to product strings, the public portal, sales material (the offer, the website,
any demo script) and onboarding material, in German and English, **regardless of whether
the module is enabled** (TRD-112):

1. **No statement that online student-body elections are lawful** — in any German Land or
   anywhere else. Their lawfulness is not established, and an unestablished fact is not
   asserted, not even as "in most Länder" or "generally".
2. **No presentation of the module as fit for statutory use** — not as a replacement for
   the university's election, not as meeting an election statute or a Satzung's
   election rules, not as a certified or approved voting system.
3. **No legal claim about secret polls.** The product may describe the secrecy
   properties it demonstrably has (one vote per eligible member; no retrievable link
   between a voter and a choice; a result recorded with the eligibility count and the
   number of votes cast). It says nothing about whether such a poll satisfies any
   Satzung's secret-ballot requirement.

**Forbidden phrasings** (the marketing-copy check, `make lint-compliance`, described in
[licence-register.md](licence-register.md), section 5, reads this table and fails on
every quoted phrasing in it; the list is a floor, not a whitelist of everything else):

| German | English |
|---|---|
| „rechtssichere Wahl", „rechtssichere Online-Wahl" | "legally compliant election", "legally secure election" |
| „rechtsgültige Wahl", „rechtskonforme Wahl" | "legally valid election", "lawful online election" |
| „zulässig nach Landesrecht", „in allen Bundesländern zulässig" | "permitted in every German state", "lawful in [any Land]" |
| „für satzungsgemäße Wahlen geeignet", „ersetzt die Hochschulwahl" | "suitable for statutory elections", "replaces the university election" |
| „amtliche Wahl", „offizielle Gremienwahl" | "official election", "binding student-body election" |
| „zertifiziertes Wahlsystem", „BSI-zertifiziert" (für dieses Modul) | "certified voting system", "government-approved e-voting" |

**Allowed** (descriptive, no legal or statutory claim): „interne Abstimmungen und
Umfragen des Gremiums", „optionales Modul, standardmäßig aus", "internal council polls",
"optional module, off by default", and the secrecy properties of point 3 stated as
product properties.

**Measured state on 2026-09-25:** a search of this repository's product strings,
public portal, `README.md` and `docs/about-gremion.md` for lawfulness or statutory-fitness
phrasing about elections found **no violation**. One product string was reviewed as
borderline and is left to the PRD-ELE-002 wording pass: the settings description
`settings.admin.elections.desc` reads „Umfragen und geheime Wahlen konfigurieren". It
makes no lawfulness claim, but "Wahlen" without the scope notice can be read as
statutory elections; the notice of section 1 is what disambiguates it.

## 3. Before any statutory use (dormant)

If the module is ever considered for statutory use — which the current scope excludes —
two deferred low-severity findings in the Helios integration (one about how a service
credential is stored, one about how an identity token is validated) are re-triaged and
fixed if still open, and a **dated re-triage record predates the enablement**
(TRD-110). While the pilot decision to keep the module off holds, this carries no open
action. The findings themselves are tracked in the project's private security record,
not here.

## 4. The Helios bump check

At **every** bump of the Helios submodule, the repository that carries the submodule
runs:

```sh
# before committing a bump (checks the staged gitlink):
ops/scripts/helios-submodule-check.sh --repo . --path helios-src
# in CI (checks the committed gitlink):
ops/scripts/helios-submodule-check.sh --repo . --path helios-src --rev HEAD
```

(`ops/scripts/` is in the kernel repository; a consuming repository calls it from its
kernel checkout.) The script reads `.python-version` and `LICENSE` **from the commit the
superproject pins**, not from the submodule's working tree, and blocks the bump unless
`.python-version` names Python 3.13 or a later 3.x and `LICENSE` is the Apache License
2.0 text with no other licence's terms added (TRD-268). Exit 1 means the pin fails a
check; exit 2 means the check could not run (no gitlink, submodule not initialised,
pinned commit not fetched). **Both block the bump.**

On success it prints one record line; paste it into the bump's commit message or PR
description, which is where the per-bump record lives. The result recorded for the pin
current on 2026-09-25:

```text
helios-submodule-check: PASS commit=c7d5e60fbf9123be13d250a2ad9dae9efd8978e3 python=3.13 licence=Apache-2.0 file=LICENSE source=HEAD
```

The script's tests: `node --test ops/scripts/helios-submodule-check.test.mjs` (14 cases:
pass, later 3.x, below 3.13, missing or unparseable `.python-version`, non-Apache,
Apache plus other terms, missing `LICENSE`, pinned commit versus working tree, staged
bump versus `--rev HEAD`, pinned commit not fetched, submodule not initialised, path not
a gitlink, bad argument). Set `HELIOS_CHECK_TEST_TMP` to move the fixture directory off
the system temp directory, and `BASH_BIN` to choose the bash binary.

**Not wired yet:** the Helios submodule does not live in this repository, so no hook or
CI job here can see a bump. The repository that carries it wires the two commands above
into its own pre-commit hook and CI; until then the check is run by hand at each bump.

## 5. Sources and decisions

- **TRD-112** — no product, sales or onboarding material asserts that online
  student-body elections are lawful in any Land or presents the module as fit for
  statutory use; inspected each release, regardless of module status (section 2).
- **TRD-110** — re-triage of the two deferred Helios findings before any statutory use;
  dormant while the module is off (section 3).
- **TRD-268** — Helios's pinned commit reports Python 3.13+ and Apache-2.0, re-verified
  at every bump (section 4). **TRD-265** — the licence register this page's check shares
  with ([licence-register.md](licence-register.md)).
- **TRD-030** — default-disabled provisioning (owned there; cited in section 1).
- **PRD-ELE-001** (Must) — default off for newly provisioned councils; **PRD-ELE-002**
  (Should) — the honest-scope notice; **PRD-TRU-009** — the forbidden-word discipline for
  product copy; **PRD section 2.4** — lawfulness of online student-body elections is not
  established and must not be asserted; **PRD section 11.4** — the secret poll is a
  product property, not a legal claim.
- **Operator decisions:** R4-6 (statutory elections are run by the university; secret
  votes and circulated resolutions happen elsewhere today); R4-10 (online elections stay
  fully optional, even after twelve months); R10-10 (no council holds real elections
  through Helios now; module off); R13-3 (the votes module is on for the pilot, Helios
  off); R18 §15.1 C12 and C13 (PRD-ELE-001 raised to Must; PRD-ELE-002 confirmed as
  Should); R22-14 (TASK-005's build work is due before the offer); R23-24 (2026-09-25:
  standing and later units pulled forward and run in parallel).
