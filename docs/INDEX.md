# Gremion Documentation Index

**Gremion** is an open, self-hostable digital-governance kernel. This `docs/` tree
covers the **governance kernel only** — the substrate (identity, multi-tenancy, the
governance domain, the invariant hooks) and the module SDK. Feature modules
(elections, newsletter, calendar, files, messages, board, users,
finance, content, vault, handover) and ready-made verticals live in their own
repositories — one per module — and carry their own docs.

## Start here

| Document | For | Purpose |
|----------|-----|---------|
| [about-gremion.md](./about-gremion.md) | Everyone | Vision, the open-core three-layer architecture, the governance charter & invariants, the module SDK, licensing & contribution, the repo/product family, the microservice roadmap |
| [../README.md](../README.md) | Everyone | Kernel contents, license, quick start (Docker Compose) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contributors | AGPL-3.0-only (permanent), DCO inbound=outbound, no CLA, the process boundary |
| [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md) | Everyone | The honest residuals list: carve leftovers, design deltas, naming debt, open invariant limitations |
| [TRADEMARK.md](./TRADEMARK.md) | Everyone | The project name, the pending filing, and what the licence does and does not let you do with the name |

## German versions (Deutsch)

The documents that operators, councils and their data-protection officers read have a German
sibling next to them (`X.md` and `X.de.md`), with a language switcher at the top of both:
[README](../README.de.md), [about-gremion](./about-gremion.de.md), [modules](./modules.de.md),
[compliance](./compliance.de.md), [log-retention-policy](./log-retention-policy.de.md),
[controller-processor-split](./compliance/controller-processor-split.de.md),
[elections-scope](./compliance/elections-scope.de.md),
[pilot/module-defaults](./pilot/module-defaults.de.md) and the README of each module under
`modules/`. [compliance/tom-annex.md](./compliance/tom-annex.md) is German only.

The English file is the source. `scripts/check-doc-translations.mjs` (tests:
`scripts/check-doc-translations.test.mjs`) records the hash of the English text in the first
line of each German file and fails once the English file changes without the German one
following. Update the German text, then re-record the hash with
`node scripts/check-doc-translations.mjs --stamp <file>.de.md`.

## Architecture & security

| Document | Purpose |
|----------|---------|
| [architecture.md](./architecture.md) | The kernel technical layer: the 7-service governance stack, OIDC/SSO flow, control-plane + per-tenant DB layout, the module SDK + dependency-direction boundary enforcer, the `getDb()` pool, the group-helper auth model, the nav schema |
| [auth.md](./auth.md) | Keycloak OIDC, the role/capability/group model, page-access gating, nav `needs[]` vs server-side enforcement, LoA/ACR step-up |
| [compliance.md](./compliance.md) | GDPR posture: per-tenant isolation, the retention concept, the tenant-delete crypto-shred pipeline, audit-log retention |
| [log-retention-policy.md](./log-retention-policy.md) | The Vector log pipeline, retention windows, IP pseudonymisation |
| [compliance/controller-processor-split.md](./compliance/controller-processor-split.md) | DRAFT: how GDPR controller / processor roles are intended to fall for a self-hosted install and for a hosted control plane |
| [security/test-smtp-guard.md](./security/test-smtp-guard.md) | The outbound target guard on `/api/setup/test-smtp`: canonical-bytes address predicate, resolve-once, the `SMTP_TEST_ALLOW_PRIVATE` range opt-in and its carve-outs, DNS classification — and the named residuals |
| [pilot/poll-usage/README.md](./pilot/poll-usage/README.md) | The two open-poll forms of the pilot, the no-anonymity and no-eligibility wording rule, and how poll usage is measured from go-live |
| [modules.md](./modules.md) | The modules under `modules/`: purpose, support status, external services needed, and a link to each module's README |
| [pilot/module-defaults.md](./pilot/module-defaults.md) | The intended pilot module set (votes only), the repository checks behind it, what is not claimed for the running system (044-b), and the hand-offs |

## Develop

