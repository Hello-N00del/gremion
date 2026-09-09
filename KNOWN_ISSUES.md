# Known Issues — Gremion kernel

This file tracks issues in the **governance kernel only**. Issues for modules
(finance, elections, content, calendar, files, messages, …) and for verticals
live in their own repositories.

**Bare `#NNN` references in this tree do not link to Gremion issues.** Roughly
650 of them, across some 260 files, predate the extraction and refer to the
private product tracker this kernel was carved out of; GitHub will happily
re-link those numbers to unrelated issues in this repository. They are left in
place because they are load-bearing provenance in code comments, and rewriting
650 of them would be a worse change than explaining them. Use the `gremion#NN`
form for anything new — that one does resolve here.

## Carve-time residuals

Leftovers of the extraction that are still in the kernel tree. None of them
stops the kernel from booting; each is tracked here until it is removed or
generalised. Every entry below was re-checked against the tree, and the ones
that had been fixed have been struck from the list rather than left standing.

- **Feature-module references in the test suite.**
  `gremion-ui/src/routes/layout.server.test.ts` still builds its config double
  with `modules: { files, messages, calendar, users, finance, elections }` and
  flips `modules.finance` on and off to exercise the shell, and
  `gremion-ui/tests/integration/deselection-setup.ts` and `setup.ts` still
  reason about a finance-OFF database. The kernel registers no such modules, so
  these tests describe a configuration the kernel cannot reach. They pass
  because the config is a double. Relocate to the module repositories or
  rewrite against a module the kernel actually ships.
- **`matrix_homeserver` survives in the provisioner.**
  `gremion-ui/src/lib/server/tenant/provisioner/materialize.ts` and
  `gremion-ui/tests/integration/fixtures/default-config.json` still carry the
  field. It is no longer *required* — the brand-completeness guard
  (`brandIdentityComplete`) checks `product` and `org_short` only — but a
  messaging-module field still sits in a kernel config shape.
- **A fresh kernel serves a tenant-scoped 503 until Setup runs.**
  `runFleetMigrations()` asserts a complete brand identity per tenant and an
  un-materialized tenant resolves `product` / `org_short` to empty, so the boot
  path records that tenant as failed. This is deliberate (a blank brand render
  is worse), but it means the very first request against a brand-new install is
  a 503 and the message has to be read as "run the Setup wizard", not as a
  fault.
- **`make lint` and `pnpm -C gremion-ui check` are red on a fresh clone.**
  The hygiene check renders the compose overlays, and the dev overlay reads
  `.env` and `legal/legal.env`, both git-ignored. Without them `docker compose
  config` degrades rather than failing, and the port-binding guard reports
  "non-loopback gremion-ui binding(s)" — a misleading security-invariant
  failure whose real cause is "run `scripts/setup.sh` first". Both gates should
  distinguish a missing local env file from a genuine violation.

Closed since this list was last written, checked at HEAD and removed rather
than carried: the finance/elections toggles in `TabServices.svelte` (gone, only
a comment remains), the dead `/calendar` dashboard links and internal calls
(gone, only comments remain), the two finance e2e specs, the finance-specific
`cutover-flip-flag.mjs`, the `matrix_homeserver` requirement in the
brand-completeness check, and the hardcoded staging host in the realm template
(now the `__APEX_DOMAIN__` sentinel).

## Naming debt carried into 0.1.0

The project is **Gremion**. Some identifiers still carry earlier names and are
**not** renamed in 0.1.0, because renaming them either breaks a running
deployment or rewrites applied history. What remains is internal, with one
stated exception: no shipped banner, no operator-facing string and no rendered
copy in either app names an earlier product — the only rendered carrier left is
the Keycloak login template's `displayName` fallback, which both shipped realm
exports override and which is named under T11 below. The first section records
the user-facing carry-over as closed rather than deleting it, because the guard
that enforced it changed shape at the same time.
They are listed here so that a reader who greps the tree knows they are known,
not missed.

### The old product name in user-facing copy — CLOSED

This used to be the part of the naming debt a user actually saw. It is recorded
here rather than deleted, because the guard that enforced it changed shape with
it and a reader who knows the old shape needs to be told.

