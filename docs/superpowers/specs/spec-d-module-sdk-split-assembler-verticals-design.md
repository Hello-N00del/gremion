# Spec D — Module SDK, one repo per module, assembler resolution, verticals (design)

Date: 2026-09-15 · Status: draft for operator review · Authority: the 31 decisions of 2026-09-15 and spec A §D as amended; consumes spec B's zero-module assembler, migration blocks and two-project compose split.

## Scope, the module SDK, the types reconcile, licence trigger, handover

### D.0 What spec D is, and what it takes as given from spec B

Spec D is the module-split and assembler-completion spec. It defines `@gremion/module-sdk`, the `gremion-module-<id>` repo shape, `module.json`, the vertical contract (`verticals/<id>/vertical.json`, D-02), the dist manifest's module and vertical resolution, and the clone-by-ref half of `scripts/assemble.mjs`. It does not define the host contract: the edge, the two-project compose split, the env contract, `/healthz`, `/api/internal/*`, backup and the release build are spec B's, as amended by the decisions of 2026-09-15. Per **F4** the order is B before D before C, and per **F2** every module lives in its own repo before the first assembled deploy — there is no interim holding repo, so `civitas-modules` is harvested and archived rather than split from.

Spec D consumes five things from spec B. Each is a named precondition, not a coordination point: if the B side is absent the D unit that needs it cannot start.

| Consumed from B | Decision | What D relies on | Where D would break without it |
|---|---|---|---|
| Zero-module assembler | B-16, unit `B34-assembler-zero-modules` | `scripts/assemble.mjs` exists, reads `GREMION_DIST_MANIFEST` and fails closed when unset, runs the four codegens plus `gen-realm-export`, runs the boundary lint on the assembled tree, and asserts each post-condition against the manifest count | `D9-assembler-module-resolution` has nothing to extend; `assemble.mjs` exists in no repo today |
| Migration blocks and baseline hashes | B-04, unit `B7-renumber-ranges-baseline` | fixed-width blocks (kernel 0001–0199, modules from 1000 in blocks of 100 allocated in ascending manifest `order:`), one zero-pad width of 4, text order == numeric order, baseline hashes taken from git **index** blobs on Linux after the renumber and before the split | a module repo created before the renumber pins basenames that the renumber then invalidates, and `migrations/manifest.json`'s SHA-256 pins reject the assembled tree |
| `module.json` schema ownership | B-16 | B owns the assembler; the **schema** of `module.json`, `migrations/ranges.json` and the dist manifest's `verticals[]` extension is D's (`D2-module-json-and-dist-schema`), and the assembler's verification of it is D's (`D9`) | B's zero-module path asserts against an empty manifest and needs no schema; D's verification of an SDK range needs one. `git ls-files \| grep -c module.json` is 0 in all three repos |
| Two composed files with fixed `COMPOSE_FILE` lists | B-07, unit `B14-two-project-split` | the kernel's `docker-compose.app.yml` carries ONLY kernel app-tier services (`gremion-ui`, `gremion-public`) and the shared conventions, and the host's `COMPOSE_FILE` lists in `state.env.tmpl` and `app.env.tmpl` stay fixed for every release so N20's "no `-f`" rule holds. The nine leaf service blocks live in `compose/<id>.yml` **in each module repo** and are inlined into the two composed files at release build by `D13-compose-fragment-inlining`, the single owner of the fragment contract and its guard set | a fragment has no way to enter the composition; its services are silently absent and Traefik drops their routers with no log line |
| Internal bearer and evict contract | B-11, unit `B19-internal-api-evict-and-modules` | one internal bearer, always 204 with an empty body, evict mounted outside the leaves' three-clause guard, and **an ack row (tenant, process, colour, epoch) written to the control DB by the evicting process before it answers** (B-11) | `D4-evict-on-leaves` has no contract to implement per leaf, and a fan-out that reached eight leaves is indistinguishable from one that reached nine |

D returns two things to B's own units: the SDK types that `B33-assembled-tree-guards` and `B34-assembler-zero-modules` compile against, and the module catalogue that `B19-internal-api-evict-and-modules` projects at `GET /api/internal/modules`.

### D.1 `@gremion/module-sdk` v1

#### D.1.1 Placement and package shape

The package is `civitas/packages/module-sdk`, beside `@gremion/db` and `@gremion/ports` (both `0.1.0`, `AGPL-3.0-only`, `private: false`). It mirrors their shape exactly: workspace `exports` pointing at `./src/*.ts`, a `publishConfig.exports` override pointing at `./dist/*.js` with `.d.ts`, `files: ["dist","src","!src/**/*.test.ts","README.md","LICENSE"]`, `prepack: pnpm build`. `pnpm-workspace.yaml` already globs `packages/*`, so no workspace edit is needed. Licence is `AGPL-3.0-only`: the SDK is kernel code and is consumed by closed modules exactly as `@gremion/ports` is.

Post-condition: `node scripts/check-packed-manifest.mjs` passes against the packed tarball's own `package.json` — the guard that exists because `publishConfig.exports` is a pnpm pack-time override that is silently ignored by `npm pack`.

#### D.1.2 The manifest contract — the three-way union

`types.ts` is forked three ways, in substance and in both directions: kernel 76 lines (`civitas/gremion-ui/src/lib/modules/types.ts`), StuRa tree 131 lines, holding repo 108 lines. Per **D-01** v1 carries the union. The holding-repo copy is deleted, not merged (D11).

| Export | Source of truth today | v1 status |
|---|---|---|
| `ModulePage` | identical in all three | unchanged |
| `ModuleRealmFragment` | identical in all three | unchanged |
| `ModuleManifest.id` / `.order?` / `.toggleable` / `.pages` / `.routePrefixes` / `.groups?` / `.capabilities?` / `.migrations?` / `.realm?` / `.nav?` | identical in all three (kernel `types.ts:25-76`) | unchanged; the `order?` optionality and the codegen's exit-1-without-`order:` rule both stand |
| `ModuleManifest.notTenantIsolated?: true` | StuRa only (`StuRaOS/gremion-ui/src/lib/modules/types.ts:109`) | **in v1.** Today's semantics (default OFF via `defaultModulesConfig`, `StuRaOS/gremion-ui/src/lib/server/config.ts:148`) are kept; N5's refusal is spec C's and layers on top. The kernel's `config.ts:131-138` has no such branch and gains one |
| `ModuleManifest.status?: {label, service?, note?}` | kernel only (`civitas/…/types.ts:64-71`) | **in v1.** Sole source of the Systemstatus module catalogue, consumed at `civitas/gremion-ui/src/lib/instance-status.ts:209-211` (`m.status?.label ?? m.id`) |
| `HandoverRetention` | StuRa + holding | **in v1**, optional (see D.3) |
| `HandoverSectionTypeDecl` | StuRa + holding | **in v1**, optional |
| `HandoverStepDecl` | StuRa + holding | **in v1**, optional |
| `ModuleHandoverDeclaration` | StuRa + holding | **in v1**, optional |
| `ModuleManifest.handover?: ModuleHandoverDeclaration` | StuRa + holding | **in v1**, optional; the live producer is `StuRaOS/gremion-ui/src/lib/modules/manifests/finance.ts:104` |

Post-condition: a manifest declaring `handover:` and a manifest declaring `status:` both typecheck against the SDK, and `add-a-module.proof.test.ts` passes against the SDK types in the kernel and in a scratch module package. Watched RED by a fresh verifier who removes one union member and re-runs both.

#### D.1.3 Registry contracts and composition seams

The fork runs in both directions here too: the kernel's `registry.ts` exports `moduleOwnsSegment` and `moduleHref`, which the StuRa tree does not have.

| Export | v1 source | Note |
|---|---|---|
| `MODULE_MANIFESTS` (re-export) | both (`civitas/…/registry.ts:9`) | the barrel stays kernel-generated; the SDK re-exports the type, not the value |
| `composePageAccess(vocabulary?: readonly string[])` | both, bodies identical | kernel spells the parameter `vocabulary`, StuRa `_vocabulary`; v1 takes the kernel spelling. The parameter is a live seam even though neither body reads it — call sites pass it (`civitas/…/auth/index.ts:48`, `auth/tenant-accessors.test.ts:57`) and `registry.vocabulary.test.ts` pins its behaviour |
| `composeCapabilities(vocabulary?)` | both, bodies identical | same, pinned at `auth/capabilities.ts:43` |
| `moduleRoutePrefixes()` | both | ordering defined by `order:`, pinned by `registry.test.ts` |
| `moduleOwnsSegment(segment)` | kernel only (`civitas/gremion-ui/src/lib/modules/registry.ts:19`) | **kernel-only helper, into v1** |
| `moduleHref(segment, subPath='')` | kernel only (`civitas/gremion-ui/src/lib/modules/registry.ts:31`) | **kernel-only helper, into v1** |
| `composeRealm(base, manifests, config)` | both (`civitas/gremion-ui/src/lib/modules/realm.ts`), one comment word apart | moves in unchanged |
| `composeNavSchema(base, manifests)` | both (`civitas/gremion-ui/src/lib/components/layout/nav-schema.ts:93-108`) | moves in unchanged |
| `ModuleNavSlot`, `NavTemplateEntry` | both (`nav-schema.ts:32,39`) | move in; `baseNavSchema` stays kernel data, it is not SDK surface |

#### D.1.4 Runtime-registry hooks — the 43-vs-24 union

`gremion-ui/src/lib/server/modules/runtime-registry.ts` — note the `server/` segment; unlike `types.ts` and `registry.ts` this is server-only code (kernel 313 lines / 24 exports, StuRa tree 548 / 43). The union is **44** (23 shared, 20 StuRa-only, 1 kernel-only).

| Family | Exports | Side |
|---|---|---|
| Server init | `ServerInitHook`, `registerServerInitHook`, `runServerInitHooks` | both |
| Tenant evict | `TenantEvictHook`, `registerTenantEvictHook`, `runTenantEvictHooks` | both |
| Provisioning | `ProvisioningSubsystemFactory`, `registerProvisioningSubsystem`, `buildModuleProvisioningSubsystems` | both |
| Dashboard rows | `UpcomingEventRow`, `DashApprovalRow`, `DashApprovalsContext`, `DashApprovalsResult` | both |
| Dashboard budget | `DashBudgetSummary` | **kernel only** |
| Data providers | `DataProviderContract`, `registerDataProvider`, `getDataProvider` | both, **bodies differ** (see below) |
| Protocol document port | `ProtocolDocumentPort`, `registerProtocolDocumentPort`, `getProtocolDocumentPort` | both |
| Setup health | `SetupHealthProbe`, `registerSetupHealthProbe`, `getSetupHealthProbes` | both |
| Test reset | `_resetRuntimeRegistryForTests` | both |
| Role-group grants | `RoleGroupGrantResolver`, `registerRoleGroupGrantResolver`, `resolveRoleGroupGrants` | **StuRa only** (`StuRaOS/…/runtime-registry.ts:321-332`) |
| Decision rules | `DecisionRuleContext`, `DecisionRuleStrategy`, `CORE_DECISION_RULE_IDS`, `ReservedDecisionRuleIdError`, `registerDecisionRule`, `getModuleDecisionRule` | **StuRa only** (`:353-413`) |
| Second locus | `SecondLocusSignerStageDef`, `SecondLocusAuthorityTier`, `SecondLocusStageInput`, `SecondLocusBuiltStage`, `SecondLocusActor`, `SecondLocusApprovalMeta`, `SecondLocusStageState`, `SecondLocusDistinctnessResult`, `SecondLocusStrategy`, `registerSecondLocusStrategy`, `getModuleSecondLocusStrategy` | **StuRa only** (`:442-533`) |

`DataProviderContract` is a per-key union, not a name-level one: the kernel has `'finance:dashboard-summary'`, the StuRa tree has `'finance:org-unit-refs'` and `'messages:unread-rooms'` (`StuRaOS/…/runtime-registry.ts:170-198` vs `civitas/…:172-191`). v1 carries all keys from both.

Per **D-01** the SDK unit does **not** depend on `B5-governance-320-subsystem`: the second-locus and decision-rule surfaces enter v1 as *types and registration functions* — porting the governance subsystem that registers against them is separate work, off the critical path.

**Entrypoint split.** The SDK exposes two entrypoints: `@gremion/module-sdk` (manifest types, registry contracts, nav and realm composition — importable from client code) and `@gremion/module-sdk/server` (the runtime-registry union). Post-condition: a client-side import of `@gremion/module-sdk/server` fails the build, watched RED by a fresh verifier who adds one to a `+page.svelte` in a scratch module and sees the assemble's boundary lint go RED.

#### D.1.5 The worker-safety test helper (B-15)

B-15's proof of exactly-once worker behaviour is a thin kernel smoke over five named side effects plus a test helper each module repo reuses. The helper ships from `@gremion/module-sdk` as `assertExactlyOnceUnderTwoColours(job, {claim, sideEffect})`: it runs the module's job concurrently against two colour-labelled processes on one database and asserts the named side effect occurred exactly once. Post-condition: every module repo that declares a background job in `module.json`'s `runtime.timedJobs` (`D10-module-runtime-declarations`) has a test importing this helper, and its CI fails when no such test is collected (vacuity guard). Watched RED by a fresh verifier who removes the `FOR UPDATE SKIP LOCKED` clause from one module's claim and sees the helper report two side effects.

#### D.1.6 Nav fragment anchors and the assembler-time assert

`composeNavSchema` splices each module's `nav` fragment at its `{slot:'module', moduleId}` anchor and resolves an anchor with no fragment to nothing. The reverse case has no error path: `navFor()` is only ever called *from* an anchor, so a fragment whose module has no anchor is dropped silently. The kernel's `baseNavSchema` declares **zero** anchors (only the `ModuleNavSlot` type at `civitas/…/nav-schema.ts:32`); the StuRa tree declares four (`StuRaOS/…/nav-schema.ts:84,88,100,102` — elections, finance, handover, vault).

Requirement: the kernel's `baseNavSchema` gains one anchor per module the dist manifest can select, and the assembler asserts, after the codegens, that **every `nav` fragment in the assembled manifest set landed at an anchor**; a fragment with no anchor fails the assemble. Post-condition, watched RED by a fresh verifier: assemble a manifest whose module declares a `nav` fragment with the anchor removed from `baseNavSchema`, and the assemble exits non-zero instead of producing a tree whose rail is quietly short one entry. This lands in `B33-assembled-tree-guards`, which depends on `D1-module-sdk-package`.

#### D.1.7 Semver and compatibility

v1 is `1.0.0`. The kernel declares the SDK version it satisfies; each module declares `"sdk": "<range>"` in its `module.json`, and the assembler refuses a module whose range the kernel does not satisfy (`D9-assembler-module-resolution`, schema in `D2-module-json-and-dist-schema`). Policy, written into the package README:

- adding an optional `ModuleManifest` field, a new `DataProviderContract` key, or a new registration family → **minor**;
- narrowing a type, removing an export, changing a signature, or making an optional field required → **major**;
- doc and comment changes → **patch**.

Post-condition: a `module.json` with `"sdk": "^2"` against a `1.x` kernel is REFUSED by the assembler, watched RED.

#### D.1.8 Publication

`release-npm.yml:14-21` records the two operator steps that gate npm publication: the `@gremion` scope is unclaimed, and the trusted publisher (GitHub Actions OIDC, repository `Hello-N00del/gremion`, workflow `release-npm.yml`) is unregistered. Both are **operator items**, and they cover `@gremion/db` and `@gremion/ports` as well.

**One SDK-consumption rule, not two.** Inside the assembled tree the SDK resolves as `workspace:*` — the kernel's `pnpm-workspace.yaml` globs `packages/*`. `civitas/gremion-ui/package.json` gains `"@gremion/module-sdk": "workspace:*"` beside its existing `@gremion/db` and `@gremion/ports` entries (`civitas/gremion-ui/package.json:50-51`), named as part of `D1-module-sdk-package`, and each module repo's `service/package.json` declares `"@gremion/module-sdk": "workspace:*"` too. Per-repo CI during the interim clones the kernel at `module.json.kernelRef` into `.kernel/` and installs with a CI-only workspace file globbing `.kernel/packages/*` and `service`, so a module repo builds alone without a registry and without a second specifier form. After the D-05 exit the dependency becomes a version range and the clone step is deleted. The committed assembled lockfile (B-17) is the only lockfile that gates an image build.

Until the operator items complete, per **D-05**'s named interim, release-1 leaf images are built by the kernel's release workflow from the assembled tree — twice, full and OSS. D-05 is **a named interim with a dated operator exit condition**. The exit *condition* is fixed in §3, "Interim leaf-image build (D-05)"; the exit **date is 2026-11-30**, proposed here for the operator to confirm or change at the review gate. The date and the three conditions — the `@gremion` scope claimed, the trusted publisher registered, `@gremion/{db,ports,module-sdk}` published — live in a tracked kernel issue created at plan dispatch and referenced by both specs as **the D-05 exit issue**. §4's guard register carries the matching row, `check-interim-expiry`: the release workflow fails after that date while `scripts/release/build-leaves-interim.mjs` still exists.

### D.2 The licence trigger (N17) in `CONTRIBUTING.md`

`civitas/CONTRIBUTING.md:84-88` today asserts the mitigation as if it were already true: "The few that are closed (finance, content, vault, handover) stay closed … by being **separate programs / services** over Gremion's stable APIs." In the assembled distribution their in-process halves are compiled into the app, so that sentence describes the destination, not the release-1 state. Per **D-01**, N17's trigger is written into `CONTRIBUTING.md` in the same change as the SDK, saying so plainly: the assembled app is a combined work of the AGPL kernel and the private modules; this is lawful while the operator holds copyright on every kernel line; **before the first external contribution to the kernel is merged, either the private modules run as separate services with their own UI, or the contribution is declined.** The paragraph names the four private modules (M3: finance, content, vault, handover) and states that `handover` has no service today.

Post-condition: `CONTRIBUTING.md` contains the trigger sentence and no longer asserts the separate-services mitigation in the present tense; a guard in the kernel's docs lint fails if the private-module list in `CONTRIBUTING.md` diverges from the `visibility: private` set in `gremion.dist.example.json`, watched RED by flipping one module's visibility.

### D.3 Handover

Per **M3** handover is a private (closed) module, and per **D-01** it stays private with **no extraction now**. It is the one private module with no leaf service — `StuRaOS/services/` holds nine leaves (board, calendar, content, files, finance, messages, newsletter, vault, votes) and none of them is handover — so N17's separate-services mitigation does not reach it. That is a stated residual of release 1, not a defect to be fixed inside it.

Its four declaration types ship in the SDK regardless of visibility (D.1.2), because `finance.ts:104` declares a `handover:` block and the union must typecheck with finance present and handover absent. No `gremion-module-handover` repo is created in release 1. Migrations `050_handover_schema`, `051_handover_event`, `052_handover_module_binding` (`StuRaOS/gremion-ui/src/lib/modules/manifests/handover.ts:39`) do not ship; block 1900–1999 is reserved and empty; and **no handover code enters either image set, the full set included** — the four declaration types are the whole of what ships. Release 1 therefore ships ten module repos, nine leaf images and zero extracted handover code (counts in §3). The code is frozen inside the archived StuRa tree, recoverable with `git archive f276af59 -- gremion-ui/src/lib/handover …` as recorded in `ARCHIVED.md` (§3, Archiving).

Handover's visibility is **re-opened as a standalone dated decision** (D-01), not settled inside spec D and not re-argued here. `D16-handover-visibility-record` files that decision and ships the implementable half meanwhile — the `CONTRIBUTING.md` private-module list and its docs-lint guard. Until it is filed, handover is private and the CONTRIBUTING trigger names it.

### Units in this section

