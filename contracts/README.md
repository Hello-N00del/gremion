# Gremion Contract Documents

## 1. What lives here

Kernel contract documents, the two module event contracts the kernel's own
subject grammar is derived from, and oasdiff test fixtures:

- `kernel/openapi.governance.json` — OpenAPI 3.1, governance/groups/health surface
- `kernel/asyncapi.provisioning.json` — AsyncAPI 3.0, provisioning lifecycle event class
- `calendar/asyncapi.calendar.json` — AsyncAPI 3.0, calendar event lifecycle
- `content/asyncapi.content.json` — AsyncAPI 3.0, content publish lifecycle
- `fixtures/oasdiff/` — base/breaking/compatible fixtures for the self-test gate

**JSON not YAML:** no YAML parser dependency exists in the repo, and NEW-FILES-ONLY
forbids adding one. oasdiff and all OpenAPI/AsyncAPI tooling fully support JSON.

## 2. Scope

The kernel owns the governance HTTP surface and the provisioning event class.

It ALSO owns the event seam: `packages/ports` builds every wire subject and
declares the JetStream stream topology, including the `calendar`, `content`,
`newsletter` and `org-unit` domains. That is deliberate — the seam has to be
disjoint across domains, and a grammar defined once in the kernel is the only
way to prove that (`nats-topology.test.ts`) — but it means the kernel names
those domains. The calendar and content AsyncAPI documents ship here for the
same reason: they are what the subject grammar is field-matched against. No
module CODE is in this repo, and the kernel imports none.

`newsletter/asyncapi.newsletter.json` is NOT here. The newsletter subject
helper predates the carve and its contract went with the module; the helper's
grammar is pinned by `broker.test.ts` in the meantime.

Route-directory coverage:

| Spec file | Covers (route-dir prefixes, relative to `src/routes/`) |
|---|---|
| `openapi.governance.json` | `api/governance/**` (8 files) · `api/groups/**` (2) · `api/health` (1) · exact-route extra: `api/committees/[id]/child-term` (governance helper under a non-governance prefix) |

**Excluded routes** (get contracts when/if they become service surfaces):
`api/auth`, `api/committees/[id]/beschluesse*` (protocols domain), `api/internal`,
`api/members`, `api/protocols`, `api/public`, `api/settings`, `api/setup` — satellite glue.
(`api/users*` is not excluded, it is ABSENT: the users-admin surface left the kernel
with its module in the carve, which is what `info.version` 0.2.0 records.)

## 3. Contract-first protocol

Change a kernel route => **same commit updates the spec**. The enforcement chain:

1. The pre-commit hook (installed via `gremion-ui/scripts/install-git-hooks.mjs`) runs
   `boundary-lint --staged`. On the spec side this does exactly ONE thing: it runs
   `oasdiff` over each staged `contracts/kernel/openapi.*.json` against its `HEAD`
   version, looking for breaking changes (operation removed/renamed, required field
   added, etc.). It does **not** schema-validate a staged spec and it does **not**
   check `$ref` resolution — the staged-file collector only picks up
   `gremion-ui/**/*.{ts,sql}`, so a staged contract never reaches the lint engine at
   all. Structural validation is step 2's job, and the unit suite's. An intentional
   break re-commits with `CONTRACTS_ALLOW_BREAKING=1`, bumps `info.version` and is
   recorded in the PR description. `--gate-self-test` proves the oasdiff gate still
   works by running it over the fixtures in `contracts/fixtures/oasdiff/`; with
   neither an `oasdiff` binary nor a reachable docker daemon it fails closed and says
   so, rather than reporting a verdict no tool produced.
2. `boundary-lint --contracts` is the enforcing whole-tree pass: it validates every
   `contracts/kernel/openapi.*.json` **and** every `contracts/kernel/asyncapi.*.json`
   document, checks `$ref` closure, and enforces route/spec coverage, exiting 1 on any
   problem. It does NOT run oasdiff — breaking-change detection needs a staged diff, so
   it lives in `--staged`. Both document lists are DISCOVERED from `contracts/kernel/`,
   not hardcoded, and each refuses to report OK when it finds no document to validate.
   Its scope is `contracts/kernel/` only: `contracts/calendar/` and `contracts/content/`
   describe module leaves that ship in their own repositories and are validated by no
   mode here — an open gap recorded in [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).
3. The `contracts-real-specs.test.ts` test enforces route/spec coverage equivalence
   (every kernel route operation appears in spec; no phantom spec operations).

**Introducing a breaking change** (e.g. P0.3b's committees POST 201->202 flip) requires:
- `CONTRACTS_ALLOW_BREAKING=1` set on the commit
- A version bump of the affected spec's `info.version`
- A PR-description note explaining the break

## 4. Gates

| Gate | Trigger | Bypass |
|---|---|---|
| `--staged` pre-commit | Every `git commit` | `--no-verify` (caveat below) |
| `--contracts` unit-suite | `pnpm test` | n/a -- runs regardless |
| CI oasdiff gate | **Not wired** -- the breaking-change gate runs locally via `--staged`; adding it to CI is an open item | n/a |

- **`--staged`** runs boundary lint on staged `gremion-ui/**` blobs, plus `oasdiff` vs HEAD on any staged `contracts/kernel/openapi.*.json` (`CONTRACTS_ALLOW_BREAKING=1` to permit a detected break). No schema validation happens here.
- **`--contracts`** (used in the unit suite) runs structural validation (`validateOpenApiDoc` / `validateAsyncApiDoc`) + `$ref` closure + bidirectional route↔spec coverage across every discovered `contracts/kernel/` document.

**`--no-verify` caveat:** bypassing the pre-commit hook is possible. What catches a bypass
is the unit suite: `src/lib/server/boundary/contracts-real-specs.test.ts` and its siblings run
the same structural validation, `$ref` closure and route↔spec coverage over the real contract
docs on every `pnpm test`, so a violation that skipped the hook still fails the branch. (The
fallback used to be a Windows scheduled task pointing at an absolute path on one maintainer's
workstation; it was operator-local glue, not kernel surface, and has been removed.) The
`oasdiff` breaking-change gate in CI is still an operator sign-off item.

## 5. v1 honesty notes

- **Schema depth is best-effort** where handlers return untyped DB aggregates: those
  responses carry `additionalProperties: true` plus a description comment. oasdiff still
  gates on operation-level breaking changes (method removed, path renamed, etc.).
- **Error-envelope convention:** governance uses `{success:false, error:string}` (see
  `GovernanceError` schema), documented in the governance spec.
- **AsyncAPI enums are provisional** until P0.3a (outbox-saga) wiring reconciles the
  event/status vocabulary. The doc is marked accordingly.
- **Boundary-lint v1 non-goals:** the design's ideal "modules only import kernel/port surfaces"
  is enforced by the boundary backstop (`lib/server/boundary/kernel-clean.test.ts`).
  `$lib/server/governance/org-units-db` is consumed repo-wide. Rules R-FK + R-IMP-1..5 implement
  the two rules the design §7 explicitly names. (See plan §3 for the complete allowlist rationale.)