Both surfaces are fixed. The dashboard subtitle in
`gremion-ui/src/lib/i18n/{de,en}.ts` no longer names any product — it reads
"Willkommen — Ihrer Plattform für die Gremienarbeit." / "Welcome — your
governance platform." A tenant's own product name is what `resolveBrand()` /
`requireBrand()` are for, so no new literal replaced the old one. The setup
wizard's test mail goes out as `Gremion SMTP-Test`
(`gremion-ui/src/routes/api/setup/test-smtp/+server.ts`), and the first-boot
banner in `setup-token.ts` says `Gremion Setup Token`.

`gremion-ui/src/lib/brand.guard.test.ts` used to snapshot the remaining
carriers into a finite `STURAOS_KNOWN_DIRTY` set and assert only that no NEW
file carried the literal, with a tripwire that failed the moment the set went
empty or a pinned file went clean — deliberately, so that whoever cleared the
last one had to delete the exception rather than let it rot. **That happened.**
The set, the known-dirty guard and the tripwire are gone; `StuRaOS` is now in
the hard zero-tolerance `FORBIDDEN` loop beside the three institution literals,
with an empty allowlist.

Where the product-name guards do **not** reach, so nobody reads them as wider
than they are:

- `brand.guard.test.ts` scans `gremion-ui/src/**` and only `.svelte`, `.ts`,
  `.js`, `.css`, excluding test files and `fixtures/`.
- `gremion-public/` has its own counterpart,
  `gremion-public/src/lib/test/kernel-instance-leak.test.ts`, which asserts no
  non-test source file under `gremion-public/src` carries the literal — but it
  scans `.svelte`, `.ts`, `.js` only, so `src/app.css`, `src/app.html` and the
  package-root `svelte.config.js` are outside it. All three are clean today; a
  new literal in them would fail no test.
- The sibling `deploy-brand.guard.test.ts` scans every tracked file, but its
  forbidden list is the *institution-identity* literals only. It says so in its
  own header.
- Shell, SQL, `docker/**` and the Keycloak login theme are outside all three.
  The literal survives there in migration `043`'s inline comment, in the login
  theme (T11 below), and in `scripts/kernel-hygiene-check.mjs`'s own
  banned-word list, which must be able to spell what it forbids.
- `deploy-brand.guard.test.ts` forbids `/hs-harz\.de/`, which does **not** match
  the hyphenated spelling `HS-Harz`. That spelling reached a source comment
  once and was found by eye, not by the guard. Widening the pattern is a guard
  change that has to be watched fail first, so it is entered here rather than
  done blind.

### The Keycloak realm is still `sturaos` (T11)

- `docker/keycloak/realm-export.base.json` and `realm-export.json` declare
  `"realm": "sturaos"`. Their `"displayName"` is **not** debt — it is now
  `Gremion`, because it is the human-readable label the login page renders and
  it binds nothing: it applies to a fresh realm import only, and an existing
  realm keeps its stored value.
- `docker/keycloak/substitute-realm-secrets.sh` writes
  `${IMPORT_DIR}/sturaos-realm.json` and `sturaos-users-0.json`. These track the
  realm id, not branding: Keycloak resolves the partial-import users file by the
  `<realm>-users-N.json` convention.
- The login theme directory is `docker/keycloak/themes/sturaos/`, its stylesheet
  filename carries the same name (renaming it 404s the login page — the
  stylesheet is served by path), and every `.ftl` in it references
  `sturaos*`-prefixed message keys from its own bundles. The directory name is
  the realm's `loginTheme` value in both exports. (Not quoted here: the wire-root
  hygiene guard `h1` forbids that literal tree-wide and carves out only the theme
  directory itself. `deploy-brand.guard.test.ts` additionally pins one file
  inside it by exact path as a vacuity check, so moving the directory turns that
  test red as well.)
- `gremion-ui/scripts/install-git-hooks.mjs` writes the pre-commit block markers
  `# >>> sturaos-boundary-lint >>>` / `# <<< sturaos-boundary-lint <<<`. These
  are matched against hooks **already installed** in contributors' `.git/hooks`;
  renaming them orphans every installed block and silently double-installs. That
  needs a migration path, not an edit.
