# Pilot module defaults: what the repo states, what is measured, what is handed over

> **Status: product documentation for the pilot (TASK-058, part A).** It states the
> module set a pilot customer is created with and which parts of that statement are
> checked in the repository. It does **not** state what a running system serves: that is
> measured by part B, which waits for TASK-044-b (section 3).

## 1. The intended pilot set

A pilot customer is created with **votes** and nothing else enabled by default. The
create request names every module explicitly; naming no module enables none
(`packages/provisioning/test/code-default-off.test.ts`).

| Module | Pilot create request | Why |
|---|---|---|
| votes | enabled | The two open-poll forms of the pilot ([poll-usage](./poll-usage/README.md)) |
| elections | not named | Optional, no statutory election ([elections-scope](../compliance/elections-scope.md)); a permanent notice is mounted on every `/elections` page |
| finance, vault, content | not named | Excluded from the default build (`modules/disabled.json`) |
| board | not named | Not yet tenant-separated; refused by the real provisioning gate |
| handover | not named | Not part of the pilot set |

Calendar, publishing (newsletter), messaging and files are deselectable as well; they
are chosen per customer at creation, and a module that is off must leave the kernel
working with no dangling link to it.

## 2. What the repository checks (part A)

`node scripts/check-pilot-module-defaults.mjs`, with its tests in
`scripts/check-pilot-module-defaults.test.mjs`:

- (a) `test/host/fixtures/module-defaults/pilot-request.json` enables votes and none of
  elections, finance, board, vault, content, handover; every named id has a `module.json`.
- (b) no `COMPOSE_PROFILES` line in `infra/host/templates/env/*.env.tmpl` names finance,
  board, vault, content or vaultwarden.
- (c) no `modules/*/module.json` carries a default-enable declaration.
- (d) the panel create form preselects no module checkbox.

Also in place: the elections notice (`ElectionsNotice.svelte`, mounted by
`modules/elections/app/routes/elections/+layout.svelte`, text pinned to
`modules/elections/src/notice/notice.ts`) and the usage-record schema
(`poll-usage/record.schema.json`, linted against DB-MSG-POLL-USAGE).

These are repository checks. They show what is declared, not what a customer's running
stack serves.

## 3. What is not claimed

**Elections and board are not shown to be off on the running system.** The module gate
(`gremion-ui/src/lib/server/module-gate.ts`) reads the per-instance setting only and the
default settings seed every toggleable module as on; the per-customer enablement level
(`plt.module_enablement`) is not yet consulted per request. That is TASK-044-b, which has
no brief and no commit. Until it lands and the named end-to-end proof (part B, TASK-058-B)
passes on a scratch stack, a fresh customer may still serve `/elections` and `/tasks`,
and no document, offer or demo may say that elections or board are off by default on a
running system. The statement "off by default" holds for the create request and the
build, not yet for the served routes.

## 4. Hand-offs

| To | What |
|---|---|
| TASK-043d (panel create form) | Offer **votes** in the module list (today: calendar, content, publishing, finance) and validate the ids against the module catalogue. 058 does not edit `apps/control-panel`. |
| TASK-044-b | Resolve level 1 once per request, fail closed; PATCH to true without level 1 answers 409. Precondition for every "off" row of part B. |
| TASK-129 | An `ackNotice` field on the enable step, so the elections notice is acknowledged where the module is enabled; the in-app mount is already permanent. |
| TASK-038 (runbook) | One line: votes plus messaging plus the messaging compose profile, because the chat poll (Matrix MSC3381) needs the messaging profile. |
| New unit (vendor/automation switch) | Put any Nextcloud-polls-to-voting automation behind a files-on switch. Per the 2026-10-21 decision there is **no** Nextcloud-poll gate on protocol publishing; this switch concerns the votes poll only. Not built here. |
| Part B (TASK-058-B) | Module OFF matrix on a scratch stack once 044-b has landed; rows for finance, vault and content can be proven earlier (they are 404 already). |
