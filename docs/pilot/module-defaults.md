**English** | [Deutsch](./module-defaults.de.md)

# Pilot module defaults: what the repo states, what is measured, what is handed over

> **Status: product documentation for the pilot (TASK-058, part A).** It states the
> module set a pilot customer is created with and which parts of that statement are
> checked in the repository. It does **not** state what a running system serves: that is
> measured by part B, which waits for TASK-044-b (section 3).

## 1. The intended pilot set

A pilot customer is created with **votes, calendar, content, publishing, files,
messaging and board**. The create request names every module explicitly; naming no module enables
none (`packages/provisioning/test/code-default-off.test.ts`).

| Module | Pilot create request | Why |
|---|---|---|
| votes | enabled | The two open-poll forms of the pilot ([poll-usage](./poll-usage/README.md)) |
| calendar | enabled | Council calendar |
| content | enabled | News and content authoring; in the default build since 2026-11-09 (`modules/disabled.json` lists finance and vault only) |
| publishing | enabled | Newsletter |
| files | enabled | Documents over Nextcloud, editing in Collabora |
| messaging | enabled | Chat and video |
| board | enabled | Task board per organisational unit; served in-process from the customer's own database, so enabling it opens no module database and starts no compose profile. It is chosen at creation through the same isolation gate as the other modules (the board isolation case, `scripts/verify/suites/isolation-tenant.mjs`) |
| elections | not named | Optional, no statutory election ([elections-scope](../compliance/elections-scope.md)); starts off and is held off in the app config (`defaultEnabled: false` on its manifest and a pin on read and write of `config.modules`), so the rail and `/votes` carry no election wording; a permanent notice is mounted on every `/elections` page |
| finance, vault | not named | Excluded from the default build (`modules/disabled.json`) |
| handover | not named | Not part of the pilot set |

All seven pilot modules are deselectable; they are chosen per customer at creation, and a
module that is off must leave the kernel working with no dangling link to it (the rail
entries of calendar, files, messaging and content carry their module id and drop out).

## 2. What the repository checks (part A)

`node scripts/check-pilot-module-defaults.mjs`, with its tests in
`scripts/check-pilot-module-defaults.test.mjs`:

- (a) `test/host/fixtures/module-defaults/pilot-request.json` enables votes, calendar,
  content, publishing, files, messaging and board and none of elections, finance, vault,
  handover; every named id has a `module.json`.
- (b) no `COMPOSE_PROFILES` line in `infra/host/templates/env/*.env.tmpl` names finance,
  board, vault or vaultwarden (board needs no profile: it runs in-process). The profiles of the pilot modules are rendered from
  `infra/host/module-profiles.json`, not written into a template.
- (c) no `modules/*/module.json` carries a default-enable declaration.
- (d) the panel create form preselects no module checkbox.

Also in place: the elections notice (`ElectionsNotice.svelte`, mounted by
`modules/elections/app/routes/elections/+layout.svelte`, text pinned to
`modules/elections/src/notice/notice.ts`) and the usage-record schema
(`poll-usage/record.schema.json`, linted against DB-MSG-POLL-USAGE).

These are repository checks. They show what is declared, not what a customer's running
stack serves.

## 3. What is not claimed

**Elections are held off in the app config, not shown to be off on the running system.**
The module gate (`gremion-ui/src/lib/server/module-gate.ts`) reads the per-instance
setting only; the per-customer enablement level (`plt.module_enablement`) is not yet
consulted per request. That is TASK-044-b, which has no brief and no commit. What the
repository does state: a fresh tenant's `config.modules` reads `elections: false` (the
manifest default plus a pin that no stored value and no settings write can widen), and
`/elections`, `/api/elections`, the rail and the `/votes` page head follow it. Until the
named end-to-end proof (part B, TASK-058-B) passes on a running stack, no document, offer
or demo may say that the running system serves no election page. The other modules of the
pilot set, calendar, content, publishing, files and messaging, are on at creation and
gated per request by the same config only; level 1 per request is still TASK-044-b.

**Board is selectable at creation.** The enable gate no longer refuses it by name (only vault
stays refused); it passes the gate like every other module, on a passed cross-customer
isolation result for the release in use. It is served in-process on kernel tables of the
customer's own database, so it has no module database of its own. A council still cannot
switch board in its own settings: it stays held back there. The isolation evidence for board
on a running host is recorded after deployment; until a host has recorded it for the release in
use, the gate refuses board like any module without evidence.

## 4. Hand-offs

| To | What |
|---|---|
| TASK-043d (panel create form) | The form lists the toggleable `plt.module` rows (`apps/control-panel/src/lib/server/modules.ts`), so content and publishing appear with the catalogue; tick votes, calendar, content, publishing, files, messaging and board, each with a DPIA reference. 058 does not edit `apps/control-panel`. |
| TASK-044-b | Resolve level 1 once per request, fail closed; PATCH to true without level 1 answers 409. Precondition for every "off" row of part B. |
| TASK-129 | An `ackNotice` field on the enable step, so the elections notice is acknowledged where the module is enabled; the in-app mount is already permanent. |
| TASK-038 (runbook) | One line: votes plus messaging plus the messaging compose profile, because the chat poll (Matrix MSC3381) needs the messaging profile. |
| New unit (vendor/automation switch) | Put any Nextcloud-polls-to-voting automation behind a files-on switch. Per the 2026-10-21 decision there is **no** Nextcloud-poll gate on protocol publishing; this switch concerns the votes poll only. Not built here. |
| Part B (TASK-058-B) | Module OFF matrix on a scratch stack once 044-b has landed; rows for finance and vault can be proven earlier (they are 404 already). |