Units for this section: `D1-module-sdk-package`, `D16-handover-visibility-record`; the table is at "Units — spec D". The nav-anchor half of `B33-assembled-tree-guards` is specified in D.1.6 and stays a spec-B unit. Consumed but owned elsewhere: `D2-module-json-and-dist-schema` (schema of `module.json`, `migrations/ranges.json`, `verticals[]`), `B34-assembler-zero-modules`, `B14-two-project-split` (kernel app-tier blocks and the fixed `COMPOSE_FILE` lists), `D13-compose-fragment-inlining` (the fragment contract and its guard set), `D9-assembler-module-resolution` (SDK-range verification), `D10-module-runtime-declarations` (`runtime.timedJobs`), `D4-evict-on-leaves`, `D5-remaining-module-repos`, `D11-archive-holding-repo-and-stura-tree` (deletes the third `types.ts` fork).

## Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)

### Scope

This section fixes, for every `gremion-module-<id>` repository that F2 requires to exist before the first assembled deploy: its file layout, its line-ending policy (D-03), its CI, its Dependabot config, the secrets it holds, and the procedure by which it is created from git index blobs. It also fixes four JSON schemas — `module.json`, `migrations/ranges.json`, the dist manifest, and `verticals/<id>/vertical.json` (D-02) — and where each file lives. Migration *numbering* is B-04 and is owned by spec B's renumber unit `B7-renumber-ranges-baseline`; this section consumes its output. The assembler's clone-and-resolve half is B-16's D-side and is specified under the assembler heading; this section states only what a module repo must present to it. Enablement (which modules the release-1 manifest turns on) is a dist-manifest fact and belongs to the release section.

### Repo inventory and visibility

