# Finance: StuFiS integration and native finance as two options for one slot

**Date:** 2026-11-26
**Status:** Draft for operator approval
**Scope:** modules/finance (native), a new StuFiS integration, the module catalogue, the control panel, the host

## 1. Intent and why

A student council needs one finance tool inside Gremion. The pilot council today pays for a
hosted StuFiS instance from its vendor (OpenAdministration). That instance is linked to the
council's bank account, its finance deputy at the university has access and helps keep it up to
date, and the StuFiS **software** carries the state approval the council relies on. The council
will keep that instance until Gremion's finance is approved and better.

So Gremion offers finance in two ways:

- **StuFiS inside Gremion.** The interface the council already knows, running in Gremion's
  navigation the way the office editor does, signed in through the customer's own login. This is
  the shorter path to a complete governance product, because the software is already approved.
- **Native finance.** Gremion's own finance (budgets, expenses, multi-signature approvals, bank
  import, SEPA, cash box, statements). Likely better in the long run; it still needs approval.

A customer has exactly one of them at a time. A council may swap once or twice to see what the
other offers. On the test environment a quick swap helps test both; it is a convenience, not a
key feature.

## 2. Goals, non-goals, anti-goals

Goals
- One finance slot per customer, two interchangeable options: `stufis` and `native`.
- StuFiS runs from current upstream StuFiS (OpenAdministration/StuFis, v4.4.7 at the time of
  writing, AGPL-3.0), without the paid Flux Pro components, inside Gremion's frame, one instance
  per customer, signed in through that customer's Keycloak realm.
- Native finance reaches feature parity with what the old single-customer fork already shipped
  (its pages exist there and are carried over), isolated per customer.
- A swap between the two in the control panel; each option keeps its own data.
- Every interaction of both options is testable on the test environment.

Non-goals
- Replacing or migrating the council's vendor-hosted StuFiS instance, its bank link or its data.
- Moving data between StuFiS and native finance.
- A StuFiS REST API or Gremion screens driving StuFiS (upstream has no API; see section 4).

Anti-goals (a failure even if it works)
- A StuFiS build that is no longer recognisably the approved software (section 7, open question 1).
- Any path where one customer's finance data, receipts or bank credentials are reachable from another.
- A swap that silently loses or mixes data.

## 3. Constraints and facts (read 2026-11-26)

- **Upstream StuFiS:** Laravel 12, PHP 8.4, MariaDB/MySQL, AGPL-3.0. Sign-in via an OAuth2 identity
  provider (jumbojett/openid-connect-php), which Keycloak serves. `routes/api.php` is empty: there
  is no API. No official container image. Since v4.2 it depends on `livewire/flux` (free tier) and
  `livewire/flux-pro` (paid licence, private composer repository); Flux tags appear in about 38 of
  its 89 view files. Upstream is active (last push 2026-11-09). OpenAdministration also has a
  multi-instance management tool (StufisManager), last touched 2025-03.
- **Old fork history:** the StuRaOS fork first drove a StuFiS copy through an API the team added to
  their own copy (ADR 2026-03-27 finance-ui, now superseded); finance was then rebuilt natively and
  the StuFiS copy removed (scripts/finalize-stufis-decommission.sh).
- **Native finance in the kernel:** modules/finance holds the leaf service only (src/, migrations,
  one database per customer `finance_<slug>`); no app half, no manifest, no compose service, and it
  is listed in modules/disabled.json. The pages and API routes live in the fork under
  gremion-ui/src/routes/finance and routes/api/finance, with the server code in
  gremion-ui/src/lib/server/finance (including a backend seam).
- **Embedding precedent:** the office editor (Collabora) runs inside Gremion pages through a per-host
  `/office` edge router (packages/edge-routers/src/render.ts); framing is allowed per customer host.
- **Secondary hosts:** a module is refused on a secondary customer host unless it is in the
  opt-in set (infra/host/lib/common.sh). Both finance options must join that mechanism.

## 4. Approaches considered

