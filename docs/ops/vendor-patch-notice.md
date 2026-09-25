# Vendor security-patch notices for bundled third-party systems

- Status: accepted procedure (standing — applies from the first bundled-system
  security patch onward and is not tied to a build phase)
- Date: 2026-09-25
- Implements: PRD-DEP-003; TRD-106, TRD-096
- Plan unit: TASK-002 (L1-26)

Gremion ships several third-party systems that the vendor does not write. When
one of their upstream projects releases a security patch, every council
running Gremion has to learn three things from the vendor: **which system is
affected**, **the risk if it stays unpatched**, and **the date the patch was
applied, or will be**. This document is the procedure that makes that happen
for hosted and self-hosted councils alike. It also covers a second duty with
the same trigger point (a release): re-assessing the ASVS Level 2 exception list
when a major release changes which components are in scope.

It is a procedure, not tooling. Nothing in this repository sends a notice
automatically; the steps below are carried out by the platform operator.

## 1. Scope — the bundled systems

PRD-DEP-003 and TRD-106 name five systems. This table shows where each one
actually lives and what version is pinned, measured in this repository on
2026-09-25. A notice has to name the version a council actually runs, so the
**source of truth for the version is the release being shipped** (its
`docker-compose.pins.yml`, which `deploy.yml` requires at the tag's tree
root), not this table. The release workflow that is to write that file is
specified but not yet in this repository; see `docs/deployment-architecture.md`.

| System | Role in Gremion | Where it is defined | Version recorded in this repository (2026-09-25) |
|---|---|---|---|
| **Keycloak** | identity provider for every tenant realm | kernel: `docker-compose.yml` (`keycloak` service), `k8s/base/keycloak/deployment.yaml` | upstream `keycloak/keycloak` image, tag `26.6.1`, pinned by tag in both places |
| **Synapse** (Matrix homeserver) | chat and rooms for the messages module | module-owned, not in this repository (the messages module ships it) | no pin here; `docs/ops/topology.md` §1 records a locally built `matrix` image on the pilot host; `docs/ops/postgres-major.md` checked Synapse 1.160's support matrix, which is not a pin |
| **LiveKit** (SFU, with its JWT auth-service) | audio/video calls | module-owned, not in this repository | no pin here; `docs/ops/topology.md` §2 records the target `livekit-server:v1.7.2`, not yet deployed (`[A]`, pin at re-init) |
| **Element Call** | call front end on top of LiveKit | module-owned, not in this repository; its config is rendered by `gremion-render` (`docs/ops/host-tooling.md`) | no version recorded anywhere in this repository |
| **Helios** | verifiable elections (elections module) | module-owned, not in this repository (`.github/workflows/ci.yml` notes it is absent) | no pin here; `docs/ops/topology.md` records a host-local image on a floating `:latest` tag (`[A]`, pin at re-init) |

