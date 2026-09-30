# Vendor mail server: licence position (TASK-015)

> **Dated statement, 2026-09-28.** Records what the distribution runs as the
> vendor's own mail server and why that is *not* a modification in the sense of
> AGPL-3.0 section 13. Nothing here is legal advice; it records what was read
> and what the repository enforces. The register row is in
> [licence-register.md](licence-register.md), section 2 (TASK-005 procedure,
> section 4).

## 1. What runs

| Item | Value |
|---|---|
| Software | Stalwart mail server, Community Edition image line `v0.15-alpine`, version `0.15.5` |
| Image (the one reference the host pulls) | `docker.io/stalwartlabs/stalwart@sha256:0620ceba9165c104789d5cacb0aa209e7f16295f54edead631b1925b1ccc1ccf` (`STALWART_IMAGE`, `infra/host/templates/env/mail.env.tmpl`) |
| Source commit | `9aecfc1dfd53a87c8918a6a98123c50af2001998`, read from the image's own `org.opencontainers.image.revision` label; `crates/main/Cargo.toml` at that commit declares version `0.15.5` |
| Licence as declared | `AGPL-3.0-only OR LicenseRef-SEL` (`crates/main/Cargo.toml`); `LICENSES/AGPL-3.0-only.txt` and `LICENSES/LicenseRef-SEL.txt` (SELv1, last updated April 29, 2025) |
| Licence the distribution uses | `AGPL-3.0-only`. The distribution holds no Stalwart Enterprise (SEL) licence and configures no enterprise licence key |
| licensed_edition | `unmodified` |

## 2. Is it "modified"? (AGPL-3.0 section 13)

**No.** The distribution runs the upstream image, byte for byte, pinned by
digest. It builds no Stalwart image, patches no Stalwart source and adds no
code to the container. What it supplies is **configuration**: a rendered
`config.toml` (from `infra/host/mail/config.toml.tmpl`), a Sieve script
executed by the server's own interpreter (`infra/host/mail/from-align.sieve`),
DKIM keys and a certificate, all mounted read-only, and principals created
through the server's management API. Section 13's obligation to offer the
Corresponding Source attaches to a *modified* version of the Program; an
unmodified program configured through its documented interfaces is not one.
The distribution therefore makes **no section 13 offer** for Stalwart, and the
upstream source at the commit above is the Corresponding Source of what runs.

## 3. What keeps this true

`ops/vendor-mail/check-upstream-image.mjs` (a required `verify` suite, TRD-253)
fails the build when:

- `STALWART_IMAGE` is not `docker.io/stalwartlabs/stalwart@sha256:<64 hex>`
  (another repository, a tag, a local build);
- the mail compose file (`infra/host/mail/docker-compose.yml`) carries a
  `build:` or any image other than `${STALWART_IMAGE:?...}`;
- the digest in `STALWART_IMAGE` is not the digest this statement and the
  register row name -- an image bump without a re-read of the licence;
- any other tracked file references a Stalwart image other than by that
  digest, except two named exclusions (the TASK-040 proof's v0.16.21 tag and
  the pooled-stack render fixture), each of which fails the check the moment
  it goes stale.

Moving to a built or patched image, or to the v0.16 line, is its own unit
(Q7, Q8): it re-reads the licence, re-decides the section 13 question, and
updates this file and the register in the same change.

## 4. Open points, stated

- Whether the official image's binary is built with Stalwart's
  SEL-licensed enterprise sources compiled in (disabled without a licence
  key) was not read from the upstream build definition; the distribution uses
  no enterprise feature either way.
- The tag `v0.15.5` could not be resolved to its commit from this session
  (the upstream API was out of scope); the commit is the image's revision
  label, and `crates/main/Cargo.toml` at the tag and at that commit hash to
  the same SHA-256.