Ten module repos exist before the first assembled deploy (F2 — no interim holding repo; `civitas-modules` is harvested and archived by D11). Handover is the eleventh module id and gets no repo in release 1 (D-01); its block is reserved in `ranges.json` and its declaration types ship in the SDK. `news` is not a repo: it folds into `gremion-module-content` with migration 047 (D-04). `vaultwarden` is deleted, not extracted (M3; the removal is spec B's and carries no unit of its own — it is post-condition text inside `B8-tenant-domains-and-leaf-trust` and `B18-router-emitter-library` — see §3).

| Repo | Visibility | Leaf (`service/`) | Leaf image (`images[]`, `role: leaf`) | `notTenantIsolated` |
|---|---|---|---|---|
| `gremion-module-users` | public | no | — | no |
| `gremion-module-board` | public | yes | `ghcr.io/hello-n00del/gremion-board` | **yes** |
| `gremion-module-calendar` | public | yes | `ghcr.io/hello-n00del/gremion-calendar` | no |
| `gremion-module-elections` | **private until #353 closes, then public** | yes | `ghcr.io/hello-n00del/gremion-elections` | no |
| `gremion-module-files` | public | yes | `ghcr.io/hello-n00del/gremion-files` | no |
| `gremion-module-messages` | public | yes | `ghcr.io/hello-n00del/gremion-messages` | no |
| `gremion-module-newsletter` | public | yes | `ghcr.io/hello-n00del/gremion-newsletter` | no |
| `gremion-module-content` | **private** | yes | `ghcr.io/hello-n00del/gremion-content` | no |
| `gremion-module-finance` | **private** | yes | `ghcr.io/hello-n00del/gremion-finance` | no |
| `gremion-module-vault` | **private** | yes | `ghcr.io/hello-n00del/gremion-vault` | **yes** |
| `gremion-module-handover` | **private — NOT created in release 1** (D-01: no extraction now) | no | — | no |

`elections` ships `module.json.visibility: "private"` and a matching dist-manifest entry until #353 (Helios licence compliance) closes; the flip is one commit changing both. OSS-set membership is **computed at release build from the dist manifest's `visibility` field, never hard-coded**, so the flip needs no guard edit, and the OSS-artefact guard (§4 D.2) is what proves it landed.

Nine leaves, matching the nine service directories at the extraction source (`git ls-tree f276af59 services/` → board, calendar, content, files, finance, messages, newsletter, vault, votes). The leaf image name is keyed on the **module id**, so `services/votes` becomes `gremion-module-elections/service/` with image `gremion-elections`; the `votes` directory name does not travel. Every first-party image takes the flat form `ghcr.io/hello-n00del/gremion-<name>`, the convention the kernel's own `gremion-ui` / `gremion-public` / `gremion-migrate` already carry.

Beyond its leaf, a module repo contributes **sidecar** images, declared in the same `images[]` array with `role: "sidecar"` and built by the same interim release pass (D-05) from the module repo's `docker/<name>/`, moved there from the StuRa tree by D3/D5: messages contributes synapse, element-call and livekit; files contributes nextcloud and collabora; elections contributes helios. Spec B's GHCR table lists these as module-owned rows, not as images ported from the StuRa tree's `docker/`. Two of the six carry configuration only — `find StuRaOS/docker -name 'Dockerfile*'` lists element-call, fallback, helios, legal, nextcloud, synapse and vector, and **no** livekit and no collabora — so their `images[]` entries declare the pinned third-party reference with a null build context and `pin-images.sh` resolves them; the other four are built.

### Repo layout

```
module.json            the declaration below; the only file the assembler parses before cloning content
app/                   the in-process half at app-relative paths, rooted so that app/<p> lands at <p>
  src/lib/modules/manifests/<id>.ts      the ModuleManifest (carries realm/nav/migrations/capabilities)
  src/lib/server/<id>/**  src/lib/components/<id>/**  src/routes/**  src/lib/client/**
  migrations/**.sql      the module's app-database DDL, inside its declared block
service/               the leaf: src/, Dockerfile, migrations/, tenant-store.ts where one exists
compose/<id>.yml       the module's compose fragment: leaf + its Postgres + profile <id> + this module's
                       state-tier services, every service block carrying x-gremion-tier (B-07; the
                       fragment contract and its guard set are D13-compose-fragment-inlining's, §4)
docker/<name>/         build context for each sidecar image the module contributes (synapse,
                       element-call, nextcloud, helios)
tests/                 vitest suites that do not belong beside the source
.github/workflows/ci.yml   the per-repo workflow below
.github/dependabot.yml
.gitattributes
package.json / pnpm-lock.yaml / pnpm-workspace.yaml   needed only by service/ builds (D-05 exit)
```

`app/` is rooted at the *app* path, not the repo path: `app/src/lib/server/calendar/**` is copied by the assembler to `gremion-ui/src/lib/server/calendar/**`. The assembler therefore performs no path arithmetic, and a module repo file's blob hash is identical to the blob it was extracted from (see verification below).

#### `.gitattributes` (D-03)

Module repos mirror the kernel's policy, not spec A §D:202's `-text`, which permits a CRLF blob and so permanently breaks the SHA-256 immutability mandated in the same paragraph. The kernel's file (`civitas/.gitattributes:5-16,37`) is explicit per-extension and per-directory and carries **no** `* text=auto` catch-all — verified: 74 lines, `grep -n "text=auto"` returns nothing. D-03's "mirror the kernel's policy" therefore means the kernel gains the catch-all in the same change as the module template, so that one policy statement covers both trees; the kernel's existing explicit lines stay, because they document why each directory needed one. Every module repo ships, at creation, before any content commit:

```
* text=auto eol=lf
*.sql text eol=lf
*.sh  text eol=lf
Dockerfile* text eol=lf
*.generated.ts text eol=lf
```

Post-condition: `git ls-files --eol` over a fresh clone reports `i/lf w/lf` for every tracked file. Watched RED by a fresh verifier who commits a CRLF-terminated `.sql` on a branch and sees the `lint-eol` job fail. `civitas-modules` is the live counter-example (`i/lf w/crlf attr/`, no `.gitattributes`) and is exactly why this lands first.

#### Per-repo CI (`.github/workflows/ci.yml`)

One workflow, eight jobs, identical across the ten repos except for the id; the eighth (`evict-contract`) exists in every repo that ships a `service/` — nine of the ten:

| Job | Asserts | Watched RED by |
|---|---|---|
| `lint-eol` | every tracked file is `i/lf` in the index | a committed CRLF `.sql` |
| `validate-module-json` | `module.json` passes the SDK's validator (D-01/D2): SDK range satisfied by the kernel's SDK version, `kernelRef` present and resolvable, migration block matches `ranges.json`, `order` and `notTenantIsolated` match `ranges.json` and the TypeScript manifest, `extractionSource` present and agreeing, declared fragment paths agree with the manifest's actual `realm`/`nav` fields, `compose.services[]` agreeing with the fragment, `images[]` carrying at most one `role: "leaf"`, and the `runtime` block present for every repo with a `service/` | a module.json with an out-of-range migration number, an unsatisfiable SDK range, and a colliding `order` — three separate RED cases |
| `test` | vitest over `app/` and `service/`, with a vacuity guard that fails the job when zero test files are collected | deleting every `*.test.ts` from `app/` on a branch — the job must FAIL as vacuous, not pass with zero collected files |
| `boundary-lint` | the kernel's `boundary-lint --all` (`civitas/gremion-ui/scripts/boundary-lint.ts:2-8`) run over `app/`, with the SDK as the only sanctioned kernel import surface; vacuity guard: scanned-file count ≥ tracked `app/` file count | a planted deep import into another module (the rule), **and** pointing the lint at an empty directory — the scanned-file count then falls below the tracked `app/` file count and the job must FAIL rather than report clean |
| `migrations-range` | every file in `app/migrations` and `service/migrations` is zero-padded to width 4, inside the declared block, and `files.sort()` equals numeric order | a `999_x.sql` and a `1000_x.sql` in one directory |
| `baseline-hashes` | each already-shipped migration's SHA-256 equals the kernel's committed `migrations/baseline-hashes.json` entry for its path | one changed byte |
| `evict-contract` | `POST /api/internal/evict {"tenant":"*"}` with the internal bearer returns **204 with an empty body**; a **200 fails the job**; the route is mounted **outside the three-header guard** (`x-internal-auth`, `x-tenant-id`, `x-tenant-slug`); and the handler writes its ack row before answering (B-11) | a fresh verifier who makes the handler return 200, and one who suppresses the ack-row write |
| `leaf-image` | **absent until the D-05 exit.** Until then a guard asserts the repo contains no `docker build`, `docker/build-push-action` or `docker/login-action` reference anywhere under `.github/` | adding a `build-push-action` step |

The host-side proof of the same evict contract — the both-colour fan-out reaching every process and getting exactly 204 from each — stays in spec B's `test/host/deploy.bats` (spec B §T.5). This job proves the contract per repo, before any host exists.

The `leaf-image` posture is D-05 stated as code: release-1 leaf images are built by the kernel's release workflow from the assembled tree, twice (full and OSS), as **a named interim with a dated operator exit condition**. The exit date is **2026-11-30**; that date and the three conditions — `@gremion` scope claimed, trusted publisher registered, `@gremion/{db,ports,module-sdk}` published — live in a tracked kernel issue created at plan dispatch and referenced by both specs as **the D-05 exit issue**. Until the exit a module repo cannot build its own leaf, because every leaf Dockerfile takes the **repo root** as context and copies `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `upstream/gremion/packages/ports` (`StuRaOS/services/calendar/Dockerfile:2-5,19-27,30`). The guard-register row `check-interim-expiry` fails the release workflow after the exit date while `scripts/release/build-leaves-interim.mjs` still exists (§4).

**SDK resolution during the interim (§4 D.1.8).** Inside the assembled tree the SDK resolves as `workspace:*` — the kernel's `pnpm-workspace.yaml` globs `packages/*` — and each module repo's `service/package.json` declares `"@gremion/module-sdk": "workspace:*"` for exactly that reason (`civitas/gremion-ui/package.json` gains the same entry, owned by `D1-module-sdk-package`). Per-repo CI has no such workspace, so during the interim it **clones the kernel at `module.json.kernelRef` into `.kernel/`** and installs with a **CI-only workspace file** globbing `.kernel/packages/*` and `service`; that file is never committed into the assembled tree and never reaches an image build. The committed assembled lockfile (B-17) is the only lockfile that gates an image build. After the D-05 exit the dependency becomes a version range, the clone step is deleted, and the `leaf-image` job is added in the same commit that deletes the no-build guard.

#### Dependabot (`.github/dependabot.yml`)

Following the kernel's `directories:` form and its stated reason (`civitas/.github/dependabot.yml:64-72` — a glob is unreliable and `directory: /` finds only `/Dockerfile`):

| ecosystem | directories | note |
|---|---|---|
| `github-actions` | `/` | weekly |
| `npm` | `/`, `/service` | weekly; `/` covers `app/`'s devDependencies |
| `docker` | `/service`, plus one entry per `docker/<name>/` that holds a Dockerfile | **every Dockerfile directory, enumerated** — `/service` is omitted for `users`, the one module repo with no `service/`; `docker/synapse`, `docker/element-call` (messages), `docker/nextcloud` (files) and `docker/helios` (elections) are the four sidecar contexts |

This closes the gap the assembler-release digest records against spec A §K: the kernel's own list (`/docker/legal`, `/docker/vector`, `/gremion-ui`, `/gremion-public`) covers no leaf Dockerfile today, and once the leaves and their sidecars move out of the StuRa tree nothing covers them at all.

#### Secrets

| Repo | Secret | When |
|---|---|---|
| every module repo | none; the default read-only `GITHUB_TOKEN` only | before the D-05 exit |
| every module repo | `GITHUB_TOKEN` with `packages: write` (job-scoped, never a stored secret) | after the D-05 exit, for `leaf-image` |
| kernel (`release.yml`) | the N23 per-run GitHub App installation token, read-only on the module repos and their packages | B-16; used in the runner only, never passed into a build container |
| `gremion-dist` (private) | none of its own | read by the App token (B-16) |

No module repo ever holds an npm token: module repos publish no npm package, and the kernel's publish path is OIDC trusted publishing with no stored token (`civitas/.github/workflows/release-npm.yml`).

Runtime secrets do not live in a module repo either. `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf are declared in `app.env.tmpl` (added by `B14`, covered by the env coverage cross-check); a fragment references them as `${INTERNAL_<LEAF>_SECRET:?}`, and the assembler's render guard fails on a leaf fragment that references an undeclared key.

### Creation from git index blobs (D-03, F2)

**Source of truth.** The StuRa tree at `f276af59` for every module path, and the kernel at `f7ac826` for any path where B-02's kernel-wins rule applies or where B-06 made the kernel's bytes canonical. Never `civitas-modules` (a late-July snapshot: 5 of 12 manifests, 1 of 9 leaves, its own third `types.ts`), and never a working tree — this box checks `.sql` out as CRLF.

**Procedure**, per repo, run inside a Linux container so no Windows checkout filter can touch a byte:

1. `git -C <source> archive <sha> -- <path> …` piped through `tar -x` into an empty directory, one invocation per source SHA. Paths are transposed class×module → module by the carve manifest's module path-class rules — `product-leaf-services`, `product-helios`, `product-module-infra`, `product-module-contracts`, `product-module-routes`, `product-module-api-routes`, `product-module-server-lib`, `product-module-client-lib`, `product-module-components`, `product-module-manifests`, `product-module-seeders`, `product-module-migrations`, `product-module-ops-scripts`, `product-module-coupled-tests` (`StuRaOS/scripts/carve/kernel-manifest.json`, 51 first-match-wins rules; `product-only-docs` and `product-hosted-ops` are not module classes and are excluded) — which already name each module inside every path class; a `--path-rename`-shaped map file records every `<source path> → <repo path>` pair and is committed as `extraction-map.json` in the module repo.
2. `git init`; commit `.gitattributes` **alone** as the first commit; then commit the extracted tree.
3. Release 1 uses `git archive` (single extraction commit), not `git filter-repo`: history stays in the StuRa tree, which D11 archives with its carve tooling frozen in place.

**Verification** (the post-condition that makes "from index blobs" checkable rather than asserted): for every tracked path `p` in the new repo, `git -C <module repo> rev-parse HEAD:<p>` equals `git -C <source> rev-parse <sha>:<extraction-map[p]>`. Renames — including B-04's renumber, which is rename-only — preserve blob identity, so the comparison holds against `f276af59` even for a finance migration whose filename changed from `013_finance_schema.sql` to `1000_finance_schema.sql`. A path whose bytes were deliberately changed (the 8 shared migrations B-06 adjudicates, the `brand.product` scrub of D-02) is listed in `extraction-map.json` with its post-change source SHA and is compared against that. The job fails on the **first** mismatch and prints both hashes; it also fails if `extraction-map.json` does not cover every tracked path (vacuity guard). Watched RED by a fresh verifier who rewrites one byte of one extracted file and re-runs it.

### Schemas

#### `module.json` — repo root of each `gremion-module-<id>`

```jsonc
{
  "schemaVersion": 1,
  "id": "calendar",                       // == the manifest's id and the config.modules key
  "sdk": "^1.0.0",                        // semver range checked against @gremion/module-sdk's version
  "kernelRef": "f7ac826d3a1b4c5e6f7089abcdef0123456789ab",  // 40-char lowercase hex; the kernel COMMIT this
                                          // repo's CI clones into .kernel/ during the D-05 interim. A tag is
                                          // refused: it is movable, and the interim build must be reproducible.
  "visibility": "public",                 // "public" | "private" — the OSS artefact guard (B-16) reads this
  "order": 70,                            // MUST equal ranges.json's order AND the TS manifest's order:
  "notTenantIsolated": false,             // true only for board and vault; MUST equal the TS manifest's value
  "extractionSource": "f276af5925abacdcfd05f6613fc11afff2d804c5",  // 40-char lowercase hex; every enabled module agrees
  "migrations": {
    "block": [1500, 1599],                // MUST equal ranges.json's block for this id
    "app":     [],
    "service": []
    // calendar's block is reserved and EMPTY in release 1: 003_calendar_schema stays kernel-applied
    // (spec A §D) and renumbers to 0003_ inside the kernel block
  },
  "images": [                             // at most one role: "leaf"; [] when the module has no service/
    { "id": "calendar", "image": "ghcr.io/hello-n00del/gremion-calendar",
      "context": "service", "role": "leaf" }
    // sidecars take the same shape with "role": "sidecar" and "context": "docker/<name>";
    // a pinned third-party sidecar (livekit, collabora) carries "context": null
  ],
  "realmFragmentPath": "app/src/lib/modules/manifests/calendar.ts",  // null when the module owns no groups/roles
  "navFragmentPath":   null,              // null when the module has no rail entry
  "navAnchorId":       null,              // required and non-null whenever navFragmentPath is set
  "compose": {
    "fragmentPath": "compose/calendar.yml",                 // null when the module has no fragment
    "services": ["calendar-postgres", "calendar-service"],  // every service name the fragment contributes
    "profile":  "calendar"                // the compose profile the fragment's services carry
    // the per-service tier is NOT here: it lives on the service block as x-gremion-tier (§4)
  },
  "runtime": {                            // consumed by D10-module-runtime-declarations
    "leafService": {
      "name": "calendar-service",         // host-fixed; the name the fragment must use
      "port": 8080,                       // host-fixed for every leaf
      "postgresService": "calendar-postgres",
      "databases": { "control": "<leaf control database>", "tenantPattern": "<per-tenant database pattern>" }
    },
    "timedJobs": [{ "id": "<job id>", "activeColourOnly": true }],
    "shred": false                        // true only for a leaf with a real per-tenant shred arm
  }
}
```

The realm and nav fragments stay *on* the manifest object — moving them out would fork a seam that already works (`composeRealm`, `composeNavSchema`). What `module.json` adds is a **declaration the validator checks against the manifest**: a repo declaring `navFragmentPath: null` whose manifest exports `nav` is refused; one declaring a `navAnchorId` the kernel's `baseNavSchema` does not define is refused at assemble time; and `order` / `notTenantIsolated` must be equal in all three places — `module.json`, `ranges.json` and the TypeScript `ModuleManifest` — each disagreement watched RED by changing exactly one of the three. That is the guard for the silent-failure class the module-system digest names — `composeNavSchema` drops an unanchored fragment with no error, and the kernel's `baseNavSchema` has zero `{slot:'module'}` anchors today. `extractionSource` is the frozen-source field spec B's `B00-extraction-source-freeze` names by key: 40-character lowercase hex, identical across every enabled module, and the assembler fails the build when two `module.json` files disagree. `images[]` replaces the single-string `leafImage` a module with sidecars could not express; `compose.fragmentPath` plus `compose.services[]` are what the render guard counts, and `runtime` is what removes the last hand-maintained host list.

**Projection into `GET /api/internal/modules` (spec A §D).** The endpoint serialises, per **enabled** module: `id`, `displayName`, `order`, `notTenantIsolated`, `realm` fragment, `migrationBlock`, `extractionSource`, `distManifestDigest`, and the `runtime` block above — with no third place to look. `id`, `order`, `notTenantIsolated`, `migrationBlock`, `extractionSource` and `runtime` come from `module.json`; `displayName` from the manifest's `status.label`, falling back to `id` exactly as `civitas/gremion-ui/src/lib/instance-status.ts:209` already does; the `realm` fragment from the manifest's `realm` block, declared present or absent by `module.json.realmFragmentPath`; `distManifestDigest` from the release. `BACKUP_POSTGRES_SERVICES` and the colour-policy job list are **produced from this catalogue at assemble time** (written into `state.env` / `app.env` by the assembler), never hand-maintained, and spec B §3.4 reads the leaf list from `runtime.leafService.postgresService`. Post-condition: the endpoint's response for an assembled tree equals that projection over the enabled set, watched RED by a fresh verifier who flips one module's `notTenantIsolated` in `module.json` without touching the manifest and sees the validator refuse the build.

#### `migrations/ranges.json` — kernel, beside `gremion-ui/migrations/manifest.json`

One allocation table, in one repo, is what prevents ten independent repos from colliding on `order` or on a migration number (`build-module-manifest.mjs:77-88` exits 1 without an `order:` and breaks ties on filename only). `B7-renumber-ranges-baseline` writes the file; the D2 validator reads it.

```jsonc
{
  "schemaVersion": 1,
  "padWidth": 4,                          // B-04: ONE width, so text order == numeric order
  "kernel": {
    "block": [1, 199],
    "highWater": 58,
    "crossCuttingModuleTables": ["calendar_events", "committee_elections", "deck_board"]
                                  // B7's written rule, machine-readable: the three module tables
                                  // owned by kernel-block migrations 0003, 0004 and 0034
  },
  "modules": {
    //  order  block          highWater  legacy  extractedTo
    "finance":    { "order": 20,  "block": [1000, 1099], "highWater": 1019, "legacy": [], "extractedTo": "gremion-module-finance" },
    "elections":  { "order": 30,  "block": [1100, 1199], "highWater": 1099, "legacy": [], "extractedTo": "gremion-module-elections" },
    "content":    { "order": 40,  "block": [1200, 1299], "highWater": 1204, "legacy": [], "extractedTo": "gremion-module-content" },
      // 1200 creation (B4a-news-posts-ownership), then 044→1201, 045→1202, 046→1203, 047→1204 (D-04)
    "newsletter": { "order": 50,  "block": [1300, 1399], "highWater": 1299, "legacy": [], "extractedTo": "gremion-module-newsletter" },
    "users":      { "order": 60,  "block": [1400, 1499], "highWater": 1399, "legacy": [], "extractedTo": "gremion-module-users" },
    "calendar":   { "order": 70,  "block": [1500, 1599], "highWater": 1499, "legacy": [], "extractedTo": "gremion-module-calendar" },
    "files":      { "order": 80,  "block": [1600, 1699], "highWater": 1599, "legacy": [], "extractedTo": "gremion-module-files" },
    "messages":   { "order": 90,  "block": [1700, 1799], "highWater": 1699, "legacy": [], "extractedTo": "gremion-module-messages" },
    "board":      { "order": 100, "block": [1800, 1899], "highWater": 1799, "legacy": [], "extractedTo": "gremion-module-board" },
    "handover":   { "order": 110, "block": [1900, 1999], "highWater": 1899, "legacy": [], "extractedTo": null },   // reserved, no repo (D-01)
    "vault":      { "order": 115, "block": [2000, 2099], "highWater": 1999, "legacy": [], "extractedTo": "gremion-module-vault" }
  }
}
```

`legacy` is the old-filename list and stays present and **empty**: the renumber is what makes it unnecessary, and an empty array is the assertion that it is unnecessary. `extractedTo: null` records a reserved block with no module repo behind it — in release 1 that is handover alone, whose files ship nowhere (D-01). `highWater` is the highest number already shipped in that block (one below the block start where nothing has shipped); a new migration must exceed it. It is captured by `B7-renumber-ranges-baseline` together with `baseline-hashes.json` and is what makes "a new migration" distinguishable from "a renamed old one" at assemble time (§4 D.1.7).

The D2 validator checks `module.json.order == ranges.json.modules[id].order == ModuleManifest.order`, and the same equality for `notTenantIsolated`; each disagreement is watched RED by changing exactly one of the three.

`order` values are the existing registered ranks (core 10 … vault 115), kept because route-prefix sequence is pinned by `registry.test.ts`. `ranges.json` is the sole allocation table: blocks are allocated in **ascending manifest `order:`** at 100 wide from 1000, which supersedes spec A §D:205's illustrative three-module list (finance/content/handover) — that list named no block for the eight modules between them. `padWidth: 4` is what makes `files.sort()` equal numeric order under both lexicographic runners. `migrations/baseline-hashes.json` sits beside it and is captured by the same unit from git index blobs on Linux, after the renumber and before the first split.

**Fresh-init replay (spec A §D).** A unit test replays fresh-init migration file selection once per module with that module OFF, asserting that the selected set applies cleanly against an empty database and that no selected file references an object only a skipped file creates. Post-condition, watched RED by a fresh verifier: mark `1000_finance_schema.sql` selectable with finance OFF and the replay fails on the missing `finance` schema.

#### `gremion.dist.json` (private) and `gremion.dist.example.json` (kernel)

```jsonc
{
  "schemaVersion": 1,
  "sdk": "1.x",
  "modules": [
    { "id": "calendar", "repo": "Hello-N00del/gremion-module-calendar", "ref": "v1.0.3", "visibility": "public" },
    { "id": "finance",  "repo": "Hello-N00del/gremion-module-finance",  "ref": "v1.0.1", "visibility": "private" }
  ],
  "verticals": [
    { "id": "stura", "repo": null, "ref": null, "visibility": "public" }   // repo null ⇒ verticals/stura/ in the kernel tree (F3)
  ]
}
```

`visibility` on a vertical is mandatory (D-02): an out-of-tree vertical can carry a named council's wording and legal templates, and without the field it is the unguarded path around the module visibility rules. Locations: the real manifest lives in the **private `gremion-dist` repo** (B-16, created by `D14-gremion-dist-repo`), checked out by `release.yml` with the N23 App token; on the host it is `/opt/gremion/etc/gremion.dist.json`, already wired as `GREMION_DIST_MANIFEST` into both project env files (`civitas/infra/host/templates/env/state.env.tmpl:66`, `app.env.tmpl:26`) and read by nothing today. `gremion.dist.example.json` is committed in the kernel and names only public modules and only in-kernel verticals. A release records the manifest's digest — `"sha256:" + <64 lowercase hex>` of the manifest bytes as read (§4) — never its content; the assembled lockfile is committed into the release tree next to `release.json` and the pins (B-17), so two builds of one `distManifestDigest` resolve identical dependency trees.

#### `verticals/<id>/vertical.json` — kernel tree (F3)

```jsonc
{
  "schemaVersion": 1,
  "id": "stura",
  "visibility": "public",
  "blueprintRef": "STURA_BLUEPRINT@1",          // resolved by resolveBlueprint(); an unknown ref THROWS
  "configPreset": "config.preset.json",         // the org/brand/portal_sections/modules/legal/retention preset
  "wording": "wording.de.json",                 // wording overrides only; no shared-code literals
  "theme": "theme.tokens.json",
  "legalTemplates": ["legal/impressum.html.tmpl", "legal/datenschutz.html.tmpl",
                     "legal/barrierefreiheit.html.tmpl"]
}
```

A vertical is **data only** (D-02). `configPreset` is the shape already shipped at `StuRaOS/examples/verticals/{musterstadt,verein}/config.json` (`org`, `brand`, `portal_sections`, `modules`, `elections`, `calendar`, `legal`, `backups`, `retention`, `compliance`), with `brand.product` scrubbed of the `Civitas` literal (M12 — a live class-42 mark). `blueprintRef` is resolved against the kernel's existing registry (`civitas/gremion-ui/src/lib/server/seed/blueprint-registry.ts:18` declares `DEFAULT_BLUEPRINT_REF`, `:29` `resolveBlueprint(ref: string)`, which throws at `:32` on an unknown ref rather than falling back to StuRa; `BLUEPRINTS` holds `STURA_BLUEPRINT@1` and `MUNICIPAL_BLUEPRINT@1`). The **same validator** that checks `module.json` checks `vertical.json`, and it calls `resolveBlueprint` during validation so an unresolvable ref fails the assemble, not the first tenant seed. Post-condition: no vertical literal appears outside `verticals/`, asserted by a repo-wide grep guard watched RED by planting one.

### Units in this section

Units for this section: `D2-module-json-and-dist-schema`, `D12-module-repo-ci-and-dependabot-template`, `D3-first-module-repo-users`, `D5-remaining-module-repos`, `D8-stura-vertical`, `D6-leaf-images-and-compose-fragments`, `D14-gremion-dist-repo`, `D11-archive-holding-repo-and-stura-tree`; the fragment contract this section's layout points at is `D13-compose-fragment-inlining`'s (§4). The table is at "Units — spec D".

## Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving

### Scope, source, and invariants

Extraction source is frozen at StuRaOS `f276af59`; every `module.json` records that SHA in its `extractionSource` key (§2; risk 10, understand-map §5). Every `gremion-module-<id>` repo is created from **git index blobs** (`git archive` / `filter-repo`), never a working tree, with `.gitattributes` carrying `* text=auto eol=lf` plus explicit `text eol=lf` for `.sql`/`.sh`/`.generated.ts` in the initial commit (D-03). The modules holding repo is never a source: `civitas-modules` holds 5 of 12 manifests, 1 of 9 leaves, no `.gitattributes`, and `git ls-files --eol` reports `i/lf w/crlf` for 24 of 24 held `.sql` files. Splits **stack** — each repo off the previous tip, never fanned out (recorded decomposition failure).

P2's wording is binding: "All nine modules enabled in release 1 (public: elections, newsletter, calendar, files, messages, board, users; private: finance, content, vault; handover per D-01)." P2's parenthetical names ten module ids with code in release 1 (public: elections, newsletter, calendar, files, messages, board, users; private: finance, content, vault) plus handover, the module id P2 delegates to D-01 and which gets no repo. Nine of the ten carry a leaf service: `users` and `handover` do not. The "nine modules" headline is the nine leaf services. Handover is not extracted (D-01), so release 1 ships **ten module repos, nine leaf images, zero handover code**.

`vaultwarden` is deleted, not extracted (M3). Six tracked paths carry it — `docker/vaultwarden/{README.md,config.env.template,configure-sso.sh}`, `docs/runbooks/vaultwarden.md`, `gremion-ui/src/lib/modules/manifests/vaultwarden.{ts,test.ts}` — plus the service block at `StuRaOS/docker-compose.yml:1736` and the `vaultwarden-data` volume at `:2046`. **The removal is spec B's, not D's:** the kernel is already at zero references, so the work is to not port it and to guard that it stays out, and spec B carries that as post-condition text inside `B8-tenant-domains-and-leaf-trust` and `B18-router-emitter-library` rather than as a unit of its own (spec B, "Storage seam, MinIO, backups and restore" §6). The StuRa-tree files are left alone with the archived flavour (F5). D asserts only the post-condition it owns: the assembled render declares no `vaultwarden` service and no module repo carries a vaultwarden path — watched RED by a fresh verifier who re-adds the manifest file.

**Migration block allocation (B-04).** Kernel `0001–0199`; module blocks of 100 from `1000`, allocated in ascending manifest `order:` — the same total order `build-module-manifest.mjs` already sorts by, so the allocation is derived rather than chosen: `ranges.json` is the sole allocation table, `order` is its primary key ordering, and each module's block is the N-th 100-wide window from 1000 in `order`-ascending sequence. The file is written by `B7-renumber-ranges-baseline`; its shape and its validator are `D2-module-json-and-dist-schema`'s (§2). A module never declares a block of its own; `module.json` restates `ranges.json`'s values and the validator refuses any disagreement. One zero-pad width (four digits) across every block, because both runners sort lexicographically.

| Module | `order:` | Block | Populated in release 1 |
|---|---|---|---|
| finance | 20 (`manifests/finance.ts:27`) | 1000–1099 | 1000–1019 (its 20 basenames, `finance.ts:48-67`) |
| elections | 30 | 1100–1199 | empty |
| content | 40 | 1200–1299 | 1200–1204: the new `1200_content_news_posts.sql` (from `B4a-news-posts-ownership`), then 044→1201, 045→1202, 046→1203, **047→1204 per D-04** |
| newsletter | 50 | 1300–1399 | empty |
| users | 60 | 1400–1499 | empty |
| calendar | 70 | 1500–1599 | empty |
| files | 80 | 1600–1699 | empty |
| messages | 90 | 1700–1799 | empty |
| board | 100 | 1800–1899 | empty |
| handover | 110 | 1900–1999 | **reserved, unpopulated** (050–052 do not ship) |
| vault | 115 | 2000–2099 | empty |

**Intra-block ordering rule.** A module's creation migration precedes every migration that alters what it creates: content's `1200_content_news_posts.sql` precedes `1204_news_posts_content_origin.sql` by construction, and the range check plus the fresh-init replay (§2) is what proves it rather than the numbering convention alone. The creation migration itself is produced by spec B's `B4a-news-posts-ownership`, lifted from the StuRa tree's `008_public_portal.sql:14-27`: the kernel's `008` creates no `news_posts` table, and `047` only ALTERs it. D owns its placement in content's block, B owns its bytes, and neither owns the other's half.

`003_calendar_schema` and `034_deck_board` stay **kernel-applied** (spec A §D) and land in the kernel block, not calendar's or board's. `services/*/migrations/**` are independent leaf-local chains (`001_init.sql` …, 12 `.sql` files across six leaves) and are **not** renumbered (`B7-renumber-ranges-baseline`).

### Per-module extraction tables

Paths are StuRa-tree paths under `gremion-ui/src/` unless stated. "Half" counts are `git -C StuRaOS ls-files` over `gremion-ui/src/{lib/server/<id>,lib/<id>,lib/components/<id>,routes/<id>,routes/api/<id>,lib/modules/manifests/<id>.*}` — the union the carve manifest's module path classes already define (`scripts/carve/kernel-manifest.json` rules `product-module-routes`, `product-module-api-routes`, `product-module-server-lib`, `product-module-client-lib`, `product-module-components`, `product-module-manifests`). Every count below is that command's output at `f276af59`; any count a re-run contradicts is a defect in this table, not in the tree. Leaf counts are `git ls-tree -r f276af59 -- services/<leaf>`.

**users** — public. Half: `lib/modules/manifests/users.ts` + `routes/users/**` (7 files) + `routes/api/users/**` (6 files) = **14 tracked files, 228 LOC** (`git -C StuRaOS ls-files | grep -E 'gremion-ui/src/(lib/modules/manifests/users|routes/users|routes/api/users)'`). There is no `lib/server/users`, `lib/users` or `lib/components/users`. No leaf, no compose fragment, no migrations, no realm fragment, no nav fragment, no `register.server.ts`. `notTenantIsolated`: no. Tests: the manifest test plus `routes/api/users/[id]/roles/roles.test.ts`, `routes/api/users/email-export.test.ts` and `routes/users/users-redirect.test.ts`. Blockers: none — this is the shape proof (D3).

**board** — public. Half: **28 files** (`lib/server/board` 13, `lib/components/board` 6, `routes/api/board` 8, manifest 1). Leaf `services/board`, 25 files (`migrations/001_init.sql`). Fragment: `board-postgres` (`docker-compose.yml:1525`) + `board-service` (`:1558`), profile `board`. Migrations: `034_deck_board` **stays kernel-applied**. `notTenantIsolated`: **yes** (`manifests/board.ts:28`). No `register.server.ts`. Blocker: request-path DDL — `services/board/src/store/index.ts:99` runs `runMigrations()` inside `getStore()`, unreachable by `run --rm migrate`; `B22-leaf-migration-ledger` moves it to an eager migrate entrypoint.

**calendar** — public. Half: **50 files** (`lib/server/calendar` 26, `lib/components/calendar` 6, `routes/calendar` 5, `routes/api/calendar` 11, manifest + manifest test 2); `register.server.ts` present. Leaf `services/calendar`, 60 files (3 leaf migrations, has a `tenant-store.ts`). Fragment: `calendar-postgres` (`:1419`) + `calendar-service` (`:1458`), profile `calendar`. Migrations: `003_calendar_schema` stays kernel-applied, so calendar's block is reserved and empty in release 1. Blocker: the CalDAV drain has no `SKIP LOCKED`; colour-gating is `B28-worker-safety-and-colour-gating` (B-15) with the declaration half in `D10-module-runtime-declarations`.

**content (+ news, D-04)** — **private**. Half: **82 files** (`lib/server/content` 50, `routes/content` 13, `routes/api/content` 17, manifest + test 2), **plus** the news surface (`lib/server/news` 3, `lib/components/news` 2, `routes/news` 5, `routes/api/news` 3 = **13 files**), which belongs to no manifest today. `register.server.ts` present. Leaf `services/content`, 68 files (3 leaf migrations, has a `tenant-store.ts`). Fragment: `content-postgres` (`:1089`) + `content-service` (`:1117`), profile `content`. Migrations: five files — the new `1200_content_news_posts.sql` creating `news_posts`, then 044→1201, 045→1202, 046→1203 and 047→1204, whose body is `ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS content_origin_post_id` (`migrations/047_news_posts_content_origin.sql:5`) — the column exists only because content publishes into `news_posts`, which is why D-04 folds news in rather than creating a repo. Post-condition of the fold: `lib/components/news` appears in the assembled `FEATURE_TARGETS` as content's, and the status quo — exempt as an importer, unguarded as a target — no longer holds.

**elections** — public module, **repo created private until #353 closes**. Half: **29 files** under the standard union (`lib/server/elections` 13, `routes/elections` 12, `routes/api/elections` 3, manifest 1) **plus 19** under the module's other roots (`lib/client/{ballot-engine,cast-service,helios-voter-session}` 6, `lib/votes` 5, `routes/polls` 5, `routes/votes` 3) = **48**; `register.server.ts` present. Leaf `services/votes`, 15 files (stateless: no Postgres, no migrations); its image is keyed on the module id, so it publishes as `gremion-elections`. Fragment: `votes-service` (`:1261`, profile `votes`) **+ Helios** — `docker/helios/**` (15 files, moving to `gremion-module-elections`'s own `docker/helios/`) and the `helios-src` submodule (`https://github.com/benadida/helios-server.git`), whose 11 vendored Django migrations sit outside every gremion numbering scheme and are recorded as such, never renumbered. Helios is a **state-tier** service. Blocker: **#353 Helios licence compliance gates the public elections repo** — the repo is created private and flips public only when kernel issue #353 closes; until then elections and `gremion-elections` are in the full image set only. OSS-set membership is **computed at release build from the dist manifest's `visibility` field, never hard-coded**, so the flip needs no guard edit; `D15-oss-artefact-guard` (B-16) is what proves it landed. Note a cross-module coupling that must not be mis-split: `lib/server/finance/services/helios/**` (14 files, `index.ts:2` "optional Helios-driven budget-plan approval") is **finance-owned** and travels with finance.

**files** — public. Half: **38 files** (`lib/server/files` 17, `lib/files` 2, `lib/components/files` 2, `routes/files` 9, `routes/api/files` 7, manifest 1); `register.server.ts` present. Leaf `services/files`, 13 files (stateless, no migrations). Fragment: `files-service` (`:1232`, profile `files`) **+ Nextcloud** (`:142`, `docker/nextcloud/**` 10 files) **+ Collabora** (`:291`) — both state-tier, both moving into `gremion-module-files`'s `docker/<name>/`.

**finance** — **private**, largest, extracted last. Half: **348 files** (`lib/server/finance` 245, `lib/finance` 2, `lib/components/finance` 6, `routes/finance` 39, `routes/api/finance` 55, manifest 1), of which 293 sit under the four roots an earlier, narrower method counted; plus 87 under `services/finance` (the digest records 436 files / 54,483 LOC for the whole module including its leaf and coupled tests). `register.server.ts` present; the only manifest declaring a **realm fragment** (`manifests/finance.ts:72`) and a nav fragment (`:87`). Leaf `services/finance` (2 leaf migrations, `tenant-store.ts`). Fragment: `finance-postgres` (`:1150`) + `finance-service` (`:1179`), profile `finance`. Migrations: the 20 basenames at `finance.ts:48-67` → 1000–1019. Constraint: `services/finance/src/tenant-store.ts:785-790` strips `BEGIN`/`COMMIT` from every leaf migration before wrapping it in `sql.begin`; any leaf-ledger retrofit (`B22-leaf-migration-ledger`) preserves or replaces that rewrite. `boundary/rules.ts:10-14` keys `FK_ALLOWLIST` on `013_finance_schema.sql` and is updated in the renumber (`B7-renumber-ranges-baseline`).

**handover** — **private, not extracted** (D-01). Half: **69 files** (`lib/server/handover` 24, `lib/handover` 8, `lib/components/handover` 2, `routes/handover` 18, `routes/api/handover` 15, manifest + test 2 — the digest's 69 files / 7,881 LOC). No leaf, and **no `gremion-module-handover` repo in release 1** — `ranges.json` records `extractedTo: null` for it. Migrations 050–052 do **not** ship; block 1900–1999 is reserved and empty. What *does* ship is types only: the four declaration types (`HandoverRetention`, `HandoverSectionTypeDecl`, `HandoverStepDecl`, `ModuleHandoverDeclaration`, `lib/modules/types.ts:28-66`) enter `@gremion/module-sdk` as **optional types** (D-01), so a later extraction needs no SDK major. The **full image set contains no handover code** — not the app half, not a leaf, not a migration — which the OSS/full guard's path inspection covers for free. The code is frozen inside the archived StuRa tree; recovery path is `git archive f276af59 -- gremion-ui/src/lib/handover …`, written into `ARCHIVED.md`. N17's licence trigger goes into the kernel's `CONTRIBUTING.md` in the SDK unit; handover's visibility becomes its own dated standalone decision (`D16-handover-visibility-record`).

**messages** — public. Half: **34 files** under the standard union (`lib/server/messages` 21, `routes/messages` 1, `routes/api/messages` 11, manifest 1) **plus 4** under `routes/{element-call,livekit}` = **38**; `register.server.ts` present; no kernel twin. Leaf `services/messages`, 19 files (stateless). Fragment: `messages-service` (`:1289`, profile `messages`) **+ Synapse** (`matrix`, `:230`, `docker/synapse/**` 6 files) **+ LiveKit** (`:957`, `docker/livekit/**` 3) **+ Element Call** (`:979`, `docker/element-call/**` 6) — all state-tier, all three `docker/<name>/` trees moving into `gremion-module-messages`. Blocker: Synapse's database moves onto the **shared** Postgres server with a **C collation** argument (B-07); the live cluster is `en_US.utf8`, so without `B31-postgres-c-collation` the failure is certain. The StuRa-tree-only `slug === 'default'` livekit/matrix branches move here, not into spec B.

**newsletter** — public. Half: **41 files** (`lib/server/newsletter` 10, `routes/newsletter` 16, `routes/api/newsletter` 14, manifest 1); `register.server.ts` present. Leaf `services/newsletter`, 58 files (1 leaf migration, `tenant-store.ts`). Fragment: `newsletter-postgres` (`:1329`) + `newsletter-service` (`:1357`) — **neither carries a `profiles:` key today**, verified: `grep -n 'profiles: \[' docker-compose.yml` lists content, finance, files, votes, messages, calendar, board, vault, vaultwarden, video, object-storage, production, and **no newsletter**. Extraction is therefore a behaviour change, not a move: newsletter becomes toggleable, which changes `defaultModulesConfig` and tenant #1's `services{}` values. This lands as its own unit **before** newsletter is cut (`D5a-newsletter-profile-gate`).

**vault** — **private**. Half: **25 files** under the standard union (`lib/server/vault` 10, `lib/vault` 2, `routes/vault` 6, `routes/api/vault` 5, manifest + test 2) **plus 3** under `routes/vault-extern` = **28**. Leaf `services/vault`, 26 files (2 leaf migrations, **no** `tenant-store.ts`). Fragment: `vault-postgres` (`:1597`) + `vault-service` (`:1628`), profile `vault`. `notTenantIsolated`: **yes** (`manifests/vault.ts:29`). Declares a nav fragment (`:36`). Blocker: request-path DDL — `services/vault/src/store/index.ts:84` runs `runMigrations()` inside `getStore()`; same `B22-leaf-migration-ledger` treatment as board.

**Where the fragments live, and what they must honour.** Each module repo carries its service blocks at `compose/<id>.yml`, declared by `module.json.compose.fragmentPath` with `compose.services[]` naming every service inside (§2); each service carries `x-gremion-tier` ∈ {state, app}, and that key is what routes the block into the state or the app composed file. The kernel's `docker-compose.app.yml` (`B14-two-project-split`) carries only the kernel app-tier services (`gremion-ui`, `gremion-public`) and the shared conventions — no leaf block lives there. The inlining and its whole guard set are `D13-compose-fragment-inlining`'s (§4); the identities the host has already fixed and a fragment may not restate differently are the nine leaf service names and port 8080 of `infra/host/templates/env/app.env.tmpl:29-40`, the `<service>-${COLOUR}` alias `gremion-deploy:479-487` resolves by, the lowest-exposed-TCP-port rule `gremion-deploy:491-498` uses to find `/api/internal/evict`, `gremion.evict=true` on every one of the nine leaf blocks (`gremion-deploy` step 8 enumerates exactly nine evict targets), and `COLOUR` / `GREMION_ACTIVE_COLOUR_FILE` for timed-job owners (B-15).

**Secrets reaching module-owned leaves.** `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf are declared in `app.env.tmpl` by `B14-two-project-split` and covered by that unit's env coverage cross-check. A fragment references them as `${INTERNAL_<LEAF>_SECRET:?}` and never carries a default; the assembler's render guard fails on a leaf fragment that references an undeclared key — watched RED by a fresh verifier who adds a reference to a key no template declares.

**Cross-cutting blockers that gate every table above.** (1) The kernel's `baseNavSchema` has **zero** `{ slot: 'module' }` anchors — `grep -n "slot: 'module'" civitas/gremion-ui/src/lib/components/layout/nav-schema.ts` returns only the type declaration at `:32`, against four real anchors in the StuRa tree (`:84,88,100,102`) — and `composeNavSchema` silently drops an unanchored fragment. (2) The kernel has **zero** `register.server.ts` files (`git -C civitas ls-files | grep -c register.server.ts` = 0) against eight in the StuRa tree, one of which is the kernel built-in `gremion-ui/src/lib/server/governance/register.server.ts`, so the server-side registration seam is unexercised in the deploy source. Both are `B33-assembled-tree-guards`, which every module repo depends on; its guard is an assemble that **fails** on a fragment naming an absent anchor, watched RED by a fresh verifier who deletes one anchor. (3) `migration-ownership.test.ts` is classified `PRODUCT_ONLY` and does not travel; it is reclassified and ported, or `ranges.json` has nothing enforcing it.

### The StuRa vertical (D8, D-02)

A vertical is **data only**: `verticals/<id>/vertical.json` — config preset, wording overrides, theme tokens, legal templates, and a `blueprintRef` resolved against the kernel's existing registry — validated by the same validator as `module.json` (D-02). The kernel today has **no `verticals/` and no `examples/` directory** (both `ls` calls fail), so this is creation, not relocation.

**Moves into `verticals/stura/`:** the StuRa config preset (org/brand/portal_sections/modules/legal/retention, the shape of `StuRaOS/examples/verticals/*/config.json`); the StuRa wording overrides; the StuRa theme tokens; the StuRa legal templates; and `gremion-ui/src/lib/server/seed/stura-demo-blueprint.ts` re-expressed as **vertical data** against the kernel's `blueprint-registry`. `verticals/musterstadt/` and `verticals/verein/` are created in the same change from `StuRaOS/examples/verticals/{musterstadt,verein}/`, with the **Civitas literal scrubbed**: `examples/verticals/musterstadt/config.json:24` sets `"product": "Civitas"`, a live class-42 mark M12 forbids in public source.

**Does not move, because it is module seed data or kernel machinery:** `finance-blueprint.ts` travels with the **finance module** (it is finance seed data, and the kernel carries no copy); finance's realm fragment (`manifests/finance.ts:72`) and every module's nav fragment stay in their module repos; leaf fixtures stay with their leaves. The kernel keeps `blueprint-registry.ts`, `blueprint-schema.ts`, `municipal-blueprint.ts`, `org-blueprint.ts` — all four are already kernel code.

Post-condition: selecting vertical `stura` at tenant-create reproduces the StuRa wording and blueprint on an assembled tree, `musterstadt` reproduces the municipal one, and **no vertical literal appears outside `verticals/`** — watched RED by planting one StuRa literal in shared code. The dist manifest's `verticals: [{id, repo, ref, visibility}]` entry carries `visibility`, and the OSS image set is asserted free of private verticals (D-02), or a vertical becomes the unguarded path around the module visibility rules.

### Interim leaf-image build (D-05)

**Amendment to spec A §D.** Spec A §D says "Leaf images build in their own module repos and are published from there." D-05 suspends that for release 1: the nine leaf images are built by the kernel's release workflow from the assembled tree. Spec A's sentence is the destination, restored at the exit condition below.

Release 1's nine leaf images are built by the **kernel's release workflow from the assembled tree**, not by the module repos, because every leaf `Dockerfile` takes the repo root as context and copies `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `upstream/gremion/packages/ports`. The build runs **twice**: the full set from the full assembled tree, the public subset from the OSS tree.

**Image names.** Leaves publish under the flat form `ghcr.io/hello-n00del/gremion-<module id>`, matching the kernel's existing `gremion-ui` / `gremion-public` / `gremion-migrate`; the name is keyed on the **module id**, not the leaf directory, so `services/votes` publishes as `gremion-elections`. These nine names replace the unowned Docker Hub `gremion/*` namespace the leaves carry today (`image: gremion/files:latest`, `gremion/votes:latest`, `gremion/messages:latest`, `gremion/newsletter:latest` …). Each module declares its images in `module.json`'s `images[]` (§2), at most one with `role: leaf`. The module-contributed images beyond the leaf — messages' Synapse, LiveKit and Element Call; files' Nextcloud and Collabora; elections' Helios — are `role: sidecar` entries in the same array, built by this same interim release pass and sourced from **the module repo's own `docker/<name>/`**, moved there from the StuRa tree by `D3-first-module-repo-users` and `D5-remaining-module-repos`. They are module-owned from the moment the repo exists; nothing builds them out of the archived StuRa tree.

This is a **named interim with a dated operator exit condition**, recorded as such in `docs/` and in `release.json`'s notes. **Exit condition (exact):** `@gremion/ports`, `@gremion/db` and `@gremion/module-sdk` are all published to the `@gremion` npm scope under a registered trusted publisher (`release-npm.yml:14-21`; the scope is unclaimed today).

**The date and where it lives.** Exit date **2026-11-30**. The date and the three conditions — `@gremion` scope claimed, trusted publisher registered, `@gremion/{db,ports,module-sdk}` published — live in a tracked kernel issue created at plan dispatch, referenced by both specs as **the D-05 exit issue**; the date itself is an orchestrator proposal for the operator to confirm or change at the review gate. Policing is a guard, not prose: `check-interim-expiry` FAILS the release workflow after the exit date while `scripts/release/build-leaves-interim.mjs` still exists, and fails equally once `@gremion/db`, `@gremion/ports` and `@gremion/module-sdk` all resolve from the npm registry while that path still exists — watched RED by a fresh verifier who winds the check's clock past the date, and again by pointing it at a registry stub that resolves all three. The guard carries a row in this spec's guard register (§4) and in spec B's.

**OSS/full guard (B-16, N22) holds inside the interim:** `D15-oss-artefact-guard` inspects the **artefact** — no private module path in the OSS image, its `MODULE_MANIFESTS`, or its published leaf list — never the manifest input, and is watched RED by building the OSS set from the full manifest.

### Archiving (D11)

**`civitas-modules` (the modules holding repo).** Harvest its one unique asset first — the `MIGRATION_OWNERSHIP` map and the derived next-free-number fact — as seed for `migrations/ranges.json`. Do **not** port its guard: `registry.ts:258` asserts `NEXT_FREE_MIGRATION_NUMBER = 58` while `058_public_reader_grants.sql` has shipped, i.e. it has already rotted by the exact failure mode it was written to prevent. Then archive read-only. Post-condition: no spec-B or spec-D artefact references `civitas-modules`, and the third `types.ts`/`registry.ts` fork no longer exists.

**The StuRaOS repo.** Archived as the flavour it is, per F5: its red CI, its 2,510 `sturaos` occurrences, its dead pre-commit hook and its per-copy fixes are left alone, listed as residuals rather than fixed. Two relationships are retired in the same change:

- **The carve tooling.** `scripts/carve/**` (eight tracked files: `carve.mjs`, `carve.test.mjs`, `verify-manifest.mjs`, `kernel-manifest.json`, `carve-ledger.json`, `diverged-baseline.json`, `pnpm-deps.mjs`, `pnpm-deps.test.mjs`) is **frozen in place, not deleted** — it is the only drift instrument that exists, its tests are what make it re-verifiable, and it is the origin story of the open-core split. Its 51 first-match-wins rules are transposed once into the D5 split driver (class × module → module) before the freeze, and the freeze is the last write. No re-pin of the drift baseline (B-02): a baseline belongs to a tree being archived.
- **The `upstream/gremion` submodule relationship.** `.gitmodules` declares `[submodule "gremion"] path = upstream/gremion`, gitlink `a4b898ea79b9c10085d1e4f2134bdd7e2be16ba9` — the kernel consumed as a SHA-pinned dependency of the StuRa tree. That direction inverts: the kernel is the deploy source and consumes modules by ref. The submodule entry and the `upstream/gremion/packages/*` workspace glob are removed from the archived tree's documentation as *history*, and the kernel-first merge ordering rule retires with it. `helios-src` travels to `gremion-module-elections`; the three `bats-*` submodules stay with the archived tree.

**Kept as origin story:** the frozen `scripts/carve/**`, `KNOWN_ISSUES.md` (including §T11, overwritten in writing by `B0-spec-docs-and-waiver-ledger` rather than deleted), and an `ARCHIVED.md` naming the frozen extraction SHA `f276af59`, the ten module repos it fed, and the recovery command for handover.

### Units in this section

Units for this section: `D2-module-json-and-dist-schema`, `D3-first-module-repo-users`, `D5a-newsletter-profile-gate`, `D4-evict-on-leaves`, `D5-remaining-module-repos`, `D6-leaf-images-and-compose-fragments`, `D7-synapse-on-postgres`, `D8-stura-vertical`, `D9-assembler-module-resolution`, `D10-module-runtime-declarations`, `D11-archive-holding-repo-and-stura-tree`; the table is at "Units — spec D". `B33-assembled-tree-guards` is a spec-B unit whose nav-anchor and `FEATURE_TARGETS` halves are specified here and in §1 D.1.6. Consumed but owned elsewhere: `D13-compose-fragment-inlining` (the inlining and the fragment guard set, §4), `D15-oss-artefact-guard` (§4), `D16-handover-visibility-record` (§1), `B7-renumber-ranges-baseline`, `B14-two-project-split`, `B22-leaf-migration-ledger`, `B31-postgres-c-collation` and `B4a-news-posts-ownership`.

## Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units

What B ships and what D adds is §1's table, "What spec D is, and what it takes as given from spec B". Verified starting state, unchanged since: `scripts/assemble.mjs`, `gremion.dist.example.json`, `migrations/ranges.json` and `migrations/baseline-hashes.json` exist in no repo (kernel HEAD `f7ac826`; `civitas/scripts/` holds 13 files, none of them the assembler), while `GREMION_DIST_MANIFEST` is already injected by `infra/host/templates/env/state.env.tmpl:66` and `app.env.tmpl:26` and read by nothing. This section specifies only the half spec D adds: module resolution, vertical resolution, compose-fragment inlining, the second (OSS) build pass, the guard register, and the acceptance conditions. The zero-module skeleton, the release workflow, `release.json` and `docker-compose.pins.yml` belong to spec B §"Assembler and release supply chain" and are not restated here.

### D.1 The D half of `scripts/assemble.mjs`

#### D.1.1 Manifest source and module clone

The distribution manifest is read from `GREMION_DIST_MANIFEST` and the assembler **fails closed when the variable is unset or the file is unreadable** (`B34-assembler-zero-modules`'s guard, consumed here) — never falls back to `gremion.dist.example.json`. Per B-16 the real manifest lives in a private `gremion-dist` repository (`D14-gremion-dist-repo`), checked out in the release workflow with the per-run GitHub App installation token (N23); the kernel commits only `gremion.dist.example.json`, which names public modules only.

Each entry `{id, repo, ref, visibility}` is cloned with `git clone --depth 1 --branch <ref>` into a scratch directory, driven by the manifest and never by a `.gitmodules` entry, so a public contributor's `--recurse-submodules` clone of the kernel cannot fail on a private repository. The token is presented **by the runner only**: `docker build` receives the assembled tree and nothing else, which is what the recorded no-credential-in-the-build-container rule requires (N23, spec A §D). Post-condition, asserted rather than assumed: after the clone loop, `git -C <scratch>/<id> rev-parse HEAD` equals the manifest `ref`'s commit for every entry, and the assembled tree contains no `.git` directory, no `.netrc`, no `auths` entry and no occurrence of the token.

**Fallback (B-16).** If the N23 GitHub App installation token is not ready at release 1, the release workflow runs against a manifest naming only repositories the runner can already read with its default `GITHUB_TOKEN` — the public module repos and the in-kernel vertical. The fallback narrows the *manifest*, never the assembler's behaviour: with `GREMION_DIST_TOKEN` unset, `B35-release-supply-chain` assembles from the public kernel plus every module repo the runner's default token can read and its run summary names each module it could not fetch, while the assembler still refuses any entry present in the manifest it cannot clone rather than skipping it. `release.json` records the reduced module set under `distManifestDigest` so the OSS and full artefacts are distinguishable. Post-condition, watched RED by a fresh verifier: with the App token unset and the manifest naming a private module, the assemble exits non-zero naming that module, and never produces a tree missing it.

#### D.1.2 `module.json` verification

For every cloned module the assembler verifies, refusing the build on any failure:

| Check | Refusal condition |
|---|---|
| SDK range | `module.json.sdk` (a semver range) does not include the kernel's `@gremion/module-sdk` version |
| Migration range | any file under the module's `app/migrations/` or `service/migrations/` falls outside the module's `[lo, hi]` block in `migrations/ranges.json` (B-04 blocks: kernel `0001–0199`, modules from `1000` in blocks of 100 allocated in ascending manifest `order:`, one zero-pad width of 4) |
| Range disjointness | two enabled modules claim overlapping blocks, or a module claims any number below `1000`. B-04 chose the renumber over spec A §D:205's alternative of freezing the old numbers in place, so after `B7-renumber-ranges-baseline` no module owns a number below 1000; `ranges.json`'s per-module `legacy[]` stays present and **empty** — the renumber is what makes an old-filename list unnecessary, and the empty array is the assertion that it is unnecessary (spec B, `B7-renumber-ranges-baseline`) — so it is never a selectable range and a non-empty `legacy[]` is itself a refusal |
| `order:` agreement | two enabled modules resolve to the same manifest `order` — which `build-module-manifest.mjs` would otherwise break only on filename — or `module.json.order`, `ranges.json.modules[<id>].order` and the TypeScript `ModuleManifest.order` disagree; the same three-way check applies to `notTenantIsolated` |
| Visibility | `module.json.visibility` disagrees with the manifest entry's `visibility` |
| Extraction source | `extractionSource` absent, not 40-char lowercase hex, or disagreeing between two enabled modules (`B00-extraction-source-freeze`) |
| Kernel ref | `module.json.kernelRef` absent or not a 40-char lowercase hex commit — it is the kernel commit the module repo's own CI clones into `.kernel/` during the D-05 interim |
| Compose declaration | `compose.fragmentPath` or `compose.services[]` missing for a module that ships `compose/<id>.yml`, or a service named in `compose.services[]` absent from the fragment, or a service block in the fragment carrying no `x-gremion-tier`. The per-service tier lives on the service block (D.1.4), never in `module.json`; `module.json` declares only the fragment path and the service *names* the render guard counts |
| Images | `images[]` carries more than one `role: leaf` entry; a `role: leaf` or first-party `role: sidecar` entry whose `image` is not `ghcr.io/hello-n00del/gremion-<name>` or whose `context` path is absent from the repo; or a pinned third-party `role: sidecar` entry (`context: null`) whose `image` is not a fully-qualified pinned third-party reference that `docker-compose.pins.yml` resolves. Module-contributed images beyond the leaf — messages' synapse, element-call and livekit; files' nextcloud and collabora; elections' helios — are `role: sidecar` entries; the four with a Dockerfile are built from the module repo's own `docker/<name>/`, and livekit and collabora carry `context: null` because no Dockerfile exists for them |
| Runtime declarations | the `runtime` block omits a field `D10-module-runtime-declarations` consumes: `leafService` (`name`, `port`, `postgresService`, `databases.control`, `databases.tenantPattern`) for a module that ships a leaf, `timedJobs[]` (each with `id` and `activeColourOnly`), or `shred` |

The validator is the same one D2 builds for `module.json`, `gremion.dist.example.json`, `migrations/ranges.json` and `vertical.json`; there is exactly one validator, not four.

#### D.1.3 App-tree copy, realm and nav fragments

Each module's `app/` tree is copied into the assembled kernel at its **app-relative** paths (`gremion-ui/src/lib/modules/manifests/<id>.ts`, `gremion-ui/src/lib/server/<id>/**`, `gremion-ui/migrations/*.sql`, …). A copy that would overwrite an existing file is a hard failure, never a silent overwrite: the kernel and its modules are disjoint by construction and a collision means the carve is wrong.

Realm fragments compose through the existing `composeRealm` seam and `gremion-ui/scripts/gen-realm-export.ts`, which the assembler invokes explicitly because it is not in `pnpm prebuild`. Nav fragments splice only at a `{slot:'module', moduleId}` anchor and `composeNavSchema` **silently drops** a fragment with no anchor; the kernel's `gremion-ui/src/lib/components/layout/nav-schema.ts` has zero anchors today. `B33-assembled-tree-guards` adds the anchors; the assembler asserts the post-condition — every nav fragment declared by an enabled manifest found an anchor, counted, with the count compared against the manifest set.

#### D.1.4 Compose fragment inlining (B-07)

Shared infrastructure stays in the kernel's base compose. Module-owned services — Synapse, Nextcloud, Collabora, Helios, LiveKit, Element Call and the nine leaves with their per-leaf Postgres servers — ship as `compose/<id>.yml` in their module repositories and are **inlined by the assembler into the composed files at release build**, so the host's file list stays exactly `docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml` (state, `state.env.tmpl:22`) and `docker-compose.app.yml:docker-compose.pins.yml` (each colour, `app.env.tmpl:18`). The kernel's `docker-compose.app.yml` (`B14-two-project-split`) carries ONLY kernel app-tier services (`gremion-ui`, `gremion-public`) and the kernel's own two one-shots (`migrate`, `tenant-create`), plus the shared conventions; every leaf fragment carries its own block. The host never learns that modules exist. One unit owns the inlining and the fragment contract's guard set: `D13-compose-fragment-inlining`. `B14-two-project-split`'s render guard asserts the same union, and spec B references `D13-compose-fragment-inlining` by id rather than restating the contract.

Routing is by declaration, not by guess: each service block in a fragment declares `x-gremion-tier: state | app`. `state` blocks are merged into `docker-compose.yml`, `app` blocks into `docker-compose.app.yml`. An undeclared tier is a refusal. Leaf databases are `state` (spec A §E: "Leaves keep their databases in the state tier"); leaves themselves are `app`.

**Host-fixed identities a fragment must honour.** These are not conventions the fragment author may choose; the host tooling already resolves against them, so the assembler asserts each per block rather than trusting the fragment.

| Requirement | Exact form | Why it is load-bearing |
|---|---|---|
| tier marker | `x-gremion-tier: app` | routes the block into `docker-compose.app.yml` rather than the state file |
| no edge labels | `traefik.enable=false` | app-tier services are reached only through `active.yml` |
| network aliases | `<service>-${COLOUR}` on **both** `${STACK}_edge` and `${STACK}_state` | `gremion-deploy:479-487` resolves the evict target by the `-<colour>` alias |
| evict label | `gremion.evict=true` on every leaf block — all nine | `gremion-deploy:452,464` dies when no started container carries it, and step 8 enumerates exactly nine leaf targets on a full-manifest release |
| colour flag | `COLOUR`, `GREMION_ACTIVE_COLOUR_FILE=/run/gremion/active-colour` and the **directory** mount `${GREMION_ROOT:?}/runtime:/run/gremion:ro`, on every block owning a timed job | the B-15 colour gate reads the active colour from that file |
| internal bearer | `INTERNAL_PUSH_SECRET` and the leaf's own `INTERNAL_<LEAF>_SECRET`, referenced as `${INTERNAL_<LEAF>_SECRET:?}` | `gremion-switch:98-113` POSTs with that bearer and aborts on anything but 204 |
| image | `image: ghcr.io/hello-n00del/gremion-<module id>:${IMAGE_TAG:?IMAGE_TAG required}`, no `build:` after the pins layer | a composition without pins must fail loudly, never build locally |
| service name and port | exactly as `infra/host/templates/env/app.env.tmpl:29-40` fixes them — `content-service`, `finance-service`, `files-service`, `votes-service`, `messages-service`, `newsletter-service`, `calendar-service`, `board-service`, `vault-service`, all on `8080`, the leaf image's **lowest exposed TCP port** serving `/api/internal/evict` | `gremion-deploy:491-498` picks the evict port by lowest exposed TCP port; a renamed service or a lower unrelated port kills the deploy at step 8 or the switch at step 10 |

**Fragment guard set.** The assembler refuses on any of these, and each is watched RED by a fresh verifier who plants the violation:

- no `name:` key anywhere in a fragment — the project name belongs to the host;
- no `COMPOSE_FILE` entry and no top-level `include:` — the host's file list is fixed and a fragment may not extend it;
- a service name colliding with a kernel service or with another enabled module's fragment aborts the assemble, never merges;
- every service block declares an `image:`;
- every service block declares `x-gremion-tier ∈ {state, app}`, which routes it;
- every env key a fragment references is declared in the templates — `INTERNAL_PUSH_SECRET` and one `INTERNAL_<LEAF>_SECRET` per leaf are added to `app.env.tmpl` by `B14-two-project-split` and covered by the env coverage cross-check; a leaf fragment referencing an undeclared key fails the render guard;
- deterministic append order: module blocks are appended after the kernel's own entries in **ascending manifest `order:`**; within a block, key order is preserved from the fragment as written; the top-level `services:`, `volumes:` and `networks:` maps are emitted in that same order;
- two assembles of the same `distManifestDigest` produce byte-identical `docker-compose.yml` and `docker-compose.app.yml`, asserted by hashing both files across two runs in the same CI job;
- the zero-module render and the all-module render both succeed and produce a byte-identical `COMPOSE_FILE` list — the host's file list is invariant in the module count;
- the per-service render count holds with a vacuity guard (below).

Post-condition, watched RED by a fresh verifier: delete `traefik.enable=false` from one leaf's block and the assemble exits non-zero; delete `gremion.evict=true` from any one of the nine leaf blocks and the assemble exits non-zero naming it.

**Render guard.** After inlining, the assembler renders the composed pair with the §E env-file form and asserts that the rendered service set contains every name in every enabled module's `compose.services[]`, with a vacuity guard: the count of module-contributed rendered services equals the sum over enabled modules and is non-zero whenever the manifest names at least one module. This is the guard that catches a fragment silently lost to a YAML merge. `newsletter` is the structurally hard case and is named: it is the one leaf with **no** compose profile in the StuRa tree (`StuRaOS/docker-compose.yml` carries `profiles: [content]` at :1096/:1122, `[finance]` :1157/:1184, `[files]` :1237, `[votes]` :1266, `[messages]` :1294, `[calendar]` :1426/:1465, `[board]` :1528/:1564, `[vault]` :1600/:1634 — and none for newsletter), so giving it a profile is a behaviour change owned by `D5a-newsletter-profile-gate`, not a mechanical move.

**Catalogue-produced env keys.** `BACKUP_POSTGRES_SERVICES` and the colour-policy timed-job list are **produced from the module catalogue at assemble time** — written into the rendered `state.env` and `app.env` by the assembler from `runtime.leafService.postgresService` and `runtime.timedJobs[]` — and are never hand-maintained. An operator-maintained string is exactly where the backup blind spot already bit; a module removed from the dist manifest therefore drops out of the backup enumeration and the colour policy with no kernel edit (G-D17).

#### D.1.5 Vertical resolution (D-02)

A vertical is **data only**: `verticals/<id>/vertical.json` carrying the config preset, wording overrides, theme tokens, legal templates and a `blueprintRef` that must resolve against the kernel's existing blueprint registry (`civitas/gremion-ui/src/lib/server/seed/blueprint-registry.ts`, alongside `blueprint-schema.ts`, `municipal-blueprint.ts`, `org-blueprint.ts`). It is validated by the same module-manifest validator. There is no vertical code path, no vertical module and no vertical-specific branch in shared code.

Resolution has two sources. **In-tree** (F3): every `verticals/<id>/` directory present in the kernel tree ships in the image and is selectable by id at tenant-create (B-06 passes `slug, host, vertical`). The kernel has **no `verticals/` directory today**; the StuRa tree carries `examples/verticals/musterstadt/` and `examples/verticals/verein/` — four files, each a `config.json` plus a `README.md` — and no `stura` vertical anywhere. **Out-of-tree**: the dist manifest's optional `verticals: [{id, repo, ref, visibility}]` is resolved by the *same* clone path as modules (depth 1, pinned ref, App token, runner only) into `verticals/<id>/`. An out-of-tree id colliding with an in-tree directory is a hard failure, never a silent overwrite.

Release 1 ships no out-of-tree vertical (F3 puts that capability after the in-tree one), so the path is exercised against a fixture, not against real data. Post-condition, owned by `D9-assembler-module-resolution` and watched RED by a fresh verifier: a fixture manifest naming an out-of-tree vertical whose id equals an in-tree `verticals/<id>/` directory makes the assemble exit non-zero naming that id; the same fixture with a fresh id resolves, clones at the pinned ref and lands under `verticals/<id>/` with no `.git` directory.

#### D.1.6 Codegens, boundary lint, vacuity

All four codegens already exist in the kernel (`gremion-ui/scripts/build-module-manifest.mjs`, `build-module-server-init.mjs`, `build-migration-manifest.mjs`, `gen-realm-export.ts`); the first three scan directories, so a copied `app/` tree wires itself in with no edit. The failure mode they create is silence: `build-module-server-init.mjs` scans for `register.server.ts`, the kernel has none, and it writes a comment-only barrel and exits 0. Every codegen invocation therefore asserts against the **manifest count**, never against an exit code:

- `MODULE_MANIFESTS.length` == enabled modules + kernel built-ins (`core`, `governance`);
- `server-init.generated.ts` import count == (enabled modules declaring a `register.server.ts`) + (kernel built-ins declaring one — `governance` does, `core` does not);
- migration-manifest key count == the union of kernel migrations and every enabled module's claimed files;
- every nav fragment anchored (D.1.3);
- realm export contains one fragment per enabled module declaring one.

The boundary lint runs on the **assembled** tree via `gremion-ui/scripts/boundary-lint.ts --all` (`boundary-lint.ts:2-8` documents the mode; nothing in CI runs it today — it is wired only into the pre-commit hook), with a scanned-file-count vacuity guard, because a lint over a tree it fails to find returns clean. That vacuity guard is itself watched: pointing the lint at an empty directory must FAIL the job rather than report clean, and deleting every `*.test.ts` from an `app/` tree must fail the `test` job as vacuous rather than pass with zero collected files. The `kernel-clean.test.ts` backstop's `FEATURE_TARGETS` (`civitas/gremion-ui/src/lib/server/boundary/kernel-clean.test.ts:35-49`) is derived from the assembled manifest set rather than the hand list, which today names seven `lib/server/*` targets (finance, elections, content, newsletter, calendar, files, messages — `kernel-clean.test.ts:35-40`) plus component and client-lib targets including `lib/components/polls` and `lib/components/ballot` (:45), and knows nothing of board, handover, vault or news — that derivation is `B33-assembled-tree-guards`'s, and the assembler consumes it.

#### D.1.7 Manifest digest and byte-immutability

The assembler computes `distManifestDigest` as `"sha256:" + <64 lowercase hex>` over the manifest **file bytes as read**, and records it in `release.json`. The prefixed form is required by both consumers, which test `^sha256:[0-9a-f]{64}$`: `civitas/.github/workflows/deploy.yml:112` at dispatch and `civitas/infra/host/bin/gremion-deploy:228-229` on the host; a bare hex digest is rejected in both places. Manifest *content* — private repository names and refs — never enters the assembled tree, the images or the release notes; a guard greps the assembled tree and each built image for every private module's repository name and asserts zero hits.

Byte-immutability compares each already-shipped migration in the assembled tree against the frozen `migrations/baseline-hashes.json`, captured at `B7-renumber-ranges-baseline` from **git index blobs on Linux** before the split. It must not compare against `gremion-ui/migrations/manifest.json`, which the assembler itself regenerates in the same run and which would therefore agree with any tree it is handed. Three assertions, all needed: every key in `baseline-hashes.json` is present in the assembled tree with a matching hash; no baseline file is missing; any assembled migration absent from the baseline falls inside its owning module's declared range and above the `highWater` mark `ranges.json` records for that block (§2). D-03 makes this deterministic across hosts: every module repository carries the kernel's line-ending policy (`* text=auto eol=lf` plus explicit `eol=lf` for SQL, shell and generated files) and is created from index blobs (`git archive` / `git filter-repo`), never from a working tree. The kernel's own `.gitattributes` has the explicit rules (`*.sql text eol=lf`, `*.sh text eol=lf`, …) but **no `* text=auto` catch-all** (74 lines, verified); adding it is part of D-03's "mirror the kernel's policy" and lands in the kernel in the same change (§2, `.gitattributes`).

### D.2 The two image sets (N22, D-05)

Two assemble+build passes per release, sharing the pnpm store and BuildKit cache.

| Set | Packages | Modules included | Leaf images included |
|---|---|---|---|
| Full (private packages under `ghcr.io/hello-n00del/`) | `gremion-ui`, `gremion-public` | elections, newsletter, calendar, files, messages, board, users, **finance, content, vault** (handover is a reserved id with no code in release 1, D-01) | `gremion-elections` (built from `services/votes`), `gremion-newsletter`, `gremion-calendar`, `gremion-files`, `gremion-messages`, `gremion-board`, **`gremion-finance`, `gremion-content`, `gremion-vault`** (9) |
| OSS (public packages under `ghcr.io/hello-n00del/`) | `gremion-ui-oss`, `gremion-public-oss` | newsletter, calendar, files, messages, board, users, **plus elections — private until #353** (7 with #353 closed, 6 while it is open) | `gremion-newsletter`, `gremion-calendar`, `gremion-files`, `gremion-messages`, `gremion-board`, **plus `gremion-elections` only while elections is public** (6 with #353 closed, 5 while it is open) |

OSS-set membership is **computed at release build from the dist manifest's `visibility` field, never hard-coded**, so the #353 flip needs no guard edit. Elections' repository is created private and flips public when kernel issue #353 (Helios licence compliance) closes; until then elections and `gremion-elections` are in the full set only. All images publish under `ghcr.io/hello-n00del/`, private-module images as private packages. The `-oss` suffix is a naming decision taken here, not derived from N22 or spec A §E: the OSS set publishes as `ghcr.io/hello-n00del/gremion-ui-oss` and `gremion-public-oss` to the public registry, the full set as `gremion-ui` and `gremion-public` as private packages. Whether `gremion-public` needs an OSS variant at all is unresolved — it carries no module code today — and is settled by `D15-oss-artefact-guard`, which either finds a private module path in `gremion-public` (the variant is needed) or does not (the full image is published to both registries and the `-oss` name is dropped).

Counts and their reconciliation are §3's, under "Scope, source, and invariants". For this section: the module-repository count is ten (`D3-first-module-repo-users`'s `users` plus `D5-remaining-module-repos`'s other nine), nine leaf images, and zero handover code extracted — handover is a reserved id with no repo and block 1900 stays empty (D-01), recorded by `D16-handover-visibility-record`. The StuRa tree's `gremion-ui/src/lib/modules/manifests/` holds board, calendar, content, elections, files, finance, handover, messages, newsletter, users and vault beside `core` and `governance` today (verified), plus `vaultwarden.ts`, which is deleted.

Release 1 builds all nine leaf images from the assembled tree in the kernel's release workflow — **a named interim with a dated operator exit condition** (D-05), because every leaf Dockerfile today takes the repository root as build context and copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `upstream/gremion/packages/ports`. The exit date is **2026-11-30**; that date and the three conditions — claim the `@gremion` npm scope, register the trusted publisher, publish `@gremion/db`, `@gremion/ports` and `@gremion/module-sdk` — live in a tracked kernel issue created at plan dispatch and referred to in both specs as **the D-05 exit issue**. After the exit each module repository builds its own leaf and the interim path is deleted. Two guards hold it: `check-interim-expiry` fails the release workflow after the date while `scripts/release/build-leaves-interim.mjs` still exists, and §3's self-retiring check fails once all three packages resolve from npm while the interim path is still wired in. The exit condition is also written into `CONTRIBUTING.md`. **Operator item, named for the review gate:** the exit date itself.

**Artefact-level OSS guard.** After the OSS images are built, the guard inspects the *artefact*, not the source: zero files under any private module's app-relative roots, zero private module ids in the image's `MODULE_MANIFESTS`, zero private leaf image references in the OSS pins file, zero private vertical ids under `verticals/`. It carries a vacuity guard — the inspection must find every public module's paths, or it fails as vacuous. It is watched RED by **building the OSS set from the full manifest** and recording the guard failing, by a fresh verifier agent, never by its author.

### D.3 Guard register — spec D

| Guard | Asserts | Watched RED by | Owner unit |
|---|---|---|---|
| G-D1 SDK-range refusal | a `module.json` whose `sdk` range excludes the kernel's SDK version is refused | a scratch module pinned to `^0.x` against SDK `1.0.0` | `D2-module-json-and-dist-schema` |
| G-D2 range/order refusal | an out-of-block migration number or a colliding `order` block is refused, and `module.json.order`, `ranges.json.modules[<id>].order` and `ModuleManifest.order` must agree | planting a `0999_` file in a module, duplicating an `order`, and flipping `order` in one of the three places | `D2-module-json-and-dist-schema` |
| G-D3 vertical schema | a `vertical.json` whose `blueprintRef` does not resolve against the blueprint registry is refused | renaming the `blueprintRef` in a scratch vertical | `D8-stura-vertical` |
| G-D4 codegen vacuity | manifest count, server-init import count — enabled modules with a `register.server.ts` plus kernel built-ins that declare one — migration-key count and anchored-nav count all equal the manifest-derived expectation | deleting one module's manifest file, then its `register.server.ts`, after the copy step; and deleting the kernel's own `governance/register.server.ts`, which must also make the count go RED rather than pass | `D9-assembler-module-resolution` |
| G-D5 fail-closed manifest | unset/unreadable `GREMION_DIST_MANIFEST` aborts the assemble — owned and watched RED by `B34-assembler-zero-modules`; `D9-assembler-module-resolution` and `D14-gremion-dist-repo` consume it and add no second implementation | unsetting the variable in CI | `B34-assembler-zero-modules` |
| G-D6a clone-ref pin | each module checkout's HEAD equals the manifest ref | pointing one entry at a branch name that moved | `D9-assembler-module-resolution` |
| G-D6b no credential in the tree | the assembled tree contains no `.git` directory, no `.netrc`, no Docker `auths` entry and no occurrence of the App token | planting a `.git` directory and a file containing the token value into a module's `app/` tree before the copy step, and asserting the assemble exits non-zero naming both | `D9-assembler-module-resolution` |
| G-D7 no-overwrite copy | an `app/` file colliding with an existing kernel file fails the assemble | planting a duplicate path in a module repo | `D9-assembler-module-resolution` |
| G-D8 fragment render | every enabled module's `compose.services[]` appears in the rendered pair, with a non-zero count check; no fragment carries a `name:` key, a `COMPOSE_FILE` entry or a top-level `include:`; a service-name collision aborts; every service block carries an `image:` and an `x-gremion-tier`; every env key a fragment references is declared in the templates; every `app`-tier block carries `traefik.enable=false`, both colour aliases and `gremion.evict=true` | deleting one service block from a fragment; planting a `name:` key, a top-level `include:` and a duplicate service name; dropping one leaf's `image:`; referencing an undeclared `INTERNAL_<LEAF>_SECRET`; deleting `traefik.enable=false` from one leaf; deleting `gremion.evict=true` from any one of the nine leaf blocks | `D13-compose-fragment-inlining` |
| G-D9 inline determinism | two assembles of one `distManifestDigest` produce byte-identical composed files, and the zero-module and all-module renders both succeed with a byte-identical `COMPOSE_FILE` list | reversing the fragment iteration order; asserting the file list after a zero-module assemble | `D13-compose-fragment-inlining` |
| G-D10 baseline immutability | every baseline migration present and byte-identical; no baseline file missing; no unaccounted new file | a one-byte edit and a rename, on a clean Linux clone | `B7-renumber-ranges-baseline` (consumed by `D9-assembler-module-resolution`) |
| G-D11 EOL determinism | a clean Linux clone and the Windows box produce identical hashes | checking out a module repo with `core.autocrlf=true` and no `.gitattributes` | `D3-first-module-repo-users` |
| G-D12 boundary backstop | the derived `FEATURE_TARGETS` reds on one planted violating import per module, 10 for 10 — the ten modules with code in release 1 (handover ships no code, D-01) | planting the imports | `B33-assembled-tree-guards` |
| G-D13 nav anchor | a nav fragment naming an absent anchor fails the assemble instead of vanishing from the rail | removing the anchor for one module | `B33-assembled-tree-guards` |
| G-D14 OSS artefact | no private module path, id, leaf image or vertical in the OSS images; every public module present; membership computed from `visibility` | building the OSS set from the full manifest | `D15-oss-artefact-guard` |
| G-D15 no manifest leakage | no private repository name or ref in the assembled tree, the images or `release.json` | planting the private repo name in a fragment comment | `D9-assembler-module-resolution` |
| G-D16 leaf evict contract | all nine leaves answer exactly 204 with an empty body on `/api/internal/evict` and each writes its ack row (tenant, process, colour, epoch) before answering; a 200 is rejected — the per-repo job is `evict-contract` (§2) | the contract test written before the routes exist; and a fresh verifier who blocks one leaf and asserts the missing ack row | `D4-evict-on-leaves` |
| G-D17 catalogue-driven ops | the assembler writes `BACKUP_POSTGRES_SERVICES` and the colour-policy job list from the catalogue, so removing a module from the manifest removes its database from backup enumeration, its job from the colour policy and its arm from the erasure gate, with no kernel edit | removing one module and re-running `gremion-backup` coverage | `D10-module-runtime-declarations` |
| G-D18 `check-interim-expiry` | the release workflow fails after the D-05 exit date (2026-11-30) while `scripts/release/build-leaves-interim.mjs` still exists | running the release workflow with the clock past the date against a tree that still carries the interim script | `D6-leaf-images-and-compose-fragments` |

### D.4 Acceptance for spec D within F1 / P4

Spec D is complete when all of the following hold. None is satisfied by a green exit code; each names its post-condition.

1. **Every module repository builds green on its own.** Each of the ten `gremion-module-<id>` repositories passes its own CI on a clean Linux clone: typecheck, unit tests, its frozen-range guard, its `.gitattributes` EOL check, its `evict-contract` job where it ships a `service/`, and — once the interim of D-05 ends — its leaf image build.
2. **The assembled tree equals the pre-split tree where the decisions say it must.** Byte-for-byte equality is required exactly for migration file *contents* against `migrations/baseline-hashes.json` (G-D10), and for the module `app/` trees against the extraction-moment StuRa tree at `f276af59` (`D5-remaining-module-repos`'s "drift between any module repo and the StuRa tree is zero at the moment of extraction"). It is **not** required for filenames (B-04 renumbers), for compose files (inlining and the §E project split rewrite them), or for anything the kernel-wins adjudication of B-02 changes. Any other byte difference is a defect.
3. **The assembled distribution boots and serves.** An assemble of kernel + ten modules + the `stura` vertical produces a tree whose MODULE_MANIFESTS count, server-init import count, migration-manifest key count and anchored-nav count all match the manifest (G-D4), which renders the fixed host file list (G-D8, G-D9), and which passes the boundary lint with a non-vacuous scanned-file count.
4. **The release passes spec B's acceptance.** `gremion-deploy`'s `validate_release_tree()` and `deploy.yml` accept the produced `dist-vX.Y.Z` tag on its own merits, and `test/host/deploy.bats` and `deploy-workflow.bats` go green against the real release tree rather than against fixtures.
5. **F1's finish line.** The assembled distribution — public kernel plus modules from their own repositories plus the StuRa vertical — is deployed on the netcup box through plan A's tooling and passes the login journey, replacing the StuRaOS compose running there; plus P4's technical proofs (reboot gate, colour switch, switch-back, rollback, verify contract green, backup with a measured restore), with the six operator items waived by name until the pilot.
6. **Nothing references the archived trees.** `civitas-modules` is archived read-only and no spec-B/D artefact references it; the third `types.ts` fork no longer exists; the StuRa tree is archived with `scripts/carve/**` frozen intact and its residuals listed, not fixed (F5).

### D.5 Lane shape and cross-lane edges

The modules lane is **not** a suffix of the B lane. Four B units depend on D units — `B33-assembled-tree-guards` on `D1-module-sdk-package`, `B34-assembler-zero-modules` on `D1-module-sdk-package` and `D2-module-json-and-dist-schema`, `B20-evict-labels-and-fanout-fix` on `D4-evict-on-leaves`, `B22-leaf-migration-ledger` on `D5-remaining-module-repos` — so the single stacked unit graph interleaves the lanes at those five edges. Subtasks stack off the previous tip and never fan out: `D5-remaining-module-repos`'s nine repositories are stacked off `D3-first-module-repo-users`'s proven shape, finance (348 app-half files plus 87 leaf files; the digest records 436 files / 54,483 LOC for the whole module) last.

### Units in this section

Units specified here: `D9-assembler-module-resolution`, `D13-compose-fragment-inlining`, `D14-gremion-dist-repo` and `D15-oss-artefact-guard`, consuming `B34-assembler-zero-modules`, `B7-renumber-ranges-baseline`, `B14-two-project-split`, `B33-assembled-tree-guards` and `B35-release-supply-chain`. Every spec D unit, `D1-module-sdk-package` through `D16-handover-visibility-record`, is listed once in the consolidated table at "Units — spec D".

## Units — spec D

| Unit | Effort | Depends on | Post-condition | Repos touched | Host contract | Notes |
|---|---|---|---|---|---|---|
| `D1-module-sdk-package` | M | — | `@gremion/module-sdk@1.0.0` exists in `civitas/packages/`; `add-a-module.proof.test.ts` passes against the SDK types in the kernel and in a scratch module package; a manifest declaring `handover:` and one declaring `status:` both typecheck; the union carries all 44 runtime-registry exports and both kernel-only registry helpers, split across `@gremion/module-sdk` and `@gremion/module-sdk/server`, and a client-side import of the server entrypoint fails the build; the B-15 helper `assertExactlyOnceUnderTwoColours` ships and reports two side effects when a module's `FOR UPDATE SKIP LOCKED` is removed; `civitas/gremion-ui/package.json` declares `"@gremion/module-sdk": "workspace:*"`, resolved by the kernel's `pnpm-workspace.yaml` `packages/*` glob; the packed tarball passes `scripts/check-packed-manifest.mjs`; `CONTRIBUTING.md` carries the N17 trigger. Each assertion watched RED by a fresh verifier who removes one union member | civitas | no | D-01 removes the `B5-governance-320-subsystem` edge; no dependency edge on `B7-renumber-ranges-baseline` either — B7 gates `D3-first-module-repo-users`, and D1's only relation to spec B is release ordering after B7 |
| `D2-module-json-and-dist-schema` | M | `D1-module-sdk-package` | The shared validator refuses, each watched RED by a fresh verifier: an out-of-block migration number, a number below 1000, an unsatisfiable SDK range, an `order`/`block` disagreeing with `ranges.json`, an `order` or `notTenantIsolated` disagreeing with the TypeScript manifest (`module.json.order == ranges.json.modules[id].order == ModuleManifest.order`, and the same equality for `notTenantIsolated`), a missing or disagreeing `extractionSource`, a `navFragmentPath`/`navAnchorId` mismatch against the manifest, a `compose.services[]` name absent from the fragment or a fragment service block with no `x-gremion-tier`, an `images[]` array with more than one `role: leaf` entry, a `distManifestDigest` that is not `"sha256:" + 64 lowercase hex`, a `vertical.json` with an unresolvable `blueprintRef`, and a dist-manifest vertical entry with no `visibility`; the fresh-init replay test runs once per module with that module OFF and fails when `1000_finance_schema.sql` is made selectable with finance OFF | civitas | no | one validator for `module.json`, `ranges.json`, the dist manifest and `vertical.json`; `ranges.json` is written by `B7-renumber-ranges-baseline` against this schema |
| `D3-first-module-repo-users` | L | `D2-module-json-and-dist-schema`, `D12-module-repo-ci-and-dependabot-template`, `B7-renumber-ranges-baseline` | `gremion-module-users` exists with the full shape (14 tracked app files); every tracked blob hash equals its `extraction-map.json` source blob; a clean Linux clone assembles with zero line-ending or hash mismatch; an assemble of kernel + users boots and serves the users surface with `MODULE_MANIFESTS` and server-init counts matching the manifest; and every path this unit adds to the kernel is classified in `StuRaOS/scripts/carve/kernel-manifest.json` so `verify-manifest.mjs` stays total — the only write this unit makes to the StuRa tree | `gremion-module-users`, civitas, StuRaOS | no | the shape proof; users is the one module with no leaf |
| `D4-evict-on-leaves` | M | `B19-internal-api-evict-and-modules`, `D5-remaining-module-repos` | A bats case drives `gremion-switch`'s fan-out against all nine leaves and gets exactly 204 with an empty body from each; each leaf has written one ack row (tenant, process, colour, epoch) to the control DB before answering, so a fan-out that reached eight leaves is distinguishable from one that reached nine — watched RED by a fresh verifier who blocks one leaf and asserts the missing ack row; a contract test rejects a 200 (watched RED before the routes exist); the route is mounted outside the three-header guard; `grep -rn x-internal-secret` returns nothing | `gremion-module-*`, civitas, StuRaOS | **yes** | contract is B-11's; the per-repo job is `evict-contract`, the eighth CI job in every repo with a `service/` (§2) |
| `D5-remaining-module-repos` | XL | `D3-first-module-repo-users`, `D5a-newsletter-profile-gate` | The other nine repos exist — ten with `gremion-module-users` from D3 — each **stacked** off the previous tip; blob-equality holds for every path `extraction-map.json` lists, and `extraction-map.json` covers every tracked path in every repo (vacuity guard). The payload is the app halves plus the nine `service/` trees plus the module `docker/**` stacks, each module's sidecar build contexts moved under its own `docker/<name>/`; its exact size is the sum of the per-module counts in §3 and is not asserted as a single number here, because no single measured figure covering all three classes exists — units-v2 records 1,193 app-half files, 371 leaf-service files and 41 module docker-stack files as separate measurements, and handover's share of the first figure does not ship. Every repo assembles alone and all ten assemble together; range and baseline-hash checks pass on a clean Linux clone of each; news resolves inside content with its creation migration at 1200 and 047 at 1204; newsletter carries the compose profile D5a gave it | `gremion-module-*`, civitas, StuRaOS | no | finance last; zero handover code extracted (D-01), block 1900–1999 reserved and empty |
| `D5a-newsletter-profile-gate` | S | `D2-module-json-and-dist-schema` | `newsletter-postgres` and `newsletter-service` carry `profiles: [newsletter]`; a tenant with newsletter OFF starts no newsletter container and `defaultModulesConfig` reports it off — watched RED against today's always-on shape | civitas | no | behaviour change, not a move |
| `D6-leaf-images-and-compose-fragments` | L | `D5-remaining-module-repos`, `B35-release-supply-chain` | A production render pulls nine leaf images by digest from GHCR with no `build:` section and no Docker Hub access, every name in the flat form `ghcr.io/hello-n00del/gremion-<module id>`; the four module-contributed sidecar images that have a build context (messages: synapse and element-call; files: nextcloud; elections: helios) build in the same interim pass from their module repo's `docker/<name>/`, while livekit and collabora are `role: sidecar` entries with `"context": null` that `pin-images.sh` resolves by digest; all six are declared as `role: sidecar` entries in that module's `images[]`; each leaf's image-level HEALTHCHECK points at `/healthz/tenants` with the per-leaf blast-radius decision (one unreachable tenant database → unhealthy or not) written into the §K census exemption list, so a leaf with an unreachable tenant database reads unhealthy and one with every tenant reachable reads healthy; the per-repo `leaf-image` job is still absent and its no-build guard is green; the interim's self-retiring CI check fails against a registry stub where `@gremion/{db,ports,module-sdk}` all resolve; and the guard-register row `check-interim-expiry` fails the release workflow after **2026-11-30** while `scripts/release/build-leaves-interim.mjs` still exists, watched RED with the clock set past that date. Each clause watched RED by a fresh verifier | `gremion-module-*`, civitas | **yes** | D-05 interim with a dated operator exit condition: the date and its three conditions (`@gremion` scope claimed, trusted publisher registered, `@gremion/{db,ports,module-sdk}` published) live in the D-05 exit issue, referenced from §3 |
| `D7-synapse-on-postgres` | M | `B31-postgres-c-collation`, `D5-remaining-module-repos` | A fresh stack brings Synapse up on the shared Postgres with C collation and `server_name = PLATFORM_DOMAIN`, no SQLite file; the honest probe reads unhealthy when Keycloak's key fetch failed; `gremion-backup` picks the synapse database up with no `state.env` edit; the fragment ships from `gremion-module-messages` | `gremion-module-messages`, civitas | **yes** | changes `compose/messages.yml` and adds a database the host must enumerate |
| `D8-stura-vertical` | M | `D2-module-json-and-dist-schema`, `D5-remaining-module-repos` | `verticals/{stura,musterstadt,verein}/` exist with `vertical.json`; selecting `stura` reproduces the StuRa blueprint and wording on an assembled tree and `musterstadt` the municipal one; no vertical literal and no `Civitas` literal appears outside `verticals/` (watched RED by planting one); and every path this unit adds to the kernel is classified in `StuRaOS/scripts/carve/kernel-manifest.json` so `verify-manifest.mjs` stays total — the only write this unit makes to the StuRa tree | civitas, StuRaOS | no | data only |
| `D9-assembler-module-resolution` | L | `B34-assembler-zero-modules`, `D5-remaining-module-repos` | Assembling a manifest naming N modules asserts `MODULE_MANIFESTS == N + kernel built-ins`, server-init imports == modules with a `register.server.ts` plus kernel built-ins that declare one, migration-manifest keys == the union, every nav fragment anchored — each watched RED by deleting one module's manifest or register file; every clone HEAD equals its pinned ref and the tree carries no `.git`, `.netrc`, `auths` entry or token occurrence; an `app/` collision fails; the App-token fallback refuses an unclonable entry instead of skipping it; an out-of-tree vertical id colliding with an in-tree directory fails; no private repo name in the tree; B34's fail-closed guard still passes on the extended assembler (regression, not a new guard) | civitas | no | extends B34, never reimplements it |
| `D10-module-runtime-declarations` | M | `D9-assembler-module-resolution`, `B28-worker-safety-and-colour-gating`, `B27-backup-host-wiring`, `B38-leaf-shreds-and-erasure-ledger` | Each `module.json` declares, under `runtime`, its background jobs and their colour-gating env key, its per-tenant export/shred arm and its leaf Postgres service name (`runtime.leafService.postgresService`). **The shred arms themselves and the widened erasure ledger are spec B's `B38-leaf-shreds-and-erasure-ledger` (three arms: `calendar`, `content`, `finance`; five leaves fail-closed: `board`, `files`, `messages`, `vault`, `votes` — spec B's written amendment to spec A §H.2, which said six). What D10 owns is the declaration `runtime.shred` that B38's gate reads: `true` for the four data-holding leaves (`calendar`, `content`, `finance`, `newsletter`), `false` for the other five, so the go-live gate names the fail-closed leaves from the catalogue rather than from prose (spec A §H.2).** Post-condition: `BACKUP_POSTGRES_SERVICES` and the colour-policy job list are produced from the module catalogue by the assembler into `state.env`/`app.env` and are hand-maintained nowhere, watched RED by editing one by hand and seeing the assemble overwrite and fail the drift check; removing a module from the dist manifest removes its database from the backup enumeration, its job from the colour policy and its arm from the erasure gate with no kernel edit; an erasure run over a tenant writes one ledger row per arm declared `runtime.shred: true` and the gate document lists exactly the leaves whose `module.json` declares `runtime.shred: false` — watched RED by a fresh verifier who deletes one module's shred declaration and sees the erasure proof fail as incomplete instead of passing vacuously (`StuRaOS/scripts/tenant-backup.sh` exports no leaf database today, so an unguarded erasure proof passes on nothing) | `gremion-module-*`, civitas | **yes** | drives host backup enumeration, colour policy and the erasure gate |
| `D11-archive-holding-repo-and-stura-tree` | S | `D5-remaining-module-repos`, `B7-renumber-ranges-baseline` | `civitas-modules` is archived read-only after `MIGRATION_OWNERSHIP` is harvested; no spec-B/D artefact references it; the third `types.ts`/`registry.ts` fork no longer exists; the StuRa tree is archived with `scripts/carve/**` (eight files) frozen intact, `.gitmodules`' `upstream/gremion` relationship retired in writing, `ARCHIVED.md` naming `f276af59`, the ten module repos it fed and the handover recovery command, and its residuals listed rather than fixed | civitas-modules, StuRaOS | no | freeze is the last write |
| `D12-module-repo-ci-and-dependabot-template` | M | `D2-module-json-and-dist-schema` | One template produces the eight-job workflow — the eighth being `evict-contract`, present in exactly the repos that ship a `service/` — and the three-ecosystem Dependabot file; during the D-05 interim the template's install step clones the kernel at `module.json.kernelRef` into `.kernel/` and installs with a CI-only workspace file globbing `.kernel/packages/*` and `service`, so each repo's `service/package.json` resolves `"@gremion/module-sdk": "workspace:*"` and no `github:Hello-N00del/gremion#<tag>` specifier appears in any repo (watched RED by planting one); the no-image-build guard goes RED when a `build-push-action` step is added; the `docker` ecosystem names `/service` in every repo that has one; the `test` vacuity guard goes RED when every `*.test.ts` is deleted from `app/` and the `boundary-lint` vacuity guard goes RED when the lint is pointed at an empty directory | civitas, `gremion-module-*` | no | D-05 posture and the Dependabot leaf-Dockerfile gap own no other unit; at the D-05 exit the clone step is deleted and the dependency becomes a version range |
| `D13-compose-fragment-inlining` | M | `D9-assembler-module-resolution`, `D6-leaf-images-and-compose-fragments`, `B14-two-project-split` | Sole owner of the fragment contract: each module repo ships `compose/<id>.yml`, the assembler inlines it into the two composed files, and the host's fixed `COMPOSE_FILE` list still renders. The validator and the render guard assert, each watched RED by planting the violation: no `name:` key, no `COMPOSE_FILE` entry and no top-level `include:` in any fragment; a service-name collision aborts the assemble; every service block carries an `image:` key and an `x-gremion-tier` of `state` or `app`, which alone routes the block into its composed file; append order is deterministic and equals ascending manifest `order:`; every enabled module's `compose.services[]` appears in the rendered pair with a non-zero per-service count check; every `app`-tier block carries `traefik.enable=false`, both colour aliases and `gremion.evict=true` — all nine leaf blocks included, so `gremion-deploy` step 8 enumerates exactly nine leaf targets on a full-manifest release; a leaf fragment referencing an env key not declared in `app.env.tmpl` fails the render, the leaf secrets being `INTERNAL_PUSH_SECRET` and one `${INTERNAL_<LEAF>_SECRET:?}` per leaf; two assembles of one `distManifestDigest` produce byte-identical composed files, and the zero-module and all-module renders both succeed with a byte-identical `COMPOSE_FILE` list. Host-fixed identities the fragments honour, cited in the contract: the nine leaf service names and port 8080 (`infra/host/templates/env/app.env.tmpl:29-40`), the `-<colour>` network alias `gremion-deploy:479-487` resolves, the lowest-exposed-TCP-port rule `gremion-deploy:491-498` uses, the `gremion.evict=true` label, and `COLOUR` plus `GREMION_ACTIVE_COLOUR_FILE` on every timed-job owner (B-15) | civitas, `gremion-module-*` | **yes** | owns G-D8 and G-D9; `B14-two-project-split`'s render guard asserts the same union and restates nothing — the kernel's `docker-compose.app.yml` carries only `gremion-ui`, `gremion-public` and the shared conventions |
| `D14-gremion-dist-repo` | S | `D2-module-json-and-dist-schema` | The private `gremion-dist` repo holds `gremion.dist.json` validated by the same validator; `release.yml` checks it out with the N23 App token; B34's fail-closed guard still passes on the extended assembler (regression, not a new guard) | gremion-dist, civitas | no | B-16 names the repo; no other unit creates it |
| `D15-oss-artefact-guard` | S | `D13-compose-fragment-inlining`, `B35-release-supply-chain` | The OSS images contain zero private module paths, ids, leaf image references and verticals, and do contain every public module's paths (vacuity); membership is computed at release build from each dist-manifest entry's `visibility`, never a hardcoded list, so the #353 elections flip needs no guard edit — elections and `gremion-elections` are in the full set only until kernel issue #353 closes; the guard was watched RED by building the OSS set from the full manifest, by a fresh verifier | civitas | no | also settles whether `gremion-public` needs an `-oss` variant (§4 D.2) |
| `D16-handover-visibility-record` | S | `D1-module-sdk-package` | The implementable half only: `CONTRIBUTING.md`'s private-module list includes `handover`, the N17 trigger paragraph names it as the one private module with no service, and a docs-lint guard fails when that list diverges from the `visibility: private` set in `gremion.dist.example.json`. Post-condition: the guard goes RED when a fresh verifier flips one module's visibility in `gremion.dist.example.json` without editing `CONTRIBUTING.md`. **Operator item, waived by name (P4 pattern):** the standalone decision on handover's visibility; this unit files it as the dated decision record once the operator takes it, and until then the state above is the state | civitas | no | no `D5-remaining-module-repos` edge: handover is not extracted, and its 1900–1999 block stays reserved and empty |

`B33-assembled-tree-guards` is a spec-B unit whose D-side is specified in §1 D.1.6 (nav anchors) and §4 D.1.6 (`FEATURE_TARGETS` derivation); it depends on `D1-module-sdk-package` and is not listed above. Spec B lists these D units by id only; this table is their sole owner.

## Appendix — Amendments from plan reconciliation (2026-09-16)

Each entry below is **binding on the implementation**. They were adopted by the release-1 implementation plan (`plan/2026-09-15-b-d-release-1.md`, reconciled 2026-09-16) as the conservative option for a question spec D did not answer; every one was raised by the named unit writer and is already in force in that plan's task text. Unless an entry is marked *operator decision pending*, it is adopted and binding exactly as written — names, paths, keys, values and exit codes are literal. Vocabulary: Gremion is the product; StuRaOS is the StuRa vertical / the StuRa tree. Entries are numbered in the order the plan residuals list them; the spec-B half of this reconciliation is in `spec-b.amendments-2026-09-16.md`.

### Resolutions of flagged contradictions (orchestrator, 2026-09-16)

The reconciliation pass flagged contradictions between adopted answers and standing spec text. They are resolved below from the plan's **"Cross-unit contracts (binding)"** table (`plan/2026-09-15-b-d-release-1.md` l.281–442), which outranks every writer answer. Entries named here carry `Consistency: resolved — see Resolutions`.

- **R1 — the shared schema validator (AM-D-02, AM-D-05, AM-D-14, AM-D-23, AM-D-34).** Contract row "the shared schema validator": `civitas/scripts/validate-module-schemas.mjs`, owner `D2-module-json-and-dist-schema`, exporting `validateModuleJson(obj, ctx): string[]`, `validateDistManifest(obj): string[]`, `validateVerticalJson(obj, ctx): string[]`, `validateRangesJson` and `validateAll` (an empty array means valid). CLI: `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]`, exit 1 on any problem including the vacuity problem. Consumers: `B34-assembler-zero-modules`, `D3-first-module-repo-users`, `D5-remaining-module-repos`, `D5a-newsletter-profile-gate`, `D8-stura-vertical`, `D9-assembler-module-resolution`, `D12-module-repo-ci-and-dependabot-template`, `D14-gremion-dist-repo`, `D6-leaf-images-and-compose-fragments`. Both earlier answers — `civitas/scripts/lib/gremion-manifest-schema.mjs` with `validateVertical`, and `civitas/packages/module-sdk/src/validate.ts` with `validateVerticalManifest` behind `@gremion/module-sdk/validate` — are **superseded**.
- **R2 — kernel `KNOWN_ISSUES.md` §T11 (AM-D-01, AM-D-26).** Both stand, with split ownership. `B0-spec-docs-and-waiver-ledger` inserts the **pointer block** naming the in-repo spec that owns the resolution, and its `test/host/spec-docs.bats` asserts the §T11 block carries the spec path; `B1b-theme-rename-and-hygiene-guard` (task .6c) replaces the section with the **closed record** and MUST preserve B0's pointer lines. Spec D l.493 stands for the pointer; AM-D-26 stands for the closed record. Neither touches `StuRaOS/KNOWN_ISSUES.md`.
- **R3 — healthcheck census input (AM-D-08).** Contract row "healthcheck census input": `civitas/infra/host/health-census.json = { schemaVersion: 1, exemptServices: ["minio-mc"], leafBlastRadius: { <leaf service>: { probe, unhealthyOnUnreachableTenantDb, scope, rationale } } }`, schema owned by `D6-leaf-images-and-compose-fragments`, committed and consumed by `B30-healthchecks-and-census`; `HEALTH_EXEMPT_SERVICES=minio-mc` in `civitas/infra/host/templates/env/state.env.tmpl` remains the env-side exemption list and B30 consumes both carriers. Spec B has no §K — the kernel-side section is spec B "### 7. `/healthz`, boot determinism, healthchecks", carried as entry **AM-B-34**.
- **R4 — M12 and the four frozen migrations (AM-D-16).** Adopted as written: G-D10's byte-immutability of `008_public_portal.sql`, 042, 043 and 048 wins over spec A record M12's scrub **for those four files only**; M12 stays in force everywhere else.
- **R5 — the example dist manifest (AM-D-21).** Adopted: the amendment's wording replaces spec D l.374's "names only public modules and only in-kernel verticals" sentence; that replacement *is* the amendment.
- **R6 — mirrors added.** Two entries were added so that a split contract is written on both sides: **AM-D-37** (mirror of AM-B-20, the G-D14 split) and **AM-D-38** (mirror of AM-B-30, the exactly-once helper signature).

### AM-D-01 — §T11 is a kernel-only write; the archived StuRa tree's own file is untouched
- **Amends:** "### Archiving (D11)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving")
- **Raised by:** B0-spec-docs-and-waiver-ledger
- **Gap:** Spec D:493 says `KNOWN_ISSUES.md` §T11 is overwritten by B0, but spec B §1.5's five permitted StuRa-tree writes exclude B0. Is a StuRa-tree edit expected?
- **Binding answer:** No StuRa-tree edit. Only `civitas/KNOWN_ISSUES.md` §T11 is written, pointing at the in-repo spec and B1a/B1b. §3 Archiving states: "The archived StuRa tree's own KNOWN_ISSUES.md §T11 is left untouched; D11-archive-holding-repo-and-stura-tree adds the one-line pointer to the kernel's rewritten §T11." Ownership of the kernel §T11 is split and both halves stand: `B0-spec-docs-and-waiver-ledger` inserts the pointer block naming the in-repo spec that owns the resolution, asserted by its `test/host/spec-docs.bats` (the §T11 block carries the spec path); `B1b-theme-rename-and-hygiene-guard` (task .6c) then replaces the section with the closed record and preserves B0's pointer lines. Spec D l.493 stands for the pointer.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-02 — The shared schema validator, named by the contract table
- **Amends:** "#### D.1.2 `module.json` verification" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the sentence "there is exactly one validator, not four")
- **Raised by:** B34-assembler-zero-modules
- **Gap:** Spec D says there is exactly one validator but gives it no path or export name.
- **Binding answer:** The one validator is `civitas/scripts/validate-module-schemas.mjs`, owned by `D2-module-json-and-dist-schema`, exporting `validateModuleJson(obj, ctx): string[]`, `validateDistManifest(obj): string[]`, `validateVerticalJson(obj, ctx): string[]`, `validateRangesJson` and `validateAll`; an empty array means valid. Its CLI is `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]`, exit 1 on any problem including the vacuity problem. Consumers are B34, D3, D5, D5a, D8, D9, D12, D14 and D6. The earlier `civitas/scripts/lib/gremion-manifest-schema.mjs` / `validateVertical` spelling is superseded. D.1.2's "exactly one validator" sentence carries the path and the export names.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-03 — 40 module docker-stack files, asserted as five measured counts
- **Amends:** "## Units — spec D" (the `D5-remaining-module-repos` row; the adopted answer cites "spec D §3's D5 row", but the "41 module docker-stack files" wording lives in this units table)
- **Raised by:** D5-remaining-module-repos
- **Gap:** Sidecar docker-stack count: spec D cites units-v2's 41 module docker-stack files; `git ls-files` at `f276af59` measures 40.
- **Binding answer:** Assert the five measured counts — helios 15, nextcloud 10, synapse 6, element-call 6, livekit 3, collabora 0 (no directory) = 40. Never the aggregate 41. The D5 row reads "units-v2 records … 40 module docker-stack files".
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-04 — finance's Helios coupling is 13 files
- **Amends:** "### Per-module extraction tables" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving"; the elections paragraph's `lib/server/finance/services/helios/**` note)
- **Raised by:** D5-remaining-module-repos
- **Gap:** Spec D §3 says `lib/server/finance/services/helios/**` is 14 files; `git ls-files` measures 13.
- **Binding answer:** Measured 13 at `f276af59` (`git -C StuRaOS ls-tree -r f276af59 --name-only -- gremion-ui/src/lib/server/finance/services/helios | wc -l`). Assert 13. The elections row's "14 files" becomes "13 files"; the path stays finance-owned and travels with finance.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-05 — The shared schema validator, as every D unit imports it
- **Amends:** "#### D.1.2 `module.json` verification" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the "exactly one validator" sentence)
- **Raised by:** D5-remaining-module-repos
- **Gap:** The D2 validator's exact export name is not fixed by spec D ("the SDK's validator" / "the same validator").
- **Binding answer:** `D2-module-json-and-dist-schema` ships `civitas/scripts/validate-module-schemas.mjs` exporting `validateModuleJson(obj, ctx): string[]`, `validateDistManifest(obj): string[]`, `validateVerticalJson(obj, ctx): string[]`, `validateRangesJson` and `validateAll` (empty array = valid); CLI `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]`, exit 1 on any problem including the vacuity problem. Every D unit imports exactly these names. The earlier `civitas/packages/module-sdk/src/validate.ts` / `validateVerticalManifest` / `@gremion/module-sdk/validate` spelling is superseded.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-06 — D3 ships the split driver `extract-module.mjs`
- **Amends:** "### Creation from git index blobs (D-03, F2)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D5-remaining-module-repos
- **Gap:** D3's registry row names `extraction-map.json` but no driver script, so it is undefined whether D3 ships a driver D5 generalises or extracted 14 files by hand.
- **Binding answer:** `D3-first-module-repo-users` creates `civitas/scripts/split/extract-module.mjs` together with `extraction-map.json` — a hand extraction is not re-verifiable against index blobs. D5 task .2 becomes an extension of that driver, proved by reproducing D3's users repo byte-for-byte.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-07 — `routes/api/auth/matrix-*/**` goes to messages
- **Amends:** "### Per-module extraction tables" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving"; the messages row)
- **Raised by:** D5-remaining-module-repos
- **Gap:** `routes/api/auth/matrix-*/**` is classified `product-module-api-routes` but is not counted in spec D §3's messages half (38 measured).
- **Binding answer:** `gremion-ui/src/routes/api/auth/matrix-device/**` and `matrix-token/**` (3 files, verified) are routed to `gremion-module-messages` and recorded in `extraction-map.json` as driver-total paths outside §3's 38-file union. The messages row gains "+3 api/auth/matrix-* files".
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-08 — The census input file, its schema and its owner
- **Amends:** "## Units — spec D" (the `D6-leaf-images-and-compose-fragments` row) and, for its kernel half, spec B "### 7. `/healthz`, boot determinism, healthchecks" — corrected from the answer's "spec B §K", which does not exist in spec B; that half is carried as entry AM-B-34
- **Raised by:** D6-leaf-images-and-compose-fragments
- **Gap:** The census exemption list has no file; `HEALTH_EXEMPT_SERVICES` is a flat name list that cannot carry a per-leaf blast-radius decision.
- **Binding answer:** The census input is `civitas/infra/host/health-census.json` = `{ schemaVersion: 1, exemptServices: ["minio-mc"], leafBlastRadius: { <leaf service>: { probe, unhealthyOnUnreachableTenantDb, scope, rationale } } }`. Its schema is owned by `D6-leaf-images-and-compose-fragments`, which commits the nine per-leaf blast-radius rows; `B30-healthchecks-and-census` consumes it. `HEALTH_EXEMPT_SERVICES=minio-mc` in `civitas/infra/host/templates/env/state.env.tmpl` remains the env-side exemption list, and B30 consumes both carriers. The file is named in spec D's D6 row and in spec B §7.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-09 — Leaf contexts resolve against the tree, sidecar contexts against the module checkout
- **Amends:** "### Interim leaf-image build (D-05)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving"), and the `images[].context` comment under "#### `module.json` — repo root of each `gremion-module-<id>`"
- **Raised by:** D6-leaf-images-and-compose-fragments
- **Gap:** A leaf build context must be the assembled tree root while `module.json.images[].context` for a leaf is `service`, relative to the module repo; spec D states the rule only in prose.
- **Binding answer:** A `role: "leaf"` context resolves against the assembled tree root (`--tree`); a `role: "sidecar"` context resolves against the module checkout (`--modules`). That sentence is the path contract in §3 "Interim leaf-image build (D-05)" and in §2's `images[].context` comment.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-10 — `gremion.dist.example.json` is created by D16
- **Amends:** "#### `gremion.dist.json` (private) and `gremion.dist.example.json` (kernel)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D2-module-json-and-dist-schema
- **Gap:** Ownership of `civitas/gremion.dist.example.json` is not stated by unit id anywhere in spec D.
- **Binding answer:** `D16-handover-visibility-record` (wave 7) creates `civitas/gremion.dist.example.json`; it lands before D2 (wave 8) and D14 (wave 9). D2 validates the committed file and asserts its negative cases against fixtures; D14 reads it. No other unit creates it.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-11 — `composePageAccess` ships in two forms
- **Amends:** "#### D.1.3 Registry contracts and composition seams" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover")
- **Raised by:** D1-module-sdk-package
- **Gap:** Spec D.1.3 writes `composePageAccess(vocabulary?)`, but the SDK cannot import the kernel-generated manifests barrel.
- **Binding answer:** The SDK ships `composePageAccess(manifests, vocabulary?)`; `civitas/gremion-ui/src/lib/modules/registry.ts` keeps `composePageAccess(vocabulary?)` as a one-line binding over `MODULE_MANIFESTS`; the same for `composeCapabilities`, `moduleRoutePrefixes`, `moduleOwnsSegment` and `moduleHref`. Call sites are untouched. D.1.3 notes both forms.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-12 — `Role` and `NavItem` are SDK surface
- **Amends:** "#### D.1.3 Registry contracts and composition seams" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover"; the export table)
- **Raised by:** D1-module-sdk-package
- **Gap:** Spec D.1.2/D.1.3 do not name `Role` or `NavItem` as SDK surface, yet `ModulePage.minRole`, `ModuleManifest.nav` and `NavTemplateEntry` cannot typecheck without them.
- **Binding answer:** `Role` (`auth/types.ts:1-6`) and `NavItem` (`nav-schema.ts:7-21`) move into the SDK and are re-exported from their current kernel paths. `baseNavSchema`, `AuthHelpers` and `termFor` stay kernel data. D.1.3's export table carries both rows.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-13 — `SDK_VERSION` is the declared compatibility token
- **Amends:** "#### D.1.7 Semver and compatibility" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover")
- **Raised by:** D1-module-sdk-package
- **Gap:** D.1.7 requires the kernel to declare the SDK version it satisfies but names no file for that declaration.
- **Binding answer:** The SDK root entrypoint exports `SDK_VERSION = '1.0.0'`, with a package test asserting it equals `packages/module-sdk/package.json`'s version. D2's range check and D9's refusal both read `SDK_VERSION`, never `package.json`.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-14 — The shared schema validator, for `vertical.json`
- **Amends:** "#### D.1.2 `module.json` verification" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the "exactly one validator" sentence, which also governs "#### `verticals/<id>/vertical.json` — kernel tree (F3)")
- **Raised by:** D8-stura-vertical
- **Gap:** Spec D fixes "the same validator" for `vertical.json` but never names D2's export or signature.
- **Binding answer:** `vertical.json` is validated by `validateVerticalJson(obj, ctx): string[]` from `civitas/scripts/validate-module-schemas.mjs`, owned by `D2-module-json-and-dist-schema`, which also exports `validateModuleJson(obj, ctx): string[]`, `validateDistManifest(obj): string[]`, `validateRangesJson` and `validateAll` (empty array = valid); CLI `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]`, exit 1 on any problem including the vacuity problem. The earlier `validateVerticalManifest` spelling and the `@gremion/module-sdk/validate` subpath are superseded.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-15 — The vertical-literal guard is scoped and ratcheted
- **Amends:** "### The StuRa vertical (D8, D-02)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving"; the post-condition "no vertical literal…", and the `D8-stura-vertical` row in "## Units — spec D")
- **Raised by:** D8-stura-vertical
- **Gap:** The registry row's "no vertical literal outside `verticals/`" is unbounded: the kernel carries 880 case-insensitive `stura` occurrences across 190 tracked files.
- **Binding answer:** The guard is scoped to `civitas/gremion-ui/src/**` and `civitas/gremion-public/src/**`, excluding `*.test.*`, as a per-file counted ratchet. §3's post-condition takes that scope, and the test-fixture, docs/k8s/docker and `KNOWN_ISSUES.md` sweeps are listed as named residuals.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-16 — Four shipped migrations are allow-listed against the M12 literal scrub
- **Amends:** "### The StuRa vertical (D8, D-02)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving")
- **Raised by:** D8-stura-vertical
- **Gap:** Four already-shipped migrations (008, 042, 043, 048) carry the Civitas literal and are byte-frozen by G-D10; M12 says scrub it.
- **Binding answer:** Baseline immutability wins for those four files. `008_public_portal.sql`, 042, 043 and 048 are not scrubbed (verified present in the kernel). Those four paths are allow-listed in the M12 literal guard with a comment naming G-D10, and a release-1 residual is recorded. M12 stays in force everywhere else. §3 carries that sentence.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — M12 narrowed by name