- The realm id is not confined to `docker/keycloak/`. It is the issuer path, so
  it is repeated wherever an issuer, a `KEYCLOAK_REALM` or an admin-API route is
  written down: `.env.example` and `gremion-ui/.env.example`,
  `docker-compose.yml` and `docker-compose.override.yml`,
  `k8s/base/gremion-ui/configmap.yaml`, `.github/workflows/gremion-ui.yml`,
  `scripts/dev-configure.sh` and `scripts/configure-keycloak-clients.sh`, the
  BATS suites under `test/`, ~30 unit and integration fixtures under
  `gremion-ui/src/` — including the acceptance assertions
  `expect(ctx!.realmName).toBe('sturaos')` in
  `src/lib/server/tenant/acceptance.integration.test.ts`, which are the proof
  that the default tenant still resolves to the existing realm — and the
  operator recipes in `docs/OPERATIONS.md`, `docs/LOCAL_TESTING.md`,
  `docs/TROUBLESHOOTING.md`, `docs/ENVIRONMENT.md` and `docs/DEVELOPMENT.md`.
  `git grep -l -i sturaos` returns 72 files at the 0.1.0 root; that count is the size of the
  rename, and it is why the rename is a deployment-identity migration rather
  than a sed. Every one of those is correct as written for as long as the realm
  is called `sturaos`.
- `STURA_BLUEPRINT`, and the string `'STURA_BLUEPRINT@1'`, are the exported
  default org blueprint and its registry key
  (`gremion-ui/src/lib/server/seed/blueprint-registry.ts`). The string is
  **persisted**: `src/lib/server/tenant/register-default.ts:120` writes it
  verbatim into the default tenant row's `blueprint_ref` column
  (`migrations-control/001_tenant_registry.sql:23`), the provisioning pipeline
  stamps it on every other row, and it is read back to resolve a tenant's seed
  shape — so renaming it orphans every existing tenant row unless a data
  migration moves them together. `blueprint-registry.test.ts:11,20` asserts the
  literal for exactly that reason. The blueprint's *content* is already neutral — the seeded users
  are `@council.example` and the fictional payees are Musterstadt/Musterland
  names — so what remains is the identifier, not the data.
- The login templates fall back to the old product name when a realm has no
  display name: `${(realm.displayName)!'StuRaOS'}` in `login.ftl`, `error.ftl`,
  `login-otp.ftl` and the reset templates. A realm that sets `displayName` never
  shows it; a realm that does not, does.

**Why it is not renamed.** The realm id is the issuer path every existing
token, client and bookmark resolves against, and the theme directory name is
the value Keycloak looks the theme up by — renaming the directory 404s the
login page. This is a deployment-identity migration, not a text change, and it
is deliberately out of scope for 0.1.0. A fresh install can set the realm
`displayName` to its own institution and never sees the fallback.

### The old working name in code and data

- **Applied migrations are the only carriers left in code.** Four name it in
  their header comments — `008`, `042`, `043`, `048` — and `043` also carries
  `Civitas/StuRaOS` in an inline comment on line 50. Migration files are
  hash-pinned in `manifest.json` and forward-only: editing one after it has been
  applied anywhere makes every existing database fail integrity verification on
  the next boot. These will never be edited.
- The `(Civitas carve)` provenance comments that used to be the bulk of this
  entry are **gone** from source, and so are the `.env.example` and
  `docker-compose.yml` header banners. Take the current inventory with
  `git grep -n -F Civitas -- . ':!docs' ':!KNOWN_ISSUES.md'`; anything outside
  `gremion-ui/migrations/` that it returns is new debt, not entered debt.
- Outside code the name survives in exactly two documents, both deliberately:
  the labelled internal-alias note in `docs/about-gremion.md`, and the
  why-it-is-not-the-name section of `docs/TRADEMARK.md` — which also has to
  name two *third parties'* marks (CIVITAS INTERNATIONAL Management Consultants
  GmbH and Civitas Connect e.V.) to explain the conflict at all.

**The contract documents are deliberately *not* on this list.** The `info.title`
and `info.description` of `contracts/**/*.json` are read by every consumer that
fetches the spec, so unlike the comments they are outward-facing and are
renamed for 0.1.0 rather than carried — `info.title` is not a breaking change
under the oasdiff gate. If `git grep -F Civitas -- contracts/` returns anything
in the tree you are shipping, that is a release blocker, not entered debt.

### The example hosts still carry the old flavour

