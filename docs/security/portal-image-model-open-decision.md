# Portal image model — OPEN product decision (audit finding #459-4)

> ## STATUS: **OPEN** — #459-4 is **NOT FIXED**
>
> Audit finding **#459-4** (`audit:security — injection/img-src-external`,
> "off-allowlist `<img src>` in the public portal / tracking pixels") remains **OPEN**. No code in
> this repository closes it. The write-side sanitiser still stores an absolute `http(s)` `<img src>`
> verbatim, and both application CSPs still grant a bare `https:` — see facts 3 and 4. Nothing below
> should be read as a mitigation; this document exists so the finding stays visible until an
> operator picks one of the three options.

Two review rounds established that this is not a patch-sized problem: what a portal `<img>` is
*allowed* to be is a product decision nobody has made, and every code-level allowlist proposed so far
encoded a different unstated answer to it. The allowlist work was therefore reverted to base
`6e709379` (see "What was reverted" below) and the decision is recorded here for the operator.

This document states the five facts the decision rests on, every place `img-src` is enforced today,
the three options, and what each costs — including in **email**, which shares the same sanitiser and
is the constraint that most cleanly separates the options. It deliberately does **not** recommend
one: the choice is about what editors may publish, not about which regex to use.

All file:line anchors below were verified against `a88f00c9` (`revert(security): trim the portal img
allowlist to base`), the commit this document ships on.

## Kernel port (TASK-206-A): anchors re-measured on the kernel base

This record is ported from the product source (tag `extraction-source-f2`,
`d0c656d0`; written on `a88f00c9`). The finding is **OPEN in the kernel too**:
no kernel change closes it, and the kernel port adds no `img-src` edit. The
body below is the source record unchanged; its file:line anchors refer to the
source tree. Re-measured on the kernel base (`merge/r28-train5`, `d3f8ad62`):

| Source anchor | Kernel |
|---|---|
| `gremion-public/src/hooks.server.ts:34` `img-src 'self' data: blob: https:` | `gremion-public/src/hooks.server.ts:36`, same value |
| `gremion-ui/svelte.config.js:69` (`kit.csp` img-src) | absent: the kernel `svelte.config.js` sets no `kit.csp` |
| `gremion-ui/src/hooks.server.ts:577`-`581` `NON_PAGE_CSP_HEADER_VALUE`, applied `:625` | `gremion-ui/src/hooks.server.ts:595` `CSP_HEADER_VALUE`, `img-src 'self' data: blob: https:` at `:599`, applied at `:628` |
| `docker/traefik/dynamic/dev-csp.yaml:71` | `docker/traefik/dynamic/dev-csp.yaml:57`, same value; attached by `keycloak-dev` only (`docker-compose.override.yml:87`) |
| `gremion-ui/src/lib/server/security/html-sanitize.ts:24`, `:35`, `:36`, `:38`-`:39`, `:55` | same lines in the kernel |
| `gremion-ui/src/lib/server/documents/collabora-convert.ts:10`, `:14`, `:16` | same lines in the kernel |
| `gremion-public/src/lib/sanitize.ts:12` | same line; the file is byte-equal to the source |
| `gremion-public/src/routes/protokolle/[id]/+page.server.ts:21` | same line |
| `gremion-public/src/routes/aktuelles/[slug]/+page.server.ts:14`, `/aktuelles`, `/beschluesse`, `/termine` | absent: the kernel portal serves `/`, `/kontakt`, `/protokolle`, `/protokolle/[id]`, `/api/public/protocols/[id]/pdf`, `/healthz` |
| `gremion-ui/src/lib/server/content/channels/email-renderer.ts` | absent from the kernel (content module); the email constraint applies wherever that module runs |

Fact 1 holds in the kernel: its portal serves no image and no `.svelte`
template of it renders an `<img>`.

The guards the kernel keeps are the NON-image ones: `gremion-public/src/hooks.server.test.ts`
(settled CSP directives and header attachment; `img-src` deliberately
unasserted) and `gremion-public/src/lib/sanitize.test.ts` (active content
removed; no image case). Owner of the decision: the operator (ledger item,
TASK-011 or an operator item).

---

## The five facts

### 1. The public portal serves no image at all

The complete route surface of `gremion-public/src/routes` is:

