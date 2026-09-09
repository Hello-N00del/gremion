# Security Policy

Gremion is a governance kernel. A defect here reaches every downstream
deployment that pins this repository, so we would rather hear about a
borderline issue than not hear about a real one.

## Supported versions

This is 0.1.0 and no stable release line has been cut. Security fixes land on
`main`; consumers track it by pinning a SHA. There is no backport channel for
older SHAs — update the pin.

The published npm packages `@gremion/db` and `@gremion/ports` follow the same
rule: fixes go out as a new version, not as a patch to an old one.

## Reporting a vulnerability

Two private channels, either is fine:

- **GitHub private vulnerability reporting** — this repository's
  [Security → Report a vulnerability](https://github.com/Hello-N00del/gremion/security/advisories/new)
  tab. Preferred: it keeps the report, the discussion and the eventual advisory
  in one place.
- **security@gremion.de** — if you would rather not use GitHub, or the report
  concerns the hosted service rather than this code.

Please do **not** open a public issue for a suspected vulnerability.

We do not promise a fixed response time: this is a small project and an SLA we
cannot keep is worse than none. We will confirm receipt as soon as we have
triaged, and we will tell you if a report turns out to be out of scope rather
than leaving you without an answer.

## What to include

- The affected component (`gremion-ui`, `gremion-public`, `k8s/`, `docker/`,
  `scripts/`, a migration) and the commit SHA you tested.
- Reproduction steps, and whether you reproduced against a **running system**
  or only by reading the source.
- Impact: what an attacker gains, and what preconditions they need
  (authenticated? which realm role or group? edge-reachable or internal-only?).

## Areas we care about most

These are the kernel's load-bearing security seams; a finding in any of them is
high priority:

- **Tenant selection.** `gremion-ui/src/lib/server/tenant/resolve.ts` trusts the
  edge-injected `x-forwarded-host` only, gated by a constant-time proxy-trust
  secret. Anything that lets a client influence tenant selection is critical.
- **AuthN/AuthZ.** `hooks.server.ts`, `PAGE_ACCESS`, capability composition, and
  the token `iss`-match assertion made before any data-plane query.
- **Multi-tenant data isolation.** Any query path that can read or write across
  a tenant boundary.
- **Secret handling.** The realm-export envsubst sentinels, backup encryption
  keys, and anything that could write a secret into a log or an image layer.

## Scope

In scope: this repository. Out of scope: third-party services we merely
configure (report those upstream), findings that require an already-compromised
host or physical access, and missing hardening headers with no demonstrated
impact.

## Disclosure

We will work with you on a coordinated disclosure timeline and will credit you
unless you ask us not to. Please give us a reasonable window to ship a fix
before publishing.