The leftmost label is still `stura`, and the example hosts are not one family.
None of what remains is registrable by a stranger, but only some of it is
reserved by RFC 2606, so the distinction is worth stating rather than
flattening:

- **RFC 2606 reserved.** `stura.example.com` in `k8s/base/**` (the gremion-ui
  and gremion-public ConfigMaps, the Keycloak ConfigMap's `DOMAIN`, the Traefik
  IngressRoutes and middlewares, the nginx ingress example, the production
  overlay patches and `k8s/traefik/values-prod.yaml`), in
  `legal/legal.env.example`'s `DOMAIN` and in `scripts/setup.sh`'s prompt; and
  `stura.example.org` across ~15 unit-test fixtures.
- **Reserved, but not by RFC 2606.** `stura.example.edu`. RFC 2606 §4 names
  only `example.com`, `example.net` and `example.org`; `.edu` registration is
  restricted and EDUCAUSE holds `example.edu` for documentation, so it is not
  registrable — but the RFC does not cover it, and this is the one leftover
  that reaches a *rendered* surface.
  `gremion-public/src/routes/+page.svelte:213` uses `kontakt@stura.example.edu`
  as the contact form's `mailto:` target when `PUBLIC_CONTACT_EMAIL` is unset,
  and `gremion-ui/src/routes/portal/+page.svelte:41` displays it as the domain
  fallback.
- **Not reserved at all.** `example.de` — `stura.example.de`, `smtp.example.de`,
  `noreply@example.de` — in four `placeholder` attributes
  (`setup/steps/Step2Org.svelte`, `setup/steps/Step4Smtp.svelte`,
  `settings/tabs/TabEmail.svelte`, `settings/tabs/TabServices.svelte`), one
  German hint string beside the first of them, and fixtures in four unit-test
  files. `.de` is a registrable TLD and RFC 2606 does not reserve `example.de`.
  These are input *hints* and test inputs: nothing substitutes them, links to
  them, or sends to them.

**The version of this that was a live defect is fixed.**
`legal/legal.env.example` shipped `info@stura-muster.de` and
`datenschutz@stura-muster.de`, `.env.example` shipped `rat@hs.example.de`, and
`gremion-ui/.env.example` shipped `PUBLIC_BASE_URL=https://example.de` — value
defaults on registrable `.de` names, copied verbatim by `scripts/setup.sh` on
every fresh install and substituted into live `mailto:` links on the TMG §5
Impressum, the GDPR Art. 13 controller notice and the portal contact page. All
now read `council.example`, and hygiene check `i2` fails the tree if any host in
a value position of a tracked `*env.example` is neither a name IANA reserves for
documentation nor a dotless compose-service alias.

It is not renamed in 0.1.0 because it is a coupled set, not a string: the
Traefik `Host(...)` / `HostRegexp(...)` pairs and the compose `DOMAIN` /
`DOMAIN_REGEX` pair must move together or every tenant subdomain 404s silently
(hygiene check `j1` and `gremion-ui/scripts/check-domain-regex.mjs` exist
because of exactly that failure), and
`gremion-ui/src/lib/server/tenant/resolve.test.ts` asserts on the leftmost
label. `.github/workflows/gremion-ui.yml` and
`gremion-ui/vitest.integration.config.ts` already use `council.example`, so the
tree is not internally consistent either — a normalisation pass should do all
of it at once, with the domain-regex guard watched.

### The retired staging host

The deployment at the old staging domain is gone, and so is the literal. This
entry used to record ~16 tracked files under `gremion-ui/` and `gremion-public/`
that still carried it, and an `i1` hygiene check whose declared scope excluded
exactly those two trees. **Both halves are now closed.** The app-source sweep
landed — the `AUTH_KEYCLOAK_ISSUER` and `SYNAPSE_SERVER_NAME` defaults are gone
from `register-default.ts`, the seed blueprint's e-mail domain is
`@council.example`, and the fixtures use RFC 2606 names — so `i1` in
`scripts/kernel-hygiene-check.mjs` now scans **every tracked file**, with the
only carve-outs being the two files that must be able to quote what they forbid
(the hygiene script itself and `test/setup.bats`).

It is therefore no longer naming debt but an enforced invariant: a
reintroduction fails `i1`. Any `AUTH_KEYCLOAK_ISSUER` or `SYNAPSE_SERVER_NAME`
default you find in source is a bug, not a supported fallback.