| Route | File |
|---|---|
| `/` (incl. the `antrag` form action) | `+page.server.ts`, `+page.svelte` |
| — (root layout) | `+layout.server.ts`, `+layout.svelte` |
| `/aktuelles` | `aktuelles/+page.server.ts`, `+page.svelte` |
| `/aktuelles/[slug]` **({@html} render site)** | `aktuelles/[slug]/+page.server.ts`, `+page.svelte` |
| `/beschluesse` | `beschluesse/+page.server.ts`, `+page.svelte` |
| `/kontakt` | `kontakt/+page.server.ts`, `+page.svelte` |
| `/protokolle` | `protokolle/+page.server.ts`, `+page.svelte` |
| `/protokolle/[id]` **({@html} render site)** | `protokolle/[id]/+page.server.ts`, `+page.svelte` |
| `/termine` | `termine/+page.server.ts`, `+page.svelte` |
| `/termine/kalender.ics` | `termine/kalender.ics/+server.ts` |
| `/api/public/protocols/[id]/pdf` | `api/public/protocols/[id]/pdf/+server.ts` |

That is the whole list. There is no media route, no upload route, no image-serving endpoint, and no
`<img>` element in any of the portal's own `.svelte` templates.

Consequence: a **relative** `<img src>` inside stored `body_html` cannot resolve to anything on the
portal — it 404s and renders as a broken image. An allowlist rule that "keeps same-origin relative
srcs" is pinning a shape that currently has no way to work.

### 2. The one producer of relative figure srcs never persists the figures

`convertOdtToHtml()` (`gremion-ui/src/lib/server/documents/collabora-convert.ts:10`) POSTs the `.odt`
to Collabora `/cool/convert-to/html` (`:14`). The LibreOffice HTML filter emits figures as *sibling
files* next to the HTML (`doc_html_<hash>.png`) and references them document-relatively. Only the
returned HTML **string** is kept (`:16` returns `res.text()`); the sibling binaries are never written
to storage and never served.

Consequence: the "Collabora legitimately emits relative image srcs" argument is true about the
markup and false about the images. Keeping those srcs preserves a reference to a file that does not
exist anywhere in the deployment.

### 3. The only fetchable shape — an absolute `http(s)` src — is stored verbatim today

The write-side sanitiser `sanitizeRichHtml()`
(`gremion-ui/src/lib/server/security/html-sanitize.ts:55`) allows `src` in `ALLOWED_ATTR` (`:24`) and
filters **only** `data:` / `javascript:` / `vbscript:` (`FORBIDDEN_URI_SCHEMES`, `:36`, matched
against the `href` / `src` / `xlink:href` set at `:35` inside the `uponSanitizeAttribute` hook,
`:38`–`:39`). An `https://tracker.example/p.gif` therefore survives every write path that funnels
through it — `lib/server/content/content-db.ts`, `lib/server/news/news-db.ts`,
`lib/server/news/portal-callback.ts`, `routes/api/content/posts/[id]/+server.ts`,
`routes/api/news/[id]/+server.ts`, `routes/api/protocols/[id]/publish/+server.ts`,
`routes/api/newsletter/[id]/preview/+server.ts`, plus the portal and email channel renderers
(`lib/server/content/channels/portal-renderer.ts`, `.../email-renderer.ts`) — and is then rendered to
**anonymous** portal readers.

Consequence: this is the actual finding. IP + User-Agent + Referer of every public reader leak to
whatever host an editor pasted, on pages with no consent surface. **It is still open.**

### 4. `data:` and `blob:` are unreachable, but every CSP still grants them

`data:` is dropped from `src` on every write path by the hook in fact 3. Nothing in either
application mints a `blob:` URL. Yet **all four** `img-src` enforcement points still grant both, plus
the bare `https:` that admits the one shape the pipeline *can* produce:

| # | Enforcement point | Directive | Applies to |
|---|---|---|---|
| 1 | `gremion-public/src/hooks.server.ts:34` | `img-src 'self' data: blob: https:` | every portal `text/html` response |
| 2 | `gremion-ui/svelte.config.js:69` (`kit.csp`) | `'img-src': ['self','data:','blob:','https:']` | every SvelteKit-rendered `gremion-ui` page (nonce mode) |
| 3 | `gremion-ui/src/hooks.server.ts:577`–`581` (`NON_PAGE_CSP_HEADER_VALUE`) | `img-src 'self' data: blob: https:` | non-page `text/html` — the proxied Element Call SPA (applied at `:625`) |
| 4 | `docker/traefik/dynamic/dev-csp.yaml:71` — **edge middleware** | `img-src 'self' data: blob: https:` | any router that attaches `dev-csp@file`; today only `keycloak-dev` in `docker-compose.override.yml:378` |

