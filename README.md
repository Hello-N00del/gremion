**English** | [Deutsch](./README.de.md)

# Gremion

**Gremion** is an open, self-hostable **digital-governance kernel** for councils, student parliaments (*Studierendenräte*), associations, and similar deliberative bodies. It provides the substrate every such body needs: identity, multi-tenancy, an org/committee model, protocols & resolutions with a hash-chained audit trail, and a quorum-aware decision engine. On top of that sits a **module SDK** that optional features plug into without the kernel ever depending on them.

> Gremion is the open core of a larger product family. Feature modules (board, calendar, content, elections, files, finance, handover, messaging, publishing (the newsletter), vault, votes) live under [`modules/`](./modules), one directory per module, and attach over the module SDK; [docs/modules.md](./docs/modules.md) says which are supported and which are disabled by default. The kernel **builds and boots standalone with no module present**.

## License

Gremion is licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only) — see [`LICENSE`](./LICENSE). This license is **permanent**: the project will never be relicensed under a non-free or source-available license. Contributions are accepted **inbound = outbound** under AGPL-3.0-only via a Developer Certificate of Origin sign-off — no CLA. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## What the kernel contains

- **Identity & auth** — Keycloak OIDC, role/capability model, step-up (LoA/ACR) plumbing.
- **Multi-tenancy** — per-tenant data isolation, the control-plane registry, fleet migrations.
- **Governance domain** — committees, members, the org-unit tree, protocols, resolutions/*Beschlüsse*, the public portal.
- **Governance invariants** — hash-chained audit log (INV-1) and the quorum / decision-rule engine (INV-5).
- **Module SDK** — manifest-driven registration (nav, pages, capabilities, migrations, realm fragments), runtime registries (boot hooks, tenant-evict hooks, provisioning adapters, data providers), and the boundary enforcer that keeps the kernel free of feature-module dependencies.
- **Services and operator tooling** — the control panel (`apps/control-panel`, the operator shell that queues customer requests and shows the host's key numbers and a code map), the kernel API (`services/kernel-api`: tenancy, module registry, identity domain, authorization decisions), the governance service (`services/governance`, its schema so far) and the host-side tooling in `infra/host`.
- **Shared packages** — the `@gremion/*` workspaces under `packages/` (for example `@gremion/db`, `@gremion/ports` for broker and tracer, `@gremion/events`, `@gremion/tenancy-core`, `@gremion/tenant-store`, `@gremion/nats-auth`, `@gremion/provisioning`, `@gremion/retention`).

A feature module is anything the kernel discovers through that SDK; the kernel imports none of them by name. The dependency direction (kernel → never a module) is enforced in code by `gremion-ui/src/lib/server/boundary/`.

## What the kernel does *not* contain yet

Say this before you plan around the repository, not after:

- **Not the product's full schema.** 37 data-plane migrations ship here: 31 of the 58 in the reference product plus the kernel-only `0059`, `0060`, `0061`, `0062`, `0063` and `0064`, so **27 are absent** — every one of them module-owned (finance, content) or unshipped (handover). The filename gaps are inherited from that larger chain and are not corruption — see [`gremion-ui/migrations/README.md`](./gremion-ui/migrations/README.md), which lists what is here and names what is not.
- **Not the full governance feature set.** The contestability / recall **schema** ships here (`055`, `056`); its application half (routes, services, UI) and the second-locus model are implemented in the product and are **absent here**, even though the charter treats accountability and contestability as first-class.
- **The module-SDK runtime-registry contract is not frozen.** The manifest shape and `runtime-registry.ts` may still change without a deprecation window. Pin a SHA rather than tracking `main`.
- **`gremion-ui` and `gremion-public` are a non-normative reference shell.** They are the shell the kernel was extracted with, not a ratified UI contract. Replacing them breaks nothing the kernel guarantees.
- **No stable release line.** This is 0.1.0. Fixes land on `main`; there is no backport channel for older SHAs.

## Quick start (local, Docker Compose)

```bash
./scripts/setup.sh        # creates .env and legal/legal.env, generates the secrets and the internal TLS certificates; on a fresh clone it then stops at the image build
echo "TENANT_PROXY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
./scripts/setup.sh        # keeps the .env, builds and starts the stack
make logs
```

`setup.sh` writes `.env` itself (from `.env.example`, then `chmod 600`) and generates every secret in it, including the seeded fixture password. Do **not** create `.env` by hand first: the script skips generation when the file already exists, and you would be left with the `CHANGE_ME_*` placeholders.

The first run stops because `docker-compose.app.yml` requires `TENANT_PROXY_SHARED_SECRET` and `setup.sh` does not generate it; the second run keeps the `.env` and continues. With the value set, the app on port 3001 answers only requests that carry the tenant resolver's headers (`/healthz` excepted), so on the local stack it is reached with `curl`, not from a browser: see [`docs/LOCAL_TESTING.md`](./docs/LOCAL_TESTING.md#quick-start).

`setup.sh` leaves placeholder imprint data in `legal/legal.env`; fill it in before going live. A Keycloak realm is composed when a tenant is created, not at boot.

The local stack is two compose projects, started by `make up`. The state project (`docker-compose.yml` plus the auto-loaded `docker-compose.override.yml`) runs **postgres, governance-postgres, nats, keycloak, legal, vector** and, under the `dev` profile, **mailpit**. The app colour (`docker-compose.app.yml` plus `docker-compose.app.dev.yml`) runs **gremion-ui, gremion-public, control-panel, kernel-api**. Module services and their databases sit behind compose profiles (board, calendar, content, finance, newsletter, vault, messaging, nextcloud, collabora, video). `traefik` and `docker-socket-proxy` come under the `production` profile, and `pgbouncer` / `fallback` from `docker-compose.prod.yml`.

## Development

```bash
pnpm install                 # Node 26, pnpm 10
pnpm -C gremion-ui check     # i18n compile, tenancy/port/secrets-dir guards, then svelte-check
pnpm -C gremion-public check # i18n compile, then svelte-check
pnpm -C gremion-ui test:unit
pnpm -C gremion-ui build     # adapter-node production build
make lint                    # the static guards (compose, shell, hygiene, migration register, ...)
make verify                  # the local gate: typecheck, unit, integration and the other required suites
```

## Documentation

- **[docs/about-gremion.md](./docs/about-gremion.md)** — the full overview: what Gremion achieves, who it's for, the open-core three-layer architecture, the governance charter & invariants, the module SDK, licensing & contribution, the repo/product family, and the microservice roadmap.
- **[docs/INDEX.md](./docs/INDEX.md)** — the documentation index: architecture & security, development, operations & deployment, the module-SDK playbooks, and the decision records. These docs were rewritten to the governance kernel when it was extracted from the larger product tree; remaining carve residuals are tracked in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).
- **[docs/modules.md](./docs/modules.md)** — the modules under `modules/`: purpose, support status (supported, disabled by default, manifest only), external services each one needs, and a link to each module's own README.
- **[KNOWN_ISSUES.md](./KNOWN_ISSUES.md)** — the honest residuals list: carve-time leftovers, design deltas, naming debt carried into 0.1.0, and the open governance-invariant limitation (audit-chain tail truncation).
- **[SECURITY.md](./SECURITY.md)** — supported versions and how to report a vulnerability privately.
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** — Contributor Covenant 2.1 and the enforcement contact.
- **[docs/TRADEMARK.md](./docs/TRADEMARK.md)** — the project name and its status.

## Status

Public, AGPL-3.0-only, version 0.1.0. The kernel builds and boots standalone; the module-SDK contract is not yet frozen. Fixes land on `main` and consumers pin a SHA — see [`SECURITY.md`](./SECURITY.md). Known limitations and residuals are in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).
