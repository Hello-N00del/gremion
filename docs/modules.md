# Supported modules

This page lists the modules that live under [`modules/`](../modules) in this tree, what each
one is for, whether it is supported, and which external services it needs. Each module
directory carries its own `README.md` with the routes, migrations, configuration and tests.

A module attaches to the governance kernel over the module SDK
([add-a-module.md](./playbooks/add-a-module.md)); the kernel builds and boots with none of
them. Everything in this table is derived from the files in the module directories
(`module.json`, the manifest under `app/lib/modules/manifests/`, `migrations/`, the route
files) and from `modules/disabled.json`. A statement that the code does not settle is marked
as such in the module's README instead of being guessed.

`scripts/check-module-docs.mjs` (tests: `scripts/check-module-docs.test.mjs`) fails when a
directory under `modules/` has no `README.md`, when it is missing from the table below, or
when the "disabled by default" status here disagrees with `modules/disabled.json`.

## Status values

| Status | Meaning |
|---|---|
| supported | Present in the default build (not listed in `modules/disabled.json`); the app half and/or the leaf service are in this tree. A tenant switches it on or off per customer. |
| disabled by default | Listed in `modules/disabled.json`: installs and typechecks with the workspace, but is excluded from the default build and deploy. |
| manifest only | The directory holds `module.json` (and a `package.json`) and nothing else; there is no code to run yet. |

"Supported" describes what the tree carries and tests. It does not say what a given customer's
running system serves; see [pilot/module-defaults.md](./pilot/module-defaults.md) for the
module set a pilot customer starts with and for what is not claimed.

## Modules

| Module | Purpose | Status | External services it needs | README |
|---|---|---|---|---|
| `board` | Task board (stacks and cards) per organisational unit; protocol action items can be promoted to cards. | supported | none beyond the kernel; its own PostgreSQL server (compose profile `board`) | [modules/board/README.md](../modules/board/README.md) |
| `calendar` | Events, event types, recurrence and committee calendar settings; pushes events to CalDAV and relays change events over NATS. | supported | Nextcloud (CalDAV), NATS, its own PostgreSQL server (profile `calendar`) | [modules/calendar/README.md](../modules/calendar/README.md) |
| `content` | Content engine: posts with e-mail, website (portal) and Instagram channels, mailing lists, scheduled publishing. | disabled by default | NATS, SMTP through the kernel, Instagram Graph API (optional channel), its own PostgreSQL server (profile `content`) | [modules/content/README.md](../modules/content/README.md) |
| `elections` | Optional committee elections run on Helios, with a permanent notice that it does not replace a statutory election. App half only; no leaf service. | supported | Helios (election server) | [modules/elections/README.md](../modules/elections/README.md) |
| `files` | Document browser over Nextcloud WebDAV; in-browser editing through Collabora. | supported | Nextcloud, Collabora | [modules/files/README.md](../modules/files/README.md) |
| `finance` | Budget plans, projects, expenses, approvals, bookings, bank accounts, SEPA export, FinTS and CSV import. Leaf service only; the app half is not in this tree. | disabled by default | NATS, bank access through FinTS (optional), Nextcloud (optional receipt storage), its own PostgreSQL server (profile `finance`) | [modules/finance/README.md](../modules/finance/README.md) |
| `handover` | Handover of an organisation's records to its successors. Placeholder: `module.json` and `package.json` only. | manifest only | none yet | [modules/handover/README.md](../modules/handover/README.md) |
| `messaging` | Chat rooms and video calls: a thin proxy to the Matrix homeserver (Synapse) and LiveKit, plus the Synapse image and its configuration. | supported | Matrix/Synapse (shipped here, profile `messaging`), LiveKit, Element Call, Keycloak; Firebase Cloud Messaging for push (optional) | [modules/messaging/README.md](../modules/messaging/README.md) |
| `publishing` | Newsletter: lists, drafts, schedule and send, unsubscribe. Its manifest id is `newsletter`. | supported | NATS, SMTP through the kernel, Collabora (draft conversion and editing), its own PostgreSQL server (compose profile `newsletter`) | [modules/publishing/README.md](../modules/publishing/README.md) |
| `vault` | Per-organisational-unit secrets store with reveal logging, plus a launcher page for an externally run Vaultwarden. | disabled by default | Vaultwarden (launcher page only), its own PostgreSQL server (profile `vault`) | [modules/vault/README.md](../modules/vault/README.md) |
| `votes` | Open polls and the combined votes list (polls plus Helios ballots). Stateless leaf service. | supported | Nextcloud Polls, Helios (optional, for ballots) | [modules/votes/README.md](../modules/votes/README.md) |

Notes on names:

- A module's directory name, its `module.json` id and its manifest id are not always the
  same. `publishing` (directory and `module.json` id) registers the manifest id `newsletter`;
  `messaging` registers `messages`. The per-tenant `config.modules` key is the manifest id.
- The compose profile that starts a module's PostgreSQL server uses the profile name from
  `docker-compose.yml` (`newsletter` for publishing, `messaging` for messaging).

## Turning a module on or off

Three separate switches exist; each module README says which of them applies.

1. **Build.** `modules/disabled.json` removes a module from the default build and deploy.
   `gremion-ui/scripts/interim-module-overlay.mjs` copies each enabled module's `app/` half
   onto `gremion-ui/src/` and refuses a disabled module in build mode.
2. **Per customer.** A customer is created by a provisioning request from the control
   panel, and modules are enabled or disabled for it through the `enable_module` and
   `disable_module` requests described in
   [runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md). A module that is in
   `modules/disabled.json` cannot be enabled that way.
3. **Per instance setting.** `config.modules.<manifest id> = false` makes the module's routes
   answer with the module-disabled surface and hides its navigation entry; data is kept
   ([playbooks/add-a-module.md](./playbooks/add-a-module.md), section on deselection).

A leaf service is a separate container built from `modules/<directory>/Dockerfile` with the
repository root as build context. The kernel app reaches it when the module's `*_BACKEND`
variable is `service` and `*_SERVICE_URL` points at it; every leaf call carries the shared
secret in `x-internal-auth` and the tenant in `x-tenant-id` and `x-tenant-slug`.