### AM-D-17 — B31 creates the Synapse database with C collation
- **Amends:** "## Units — spec D" (the `D7-synapse-on-postgres` row)
- **Raised by:** D7-synapse-on-postgres
- **Gap:** Seam with B31: B31 must also carry the `create_db_and_user "${SYNAPSE_DB_NAME:-synapse}" … C` invocation, or D7's `datcollate` assertion fails.
- **Binding answer:** Correct, and it is B31's: `create_db_and_user "${SYNAPSE_DB_NAME:-synapse}" … C` is added to `civitas/docker/postgres/init-databases.sh` in `B31-postgres-c-collation`'s task list. D7 edits neither that file nor `k8s/base/postgres/configmap.yaml`; it declares the three `SYNAPSE_DB_*` keys and asserts `datcollate`.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-18 — D9 exports `resolveModules` and an `outDir` option
- **Amends:** "#### D.1.1 Manifest source and module clone" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units")
- **Raised by:** D10-module-runtime-declarations
- **Gap:** D9's export name for the resolved-module list is not fixed in spec D §D.1.
- **Binding answer:** `D9-assembler-module-resolution` exports `resolveModules(manifest) => [{ id, order, dir, moduleJson }]` and an `outDir` option from `civitas/scripts/assemble.mjs`. Those names are pinned in D9's task list; D10 and D13 import them and change nothing else.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-19 — The three leaf scheduler job ids
- **Amends:** "#### `module.json` — repo root of each `gremion-module-<id>`" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)"; the `runtime.timedJobs[]` block)
- **Raised by:** D10-module-runtime-declarations
- **Gap:** The three leaf schedulers carry no job id today; B28 must emit the ids D10 declares.
- **Binding answer:** `calendar-leaf-scheduler`, `content-leaf-scheduler` and `newsletter-leaf-scheduler` are declared as `runtime.timedJobs[].id`. `B28-worker-safety-and-colour-gating`'s task list gains: each leaf tick body emits its own id string verbatim, so the colour-policy assertion matches `GREMION_COLOUR_GATED_JOBS`.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-20 — D16 owns the example dist manifest (D16's own raising)
- **Amends:** "#### `gremion.dist.json` (private) and `gremion.dist.example.json` (kernel)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D16-handover-visibility-record
- **Gap:** `gremion.dist.example.json` exists in no repo and spec D names no owning unit; D16 carries no D2 edge. (Same answer as AM-D-10, raised independently.)
- **Binding answer:** `D16-handover-visibility-record` (wave 7) creates `civitas/gremion.dist.example.json`; it lands before D2 (wave 8) and D14 (wave 9). D2 validates the committed file and asserts its negative cases against fixtures; D14 reads it. No other unit creates it.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-21 — The example manifest carries every module id with its visibility
- **Amends:** "#### `gremion.dist.json` (private) and `gremion.dist.example.json` (kernel)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)"; the adopted answer cites "spec D §4 D.1.1", but the sentence it replaces is at spec D l.374 in this §2 schema block)
- **Raised by:** D16-handover-visibility-record
- **Gap:** Spec D:374 says the example manifest names only public modules, while D16's guard must read a `visibility: private` set out of it.
- **Binding answer:** "gremion.dist.example.json carries an entry for every module id with its visibility; private entries carry repo: null and ref: null." That wording **replaces** spec D l.374's "names only public modules and only in-kernel verticals" sentence. It ships that way; D16's docs-lint guard compares `CONTRIBUTING.md`'s private list against those entries.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-22 — Handover's visibility (operator decision)
- **Amends:** "### D.3 Handover" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover")
- **Raised by:** D16-handover-visibility-record
- **Gap:** The operator half — the standalone dated decision re-opening handover's visibility (D-01) — has no date and no outcome.
- **Binding answer:** The standalone dated decision on handover's visibility is the operator's to take and to date. Until it is taken, the state below is the state, and `D16-handover-visibility-record` task .4 files the record of that state and marks the decision open.
- **Status:** operator decision pending (default in force: handover stays private, no repo, block 1900–1999 reserved and empty, `CONTRIBUTING.md` names it as the one private module with no service)
- **Consistency:** none

