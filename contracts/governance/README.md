# Gremion governance contract (TASK-083)

## 1. What lives here

- `openapi.gov.json` — OpenAPI 3.1, the governance service's own `/api/v1`
  HTTP surface: meetings, agenda-sections, agenda-items, invitations (with
  notice-override and recipients), and motions (with motion-admissions).
- `asyncapi.gov.json` — AsyncAPI 3.0, the governance lifecycle event class:
  meeting scheduled/rescheduled/cancelled/opened/closed, invitation.issued,
  notice.overridden, and motion submitted/withheld/admitted/deferred.
- `fixtures/` — self-contained oasdiff fixtures for the breaking-change demo
  (brief §1, acceptance item 3): a required response field removed at the
  same version is RED, and GREEN once the version is bumped.

Built from `DOMAIN-gremion.md` v0.4's `DB-GOV-*` rows (§ "Governance core"),
not from `release-1`'s `contracts/kernel/openapi.governance.json` routes —
see §2 below.

This is **distinct** from `contracts/kernel/openapi.governance.json`, which
is the kernel's own committee surface (org-units, committee roles) and is
out of scope for this package; `boundary-lint` scans `contracts/kernel/`
only, so this directory triggers no route-coverage check there.

## 2. Release-1 reuse — checked, not taken

`B5-governance-320-subsystem` (commit `45f5bdd`, ref `…/r3b` @ `5f0d420`)
touched only `contracts/kernel/openapi.governance.json`, adding a mandate
recall endpoint, an `ended_reason: 'recalled'` value and a `DegradedWorker`
health schema. No PRD-MTG or TRD-005/408 row backs either:

- the recall belongs to bodies (L3) and stays out of this spec;
- degraded health belongs to TASK-084's `/healthz`.

Neither was taken. This spec is built from DOMAIN, not from those routes.

## 3. Scope and P3 exclusions

Only the six resource families named in the brief's acceptance (§1) are
covered. Protocol, resolution, register and poll resources — and their
events — are P3-additive (DOMAIN's events table) and are deliberately
**absent** from both documents.

## 4. Decisions carried into the spec (brief §5, orchestrator R23-26 defaults)

1. **Channel address**: `gremion.{tenantId}.gov.{entity}.{event}`, matching
   the ports subject grammar. The `govSubject` helper and its NATS topology
   entry are **not** added here — they belong to TASK-079/084; this spec
   only names the subject shape the helper must produce.
2. **Importers**: neither the governance service (TASK-084, W11) nor the
   web app's real usage (TASK-032's `gremion-ui/**`) exists yet in this
   wave. A consumer fixture in `packages/generated-clients` proves both
   import shapes (node-style and browser-style) typecheck against the
   generated client now; TASK-084 and TASK-038 assert the real importers.
3. **Dart**: a smoke run only (`openapitools/openapi-generator-cli:v7.12.0`
   via Docker, `-g dart-dio`, into the gitignored `.tmp/dart-gov/`), no
   package committed. TASK-124 (P3) owns `generated-clients-dart/**`.
4. **Ids**: section/override/admission ids are bigint, exposed as strings
   matching `^[0-9]+$` to avoid JS precision loss. Meeting/agenda-item/
   invitation/motion/recipient ids are UUIDv7, `format: uuid`.
5. **Invitation recipients**: a read-only
   `GET /api/v1/invitations/{invitationId}/recipients` is included, because
   PRD-MTG-002a's per-recipient proof needs it. No address or e-mail is
   ever exposed on that schema (DOMAIN DB-GOV-INVITATION-RECIPIENT
   invariant); the evidence lives only in MAIL.
6. **Error shape**: `application/problem+json` (RFC 9457). Every 4xx
   response declares its named problem schemas, each pinning a `type` URN
   and its `status`: `urn:gremion:problem:{unauthenticated, validation-failed,
   forbidden, not-found}` and the governance refusals
   `urn:gremion:problem:gov:{state-transition-refused, agenda-frozen,
   notice-override-missing, no-mail-connector, override-exists,
   override-not-required, invitation-already-dispatched, motion-not-late,
   admission-exists}`. `sendInvitation` 409 names the missing override and
   the missing mail connector as two distinct types.
7. **Pagination**: a cursor (`?cursor=&limit=`) on **every** list
   operation, each returning a named `*Page` (`items`, `nextCursor`).

Every operation documents 401 and 403 (the PDP decides every call); the
chair-only ones say so on their 403; every operation addressed by a path id
documents 404, and every one with a request body documents 400.

## 4a. Records the server writes

- The notice-override is append-only: `POST` records it, `GET`
  (`getNoticeOverride`) reads it back, and no PUT/PATCH/DELETE exists.
  `curing_basis_snapshot` is read-only.