Enforcement point 4 is an **edge** override, not an app header: Traefik `customResponseHeaders`
*overwrites* the upstream `Content-Security-Policy`, so wherever it is attached it replaces — not
tightens — whatever the app sent. It is dev-only by attachment, not by loading: the file provider is
a directory, so the middleware is parsed in production too and is inert only because no production
router references it (guarded by `gremion-ui/tests/unit/traefik-dev-csp.test.ts`). Whichever option
is chosen, all four points must move together, or the tightest app header can be undone at the edge.

There is also a fifth, **editor-side** point that is not a CSP and already implements Option A for
one surface: `gremion-ui/src/lib/components/news/RichTextComposer.svelte` mirrors the server
allowlist client-side (`:9`–`:16`) and its `ALLOWED_TAGS` (`:10`) contains **no `img`** and its
`ALLOWED_ATTR` (`:14`) is `['href','title']` — no `src` at all. Everything the news composer
produces is already image-free (`sanitizeComposerHtml`, `:21`, called from `:60`). Images can only
enter `body_html` through the Collabora protocol path or a direct API write, never through this
editor. Option A therefore costs the news surface nothing; the other two options require widening
this component as well, which is the piece most easily forgotten.

Consequence: the CSP is not currently a second layer for this finding in any of the four places.

### 5. On the portal the origin is pinned to the apex, and the render call sites pass none

`docker-compose.yml:747` pins `ORIGIN: https://${DOMAIN}` for the `gremion-public` service
(`:718`), while the `gremion-ui` service (`:424`) deliberately leaves `ORIGIN` unset
(`docker-compose.yml:463`–`473`) so adapter-node derives it per inbound `Host` — the deployment is
multi-tenant, every tenant is served on its own host. On top of that, both portal render sites call
the sanitiser with no origin argument:
`gremion-public/src/routes/aktuelles/[slug]/+page.server.ts:14` and
`gremion-public/src/routes/protokolle/[id]/+page.server.ts:21`. `sanitizeHtml`
(`gremion-public/src/lib/sanitize.ts:12`) takes no origin parameter at all.

Consequence: any rule that decides by comparing a resolved URL's **origin** has, on the portal,
either no origin at all or the apex — never the tenant host the reader is actually on. An absolute
src on a legitimate tenant host would be stripped. Fixing that is plumbing work, not a one-liner,
and it must be settled before an origin-based rule can be correct.

---

## The three options

Each option is costed twice: on the **portal** (the surface the finding is about) and in **email**,
because the newsletter/content email channel re-runs the *same* `sanitizeRichHtml` over the *same*
`body_html` (`gremion-ui/src/lib/server/content/channels/email-renderer.ts:34`, `:44`, `:72`). Email
is the harder constraint, and it is where the three options stop being interchangeable:

- an email client has **no document base URL**, so a relative or document-relative `src` cannot
  resolve — it is a guaranteed broken image in every client;
- an email client has **no notion of "our origin"**, so "same-origin only" is not expressible in an
  email at all: an own-host image is fetched by the recipient's client as an ordinary third-party
  remote resource, and is blocked by default in most clients until the reader clicks "load images";
- the only shape an email client can render is an **absolute `https:` URL on a publicly reachable
  host**.

### Option A — no images in portal-rendered content

Strip the `<img>` element on the write side and on the portal render side; set `img-src 'self'` at
all four enforcement points in fact 4.

- **Closes** #459-4 outright, and matches what the portal can serve today (facts 1 and 2).
- Costs on the portal: authored images vanish silently unless an editor-facing message is added;
  existing rows change meaning the next time they are republished; forecloses images until the
  decision is reopened.
- **Email consequence:** coherent but total — newsletters become text-only for everyone. Nothing
  half-renders and no reader is tracked, but "add a picture to the newsletter" stops being possible
  until the decision is reopened. Note the news composer is already here (fact 4, fifth point).