### AM-D-23 — The shared schema validator, for the dist manifest
- **Amends:** "#### D.1.2 `module.json` verification" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the "exactly one validator" sentence)
- **Raised by:** D14-gremion-dist-repo
- **Gap:** The exact export name and specifier of D2's shared validator is not written in spec D.
- **Binding answer:** The dist manifest is validated by `validateDistManifest(obj): string[]` from `civitas/scripts/validate-module-schemas.mjs`, owned by `D2-module-json-and-dist-schema`, alongside `validateModuleJson(obj, ctx)`, `validateVerticalJson(obj, ctx)`, `validateRangesJson` and `validateAll` (empty array = valid); CLI `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]`, exit 1 on any problem including the vacuity problem. The `@gremion/module-sdk/validate` subpath is superseded.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-24 — Who creates `civitas/gremion.dist.example.json`, by unit id
- **Amends:** "#### `gremion.dist.json` (private) and `gremion.dist.example.json` (kernel)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D14-gremion-dist-repo
- **Gap:** No unit's registry row says by name who creates `civitas/gremion.dist.example.json`. (Same answer as AM-D-10, raised independently.)
- **Binding answer:** `D16-handover-visibility-record` (wave 7) creates `civitas/gremion.dist.example.json`; it lands before D2 (wave 8) and D14 (wave 9). D2 validates the committed file and asserts its negative cases against fixtures; D14 reads it. No other unit creates it.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-25 — Exactly one dated provenance reference to the holding repo
- **Amends:** "### Archiving (D11)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving")
- **Raised by:** D11-archive-holding-repo-and-stura-tree
- **Gap:** Is "no spec-B/D artefact references civitas-modules" literally zero occurrences, or "nothing depends on it"?
- **Binding answer:** Read it as "nothing depends on it": exactly one dated provenance reference is allowed — `source.repo` and `source.commit` in `civitas/gremion-ui/migrations/ownership-harvest.json` — and both tokens are forbidden everywhere else. D11's row carries that exemption sentence so the guard's allow-list is spec-backed.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-26 — §T11 is `civitas/KNOWN_ISSUES.md:122`, and B1b writes the closed record
- **Amends:** "### Archiving (D11)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving"; the "Kept as origin story" line at l.493)
- **Raised by:** D11-archive-holding-repo-and-stura-tree
- **Gap:** Spec D's "Kept as origin story: KNOWN_ISSUES.md (including §T11)" — §T11 is in `civitas/KNOWN_ISSUES.md`, not StuRaOS's.
- **Binding answer:** §T11 is at `civitas/KNOWN_ISSUES.md:122` and absent from `StuRaOS/KNOWN_ISSUES.md` (verified). The StuRa file is left untouched, and D11's "Kept as origin story" line names `civitas/KNOWN_ISSUES.md`. Ownership is split: `B0-spec-docs-and-waiver-ledger` inserts the pointer block (asserted by `test/host/spec-docs.bats`), and `B1b-theme-rename-and-hygiene-guard` task .6c replaces the section with the **closed record**, preserving B0's pointer lines verbatim.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-27 — The archive flip on two repos (operator decision)
- **Amends:** "### Archiving (D11)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving")
- **Raised by:** D11-archive-holding-repo-and-stura-tree
- **Gap:** The archive flip in D11 task .4 is an irreversible outward-facing GitHub state change on two repos.
- **Binding answer:** Archiving `Hello-N00del/gremion-modules` and `Hello-N00del/StuRaOS` read-only is irreversible and outward-facing, and is the operator's to run at the gate. The item is added to `registry.json`'s `operator_items` list.
- **Status:** operator decision pending (default in force: task .4 prints the exact `gh repo archive` commands and stops; the plan archives nothing)
- **Consistency:** none