### Internal references that outlive the private tracker

- **Bare issue numbers in shipped source.** Shipped source carries bare
  `#NNN` references to the private StuRaOS issue tracker; once public they
  resolve to Gremion issue numbers that do not exist. A mechanical sweep is
  deferred because a three-digit `#NNN` is also a valid CSS hex colour inside
  the `<style>` blocks of the same files, so the rewrite needs comment-context
  awareness and a full re-verify. The only reproducible number is the mechanical
  one — `git grep -oE '#[0-9]{3}' -- gremion-ui/src gremion-public/src
  packages | wc -l` returns 397 at the 0.1.0 root — and an unknown share of those
  are hex colours a naive rewrite would corrupt; that share *is* the ambiguity. Unswept from the
  same pass: internal plan codes (`HANDOVER-vN`, `P2.1c`, `WI-N`, `D-SECMOUNT`,
  `G-097`, "design §7 / meta-plan S5") in those files. Issue numbers disclose
  nothing on their own; the cost of getting the rewrite wrong is a broken
  stylesheet in the public repo.
- **Two contract documents are validated by no mode.**
  `contracts/calendar/asyncapi.calendar.json` and
  `contracts/content/asyncapi.content.json` describe module leaves that ship in
  their own repositories. `boundary-lint --contracts` discovers documents from
  `contracts/kernel/` only, so those two are never schema-checked here. Widening
  the discovery today fails on a `collectUnresolvedRefs` false positive — the
  content spec's channel `$ref`s are percent-encoded
  (`#/channels/gremion.%7BtenantId%7D....`) and the collector cannot resolve
  them — which is a defect in the ref collector, not in the spec. Fix the
  collector, or move the two documents out with their modules; do not widen the
  gate onto a known false positive.
  (The stale `contracts/(kernel|newsletter)/openapi.*.json` filter that used to
  be recorded here is fixed: the newsletter half matched nothing and is gone.)

### Carve residue that no runner touches

Two files describe subsystems that left with their modules. Neither is wired
into `make test` or any CI job, so neither has run since the carve and neither
can fail — which is why the naming sweep found them by grep rather than by a
red test. They are recorded rather than deleted because deleting test material
is the operator's call, not a sweep's.

- `gremion-ui/test/cutover-flip-flag.bats` is the only file under
  `gremion-ui/test/`. It is a six-case BATS suite for
  `gremion-ui/scripts/cutover-flip-flag.mjs`, which is **not in this tree** —
  the script left with the finance module, and the flag values every case flips
  (`--to stufis`) name the decommissioned StuFis backend. Its `DATABASE_URL`
  default points at a `stura` user and a `stura` database that this repo never
  creates (`.env.example` names `keycloak`, `gremion` and `control`), and its
  setup `skip`s on an unreachable DB, so a hand-run is a silent skip rather
  than an error. Its header now says all of this; the honest fix is to delete
  the file with its module.
- `test/fixtures/.env.test` carries `STUFIS_DB_*`, `STUFIS_APP_*` and
  `STUFIS_OIDC_*` values. `git grep STUFIS_` finds no reader anywhere in the
  tree, and no BATS helper sources the fixture, so these are dead keys in a
  dead fixture rather than a leak — the values are visibly synthetic
  (`testpassword_stufis_db_32chars`).

### Verify this section against the tree you ship

Every claim above is an inventory of the working tree, so it decays the moment
a sweep lands — and this section is the repository's own honesty artifact, which
makes a stale entry here worse than a stale entry anywhere else. Before tagging,
re-run the four checks it rests on and correct any that disagree:

```
git grep -n -F Civitas -- . ':!docs' ':!KNOWN_ISSUES.md'    # migrations only
git grep -n -F Civitas -- contracts/                        # must be EMPTY
git grep -n -F StuRaOS -- gremion-ui/src gremion-public/src # guard files only
git grep -n -F sturaos docker/keycloak/                     # realm/theme identity, T11
pnpm -C gremion-ui vitest run src/lib/brand.guard.test.ts src/lib/deploy-brand.guard.test.ts
pnpm -C gremion-public vitest run src/lib/test/kernel-instance-leak.test.ts
node scripts/kernel-hygiene-check.mjs   # h1 wire root, i1 retired hosts, i2 env-template hosts
```

