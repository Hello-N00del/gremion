# Add a Module — the Gremion module-SDK playbook

> **What this is.** The reusable, stable contract for adding a **net-new vertical
> module** to the Gremion governance kernel — a self-contained feature unit that
> owns its routes, pages, capabilities, Keycloak realm objects, migrations,
> nav-rail entry, server-side boot/runtime hooks, and config toggle, without the
> kernel ever statically depending on it. It is the operational/technical
> companion to the conceptual overview in
> [`docs/about-gremion.md`](../about-gremion.md) (read that first for the kernel's
> vision, architecture, and the open-core boundary) and the sibling of
> [`docs/playbooks/extract-a-service.md`](./extract-a-service.md) (that one cuts an
> existing module OUT to its own service; this one plugs a new one IN).
>
> **What ships in the kernel.** The Gremion kernel registers exactly **two**
> manifests — `core` (the always-on shell: dashboard, settings, systemstatus) and
> `governance` (the always-on flagship: members, committees, portal, protocols,
> resolutions). Both are `toggleable:false`. Everything else — every feature
> vertical — is a module added through this playbook, and lives in the kernel only
> when its files are present. Feature modules (elections, newsletter, calendar,
> files, messages, board, users, finance, content, vault, handover)
> live in their own repositories — one per module — and plug in over this same
> SDK; they are never required for the kernel to build or boot. Most are
> AGPL-3.0-only; finance, content, vault and handover are closed.
>
> **The load-bearing promise.** Adding a module edits **NO shared composition
> function**. You write the module's own files (manifest, server logic, routes,
> migrations, an optional `register.server.ts`) and re-run two build-time codegen
> scripts that **scan** for them. The config toggle key, route-gating, nav,
> page-access, capabilities, the realm fragment, migration gating, server-init
> wiring, and the OFF→ON runtime catch-up all derive **automatically** from the
> manifest and the scan. This is proven end-to-end by
> `gremion-ui/src/lib/modules/add-a-module.proof.test.ts` (the plug-in proof), which
> constructs a throwaway `demo_vertical` manifest and asserts it appears in every
> seam when enabled and is excluded from each when disabled — with zero edits to
> any composition function.
>
> **How to use it.** Walk the sections in order. Section 0 (the manifest) and the
> two codegen re-runs in Section 1 are the only *mandatory* steps; Sections 2–7 are
> the surfaces the manifest and the scan wire for you — author each only if your
> module needs it. Each section ends with a **checklist** you copy into the
> module's task plan and tick off. Section 8 is the deselect/runtime-toggle
> contract you inherit for free.
>
> The running example below is a neutral feature vertical called **`agenda`** (a
> meeting-agenda planner over the governance domain). Replace `agenda` with your
> own module id throughout.

---

## 0. The manifest shape (the contract)

A module is described by ONE `ModuleManifest`
(`gremion-ui/src/lib/modules/types.ts`). Every field maps to exactly one composition
seam. Optional fields are simply absent for modules that do not use that surface.

```ts
interface ModuleManifest {
  id: string                                       // stable id; for toggleable
                                                   // modules MUST equal the
                                                   // config.modules key
  order: number                                    // registration rank; the
                                                   // codegen sorts MODULE_MANIFESTS
                                                   // by this (lower = earlier).
                                                   // REQUIRED on real manifests.
  toggleable: boolean                              // can config.modules[id]
                                                   // disable it? (core/governance
                                                   // = false)
  pages: { segment: string; minRole: Role }[]      // → composed PAGE_ACCESS
  routePrefixes: string[]                          // → module-disable route gate
                                                   //   e.g. ['/agenda','/api/agenda']
  groups?: Record<string, string>                  // KC group literals it owns
  capabilities?: Record<string, readonly string[]> // capability-id → groups
                                                   //   that grant it (any-of)
  migrations?: string[]                            // migration BASENAMES (no
                                                   //   .sql) it owns
  realm?: ModuleRealmFragment                       // KC groups + realm-roles it
                                                   //   owns (injected when ON)
  nav?: NavItem[]                                  // rail fragment, woven at its
                                                   //   { slot:'module', moduleId }
                                                   //   anchor
}
```