1. **Gremion screens over a StuFiS API** (the fork's first design). Rejected: upstream has no API;
   it would mean maintaining a StuFiS fork with an API of our own, and the council would lose the
   interface it knows.
2. **StuFiS as-is with its own login, linked from Gremion.** Rejected: needs the paid Flux Pro
   licence per build, a second login, and it does not run inside Gremion's navigation.
3. **Our StuFiS build without Flux Pro, framed inside Gremion, one instance per customer, signed
   in through the customer's realm** (chosen by the operator). Keeps the interface the council
   knows, one login, stays close to upstream.

For native finance there is one sensible way: carry the fork's pages into `modules/finance/app`
on the kernel's module pattern, behind the existing leaf.

## 5. Design

### 5.1 The finance slot

- The catalogue gets one slot, `finance`, with an option `stufis` or `native` recorded per
  customer. Enabling the slot requires choosing an option; a customer never has both on.
- **Swap** (`finance` option change) is a control-panel action: disable the current option
  (its data stays where it is, untouched, nothing exported or deleted), enable the other one.
  Swapping back finds the earlier data as it was. The panel says this plainly before it acts.
- Each option has its own DPIA decision and its own isolation evidence row, like any module.

### 5.2 StuFiS inside Gremion

- **Build:** a container image built by us from a pinned upstream StuFiS tag, with a small patch
  set that replaces every `flux-pro` component with generic components (the free Flux tier where
  it suffices, plain Blade/Tailwind where not), and drops the private composer repository. The
  patch set is kept minimal and reviewable, and rebased on each upstream release we adopt.
  We offer the generic-component change upstream (section 7, open question 1).
- **Per customer:** one StuFiS container and one MariaDB database (or one MariaDB server with one
  database and one user per customer; builder's call, with isolation tested), its own `APP_KEY`,
  its own storage volume for receipts.
- **Sign-in:** StuFiS's OAuth2 login points at the customer's Keycloak realm with its own client.
  Gremion groups and roles map to StuFiS rights (who submits applications, who approves and signs,
  the treasurer, read access for an external finance deputy). The university's finance deputy is an
  external user in the customer's realm.
- **Inside Gremion:** a `/finance` entry in Gremion's navigation frames StuFiS, served on the
  customer's own host under a path router like `/office` (framing allowed only from that customer's
  own origin). Session cookies and CSP are set for framing on that one host.
- **Bank access (FinTS):** StuFiS needs a registration number from the Deutsche Kreditwirtschaft
  for FinTS; until one is available, bank import is CSV only on our instances.

### 5.3 Native finance

- `modules/finance/app` gets the fork's pages, API routes and server code, adapted to the kernel's
  module pattern (manifest, routes, nav entry, module gate), talking to the existing leaf.
- The leaf runs as a compose service per install with one database per customer (already its
  design); receipts per customer.
- Remove `finance` from modules/disabled.json once its isolation case passes.

### 5.4 Host and panel

- Both options join the module catalogue, module profiles and the secondary-host opt-in set.
- The control panel shows the slot with its two options and the swap action, and states which
  option holds data.

## 6. Testing (against the running system)

- Two customers, each with a different option: neither can reach the other's finance pages,
  database, receipts or bank settings (by URL, by id, by token).
- StuFiS: sign-in through each realm lands in that customer's StuFiS only; a role change in Gremion
  changes the StuFiS right on next login; framing works from the customer's host and is refused
  from any other origin; no Flux Pro asset or licence check is present in the image.
- Native: the fork's finance journeys (budget plan, expense with receipt, multi-signature approval,
  payment order, bank CSV import, SEPA export, year-end close) pass on the test environment.
- Swap: data written under option A is intact after A -> B -> A; B starts empty.

## 7. Open questions only the operator can answer

1. **Approval and a modified build.** The approval belongs to "the StuFiS software". Does a build
   with replaced interface components still count as that software? Ask the finance deputy or the
   approving office. If the answer is uncertain, the safe path is upstreaming the generic-component
   change so our build is plain upstream StuFiS.
2. **Licence check.** Is OpenAdministration fine with a Flux-Pro-free build being run by a third
   party for councils (AGPL permits it; the relationship matters)? Would they take the change upstream?
3. **FinTS registration:** apply for a registration number, or stay CSV-only for now?

## 8. Left to the builder

The exact replacement components, database layout for MariaDB per customer, the role-to-right
mapping table, the router and cookie details for framing, and the order of carrying the fork's pages.