The guard tests are the load-bearing ones: they are what turns this section
from a note into an enforced boundary. `brand.guard.test.ts` now fails on ANY
`StuRaOS` in `gremion-ui/src/**` non-test source — there is no exception set
left to add a file to.

### German-language defaults in a domain-neutral kernel

`gremion-public/src/routes/+layout.server.ts` defaults `institutionName` to
`Studierendenrat`, and several UI strings are German-only. The kernel targets
German councils first and this is honest for now, but it is a default a
non-German deployment has to override rather than a neutral one.

## Operator actions the repository cannot do for itself

These are not code defects; they are settings that have to be true for what
the repository says to be true.

- **GitHub private vulnerability reporting must be enabled** on this repository
  (*Settings -> Code security*). [`SECURITY.md`](./SECURITY.md) links the
  `security/advisories/new` form, and that link 404s for a researcher until the
  feature is switched on.
- **`security@gremion.de` must route and be read.** It is named in both
  `SECURITY.md` and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). An address
  that bounces is worse than none.
- **The narrowed `.gitleaks.toml` has been run, not just written.** Its broad
  path allowlists were replaced by value regexes, and gitleaks 8.30.1 was then
  run over the 0.1.0 tree twice — with this config and with the default rules —
  reporting zero findings both times. The `lint` job in `ci.yml` re-runs it on
  every push and pull request; a silent run is a passing run only because the
  config was proven against known fixtures first.
- **Repository settings that the flip sets and that must stay true:** secret
  scanning with push protection, branch protection on `main`,
  delete-branch-on-merge, Actions enabled with the cost governor, and the
  `@gremion` npm scope claimed by the operator before the first `v*` tag (see
  the header of `.github/workflows/release-npm.yml`).
## Design parity with product

The product vertical is the design source of truth and the kernel tracks it on a
lag; it is a private repository, so the deltas are recorded here rather than
linked. These are the known deltas after the design handover **v12**
(apex topology) port.

### Carried in v12