### AM-D-28 — Per-leaf Postgres credential keys are B14's
- **Amends:** "#### D.1.4 Compose fragment inlining (B-07)" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units")
- **Raised by:** D13-compose-fragment-inlining
- **Gap:** `state.env.tmpl` declares no per-leaf Postgres credential keys while state-tier fragment blocks reference `${<LEAF>_PG_USER}` / `${<LEAF>_PG_PASSWORD}`; spec B names no owner.
- **Binding answer:** Ownership is `B14-two-project-split`'s — it owns every env-template key and its coverage cross-check. `<LEAF>_PG_USER` and `<LEAF>_PG_PASSWORD` are declared in B14's `state.env.tmpl` change (wave 7); `D13-compose-fragment-inlining` (wave 17) only asserts them through the render guard.
- **Status:** adopted (conservative option)
- **Consistency:** none (it mirrors seam S15, which likewise places `INTERNAL_<LEAF>_SECRET` in the env templates with B14)

### AM-D-29 — D9's export shape, as D13's wire-in reads it
- **Amends:** "#### D.1.1 Manifest source and module clone" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units")
- **Raised by:** D13-compose-fragment-inlining
- **Gap:** Task 6's wire-in assumes D9 exposes `resolveModules()` and an `outDir`; a different export shape moves the call site. (Same answer as AM-D-18, raised independently.)
- **Binding answer:** `D9-assembler-module-resolution` exports `resolveModules(manifest) => [{ id, order, dir, moduleJson }]` and an `outDir` option from `civitas/scripts/assemble.mjs`. Those names are pinned in D9's task list; D10 and D13 import them and change nothing else.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-30 — `Role.Finance` and `Role.Auditor` are restored kernel-side, in the SDK enum
- **Amends:** "#### D.1.3 Registry contracts and composition seams" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover")
- **Raised by:** D5a-newsletter-profile-gate
- **Gap:** The kernel `Role` enum has no `Finance`, which newsletter's manifest uses; whether the finance-scoped Role travels with finance or is restored kernel-side is unsettled.
- **Binding answer:** Restore it kernel-side — a module repo cannot extend a TypeScript enum. `D1-module-sdk-package` (wave 6) ships `Role.Finance = 'finance'` and `Role.Auditor` in the SDK enum with the `ROLE_HIERARCHY` rows of `StuRaOS/gremion-ui/src/lib/auth/index.ts:8-13`. `D5a-newsletter-profile-gate` (wave 9) then uses `Role.Finance` directly.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-31 — Pre-cut overlays live at `civitas/extraction/<module>/`
- **Amends:** "### Creation from git index blobs (D-03, F2)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D5a-newsletter-profile-gate
- **Gap:** Spec D names no kernel location for an artefact deliberately changed before its module repo is cut.
- **Binding answer:** Use `civitas/extraction/newsletter/`. The path and its post-change source SHA are recorded in `extraction-map.json` and handed to D5's split driver (`civitas/scripts/split/extract-module.mjs`), so D5 extracts the overlay rather than the `f276af59` bytes and the profile gate survives the cut.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-32 — `ranges.json`'s path is kernel-relative
- **Amends:** "#### `migrations/ranges.json` — kernel, beside `gremion-ui/migrations/manifest.json`" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)"; together with the bare `migrations/ranges.json` forms the adopted answer cites as "spec D §1 D.1.2/D.1.7")
- **Raised by:** D15-oss-artefact-guard
- **Gap:** `ranges.json`'s path is ambiguous in spec D: "beside `gremion-ui/migrations/manifest.json`" vs the bare `migrations/ranges.json`.
- **Binding answer:** The path is `civitas/gremion-ui/migrations/ranges.json` — spec B §5 fixes it: "Both live at gremion-ui/migrations/ in the kernel and both are committed." `--ranges` is kept and that path is named in the `release.yml` step. Spec D's bare form becomes the kernel-relative one.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-33 — `verticals/` ships inside the gremion-ui image
- **Amends:** "### The StuRa vertical (D8, D-02)" (chapter "Per-module extraction, the StuRa vertical, news, compose fragments, interim leaf images, archiving")
- **Raised by:** D15-oss-artefact-guard
- **Gap:** Whether `verticals/` ships inside the gremion-ui image at all is undecided, so the image-side private-vertical check may be permanently vacuous.
- **Binding answer:** `civitas/gremion-ui/Dockerfile` copies only `gremion-ui/**`, `LICENSE` and `NOTICE` (verified `:12-21,50`). `D8-stura-vertical` adds `COPY verticals ./verticals/` so the interim `tenant-create` resolves a vertical at runtime; `D15-oss-artefact-guard` then asserts the private-vertical clause against both the release tree and the image.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-34 — The shared schema validator, for the per-repo `validate-module-json` job
- **Amends:** "#### D.1.2 `module.json` verification" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the "exactly one validator" sentence, consumed by the `validate-module-json` row of "#### Per-repo CI (`.github/workflows/ci.yml`)")
- **Raised by:** D12-module-repo-ci-and-dependabot-template
- **Gap:** Spec D names "the SDK's validator" but fixes neither an export name nor a CLI path for the `validate-module-json` job.
- **Binding answer:** The job runs `node scripts/validate-module-schemas.mjs [--modules DIR] [--ranges FILE] [--verticals DIR] [--dist FILE]` from `civitas/scripts/validate-module-schemas.mjs`, owner `D2-module-json-and-dist-schema`, exit 1 on any problem including the vacuity problem; the module exports `validateModuleJson(obj, ctx): string[]`, `validateDistManifest(obj): string[]`, `validateVerticalJson(obj, ctx): string[]`, `validateRangesJson` and `validateAll` (empty array = valid). The `@gremion/module-sdk/validate` subpath and `packages/module-sdk/bin/validate-module-json.mjs` are superseded.
- **Status:** adopted (conservative option)
- **Consistency:** resolved — see Resolutions