Consequence: until the re-init pins land, four of the five systems have no
version fixed in a Gremion release artefact. Until that changes, a notice
states the version the operator observed on the hosted instance (e.g. with
`docker image inspect`) and says so. Other third-party components, such as
PostgreSQL, Traefik, Nextcloud, Collabora and PgBouncer, are **outside** PRD-DEP-003's
list. Following this procedure for them too is recommended but is not a
requirement (see [Open points](#8-open-points)).

## 2. Trigger — upstream advisory sources

The procedure starts when **any** security patch is published for one of the
five systems, whether or not Gremion turns out to be affected. The operator
watches these sources. Subscribing to GitHub's per-repository "security
advisories" watch setting and to the release feed covers most of them:

| System | Primary advisory source | Also watch |
|---|---|---|
| Keycloak | GitHub security advisories of `keycloak/keycloak` | Keycloak release notes (upstream project site and GitHub releases) |
| Synapse | GitHub security advisories of `element-hq/synapse` | Synapse release notes on the same repository; the Matrix project's security announcements |
| LiveKit | GitHub security advisories of `livekit/livekit` | the JWT auth-service's repository (advisories and releases) |
| Element Call | GitHub security advisories of `element-hq/element-call` | its release notes |
| Helios | the upstream `helios-server` repository (releases, commits, issues). It has no dedicated advisory feed, so releases have to be watched and read by hand | the module's own repository, since Gremion builds the image locally |

Cross-check source for all five: the GitHub Advisory Database, the CVE record,
and the BSI's Warn- und Informationsdienst (WID) for Germany-facing
classification. If a security fix arrives by any other route, it is still a
trigger. Examples: an upstream release note that says "security" without an
advisory, or a report sent to `security@gremion.de` about a bundled system.

## 3. Triage (operator, on the day the trigger is seen)

For each trigger, record the following in the notice register (§6):

1. **System and upstream reference.** The system name, the advisory or CVE id,
   the upstream fixed version, and the date the upstream advisory was published.
2. **Exposure in Gremion.** Which Gremion releases, and which versions actually
   running on hosted instances, fall in the affected range. Use the release's
   pins file, or the observed version where no pin exists (§1).
3. **Unpatched risk, in plain words.** Upstream severity (CVSS, if it is
   given), and whether the vulnerable feature is reachable in Gremion's
   deployment. Examples: is the endpoint behind the edge, is the feature
   switched on, does exploiting it need an account? Then one or two sentences a
   council's digital officer can act on. If the patch does not affect Gremion
   (version outside the range, feature not used), the risk statement says so
   and why. A notice is still published (§4).
4. **Plan.** The Gremion release, or the module or pin update, that carries the
   upstream fix, and its **applied date** (already live on hosted instances) or
   **planned date** (a specific calendar date, not "soon").
5. **Owner.** Kernel (Keycloak) or the owning module repository (the other four).

A security fix ships at any time. It is not held for a semester-break window,
and a council's deferral of a feature release does not delay it (PRD-PLAT-003).

## 4. The notice

One notice per upstream advisory. Advisories published together for the same
system may share one notice, as long as each is named. Every notice carries:

| Field | Content |
|---|---|
| Date | the notice's publication date, and the date of each later update |
| System | one of the five, with the affected version range and the fixed version |
| Upstream reference | advisory / CVE id, with a link to the upstream advisory |
| Unpatched risk | the plain-language statement from triage step 3, including "not affected, because …" where that applies |
| Applied / planned date | the date the fix went live on hosted instances, or the date it is planned to. For self-hosted councils: the Gremion release or pin update that carries the fix, and the date it was or will be published |
| What a self-hosted council must do | the release or pin to move to, or the upstream version and any configuration workaround, if the vendor has no release yet |
| Status | `planned` → `applied`. When the fix goes live, the notice is updated in place with the applied date. It is never deleted |

The notice uses only information that is already public upstream. It adds no
exploitation detail beyond the upstream advisory. Coordinated disclosure of
anything Gremion-specific follows `SECURITY.md` and ISO/IEC 29147. Like the
change list, the notice is written in German and in English. That is this
procedure's choice, made for consistency with PRD-PLAT-003's change list. The
sources do not require it for notices.

## 5. Channel and schedule

**Channel.** Notices are published on the vendor's website, reachable from
`gremion.de`, in the same place as the change lists (PRD-SUP-004: advisories
and patch notifications are reachable from gremion.de, and no second channel is
needed). Hosted and self-hosted councils read the same page. There is no
separate hosted-only notice. PRD-SUP-004 does not require a second channel,
so this procedure uses none. The exact page path is left to whoever builds the site (see [Open points](#8-open-points)).

**Schedule.** A notice follows the schedule PRD-PLAT-003 sets for change lists
(TRD-106). PRD-PLAT-003 ties a dated change list to each release. This
procedure applies the same rule to a security fix: the dated notice goes with
the fix. It also adds its own rule that the notice must be public before hosted
councils run the fixed release:

- **Fix ready to ship.** The notice (status `applied`, or `planned` with that
  day's date) is published **no later than the traffic switch** to the fixed
  release on hosted instances. It does not wait for a semester break, because
  security fixes ship any time.
- **Fix not yet ready.** A notice with status `planned` and a planned date is
  published once triage has fixed the plan. It is then updated in place to
  `applied` at the switch. If the planned date slips, the notice is updated
  before the old date passes, with the new date.
- **Not affected.** The notice is published when triage concludes, with the
  reason.
- **Deferral.** A hosted council's deferral right (one feature release, one
  cycle) never applies to a security fix. The notice's applied date is the
  same for every hosted council.
- **Pilot period.** While a named pilot suspends the feature-release cadence,
  nothing in this section changes. The suspension covers feature releases
  only.
- **Next change list.** The next feature release's change list also lists
  every notice published since the previous change list, with a link to each.

## 6. Records

Keep a **notice register** in the deployment's private annex
(`docs/ops/go-live-gate.md`, "The private annex"), not in this repository.
Record one row per trigger with these columns:

upstream reference · system · date upstream published · date seen · triage
outcome (affected / not affected, with reason) · risk statement · Gremion
release or pin carrying the fix · planned date · applied date per hosted
instance · notice publication date and each update date · link to the notice.

**Evidence** (TRD-106 verification): pick any row. There is a dated notice
reachable from gremion.de that names the system, the unpatched risk and the
applied or planned date. Its publication date is no later than the applied
date in the row.

## 7. ASVS L2 exception list at a major release (TRD-096)

TRD-095 keeps an exception list of the ASVS Level 2 requirements that Gremion
does not meet, each with its reason. No such list exists in this repository as
of 2026-09-25: it is owned by the unit implementing TRD-095, and this
procedure only adds the re-assessment rule.

At **every major release**, as part of preparing its change list:

1. Compare the set of components in ASVS L2 scope with the previous major
   release. Count any bundled system, kernel service or module that was added,
   removed, or moved to a new upstream major version. Examples: Keycloak moving
   to a new major, or LiveKit first being deployed.
2. **If the set changed**, re-assess every exception that touches a changed
   component. Add exceptions for new components, and drop exceptions that no
   longer apply. Then republish the list with a new date.
3. **If the set did not change**, republish the list with a new date and a line
   saying it was reviewed and the scope did not change.
4. The dated list is published **with that major release's change list**, in
   the same place. A major release's change list without a dated exception list
   next to it fails TRD-096's verification.

No external standard sets this cadence. It is operator policy, and ASVS 5.0
sets no re-assessment interval of its own. Here, "major release" means a
release whose `dist-vX.Y.Z` tag raises X. That reading is this procedure's own
(see [Open points](#8-open-points)).

## 8. Open points

The sources do not settle these, so they are left open rather than guessed:

- **Maximum time from upstream advisory to notice.** No source sets one. This
  procedure only requires triage on the day a trigger is seen (§3) and
  publication no later than the switch (§5). TRD-106 carries an `[A]` clause
  asking for the standard to be verified.
- **Page path on gremion.de** for notices and change lists. Choosing it belongs
  to whoever publishes the site. PRD-SUP-004 only requires that it is
  reachable from gremion.de.
- **Other third-party components** (PostgreSQL, Traefik, Nextcloud, Collabora,
  PgBouncer, NATS, Redis/Valkey). Extending the five-system list is an operator
  decision.
- **"Major release" under 0.x.** While Gremion is below 1.0, the X in
  `dist-vX.Y.Z` does not move. Whether a 0.Y bump counts as major for TRD-096
  needs an operator decision.
- **Decision status.** The notice duty itself is confirmed: it is PRD-DEP-003,
  confirmed by the operator [D R18-§15.1 F4], and the gremion.de channel is
  PRD-SUP-004 [D R18-§15.1 F5]. TRD-106 restates that duty and still carries a
  `[D-nc]` marker (a proposal the operator has not confirmed); the concrete
  steps in §3–§6 are this procedure's own. TRD-096, and TRD-095 which it
  extends, are `[D-nc]` proposals, so §7 stays provisional until the operator
  confirms them.

## Related documents

- `SECURITY.md` — reporting vulnerabilities in Gremion itself; bundled systems
  are reported upstream.
- `docs/ops/topology.md` — component census and pin status.
- `docs/ops/postgres-major.md` — the versions checked for the Postgres pin.
- `docs/ops/host-tooling.md` — `gremion-render`, deploy, switch and rollback.
- `docs/ops/go-live-gate.md` — the private annex where records are kept.

## Sources and decisions

| Topic | Ids | Basis |
|---|---|---|
| Notify every council of bundled-system security patches | PRD-DEP-003 (Must, Inspection) | [D R18 15.1 F4]; applies the change-list duty (PRD-PLAT-003) and the self-hosting duty (PRD-PLAT-005) to security patches |
| Notice content, schedule and verification | TRD-106 | [D-nc]; ISO/IEC 29147; BSI IT-Grundschutz OPS.1.1.3; `[A]` standard to verify |
| Change-list schedule, security fixes any time, deferral, pilot suspension | PRD-PLAT-003 | the cadence this procedure's schedule follows |
| Channel reachable from gremion.de, no second channel | PRD-SUP-004 | traced by TRD-106 |
| Re-assess and republish the ASVS L2 exception list at a major release | TRD-096, extends TRD-095 | [D-nc]; cadence is set by the operator, not by ASVS 5.0 |
