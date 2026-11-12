**English** | [Deutsch](./about-gremion.de.md)

# About Gremion

> **Status:** Public, AGPL-3.0-only, version 0.1.0. No stable release line has been cut: fixes land on `main` and consumers pin a SHA. This document is the kernel's own source of truth for what Gremion is and how it is governed; the rest of `docs/` is partly inherited from the StuRaOS reference deployment and is still being revised (see [INDEX.md](./INDEX.md)).
>
> **Internal alias.** During development this project was worked on under the internal name **Civitas**. That name is not used outwardly and is not the project's name; it survives only in commit history and in the header comment text of four applied migrations, listed as naming debt in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md). The project is **Gremion**. The alias is named here and, with the reasons it was dropped, in [`TRADEMARK.md`](./TRADEMARK.md); nowhere else in the documentation does it appear as a name for this project.

## What Gremion is

**Gremion** is an open, self-hostable **digital-governance kernel** for councils, student parliaments (*Studierendenräte*), associations, and similar deliberative bodies. It provides the substrate every mandated governance body needs: identity, multi-tenancy, an org/committee model, protocols & resolutions with a hash-chained audit trail, and a quorum-aware decision engine. On top of that sits a **module SDK** that optional features plug into without the kernel ever depending on them.

Gremion's defensible, novel core is the **binding-decision + checked-resource-commitment layer**. Civic-tech platforms such as Decidim, CONSUL, and Pol.is implement only the *consultative* half and push the binding decision and the money *outside* the software. Gremion is the inverse: the binding decision and the checked commitment of resources are first-class *in* the software.

## What it achieves