### AM-D-35 — The boundary-lint vacuity comparison is qualified to `.ts` and `.sql`
- **Amends:** "#### Per-repo CI (`.github/workflows/ci.yml`)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)"; the `boundary-lint` row's vacuity guard)
- **Raised by:** D12-module-repo-ci-and-dependabot-template
- **Gap:** Spec D's boundary-lint vacuity rule reads "scanned-file count ≥ tracked `app/` file count" unqualified, but `app/` also tracks `.json` and `.md`.
- **Binding answer:** Compare against tracked `app/` files ending `.ts` or `.sql` only — `boundary-lint.ts:92` and `:105` read exactly those two extensions and never `.svelte`. §2's unqualified wording takes that qualified form.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-36 — The CI-only root manifest tracks the kernel's dev dependency versions
- **Amends:** "#### Per-repo CI (`.github/workflows/ci.yml`)" (chapter "Module repo shape, creation from index blobs, per-repo CI, schemas (module.json, ranges, dist manifest, vertical)")
- **Raised by:** D12-module-repo-ci-and-dependabot-template
- **Gap:** The CI-only root manifest pins vitest/tsx/typescript versions that must track the kernel's, with no mechanism fixed to keep them in step.
- **Binding answer:** A CI step asserts that every version in `.github/ci/package.ci.json` equals the kernel's `devDependencies` value read from `.kernel/package.json` at `module.json.kernelRef`; drift then fails the job. §2's per-repo CI section carries that mechanism sentence.
- **Status:** adopted (conservative option)
- **Consistency:** none