`ModuleRealmFragment` = `{ groups: {name,path}[]; realmRoles?: {name,description?}[] }`.

The `order` field is REQUIRED on every registered manifest — the manifest codegen
exits `1` on any `manifests/*.ts` file without an `order: <number>,` field, so the
live registry order stays codegen-enforced. Pick an `order` higher than the kernel
manifests (`core` is `10`, `governance` is `15`); appending high keeps existing
`moduleRoutePrefixes()` ordering golden tests green.

> **Evidence anchors:** `gremion-ui/src/lib/modules/types.ts` (the interface +
> field-level docs); `gremion-ui/src/lib/modules/manifests/governance.ts` and
> `manifests/core.ts` are the two registered references (both `toggleable:false`,
> both carry an explicit `order`). The throwaway `demo_vertical` manifest in
> `add-a-module.proof.test.ts` is a fully-populated example carrying one of every
> field.

### Checklist
- [ ] Pick a stable `id`; if toggleable it MUST equal the `config.modules` key.
- [ ] Set an explicit `order` (higher than `governance`'s `15`).
- [ ] Decide `toggleable` (a feature vertical = `true`; always-on plumbing = `false`).
- [ ] Populate only the optional fields your module actually owns; omit the rest.

---

## 1. Where the files go (and the two codegen re-runs)

A module is a fan of files under stable, predictable locations. **None** of the
kernel composition files are hand-edited. You add the module's own files and
re-run two build-time scanners that regenerate the committed barrels.

| Surface | Location | Shared? |
|---|---|---|
| **Manifest** | `gremion-ui/src/lib/modules/manifests/<mod>.ts` | new file |
| **Registration** | _none by hand_ — `scripts/build-module-manifest.mjs` scans `manifests/*.ts` → emits `manifests/index.generated.ts` | codegen output |
| Server logic | `gremion-ui/src/lib/server/<mod>/` | new dir |
| **Server self-registration** | `gremion-ui/src/lib/server/<mod>/register.server.ts` (optional; §7) — picked up by `scripts/build-module-server-init.mjs` → `server/modules/server-init.generated.ts` | codegen output |
| Page routes | `gremion-ui/src/routes/<mod>/` (must match a `pages[].segment` + a `routePrefixes` entry) | new dir |
| API routes | `gremion-ui/src/routes/api/<mod>/` (must match a `routePrefixes` entry) | new dir |
| Migrations | `gremion-ui/migrations/NNN_<mod>_<name>.sql` — **OWNED tables only** | new files |
| Realm fragment | declared in the manifest's `realm` (KC groups/roles) | in-manifest |
| Capabilities | declared in the manifest's `capabilities` | in-manifest |
| Nav | declared in the manifest's `nav` (+ a `{ slot:'module', moduleId }` anchor) | see §6 |

**The two codegen re-runs.** After dropping your files in place:

```sh
# 1. Re-scan manifests/*.ts → regenerate the registry barrel.
node scripts/build-module-manifest.mjs

# 2. Re-scan src/lib/server for register.server.ts → regenerate the boot barrel.
node scripts/build-module-server-init.mjs
```

`build-module-manifest.mjs` reads every `manifests/*.ts`, extracts each file's
`export const <name>Manifest` and its `order:` rank, and writes
`manifests/index.generated.ts` — the `MODULE_MANIFESTS` array, sorted by `order`.
`registry.ts` re-exports `MODULE_MANIFESTS`, and through it `db.ts`, the
provisioner, `realm.ts`, and `config.ts`'s `defaultModulesConfig()` all see your
module with **no edit to any of them**. (Neither scanner uses `import.meta.glob`;
both emit a plain static import list so the barrels resolve under bare `tsx`/Node,
not just the Vite graph.)

The committed `*.generated.ts` barrels are **byte-pinned** by staleness-guard
tests (`registry.test.ts` for the manifest barrel,
`server-init.generated.test.ts` for the boot barrel) — they run the codegen with
`--stdout` and assert the committed file matches, so a forgotten re-run fails CI.

**The migration-ownership invariant.** A module's migrations create/alter ONLY the
tables that module owns. The migration-ownership guard enforces that every
migration whose contents reference a module's domain is listed in that module's
`migrations[]`. Never touch another module's tables from your migration; never let
a migration of yours fall outside your `migrations[]` list.

> **Evidence anchors:** `gremion-ui/scripts/build-module-manifest.mjs` (the manifest
> scanner; exits 1 on a missing `order`); `gremion-ui/scripts/build-module-server-init.mjs`
> (the boot-barrel scanner); `gremion-ui/src/lib/modules/manifests/index.ts`
> (re-exports the generated barrel); `gremion-ui/src/lib/modules/registry.ts`
> (re-exports `MODULE_MANIFESTS` for all downstream consumers).

### Checklist
- [ ] Manifest at `manifests/<mod>.ts`; **re-run `build-module-manifest.mjs`** and commit the regenerated `index.generated.ts`.
- [ ] Server logic under `lib/server/<mod>/`; if it has a `register.server.ts`, **re-run `build-module-server-init.mjs`** and commit `server-init.generated.ts`.
- [ ] Pages under `routes/<mod>/`; APIs under `routes/api/<mod>/`.
- [ ] Every `pages[].segment` and `routePrefixes` entry has a matching route directory.
- [ ] Migrations named `NNN_<mod>_*.sql`, listed in `migrations[]`, touching OWNED tables only.

---

## 2. Page access (`pages[]` → `composePageAccess`)

Each `{ segment, minRole }` becomes a `PAGE_ACCESS` entry the moment the manifest
is in the generated barrel. `composePageAccess()` (in `registry.ts`) folds every
manifest's `pages` into the access map and **throws on a duplicate segment** — so
two modules can never silently claim the same top-level route. No edit to the auth
layer is needed: `hooks.server.ts` and the per-tenant accessors read the composed
map.

> **Automatic from the manifest:** the `PAGE_ACCESS` entry + the dup-segment guard.
>
> **Evidence anchors:** `registry.ts` `composePageAccess()`; `registry.test.ts`
> (golden PAGE_ACCESS map). The proof: `add-a-module.proof.test.ts` →
> "composePageAccess includes the demo_vertical page segments" (which also asserts
> the kernel's `committees` segment still composes alongside it).

### Checklist
- [ ] Each owned top-level route segment has a `pages[]` entry with the right `minRole`.
- [ ] No segment collides with a kernel segment (`dashboard`, `settings`, `systemstatus`, `members`, `committees`, `portal`, `protokolle`, `beschluesse`) or another module's.

---

## 3. Route gating (`routePrefixes[]` → module-gate)

For a **toggleable** module, list every URL prefix the toggle should gate — both
the page prefix and its `/api/` sibling, e.g. `['/agenda', '/api/agenda']`.
`moduleRoutePrefixes()` (toggleable modules only) feeds `module-gate.ts`, which
runs per-request on **both** the cookie-session and Bearer paths: when
`config.modules[id] === false`, any request under a prefix gets a `403 Module
disabled` (and a styled "module not active" surface for a page deep link).

> **Automatic from the manifest:** per-request route 403 on disable, on every auth
> method, with zero edit to `hooks.server.ts` or `module-gate.ts`.
>
> **Evidence anchors:** `registry.ts` `moduleRoutePrefixes()`;
> `gremion-ui/src/lib/server/module-gate.ts` (`disabledModuleForPath` /
> `moduleGateResponse`); `module-gate.test.ts`. The proof:
> `add-a-module.proof.test.ts` → "the module-gate 403s the demo_vertical prefix".

### Checklist
- [ ] List BOTH the page prefix and the `/api/` prefix for every gated surface.
- [ ] A non-toggleable (`toggleable:false`) module leaves `routePrefixes: []` (no gate) — as `core` and `governance` do.

---

## 4. Capabilities (`capabilities` → `composeCapabilities`)

Capabilities are `capability-id → groups-that-grant-it` (any-of).
`composeCapabilities()` merges every manifest's `capabilities` into the global map.
Consumers check a capability id (e.g. `agenda.publish.any`) instead of hardcoding
group names, so the group→capability mapping lives once, on the owning manifest.

> **Automatic from the manifest:** the capability appears in the composed map and
> is checkable everywhere `capabilitiesForTenant()` / the auth helpers resolve.
>
> **Evidence anchors:** `registry.ts` `composeCapabilities()`; `registry.test.ts`
> ("composeCapabilities — single composition seam"). The proof:
> `add-a-module.proof.test.ts` → "composeCapabilities includes the demo_vertical
> capabilities".

### Checklist
- [ ] Express access as capability ids → granting groups, not raw group checks at the call site.
- [ ] Reuse the platform groups (`admin`, `it-admin` — owned by the `core` manifest) where appropriate; declare module-owned groups in `groups`.

---

## 5. Realm fragment (`realm` → `composeRealm`)

A toggleable module's Keycloak groups and realm-roles live in its `realm`
fragment. `composeRealm()` injects them into the generated realm-export **only
when the module is enabled** — a disabled module's groups/roles exist nowhere in
the realm. Because first-party clients run `fullScopeAllowed:false`, `composeRealm`
also appends each enabled module's realm-roles to every client `scopeMappings`
entry, so the role actually reaches tokens; a disabled module's role is absent from
the mappings too (import-consistent in both states).

> **Automatic from the manifest:** groups + roles + the per-client scope mappings,
> all gated by the enabled/disabled state, with zero edit to the realm generator or
> the base template.
>
> **Evidence anchors:** `gremion-ui/src/lib/modules/realm.ts` (`composeRealm`);
> `realm.test.ts`. The proof: `add-a-module.proof.test.ts` → "composeRealm (KC
> groups + roles only when enabled)", which asserts the role reaches the
> `gremion-ui` client scope mapping when ON and is absent from every mapping when
> OFF.

### Checklist
- [ ] Declare every owned KC group (full `{name,path}`) and realm-role (`{name,description?}`).
- [ ] Keep the realm fragment in drift-sync with the manifest's `groups` literals (see `realm.test.ts` drift guard).
- [ ] Platform groups (login/admin) stay in the base template, NOT the module fragment.

---

## 6. Nav (`nav` → `composeNavSchema`)

The rail is composed, not hardcoded. `nav-schema.ts` exposes a module-NEUTRAL
`baseNavSchema` with `{ slot: 'module', moduleId }` anchors; `composeNavSchema`
weaves each module's `nav` fragment in at the matching anchor. A fragment can be a
bare item injected into an existing section (e.g. an item anchored inside the
Gremien section) or a whole section injected at top level (e.g. an `Agenda`
section). A deselected module's anchor resolves to nothing, so its rail entry
vanishes with the module; `filterNavForSession` additionally hides any
`moduleId`-tagged entry at request time when the module is disabled.

**The one nav nuance.** The fragment lives on your manifest (no shared
composition edit), but its **anchor** (`{ slot:'module', moduleId: '<your-id>' }`)
must exist in `baseNavSchema`. Adding a top-level anchor to `baseNavSchema` is the
single documented exception for nav-bearing modules — it is one declarative slot
line, not composition logic. Tag both the section and its items with `moduleId` so
the runtime gate hides them on a disabled tenant.

> **Automatic from the manifest:** the rail entry composes at the anchor and is
> filtered out on disable, with no edit to `composeNavSchema`,
> `filterNavForSession`, or any NavItem consumer.
>
> **Evidence anchors:** `gremion-ui/src/lib/components/layout/nav-schema.ts`
> (`baseNavSchema` anchors + `composeNavSchema` + `filterNavForSession`);
> `nav-schema.test.ts`. The proof: `add-a-module.proof.test.ts` → "composeNavSchema
> (nav fragment at the module anchor)" + the runtime-gate deselect case.

### Checklist
- [ ] Declare the rail fragment on the manifest's `nav` (reuse the `NavItem` shape).
- [ ] Add the matching `{ slot:'module', moduleId }` anchor to `baseNavSchema`.
- [ ] Tag the section AND its items with `moduleId` so the disable gate hides them.
- [ ] Use `termKey` on labels that should re-term per tenant.

---

## 7. Server-side wiring (`register.server.ts` → the runtime registry)

A module that needs to run code at boot, react to tenant eviction, contribute a
provisioning subsystem, or serve request-time data to kernel routes does so
WITHOUT the kernel ever importing it. The dependency direction is inverted through
`gremion-ui/src/lib/server/modules/runtime-registry.ts`: the module **self-registers**
its contributions at import time, and the kernel composition roots invoke the
aggregate.

Put one `register.server.ts` in your module's server dir
(`gremion-ui/src/lib/server/<mod>/register.server.ts`). `build-module-server-init.mjs`
scans for it and emits the side-effect import barrel
(`server/modules/server-init.generated.ts`), which `hooks.server.ts` imports once
at cold start — running every module's registration. The registry exposes five
kinds of contribution:

- **Server-init (boot) hooks** — `registerServerInitHook(hook)`. Boot-time
  workers (schedulers, consumers, drains). The kernel runs them via
  `runServerInitHooks()` in `hooks.server.ts`.
- **Tenant-evict hooks** — `registerTenantEvictHook(hook)`. Drop a module's
  per-tenant runtime handle when a tenant is evicted. Run via
  `runTenantEvictHooks(tenantId)` from `tenant/registry.ts`.
- **Provisioning subsystem factories** — `registerProvisioningSubsystem(name,
  factory)`. A module's provisioning adapter, built by the governance
  orchestrator's `buildModuleProvisioningSubsystems(kc)`; the kernel keeps only
  its own `keycloak` subsystem inline.
- **Request-time data providers** — `registerDataProvider(key, provider)`. A
  typed, keyed read function a kernel shell/dashboard route invokes by key via
  `getDataProvider(key)?.(args)`. When the module is absent the key is
  unregistered and the caller degrades to its empty state. The provider key set
  is the kernel-owned `DataProviderContract` — extend it there if your module
  contributes a new kernel-consumed read.
- **Setup-wizard health probes** — `registerSetupHealthProbe(probe)`. A
  credential probe the setup-wizard health route runs to predict provisioning
  success; an unregistered module simply contributes no probe.

The point of the seam: `hooks.server.ts`, `tenant/registry.ts`, the governance
orchestrator, and the kernel route loads depend ONLY on `runtime-registry.ts` —
they never statically import any module's server internals. The modules depend on
the registry too, and register into it.

> **Automatic from the scan:** your `register.server.ts` runs at boot with no edit
> to `hooks.server.ts` or any kernel root — only the regenerated
> `server-init.generated.ts` changes (byte-pinned by `server-init.generated.test.ts`).
>
> **Evidence anchors:** `gremion-ui/src/lib/server/modules/runtime-registry.ts` (the
> five registries + their register/run/get functions);
> `gremion-ui/scripts/build-module-server-init.mjs` (the scanner);
> `gremion-ui/src/lib/server/modules/runtime-registry.test.ts`;
> `gremion-ui/src/lib/server/boundary/kernel-clean.test.ts` (the boundary backstop
> that forbids the kernel statically importing a module's server internals).

### Checklist
- [ ] Add `register.server.ts` only if the module needs a boot/evict/provisioning/data-provider/health hook; **re-run `build-module-server-init.mjs`** and commit the barrel.
- [ ] Register through `runtime-registry.ts` — never import your module from a kernel root.
- [ ] If you contribute a new kernel-consumed read, add its key to `DataProviderContract` and have the kernel caller degrade to an empty state when the provider is absent.

---

## 8. The toggle, migrations, and runtime enable/disable (what you inherit)

Once the manifest is in the generated barrel, a **toggleable** module is
on-by-default and fully runtime-toggleable with no further wiring:

- **Config toggle key (automatic).** `defaultModulesConfig()` (in `config.ts`)
  sources its toggleable ids from `MODULE_MANIFESTS`, so your id is `true` by
  default with **zero edit to `config.ts`**. `config.modules` is an open
  `Record<string, boolean>`; the zod schema (`modulesSchema`) and the `mergeStored`
  back-fill accept your id structurally. `REQUIRED_MODULES` is **`[]`** in the
  governance-only kernel — it ships no always-on feature modules (the `core` and
  `governance` manifests are `toggleable:false`, so they never appear in the toggle
  map at all). A feature module contributes its own required ids only if it is
  present.

- **Migration gating + OFF→ON catch-up (automatic).** On a **fresh init** with the
  module OFF, `disabledModuleMigrationFiles` filters your `migrations[]` out of the
  apply set (recorded nowhere — "absence, not bookkeeping"). On an
  already-initialized DB, a true **OFF→ON re-enable** has `moduleReenableCatchup`
  plan your unapplied migrations for replay against the advanced schema (it returns
  `[]` for a fresh DB, a disabled module, or a fully-applied module).

- **Deselection contract.** `config.modules.<id> = false` → routes `403` (§3) +
  nav hidden (§6) + realm omitted (§5) + page-access still composes the segment but
  the route gate blocks it + migrations skipped on fresh init. **Data is RETAINED**
  by default (ON→OFF is retain — no drop, no `schema_migrations` removal); a later
  OFF→ON re-enable catches up. Teardown of data-at-rest is operator-explicit, never
  automatic.

- **No shared composition edit.** Adding a module edits **no shared composition
  function** — only the module's own files plus the two regenerated `*.generated.ts`
  barrels (and a single nav anchor line in `baseNavSchema` IF the module
  contributes a top-level rail section, §6). The composition functions
  (`composePageAccess`, `moduleRoutePrefixes`, `composeCapabilities`,
  `composeRealm`, `composeNavSchema`, `disabledModuleMigrationFiles`,
  `moduleReenableCatchup`, `defaultModulesConfig`) are never touched.

> **Evidence anchors:** `gremion-ui/src/lib/server/config.ts` (`defaultModulesConfig()`
> derives from `MODULE_MANIFESTS`; `modulesSchema` open record; `REQUIRED_MODULES`
> is `[]`); `config.test.ts` (a net-new toggleable id validates + force-ons with
> zero config.ts edit); `gremion-ui/src/lib/server/module-migrations.ts`
> (`disabledModuleMigrationFiles` + `moduleReenableCatchup`);
> `module-migrations.test.ts`. The capstone proof — all seams in one file:
> `gremion-ui/src/lib/modules/add-a-module.proof.test.ts`.

### Checklist
- [ ] Toggleable module is on-by-default via `defaultModulesConfig()` (no `config.ts` edit) — verify in the proof test.
- [ ] Migrations skip on fresh-OFF init and catch up on OFF→ON re-enable (no migration-runner edit).
- [ ] Deselection 403s routes + hides nav + omits realm + retains data — all from `config.modules.<id>=false`.
- [ ] Confirm the add touched only the module's own files + the two regenerated barrels (+ at most one nav anchor) — NO composition-function edit.

---

## Proof: the plug-in test

`gremion-ui/src/lib/modules/add-a-module.proof.test.ts` is the executable contract
for this playbook. It builds a throwaway `demo_vertical` manifest carrying one of
every field above and asserts, **with no edit to any shared composition file**:

- **WHEN ENABLED** `demo_vertical` appears in `composePageAccess` (its pages),
  `moduleRoutePrefixes` (its prefixes), `composeCapabilities` (its caps),
  `composeNavSchema` (its nav fragment at its anchor), `composeRealm` (its
  groups/roles + scope mapping), `defaultModulesConfig` (key = `true`), and
  `moduleReenableCatchup` plans its migrations on an OFF→ON re-enable.
- **WHEN DISABLED** it is excluded from each: nav hidden, realm omitted, routes
  gated (the module-gate 403s its prefix), migrations skipped on fresh init.
- **DESELECT** disabling a toggleable module removes it from nav, page-access,
  capabilities, realm, and route-prefixes — purely via config / the manifest set,
  with zero shared-file edits. (In the governance-only kernel the two registered
  manifests `core` and `governance` are non-toggleable and never deselect, so the
  throwaway `demo_vertical` proves the contract.)

The list-parameterised seams (`composeNavSchema`, `composeRealm`,
`disabledModuleMigrationFiles`, `moduleReenableCatchup`) receive the mock manifest
as an argument; the global-set seams (`composePageAccess`, `moduleRoutePrefixes`,
`composeCapabilities`, `defaultModulesConfig`, and the module-gate) get it by
`vi.doMock`-ing the barrel `$lib/modules/manifests` to include the mock alongside
the real `core` and `governance` manifests. Every seam is reachable with the mock
without any signature change, so there is no real-manifest-only fallback.