### Option B — own-origin images only, with the missing media pipeline built

Persist Collabora figures and editor uploads to storage (MinIO already runs in the stack,
`docker-compose.yml:1011`), add a tenant-scoped serving route to `gremion-public`, keep relative and
own-origin absolute srcs, strip everything else.

- **The only option that keeps images on the portal without leaking readers.**
- Costs on the portal: genuine feature work — storage layout, a serving route, per-tenant origin
  plumbing into the sanitiser (fact 5), a backfill/migration decision for bodies already stored, and
  a cache/authorisation story for protocol figures that may predate publication.
- **Email consequence: this is the option email cannot express.** A relative src (the shape this
  option is built to preserve) has no base in a mail client and always breaks. Making it work in
  email means rewriting every own-origin src to an absolute, publicly-fetchable, unauthenticated URL
  at send time — at which point the recipient's client fetches it from the tenant host exactly as it
  would fetch any external host, and the emailed image is Option C's shape with a one-entry
  allowlist. So Option B is either "portal keeps images, email does not", or Option B **plus** an
  Option-C-shaped absolute-URL rewrite built on top of it.

### Option C — curated external host allowlist

Keep absolute srcs, but only for an operator-configured host list; strip the rest.

- **Cheapest to widen later**; preserves whatever editors already pasted from approved hosts.
- Costs on the portal: a per-tenant config surface, an admin UI and an operator process to run it —
  and the privacy posture stays the weakest of the three: reader IP / User-Agent / Referer still
  leave the deployment for every allowlisted host, on anonymous public pages, with no consent
  surface.
- **Email consequence: C is the only shape that is coherent in email.** An absolute `https:` URL on
  a named, publicly reachable host is exactly and only what a mail client can render, so a curated
  allowlist is the one option under which the same stored `body_html` renders the same way on the
  portal and in the inbox with no send-time rewriting. The privacy cost carries over unchanged and
  is arguably worse there: remote-image loading in email is the classic read-receipt/open-tracking
  channel, and the allowlisted host learns when each recipient opened the mail.

**Reading of the three:** the option that is best for portal privacy (A) and the option that is best
for email fidelity (C) are opposite ends; B buys portal images at the price of needing C's mechanism
bolted on for email. That trade — not the sanitiser's implementation — is what needs deciding.

---

## What was reverted, and what stayed

Reverted to base `6e709379` (no behaviour change vs. that commit) — verified empty by
`git diff 6e709379 -- gremion-public/src/lib/sanitize.ts gremion-public/src/hooks.server.ts gremion-ui/src/lib/server/security/html-sanitize.ts`:

- `gremion-public/src/lib/sanitize.ts`
- `gremion-public/src/hooks.server.ts`
- `gremion-ui/src/lib/server/security/html-sanitize.ts` (+ its test file)

`gremion-public/src/lib/sanitize.test.ts` and `gremion-public/src/hooks.server.test.ts` were removed
with the image batch and have since been **restored with their image cases removed**. They now pin
only the settled contracts — script / `on*` / `javascript:` stripping, external `<a href>` kept,
security headers attached to `text/html` and withheld from JSON and PDF responses — and both files
carry a scope note pointing back here. Nothing in either file asserts an `img-src` value or an
`<img src>` outcome, so restoring them does not pre-empt this decision.

Kept, with their guards, from the same batch:

- `#459-2` per-tenant rate-limit bucket eviction (`gremion-ui/src/lib/server/tenant/rate-limit.ts`,
  called from `registry.ts`)
- `#458-2` safe error logging in `gremion-ui/src/routes/protocols/+page.server.ts` (name/message/code,
  never the raw postgres.js error with its bound parameters)
- `leafJson` fresh-controller retry in
  `gremion-ui/src/lib/server/messages/backend/service-client.ts`
- `#434-6` SMTP auth-gate coverage, `gremion-public/src/lib/server/mail.test.ts`

## Related residual (also open, not addressed here)

The `img-src` value is identical at all four enforcement points in fact 4. Whichever option is
chosen, all four have to move together — the two application headers, the SvelteKit `kit.csp` page
policy, and the Traefik edge middleware that overwrites whatever the app sent — and the
`RichTextComposer` allowlist has to be widened for options B and C.