### AM-D-37 — The G-D14 split, mirrored from AM-B-20
- **Amends:** "### D.3 Guard register — spec D" (chapter "Assembler module and vertical resolution, fragment inlining, OSS artefact guard, guards, acceptance, D units"; the G-D14 row)
- **Raised by:** B35-release-supply-chain (mirror of AM-B-20)
- **Gap:** G-D14 reads as `D15-oss-artefact-guard`'s guard alone while spec B §E reads as `B35-release-supply-chain`'s alone; one guard cannot have two sole owners.
- **Binding answer:** The G-D14 row splits: `B35-release-supply-chain` owns the **release-tree half** (recorded in spec B §E, where it authors `check-oss-purity.mjs` — private-path refusal plus an independent vacuity count — because it owns the two build passes) and `D15-oss-artefact-guard` owns the **artefact half** (this row: the public-module presence check and the `gremion-public-oss` variant question). Neither register reads as sole owner.
- **Status:** adopted (orchestrator resolution)
- **Consistency:** resolved — see Resolutions

### AM-D-38 — The worker-safety helper's full signature, mirrored from AM-B-30
- **Amends:** "#### D.1.5 The worker-safety test helper (B-15)" (chapter "Scope, the module SDK, the types reconcile, licence trigger, handover")
- **Raised by:** D1-module-sdk-package (mirror of AM-B-30)
- **Gap:** D.1.5 ships `assertExactlyOnceUnderTwoColours(job, {claim, sideEffect})`; a two-field options object cannot carry the job across the process boundary D.1.5 itself requires.
- **Binding answer:** The signature is `assertExactlyOnceUnderTwoColours(job, { module, exportName, claim, sideEffect, databaseUrl, expected?, colours? })`, returning `{ colours: [string, string]; sideEffectCount: number }`, exported from `@gremion/module-sdk/testing`; `module` is an `import.meta.url`. D.1.5's two-field options form is superseded, and spec B §4 (l.854) carries the same signature as AM-B-30.
- **Status:** adopted (orchestrator resolution)
- **Consistency:** resolved — see Resolutions
