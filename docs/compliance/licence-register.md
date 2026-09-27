# Third-party licence register

> **Status: standing register (TASK-005).** Last read: **2026-09-25**.
> Every licence below was read directly from the project's own licence file at the
> commit linked in the table, not from a package index, a badge or a README summary.
> Nothing here is legal advice; it records what each project's licence file says.

## 1. The rule

1. **No sales artefact, offer, website text, demo script or the trust document**
   (the public statement of what the record proves and does not) **states a licence for
   any system in section 2 that differs from the "SPDX expression" column below.**
   Where copy needs a licence name, it uses that column or the "Plain wording" column
   verbatim.
2. **A system not in this register gets no licence claim at all** until a row is added
   by the procedure in section 4.
3. **The register is re-read at every version bump** of a listed system, and the row's
   commit, date and file hash are updated in the same change as the bump. A bump that
   changes a licence file changes this register before any copy is touched.
4. A licence file that offers **an alternative commercial licence** is recorded as such;
   copy never implies that the platform holds or needs that commercial licence.

## 2. Register

"Version read" is the release the licence file was read at. "Deployed as" says how that
release relates to what the distribution actually runs; where they are not the same
commit, the gap is stated rather than hidden.

| System | Upstream repository | Version read | Deployed as (2026-09-25) | Commit read (linked) | Licence file | What the file states | SPDX expression | Plain wording for copy |
|---|---|---|---|---|---|---|---|---|
| Nextcloud (server) | nextcloud/server | tag `v33.0.9` | the upstream Nextcloud 33 image line, extended by the distribution; the 33.x patch level floats with that line | [`4d7d05e`](https://github.com/nextcloud/server/blob/4d7d05e778398cdce1428b20d8687386edbc8268/COPYING) | `COPYING` (full AGPL v3 text) + `COPYING-README` | GNU Affero General Public License v3; `COPYING-README` carries `SPDX-License-Identifier: AGPL-3.0-or-later` and says "or any later version of the AGPL, unless otherwise noted". The root `LICENSES/` directory holds per-file REUSE texts for bundled components; it is not the project licence | `AGPL-3.0-or-later` | "GNU AGPL v3 or later" |
| Collabora Online | CollaboraOnline/online | tag `cp-24.04.10-1` | the Collabora Online Development Edition (CODE) image, release 24.04.10.1.1; the source repository does not tag CODE 24.04 builds, so the tag was matched by version number | [`3799c09`](https://github.com/CollaboraOnline/online/blob/3799c094dabf7528da564b50db3e91df9007e35f/COPYING) | `COPYING` | "subject to the terms of the Mozilla Public License, v. 2.0" | `MPL-2.0` | "Mozilla Public License 2.0" |
| Matrix homeserver (Synapse) | element-hq/synapse | tag `v1.124.0` | the upstream Synapse image, release v1.124.0, which the messages module's image build pins (the pin lives in the module repository, not in this one) | [`c1b7c6b`](https://github.com/element-hq/synapse/blob/c1b7c6b12e7b9b2cf586a3210145f70a5e30ed67/LICENSE) | `LICENSE` (full AGPL v3 text) | GNU Affero General Public License v3; the same commit's `pyproject.toml` declares `license = "AGPL-3.0-or-later"` | `AGPL-3.0-or-later` | "GNU AGPL v3 or later" |
| LiveKit (server) | livekit/livekit | tag `v1.7.2` | **not deployed today**; the target is the upstream LiveKit server image v1.7.2, to be digest-pinned at re-initialisation (docs/ops/topology.md, section 2) | [`28f7977`](https://github.com/livekit/livekit/blob/28f797786b4537dbd12feec25c9f50e8270871ba/LICENSE) | `LICENSE` (+ `NOTICE`) | Apache License, Version 2.0 | `Apache-2.0` | "Apache License 2.0" |
| Element Call | element-hq/element-call | tag `v0.26.0` (latest release on 2026-09-25) | **no pin in this repository** and not observed in the 2026-09-24 container census (docs/ops/topology.md); the release read is the latest, not a deployed version (see section 3) | [`71593f1`](https://github.com/element-hq/element-call/blob/71593f1a245b1afa971e3940596e1c500edf9548/LICENSE-AGPL-3.0) | `LICENSE-AGPL-3.0` + `LICENSE-COMMERCIAL` | GNU Affero General Public License v3; the file does not state "only" or "or later", the same commit's source headers declare `SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial` (e.g. `src/main.tsx`), while its `README.md` says "or (at your option) any later version". `LICENSE-COMMERCIAL` offers a separate commercial licence from the vendor as an alternative | `AGPL-3.0-only OR LicenseRef-Element-Commercial` (the narrower, per-file declared reading) | "GNU AGPL v3 (dual-licensed; a commercial licence is available from the vendor)" |
| Keycloak | keycloak/keycloak | tag `26.6.1` | the upstream Keycloak image, release 26.6.1 (pinned in this repository's compose files) | [`5bebfac`](https://github.com/keycloak/keycloak/blob/5bebfac09dd9abc5fe8b43f00ac596f0a5c998d1/LICENSE.txt) | `LICENSE.txt` | Apache License, Version 2.0 | `Apache-2.0` | "Apache License 2.0" |
| Vaultwarden | dani-garcia/vaultwarden | tag `1.36.0` | **not bundled**: the council's own externally operated instance, version not known to the distribution; 1.36.0 is the release read, not a deployed pin (docs/ops/topology.md, section 2) | [`f21a3ad`](https://github.com/dani-garcia/vaultwarden/blob/f21a3adae2fbb8582b60b121783c597fe6895ff4/LICENSE.txt) | `LICENSE.txt` (full AGPL v3 text) | GNU Affero General Public License v3; the same commit's `Cargo.toml` declares `license = "AGPL-3.0-only"` | `AGPL-3.0-only` | "GNU AGPL v3" |
| Helios (elections overlay) | benadida/helios-server | the commit the distribution pins as its `helios-src` submodule | that submodule commit, checked at every bump by `ops/scripts/helios-submodule-check.sh` | [`c7d5e60`](https://github.com/benadida/helios-server/blob/c7d5e60fbf9123be13d250a2ad9dae9efd8978e3/LICENSE) | `LICENSE` | Apache License, Version 2.0 | `Apache-2.0` | "Apache License 2.0" |

Full commit SHAs and the SHA-256 of each licence file as read, so a later reader can
tell whether a file changed without trusting this table:

| System | Full commit SHA | File | SHA-256 of the file as read |
|---|---|---|---|
| Nextcloud | `4d7d05e778398cdce1428b20d8687386edbc8268` | `COPYING` | `57c8ff33c9c0cfc3ef00e650a1cc910d7ee479a8bc509f6c9209a7c2a11399d6` |
| Nextcloud | `4d7d05e778398cdce1428b20d8687386edbc8268` | `COPYING-README` | `c269f524e3e81989b05eba49b82a9e523188fa898ba2d8a561338a5aa8b8f1df` |
| Collabora Online | `3799c094dabf7528da564b50db3e91df9007e35f` | `COPYING` | `2bfdca60adf803108d4c7f009000bea76ad00e621e163197881b0eaae91b530e` |
| Synapse | `c1b7c6b12e7b9b2cf586a3210145f70a5e30ed67` | `LICENSE` | `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0` |
| LiveKit | `28f797786b4537dbd12feec25c9f50e8270871ba` | `LICENSE` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| Element Call | `71593f1a245b1afa971e3940596e1c500edf9548` | `LICENSE-AGPL-3.0` | `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0` |
| Element Call | `71593f1a245b1afa971e3940596e1c500edf9548` | `LICENSE-COMMERCIAL` | `1197de6d29c5037c6d9b5c3607d72eaa90b5045f2d623400e870825fdcf7666e` |
| Keycloak | `5bebfac09dd9abc5fe8b43f00ac596f0a5c998d1` | `LICENSE.txt` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| Vaultwarden | `f21a3adae2fbb8582b60b121783c597fe6895ff4` | `LICENSE.txt` | `8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef` |
| Helios | `c7d5e60fbf9123be13d250a2ad9dae9efd8978e3` | `LICENSE` | `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1` |

Identical hashes across rows are expected: those projects ship the unmodified licence
text (Synapse and Element Call the same AGPL v3 file; LiveKit and Keycloak the same
Apache 2.0 file). The Helios file differs from the stock Apache text only in its
appendix placeholders (`{}` in place of `[]`, the older template); its terms section
(from "TERMS AND CONDITIONS" to "END OF TERMS AND CONDITIONS", whitespace-normalised) is
identical to LiveKit's and Keycloak's, and the bump script checks exactly that. Hashes are
of the blob at the commit (LF line endings), not of a checked-out working copy.

## 2a. Development tooling (dev-only, not shipped in any image)

Not one of TRD-265's seven systems and out of the marketing-copy check's scope (section 5
names the systems it cross-checks; these are not among them) — recorded here anyway, in the
same format, because R25-oxlint (2026-09-26) introduced them as root `devDependencies`. Read
directly from the installed npm package's own `LICENSE` file and `package.json`, the same as
section 2's rule 1, except the "Commit read" link points at the npm-published package tree
(no upstream git commit was individually resolved for these dev-only rows). Standalone
`oxlint`/`oxlint-tsgolint`, pinned directly (`--save-exact`), replace the earlier
`vite-plus`-mediated pin: `vite-plus` as a workspace devDependency made pnpm resolve peers
against its bundled vite core + Vitest 5, which broke gremion-ui svelte-check, so it is not a
root dependency here and carries no row.

| System | Upstream repository | Version read | Deployed as | Package artefact read | Licence file | What the file states | SPDX expression | Plain wording for copy |
|---|---|---|---|---|---|---|---|---|
| oxlint | oxc-project/oxc, `npm/oxlint` directory (npm `oxlint`) | `1.85.0` (exact pin, root `devDependency`) | dev-only tooling (the linter `pnpm run lint:js` / `make lint-js` runs); never shipped in any built image | `node_modules/oxlint/LICENSE` as installed from the pinned npm release | `LICENSE` (full MIT text) | "MIT License / Copyright (c) 2024-present VoidZero Inc. & Contributors"; the same release's `package.json` declares `"license": "MIT"` | `MIT` | "MIT License" |
| oxlint-tsgolint | oxc-project/tsgolint (npm `oxlint-tsgolint`) | `7.0.2003` (exact pin, root `devDependency`) | dev-only tooling (type-aware lint rules `options.typeAware` / `--type-aware` runs on top of); never shipped in any built image | `node_modules/oxlint-tsgolint/LICENSE` as installed from the pinned npm release | `LICENSE` (full MIT text) | "MIT License / Copyright (c) 2025 July-present VoidZero Inc. & Contributors"; the same release's `package.json` declares `"license": "MIT"` | `MIT` | "MIT License" |

SHA-256 of each licence file as installed (hash of the file on disk in `node_modules`, not a
checked-out git blob — no upstream commit was individually resolved for these rows):

| System | Version | File | SHA-256 of the file as read |
|---|---|---|---|
| oxlint | `1.85.0` | `LICENSE` | `95ced5ecf1133fbf41d409b5555c86c344f83f3b019926057ddbc07cfdcc27b3` |
| oxlint-tsgolint | `7.0.2003` | `LICENSE` | `c211cc5336d2d47f21322aca35c8149699de621edc447294b617048d05a745ce` |

## 3. Known gaps, stated openly

- **Element Call:** this repository pins no Element Call image and the 2026-09-24 census
  shows no such container, so no deployed version exists to read at. The licence was read
  at the latest release instead. The upstream declarations also disagree on "only" versus
  "or later" (see the row); the register records the narrower reading. Before any copy
  names Element Call's licence, the deployed release is fixed and the row re-read at that
  tag, or the copy cites this row together with this gap.
- **LiveKit and Vaultwarden:** neither runs as a pinned component of the distribution
  today (LiveKit is a re-initialisation target; Vaultwarden is the council's external
  instance). Each row records the licence of the release read; when a version is
  deployed or bundled, the row is re-read at that version under rule 3.
- **Nextcloud:** the image line floats within major version 33. The licence was read at
  the newest 33.x release on the date above; a new 33.x release is a bump under rule 3
  only if it changes `COPYING` or `COPYING-README`.
- **Container images bundle more than the one repository.** Each row records the licence
  of the named upstream repository. It says nothing about the operating-system packages,
  fonts, office core or other components an image also contains, and no copy may extend
  a row's licence to the whole image.
- **Trademarks are not licences.** Several of these projects restrict the use of their
  names and logos separately from the code licence; nothing in this register grants or
  records trademark permission.

## 4. How a row is added or re-read

1. Resolve the release tag to its commit (for an annotated tag, dereference the tag
   object to the commit it points at).
2. List the repository root at that commit and read **every** licence-shaped file
   (`LICENSE*`, `COPYING*`, `NOTICE`), not only the first one.
3. Record the commit (full SHA and a link), the file names, what the file itself says,
   any SPDX identifier the same commit declares in its package metadata, the SHA-256 of
   each file, and the date.
4. Derive the "SPDX expression" from what was read. Where the file does not say "only"
   or "or later", say so, record every other statement the same commit makes (package
   metadata, source headers, README), and use the narrower `-only` form: the bare
   `AGPL-3.0` / `GPL-3.0` identifiers are deprecated in the SPDX License List.
5. For Helios, run `ops/scripts/helios-submodule-check.sh` in the repository that
   carries the submodule and paste its `PASS` line into the bump (see
   [elections-scope.md](elections-scope.md), section 4).

## 5. The marketing-copy check

The CI grep over marketing copy that the plan pairs with this register is
`ops/scripts/marketing-copy-check.mjs`. It runs as `make lint-compliance`, which is part
of `make lint` and a step of the CI lint job; its suite
(`ops/scripts/marketing-copy-check.test.mjs`) runs first, and the number of tests it
collected is checked against the number it declares. It reads its rules from the
records, so this page and the check cannot drift apart:

- **Scope ("marketing copy"):** the repository `README.md`, `docs/about-gremion.md`,
  the public portal's sources (`gremion-public/src/`), the product's UI strings
  (`gremion-ui/src/lib/i18n/`), and, from the day they exist, `docs/sales/`,
  `docs/marketing/`, `docs/trust/` and `docs/onboarding/` (the offer, the website text,
  the trust document, demo scripts and onboarding material belong there). Test files
  are not copy and are skipped.
- **Licence rule:** in any sentence in scope that names a system from section 2, every
  licence name or SPDX identifier is attributed to the nearest system name and must lie
  inside that system's "SPDX expression" or "Plain wording" value, read from the table
  above. Anything else fails, including a correct family with a wrong "only" /
  "or later". A licence named for a system with no row fails.
- **Elections rule:** the forbidden phrasings of elections-scope.md section 2, read from
  its table, fail wherever they appear in scope, and so do general assertions that
  elections are lawful or that the module is fit, approved or certified for statutory
  use (German and English).
- **Vacuity guards:** the check exits 2, which fails CI as surely as a violation, when a
  required scope entry is missing or yields no file, when the register lacks a row for
  any of the seven systems, or when the elections table yields no phrasings.

Sentences are read whole: in Markdown and plain text, hard-wrapped lines are joined into
paragraphs before they are split into sentences, so a claim cannot hide across a line
break. An SPDX disjunction in the register allows each of its alternatives on its own.

What it cannot see: a licence stated for a system under a name the check does not know
(it knows the names in section 2); a sentence split across two string literals in code;
and copy that lives outside this repository. The broader elections patterns are skipped
in a sentence that contains a negation, so that the sanctioned honest-scope notice passes;
a negated sentence that still asserts lawfulness is left to the per-release reading
TRD-112 requires. Copy outside the check's reach is checked against this register and
elections-scope.md by hand before it is published.

**Measured state on 2026-09-25:** the first run of the check found one divergence:
`docs/about-gremion.md` listed the public module repositories as "AGPL-3.0-only" and
named Helios and Nextcloud in the same sentence, which reads as a licence claim for
both (Helios is Apache-2.0 and Nextcloud AGPL-3.0-or-later, per section 2). The
sentence was reworded in the same change to keep the first-party module licence apart
from the wrapped systems' own licences. No other licence claim for a section 2 system
was found in scope.

## 6. Out of scope here

The platform's own mail server candidate is covered by its own technical requirement
(TRD-253) and is not one of the seven systems TRD-265 names; it gets a row here only when
copy first needs to name its licence. First-party code is licensed under the repository's
own `LICENSE` and `NOTICE` and is not a third-party row.

## 7. Sources and decisions

- **TRD-265** — before any sales artefact or the trust document states a licence for
  Nextcloud, Collabora, Matrix/Synapse, LiveKit, Element Call, Keycloak or Vaultwarden,
  that project's own licence file is read directly; verified by inspection of a dated
  register sourced from the licence files. This document is that register.
- **TRD-268** — Helios's pinned commit reports Apache-2.0 (and Python 3.13+), re-verified
  at every submodule bump; the Helios row here is the recorded result.
- **PRD-TRU-009** (section 11 of the PRD, the trust claims and the allowed / forbidden
  word lists) and **PRD-REG-016** (a software bill of materials per release) — the trust
  document and release artefacts this register constrains.
- **PRD assumption A2** (section 12.3) — the licences of the seven systems had not been
  independently verified; this register discharges A2 for the commits listed.
- **Operator decisions:** R22-14 (TASK-005's build work is due before the offer,
  date-bound to about 2027-02); R23-24 (2026-09-25: pull standing and later units forward
  and run them in parallel), which is why the register is written now.
- **Delivery note (TASK-005):** the plan entry owns three files — this register,
  elections-scope.md and the Helios bump script. The acceptance also requires the CI
  marketing-copy grep, which has no owned file; it was added as
  `ops/scripts/marketing-copy-check.mjs` next to the bump script, with a `lint-compliance`
  Makefile target and a CI step, rather than left unbuilt.