- **Generalizes one vertical into a reusable substrate.** Gremion lifts the governance ontology that sat implicitly in the StuRaOS schema (bodies, mandates, resolutions, four-eyes finance, audit) into a universal model, so any mandated governance body can be stood up from one codebase rather than forking a German student-council application.
- **Keeps tamper-evidence non-deselectable.** The governance invariants (hash-chained audit, quorum/threshold enforcement, tenant isolation) live in the kernel as hooks behind no feature flag. No deployment toggle can forge, hide, or delegitimize a governance act.
- **Boots standalone.** The kernel **builds and boots with no closed module present** — the whole of it is usable, and grantable, on its own.
- **Sustainability without a relicensing risk.** The core is and stays AGPL-3.0-only. Optional hosting and support fund the work, the same model as Decidim, and no funding arrangement can relicense the core (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

## Who it is for / where to use it

Gremion targets **person-membered, mandated governance bodies** — bodies with elected or appointed members, motions, resolutions, and checked resource commitment:

- Student councils (*Studierendenräte*)
- Municipal / communal councils (*Gemeinderat*)
- NGOs, cooperatives, and associations (*Vereine*)

Each deployment is a **vertical** that layers config, i18n, seed data, and theme over the kernel + governance module:

- **StuRaOS** — the first reference deployment, a German student council instance (the elected-assembly + majority-vote + four-eyes-finance preset). It lives in a private repository; the deployment it ran on has been retired.
- **Musterstadt** — a municipal *Gemeinderat* vertical (finance off, municipal vocabulary, three *Fraktionen*), the proof that Gremion is a reusable framework rather than StuRaOS-with-tenancy.
- A generic **demo** tenant.

This tree carries two verticals as data under [`verticals/`](../verticals): `stura` and `municipal` (see [`verticals/README.md`](../verticals/README.md)).

**In scope:** person-membered bodies modelled as a strict tree. **Out of scope** (a separate sibling altitude): the token-weighted / self-executing / owned / sovereign quadrant — DAOs, corporations, sovereign bodies.

**Hard red line — for every deployment and every repository, public or private:** no real or private data. Only invented, generic fixtures. The rule is enforced on the current tree; see [`../SECURITY.md`](../SECURITY.md) to report anything that slipped through.

## Architecture: the open-core three-layer model

Gremion is a **distributed modular monolith** organized in three layers. The boundary between them is defined by **one principle — dependency direction:**

> **The core may never import a module; modules import the core.**

Made a lint, the line maintains itself. The classification test for any piece of code:

> If the system cannot **boot** or **authorize** without it, or if turning it off could **forge, hide, or delegitimize** a governance act, it is **kernel**. Anything a deployment could run without is a **module**.

| Layer | What | License | Deselectable? |
|-------|------|---------|---------------|
| **1. Kernel** | Domain-neutral substrate + governance **invariant hooks** | Public AGPL-3.0-only | Never |
| **2. Governance** | The flagship governance domain, shipped in-tree, default-on — architecturally a *module* that calls the kernel hooks | Public AGPL-3.0-only | No (always-on) |
| **3. Feature modules** | board, calendar, content, elections, files, finance, handover, messaging, publishing, vault, votes (the directories under `modules/`) | Sources in this repository, under the root AGPL-3.0 `LICENSE` (see [below](#repo-topology--product-family)) | Yes |

The boundary maps 1:1 onto the governance charter: the **4 fixed invariants are kernel hooks**; the **3 strategy slots and all features are modules**. The one catastrophic, irreversible mis-cut to avoid is a "turn off tamper-evidence" toggle — the audit chain, quorum enforcement, auth/identity, and tenant isolation are non-negotiably never-deselectable.

Precedents: Decidim (`decidim-core` = users/auth + Organization/multitenancy + the component contract; features as optional gems; the admin always shipped), Odoo (a neutral `base` where everything-is-a-module), and Azure multitenant identity ("don't build your own IdP").

## The kernel

The kernel ships in-tree:

- **Identity & auth** — Keycloak OIDC, a role/capability model, step-up (LoA/ACR) plumbing. *users-identity* is kernel; the *users-admin UI* is a module.
- **Multi-tenancy** — per-tenant data isolation, the tenant-resolver, the control-plane registry, fleet migrations.
- **Governance domain** (the flagship governance module) — committees/members, the org-unit tree, protocols, resolutions/*Beschlüsse*, the public portal.
- **Governance invariants** (kernel hooks, behind no flag) — **INV-1** the hash-chained audit log and **INV-5** the quorum / decision-rule engine; tenant isolation is also a kernel invariant hook.
- **Module SDK** — manifest-driven registration plus runtime registries and the boundary enforcer (see below).
- **Shared packages** — `@gremion/db` (the Postgres client factory and shared row types, zero feature references) and `@gremion/ports` (`BrokerPort` over NATS/JetStream, `TracerPort`, the erasure-hook contract), plus the tenancy, provisioning, event (outbox, inbox, relay, dead letters) and broker-auth packages listed in [architecture.md](./architecture.md).
- **Config / brand** and the **admin shell**.

**Kernel manifests:** exactly two. `coreManifest` (id `core`, `toggleable: false`; the minimal kernel shell: dashboard, settings, systemstatus) and `governanceManifest` (id `governance`, `toggleable: false`, because *the Gremion kernel is a governance product*: members, committees, portal, protokolle, beschlüsse). The feature modules under `modules/` keep their manifests in their own trees; the build overlays the enabled ones onto `gremion-ui/src`, and in the default build `index.generated.ts` registers ten manifests (`core`, `governance`, `elections`, `votes`, `content`, `newsletter`, `calendar`, `files`, `messages`, `board`), codegen-built and byte-pinned by `registry.test.ts`. `finance` and `vault` are listed in `modules/disabled.json` and contribute none.

**Stack:** two tiers (see [architecture.md](./architecture.md) and [ops/pooled-stack-layout.md](./ops/pooled-stack-layout.md)). The state project runs `postgres`, `governance-postgres`, `nats`, `keycloak`, `legal` and `vector`, a PostgreSQL server per module and per collaboration service under their compose profiles, and, under the `production` profile, `traefik`, `docker-socket-proxy` and `fallback`, with `pgbouncer` from `docker-compose.prod.yml`; `mailpit` is dev-only. The app tier runs `gremion-ui`, `gremion-public`, `control-panel`, `kernel-api` and the module leaf services in two colours. Traefik's `x-forwarded-host` resolver is load-bearing for tenancy.

## Governance charter & invariants

Gremion adopts a **governance-domain charter at the medium altitude** — the **Mandated Governance Body** (moderate core, medium reach). A narrower altitude ("Mandated Deliberative Assembly") was rejected because the *Gemeinderat*'s show-of-hands/no-tally mode breaks a per-voter-tally universal; a broader one ("Accountable Authority Substrate") was rejected because its invariants collapse to a lowest common denominator that constrains nothing.

The honest spine is **4 fixed invariants + 3 strategy slots** (an adversarial stress-test demoted two of six proposed universals to slots).

**Fixed invariants:**
- **INV-1 — recorded before adopted** (tally-free): the hash-chained, tamper-evident audit log.
- **INV-2 — bounded scope / ultra-vires void.**
- **INV-3 — mandate is a first-class terminable grant.**
- **INV-5 — binding force from a pre-declared procedure**, validated at adoption: the quorum / threshold / decision-rule engine.

*(The charter numbering deliberately skips INV-4.)* The two **technical** invariants enforced in the kernel are **INV-1** and **INV-5**. Both live in the kernel as hooks the governance module *calls* — the module never owns enforcement, so tamper-evidence cannot be toggled off.

**Strategy slots** (these legitimately vary across the class and are owned by the governance module, not the kernel):
1. **Franchise** — equal-counted / acclamation / weighted / liquid.
2. **Resource-commitment guard** — ex-ante four-eyes / M-of-N / parent-grant / ex-post sanction.
3. **Mandate accountability** — constituency-revocable / purpose-bound / appointed.

The **meta-model is 7 primitives**: Body, Mandate, Franchise, Decision-Rule, Resolution, Resource-Commitment Guard, and Accountability+Contestability. Each is a generalization of an existing StuRaOS table, so adoption needs no schema rip-out.

**Implementation notes.** The INV-5 quorum gate enforces **at adoption** (protocol publish), not at draft resolution-write — gating drafts returned 422 to the live UI. The decision rule is fixed at creation (a PATCH cannot change the required majority). The audit chain is hash-chained with an advisory-lock-serialized `BEFORE INSERT` trigger and a `verifyAuditChain` check; a known residual is that a self-contained chain cannot detect **tail truncation** (mid-chain edits *are* detected), deferred to a Phase-3 external-anchor follow-up. Contestability and recall ship in the kernel: the schema (`0055`, `0056`), the resolution-challenge routes (`/api/protocols/resolutions/[resId]/challenges`) and the mandate-revoke route (`/api/governance/committees/[id]/roles/[roleId]/revoke`), with the second-locus strategy seam in the runtime registry; the provenance of these ports is in [`ops/shell-port-list.md`](./ops/shell-port-list.md).

**Theory anchor:** Weber (legal-rational office), Montesquieu (separation), principal-agent (terminable delegation), and Pettit (non-domination / contestability), with Ostrom as the empirical validator. German parliamentary practice is the **reference preset, not the core**. Ratified scope cut: a strict tree body model only (no polycentric/DAG — a documented hard fork).

Invariants are **cheap to add later** (nothing depends on them yet) and **expensive to relax** (a breaking change to every consumer that trusted them), so only what holds across the whole class — and that you will never need to break — is ratified as fixed; everything else is a slot.

## The module SDK

A **module** = an in-kernel **manifest** (pages, route-gates, capabilities, a realm fragment, nav) **+ an optional backing service** (data and heavy logic). The kernel discovers modules through the SDK and **imports none of them by name**.

- **Manifest-driven, zero-shared-edit.** Nav is composed via `composeNavSchema(baseNavSchema, MODULE_MANIFESTS)`; `config.modules` is a dynamic `Record<string, boolean>`. A net-new toggleable module needs no edits to shared files — page-access, route-prefixes, capabilities, nav, realm, config-default, and migration catch-up are all manifest-keyed.
- **Composition roots are codegen barrels.** Prebuild scripts scan the filesystem (`manifests/*.ts`, `lib/server/*/register.server.ts`, `migrations/*.sql`) to generate the module registry, server-init, and migration manifest. Adding or removing a module re-runs codegen rather than hand-editing import lists.
- **Runtime-registry seam.** `lib/server/modules/runtime-registry.ts` plus per-module `register.server.ts` (loaded via the codegen `server-init.generated` barrel) invert server-init, tenant-evict, provisioning, request-time data providers, the protocol document port, setup health probes, role-group grants, decision-rule and second-locus strategies and erasure hooks, so the kernel never statically imports a module.
- **Auto-discovery is the open-core hinge.** A private module's manifest cannot be hardcoded in the public kernel — that would leak the module's existence and shape. So the kernel ships the SDK plus a discovery seam and private modules bring their own manifest.
- **The boundary enforcer.** A comprehensive `boundary/kernel-clean.test.ts` walks every kernel file, resolves `$lib/*` and relative specifiers to canonical paths, skips module-owned and generated dirs, and asserts every import is a subset of a documented ALLOW map — proven non-vacuous by injecting a kernel→module import. The ALLOW set *is* the remaining-work list.

See the [module playbook](./playbooks/add-a-module.md) and the [service-extraction playbook](./playbooks/extract-a-service.md) (both inherited StuRaOS-first and being rewritten).

## Licensing & contribution

Gremion is **AGPL-3.0-only, permanent** — it will never be relicensed under a non-free or source-available license. A BSL/SSPL/FSL rug-pull would mean trust death and grant disqualification.

Contributions are accepted **inbound = outbound** under AGPL-3.0-only via a **Developer Certificate of Origin** sign-off (`git commit -s`). There is **no CLA and no FLA**, so no party, including the maintainers, can ever relicense a contribution away from the AGPL.

The module sources in this tree sit under the same root `LICENSE` as the kernel, so for them this question does not arise. For a component that has to stay closed, the load-bearing mechanic is the **process boundary, not a CLA.** The FSF treats anything linked in-process with an AGPL program (plugins *and* UI routes compiled into the app) as one combined work that must also be AGPL, and §13 triggers source-disclosure once the modified program is served over a network. Therefore a closed component **cannot be "just in-app routes"** on the kernel; to stay closed it must be a **full separate service** (its own API *and* its own UI) the kernel composes over HTTP ("mere aggregation"). Closed code never enters public git history by construction — separate repositories, never a shared monorepo with an `ee/` directory.

For the full text and rationale, see [`../README.md`](../README.md) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Repo topology / product family

Gremion is the open core of a product family. The target is modules and verticals in **separate repositories**; today this tree carries the module sources under `modules/` and two verticals under `verticals/`.

| Repo | Visibility | Role |
|------|-----------|------|
| **gremion** (this repo) | public, AGPL-3.0-only | The kernel + module SDK + a reference core shell. Boots standalone. |
| module sources | in this repository today, under `modules/` | See below; one repository per module is the target, not the present state. |
| verticals and the hosting control plane | private | Deployment-specific config, seed data and theming; hosting / provisioning / billing. |

**The module sources are in this repository today.** `modules/` carries eleven modules: board, calendar, content, elections, files, finance, handover, messaging, publishing, vault and votes. No module directory has a licence file of its own and no module `package.json` declares a licence; the licence file above them is the root [`LICENSE`](../LICENSE) (AGPL-3.0), and the root `package.json` declares `AGPL-3.0-only`. That covers the module code only; the upstream systems those modules wrap (the Helios overlay, Nextcloud, the Matrix homeserver, LiveKit) keep their own licences, which are recorded in [the licence register](compliance/licence-register.md). `finance` and `vault` are excluded from the default build and deploy ([`modules/disabled.json`](../modules/disabled.json)); that is a build default, not a licence statement. The module sources are frozen copies of one extraction source (see [ops/extraction-source.md](./ops/extraction-source.md)) rather than published packages; `@gremion/db` and `@gremion/ports` begin publishing to npm at 0.1.0.

**History.** This repository starts from a single root commit. It is a **fresh extraction** of only the ratified core subset, with a secret/PII sweep of that subset, not a re-publish of the private product repository, whose history stays private.

## Microservice roadmap

The architecture is a **modular monolith — extract on demand**, on the proven `@gremion/ports` plus a 7-section extract-a-service playbook (branch-by-abstraction → ACL → outbox → flag-flip → decommission → dual-deploy → rollback). The phases were ordered by difficulty; this is where each stands in this tree:

- **Phase 0 (done) — newsletter.** Own container, own database, HTTP REST ACL, NATS JetStream. Cut over live; the old path decommissioned. The proven template and the first load-bearing Gremion microservice.
- **Phase 1 — files, messages, votes.** Arm's-length HTTP proxies to external systems with no database of their own: `modules/files`, `modules/messaging` and `modules/votes` each carry a thin leaf next to their in-process half. `docker-compose.app.yml` defines no service for them.
- **Phase 2 — content, calendar.** Each is a leaf service with its own PostgreSQL server (`content-service` and `calendar-service`, compose profiles `content` and `calendar`), the in-process half overlaid on the kernel app. Content publishes to the portal through a kernel callback (`/api/internal/content/portal-publish`).
- **Board.** The leaf and `board-postgres` exist in the tree; a pilot host runs the board in-process on kernel tables and does not start them.
- **Phase 3 — finance.** A leaf service only (no app half in this tree) with its own database, disabled by default. It keeps a leaf-local mirror of the org units, fed by the kernel's org-unit change events (`modules/finance/migrations/002_org_unit_mirror.sql`), instead of foreign keys into the kernel schema.

**Open-core prerequisites (the hinge, both executed):** invert the `org-units-db → finance/tx` reverse-import, and make the registry auto-discovery so the kernel never hardcodes a module's manifest.

**Module shape.** A component that stays closed cannot be "just in-app routes" on the kernel (see [Licensing & contribution](#licensing--contribution)), so it has to be a full separate service with its own API *and* its own UI, composed over HTTP. The modules in this tree are under no such constraint.

## Relationship to StuRaOS and status

**Gremion is the framework; StuRaOS is its first reference deployment ("branch").** StuRaOS is where the governance ontology was first implemented; Gremion generalizes it into a domain-neutral substrate. Post-carve, StuRaOS stays the full integrated product / StuRa demo, and the German finance vocabulary (KV/HV, *Finanzordnung*) is demoted to a vertical plugin, not core.

**Runtime maturity, honestly stated:** Gremion is design- and code-mature but runtime-immature: "the seam is drawn precisely on both sides and never cut." Code-completeness on-branch is roughly 70% to v1; load-bearing-in-production is roughly 28–30% after the newsletter cutover.

**Carve-time residuals** are tracked, one by one, in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) — leftovers of the extraction, listed there until they are removed or generalised rather than promised against a date.

**Fresh-init proof:** `make fresh-init-proof` (`gremion-ui/scripts/fresh-init-proof.sh`) applies the whole kernel migration chain to a throwaway PostgreSQL and asserts the resulting tables, a column, a CHECK definition and the public-reader grants in the database. The kernel app starts with zero tenants: boot writes nothing into the tenant registry, and the first-run setup wizard no longer exists (a customer is created by the platform operator).

## What this repository does not contain

Stated plainly, because a reader would otherwise assume otherwise:

- **Not the product's full schema.** 38 data-plane migrations ship here: 31 of the 58 in the product plus the kernel-only `0059`, `0060`, `0061`, `0062`, `0063`, `0064` and `0065`, so **27 are absent**. All of them belong to feature modules that are not part of the kernel and keep their schema in their own module trees (`modules/<id>/migrations/`), namely finance (`013`–`017`, `019`–`023`, `025`–`032`, `035`, `036`) and content (`044`–`047`), or to handover (`050`–`052`), which ships in no release-1 tree at all. No governance-side migration of the product is absent here any more: the 2026-09-15 port-back brought `003`, `034`, `049` and `053`–`058` in, provenance in [`ops/migration-portback-2026-09-15.md`](./ops/migration-portback-2026-09-15.md). The filename gaps are inherited from the larger chain and are not corruption; what is here and what is not is named in [`../gremion-ui/migrations/README.md`](../gremion-ui/migrations/README.md).
- **The runtime-registry contract is not frozen.** `lib/server/modules/runtime-registry.ts` and the manifest shape are the module SDK's seam, and they may still change without a deprecation window. Pin a SHA.
- **`gremion-ui` and `gremion-public` are a non-normative reference shell.** They are the shell the kernel was extracted with, not a ratified UI contract. A deployment is free to replace them; nothing in the kernel's guarantees depends on their markup.