Ported as **mechanism only** — every instance-specific value is a prop/env with a
neutral default, and each new surface renders **nothing** when unconfigured. (The
`app.html` head and the members' CTA are the two places where an unconfigured
kernel's output does change; both are called out below.)

- **Portal base path.** `gremion-public/svelte.config.js` reads `kit.paths.base`
  from `BASE_PATH` (default `''` → portal at `/`), with a matching `ARG/ENV
  BASE_PATH` in its Dockerfile and a `PUBLIC_BASE_PATH` build arg in
  `docker-compose.yml`. Every internal link routes through `base` from
  `$app/paths`; `src/lib/test/base-path.test.ts` fails the build if a
  root-relative `href`/`action`/`src` reappears. The compose healthcheck follows
  the same variable — probing `/` under a base path 404s, which marks the
  container unhealthy and makes Traefik drop its routers.
- **Portal back-routes.** Apex strip in `PortalHeader.svelte`, colophon in
  `PortalFooter.svelte`, fed by `PUBLIC_APEX_URL` / `PUBLIC_APEX_LABEL` /
  `PUBLIC_APEX_NOTE` / `PUBLIC_APEX_COLOPHON`. All default to `null` and each
  surface is gated on **both** a target and a label: the kernel has no marketing
  site above it, and a dangling link is worse than no link. No product name,
  host or marketing copy is baked into the markup — the guard test asserts that.
- **Keycloak portal back-link.** `docker/keycloak/themes/sturaos/login/`
  `url-guard.ftl` (strict shared validator) + `portal-back.ftl`, included by all
  four templates. Driven by the `gremion.portal-url` realm attribute; absent or
  invalid emits nothing at all. Uses `?esc`, **never** `?html` — Keycloak 26 runs
  FreeMarker with HTML auto-escaping on and rejects legacy escapers at parse
  time, which turns every login render into an HTTP 500. See
  `docker/keycloak/README.md`.
- **Icon/`theme-color` plumbing** in both `app.html` files, pointing at
  `static/brand/{favicon-32,favicon-512,apple-touch-icon}.png`. This does change
  the rendered head: one dead `favicon.png` reference becomes three dead
  `brand/*.png` references plus a `theme-color`, until an operator supplies the
  files.

### Fixed in passing (they blocked the port)

- **`PUBLIC_*` were read from `$env/dynamic/private`.** SvelteKit's private
  dynamic env excludes every public-prefixed name, so
  `gremion-public/src/routes/+layout.server.ts` and the PDF redirect route silently
  saw `undefined` for `PUBLIC_CONTACT_NAME`, `PUBLIC_LEGISLATURE_LABEL`,
  `PUBLIC_MAIN_APP_URL` — the portal always rendered defaults and the PDF route
  always 500'd with "Main app URL not configured". Both now read
  `$env/dynamic/public`, matching their siblings and the product's QA-v11 F2 fix.
  Without this the v12 apex props would have been unreachable dead code.
- **The members' CTA no longer degrades to `href="#"`.** It renders only when
  `PUBLIC_MAIN_APP_URL` is set — same "no dangling links" rule as the apex strip.
  Note the visible consequence: a deployment that never set the variable used to
  show a dead button and now shows none.

### Deliberately NOT carried

- **The v12 icon files themselves.** The handover's icon family is built around
  the StuRaOS "S" mark. An unbranded kernel must not put one instance's glyph in
  every self-hoster's browser tab, so `static/brand/` ships the drop-in contract
  (see its `README.md`) and no images. Until an operator supplies them the three
  `<link>` elements 404 — as the single `favicon.png` reference they replaced
  already did, since neither app has ever had a `static/` directory.
- **`demo-hint.ftl`** (`gremion.demo-url`) — a demo affordance is an instance
  decision, not kernel behaviour.
- **The app-side half of the apex topology** — the product moved its
  authenticated home off bare `/` to `/dashboard` and gave `gremion-ui` its own
  `kit.paths.base`. Both are instance topology: the kernel's app boots standalone
  at `/`. Taking them later means a `base`-sweep across all of `gremion-ui/src`
  (and the app surfaces held in `gremion-modules`), not a config change.
- **The portal's clay `theme-color` (`#f4ede2`).** The kernel's portal `--paper`
  is still `#fafaf7`; `theme-color` is set from this tree's own token so the two
  cannot disagree.

### Still open

- **The portal brand mark is a hardcoded literal `S`.** `PortalHeader.svelte` and
  `PortalFooter.svelte` render `S` in the brand tile regardless of
  `institutionName`. Same class of leak as the favicon, but it is a visual-design
  change (Design-owned), so it is recorded here rather than fixed in passing.
- **No button-contract test.** The product ships a `button-contract.test.ts`
  pinning the healed button variants; the kernel carries the healed
  `button.svelte` and no test guarding it against regression.

`PUBLIC_PRODUCT_NAME` no longer defaults to a product name — it resolves to
`null` and the portal renders the product chip only when it is set. That entry
is closed.

Carried over from the v10 Part D interim-parity pass and **explicitly deferred by
Design** — do not close these as part of a design port:

- **No instance engine — graphite is hardcoded, not derived.** `gremion-ui/src/app.css`
  carries the module/component CSS (`.pill`, `.btn`, `.deck-*`, `.wiz-*`, finance and
  settings surfaces), but it has NO per-instance OKLCH engine: there is no `--i-h`/`--i-c`
  ramp, no `--on-accent`, and no `--punkt` instance-dot. The graphite default (hue 265,
  chroma factor 0.14) is written straight onto the static `--accent*` tokens rather than
  derived — the product generates the same values from its engine, and until Part D the
  kernel default was a static navy (hue 252). This whole generation gap is closed by the
  planned `@gremion/tokens` package, which does not exist yet. The Keycloak side of the same gap
  is `login/instance-accent.ftl` (`gremion.i-h` / `gremion.i-c`), which the product
  has and the kernel does not — v12's `url-guard.ftl` establishes the
  realm-attribute pattern in the kernel, and instance-accent should adopt it when
  the engine lands.
- **Port the button-contract test alongside `@gremion/tokens`.** The product
  version pins the healed variants (neutral ink-on-paper primary; `--on-rust` /
  `--rust-hover` destructive); see the entry under **Still open** above.

## Governance invariants

- **Audit-chain tail truncation.** The INV-1 hash chain detects mid-chain edits, but
  a self-contained chain cannot detect truncation of the tail. An external-anchor
  follow-up is deferred to a later phase. See [`docs/about-gremion.md`](./docs/about-gremion.md)
  (Governance charter & invariants).