| Document | Purpose |
|----------|---------|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Local development against the governance-only stack |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Reference for the kernel environment variables |
| [LOCAL_TESTING.md](./LOCAL_TESTING.md) | Local manual/smoke testing of the governance surfaces |
| [TESTING.md](./TESTING.md) | Automated test strategy: svelte-check + tsc, vitest, the boundary backstop, the registry golden test |
| [TESTING-UI.md](./TESTING-UI.md) | UI/Playwright testing of the governance surfaces |

## Operate & deploy

| Document | Purpose |
|----------|---------|
| [OPERATIONS.md](./OPERATIONS.md) | Backup/restore, monitoring & logs, maintenance, disaster recovery |
| [deployment.md](./deployment.md) | Deploying the kernel: single host (Compose) or Kubernetes (Kustomize overlays) |
| [ops/setup.md](./ops/setup.md) | The `scripts/setup.sh` setup runbook (secrets + governance realm + stack start) |
| [ops/host-tooling.md](./ops/host-tooling.md) | The `/opt/gremion` host tooling: the per-project env contract, every `gremion-*` command, the restricted deploy channel and the `noop` dry-run |
| [ops/runbook/README.md](./ops/runbook/README.md) | The four-procedure operations runbook: install, upgrade, backup and restore (supersedes ops/restore-runbook.md) |
| [ops/go-live-gate.md](./ops/go-live-gate.md) | The go-live gate: the eight conditions an operator-run instance must prove against the running system before it may hold real users or real personal data |
| [ops/release-1-waivers.md](./ops/release-1-waivers.md) | The six release-1 waivers (P4): what is waived, which §L item and gate it suspends, who lifts it, and the named residuals |
| [deployment-architecture.md](./deployment-architecture.md) | The deployment shape: two tiers, two colours, networks, the release tree, deploy/switch/rollback and verification |
| [design-specs/spec-b-kernel-portback-relocatability-release-design.md](./design-specs/spec-b-kernel-portback-relocatability-release-design.md) | Spec B (approved 2026-09-15): kernel port-back, relocatability, release supply chain, the unit registry |
| [design-specs/spec-d-module-sdk-split-assembler-verticals-design.md](./design-specs/spec-d-module-sdk-split-assembler-verticals-design.md) | Spec D (approved 2026-09-15): module SDK, one repo per module, assembler resolution, the StuRa vertical |
| [runbooks/tenant-edge.md](./runbooks/tenant-edge.md) | Multi-tenancy edge: Traefik `x-forwarded-host` tenant resolution |
| [runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md) | Tenant create / provision / evict / delete (with crypto-shred) |
| [runbooks/pgbouncer.md](./runbooks/pgbouncer.md) | PgBouncer transaction pooling (production profile) |
| [runbooks/email-smtp.md](./runbooks/email-smtp.md) | Email/SMTP (Mailpit in dev; per-tenant SMTP for governance mail) |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common kernel issues and fixes |

## Extend

| Document | Purpose |
|----------|---------|
| [playbooks/add-a-module.md](./playbooks/add-a-module.md) | The module-SDK playbook: how to add a feature module (manifest, registries, migrations, codegen) |
| [playbooks/extract-a-service.md](./playbooks/extract-a-service.md) | The service-extraction playbook over `@gremion/ports` (branch-by-abstraction → ACL → outbox → flag-flip → decommission → dual-deploy → rollback) |
| [playbooks/nats-root-cutover.md](./playbooks/nats-root-cutover.md) | Migrating an existing deployment's JetStream streams to the `gremion` wire-subject root — a hard cutover, not a dependency bump |

## Decision records

| Document | Purpose |
|----------|---------|
| [adr/2026-03-27-user-management.md](./adr/2026-03-27-user-management.md) | Identity/user-management decision (kernel identity vs the module admin UI) |

---

> **On the carve.** This kernel was carved out of the StuRaOS monorepo. The carve
> regenerated code (manifests, migrations, compose, realm); these docs were then
> rewritten to the governance kernel, and the product-only material (the
> full-product design bundle, historical plans/specs/reviews, and the module
> runbooks and ADRs) was removed — it stays with the product vertical and with the
> module repositories. Some pages here are still being revised. See
> [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) for the remaining carve residuals.