- Motion admissions are append-only: `POST` records one, `GET`
  (`listMotionAdmissions`) lists them. A `defer` names exactly one target,
  `deferred_to_meeting_id` or `defer_to_next_meeting: true` (DOMAIN
  DB-GOV-MOTION-ADMISSION, SCHEMA `motion_admission_defer_check`); an
  `admit` names neither. This is an `if`/`then`/`else` in
  `MotionAdmissionCreate`; openapi-typescript does not turn it into a TS
  union, so the service validates it.
- Read-only server fields: `Motion.is_late` and `deadline_snapshot`,
  `Invitation.sender_person_id`, `AgendaItem.outcome` (set when dealt).
- Every state enum equals its DOMAIN lifecycle diagram, because adding a
  response enum value later is a MAJOR bump under the compat gate.

## 4b. Events

- Every envelope pins `eventType` to its DB-PLT-EVENT-TYPE name,
  `de.gremion.gov.<entity>.<verb>.v1` (the reverse-DNS CloudEvents 1.0
  `type` form). The calendar and content contracts carry a short
  event type instead; governance follows DOMAIN's event-type names.
- Payloads equal DOMAIN's events table field for field and are closed
  (`additionalProperties: false`). `meeting.scheduled` carries no title or
  location, and `notice.overridden` no free-text reason: readers fetch
  those from the HTTP read surface.
- `motion.deferred` carries a null `target_meeting_id` for a defer to the
  next meeting.
- The document holds only GOV's `send` operations. Consumers subscribe on
  `gremion.*.gov.>` and dedupe on `eventId`; no `receive` operation stands
  in for them.

## 4c. Nullability and value sets follow SCHEMA

Widening a response or payload type to admit `null`, or renaming an enum
value, is a MAJOR bump under the compat gate. So at 1.0.0 every column
that `SCHEMA-gremion.md` declares nullable is already nullable here, and
every NOT NULL column stays non-null (guard D6,
`governance-nullability.test.ts`):

- `Meeting.org_unit_id` is null where the body itself decides (DOMAIN
  DB-GOV organisational references), in `Meeting`, in the
  `meeting.scheduled` payload, and optional on `MeetingCreate`. Because the
  org unit can be absent, `MeetingCreate` names `body_id` (required). The
  tenant still comes from the host and token, never from the body.
- `scheduled_end`, `meeting_number`, `location` and `motion_deadline_at`
  are nullable; `scheduled_end` is optional on create and nullable in the
  scheduled/rescheduled payloads.
- `Motion.target_meeting_id` (draft, or deferred to the next meeting),
  `submitted_at` (`motion_submitted_check`) and `is_late` (a generated
  column, null while either side is null, also in `motion.submitted`).
- `AgendaItem.position` (null while proposed or declined),
  `Invitation.notice_met` (null while draft or checked) and
  `NoticeOverride.reason` (erasable in place under a covered redaction).
- `cancel_reason` uses SCHEMA `meeting_cancel_reason_check`:
  `chair_cancelled`, `body_archived`, `org_unit_archived`,
  `customer_offboarding` (guard D7).

Named schemas beyond the 2xx and request bodies (guards N1, N2):
`updateAgendaItem` takes a partial `AgendaItemUpdate` (no required field),
and the three multi-refusal 409s name their unions
(`ProblemNoticeOverrideConflict`, `ProblemSendInvitationRefused`,
`ProblemMotionAdmissionConflict`), so no generator synthesizes a name.

## 5. Ownership note (brief §3)

This directory (`contracts/governance/**`) is fully owned here. The
following edits happen **outside** this directory and are called out per
the brief's ownership rule:

- two appended entries in `contracts/registry.json` (`governance-http`,
  `governance-lifecycle`);
- in `packages/generated-clients` (TASK-030's package):
  - one codegen entry in `src/codegen.ts`;
  - two `package.json` export entries for `./governance-client` (the
    source `exports` map and the `publishConfig.exports` map), plus one
    `files` exclusion (`!src/consumer-fixture/**`) so the fixtures are
    never packed;
  - the codegen output itself
    (`src/generated/governance-client.ts`, produced only by
    `pnpm --filter @gremion/generated-clients generate`);
  - the consumer fixtures (`src/consumer-fixture/{node,browser}-style.ts`)
    with their two configs, `tsconfig.consumer-node.json` and
    `tsconfig.consumer-browser.json`, and an `exclude` of the fixtures in
    `tsconfig.build.json` so they stay out of `dist`;
  - the governance-scoped TDD suite (T1-T9, D1-D7, N1-N2):
    `governance-contracts.test.ts`, `governance-domain.test.ts`,
    `governance-http-surface.test.ts`, `governance-nullability.test.ts`
    and `governance-named-schemas.test.ts`;
- one line in the root `.gitignore` (`.tmp/`), for the Dart smoke output
  (brief §5 Q3 names `.tmp/dart-gov/` as gitignored). This edit is not in
  the brief's list of permitted outside edits; it is stated here and in
  the PR body.

No generator was added; TASK-030's existing `openapi-typescript` +
`openapi-fetch` pipeline picked up the new spec unchanged.
