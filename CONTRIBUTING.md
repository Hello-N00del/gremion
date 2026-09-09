# Contributing to Gremion

Thank you for your interest in contributing to Gremion — the open civic-governance
kernel. This document explains the legal basis on which contributions are accepted.

## License & inbound = outbound

Gremion is licensed under the **GNU Affero General Public License v3.0 only**
(AGPL-3.0-only) — see [`LICENSE`](./LICENSE). This license is **permanent**: the
project will never be relicensed under a non-free or source-available license.

Contributions are accepted on an **inbound = outbound** basis: any contribution
you submit is offered under the **same AGPL-3.0-only** terms that cover the project.
We do **not** ask you to sign a Contributor License Agreement (CLA) and we do
**not** aggregate relicensing rights. You keep the copyright to your work; you
simply license it to the project (and everyone else) under AGPL-3.0-only.

## Developer Certificate of Origin (DCO)

Instead of a CLA, Gremion uses the **Developer Certificate of Origin**. To
contribute, you certify the statement below by adding a `Signed-off-by` line to
each commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

Add it automatically with:

```
git commit -s
```

CI checks the sign-off on pull requests opened from a fork — the `DCO sign-off
(external pull requests)` job. Pull requests from branches inside this
repository are not checked by any job; maintainers are asked to sign off anyway
(`git commit -s`).

The name and email must match your real identity (no anonymous or pseudonymous
sign-offs). By signing off, you certify the DCO 1.1:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this license
document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right
    to submit it under the open source license indicated in the file; or

(b) The contribution is based upon previous work that, to the best of my
    knowledge, is covered under an appropriate open source license and I have
    the right under that license to submit that work with modifications, whether
    created in whole or in part by me, under the same open source license
    (unless I am permitted to submit under a different license), as indicated in
    the file; or

(c) The contribution was provided directly to me by some other person who
    certified (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public and
    that a record of the contribution (including all personal information I
    submit with it, including my sign-off) is maintained indefinitely and may be
    redistributed consistent with this project or the open source license(s)
    involved.
```

## Why DCO and not a CLA

Gremion is built to be trusted civic infrastructure. A CLA that aggregates
relicensing rights is the mechanism behind every open-source "rug-pull" (a later
move to a proprietary or source-available license). By using a DCO with
inbound = outbound AGPL-3.0-only, **no party — including the maintainers — can
ever relicense your contribution away from the AGPL.** That guarantee is the
point.

Most feature modules are themselves AGPL-3.0-only. The few that are closed
(finance, content, vault, handover) stay closed not by acquiring relicensing
rights over the core, but by being **separate programs / services** over
Gremion's stable APIs (AGPL "mere aggregation"). The core stays free; the
boundary is architectural, not legal-by-CLA.

## Network use (AGPL §13)

Because Gremion is AGPL-3.0-only, anyone who runs a **modified** Gremion and
offers it to users over a network must offer those users the corresponding
source of their modified version.

The app makes that offer for you, and you have to keep it pointing at *your*
source. Both shells render a **"Source code (AGPL-3.0)"** link in the footer,
taken from the `PUBLIC_SOURCE_URL` environment variable; unset, it points at
this repository, which is correct only for an **unmodified** deployment. If you
modify Gremion and serve it, set `PUBLIC_SOURCE_URL` to a location that
publishes your modified source — leaving the default in place while running
modified code is a licence violation, not a cosmetic default.

## Making a contribution

1. Fork the repository and create a topic branch.
2. Make your change; keep it focused and covered by tests where applicable.
3. Sign off every commit (`git commit -s`).
4. Open a pull request describing the change and its motivation.

All contributions are reviewed before merge. Thanks for helping keep civic
software free.

## Git hooks — the pre-commit boundary lint

Install once per clone (idempotent):

```bash
pnpm install --frozen-lockfile
node gremion-ui/scripts/install-git-hooks.mjs
```

**The guarantee: after any successful install, the directory the hook was
written into is exactly what `git rev-parse --git-path hooks` prints.** That is
the only directory git reads hooks from, so it is the only place a hook can
land and still run. The installer asks git that question, installs there, and
re-checks the answer before it prints a success line; if the two ever disagree
it refuses rather than report an install. Everything below is a consequence of
that one post-condition rather than a separate rule.

`git rev-parse --git-path hooks` already accounts for all of it: a
`core.hooksPath` (repo-**local** or per-**worktree**) wins over the git common
dir, a leading `~` is expanded against your home directory, a relative value is
resolved against *this* worktree, and a linked worktree gets its own answer.
Run the installer from inside the worktree you want covered.

**The hook fails closed.** Every condition that stops the boundary lint from
running — no repo root, a missing `gremion-ui/scripts/boundary-lint.ts`, a
missing `gremion-ui/node_modules` (fresh clones, and any checkout where install
has not run) —
blocks the commit and prints what to do about it. It never skips silently: a
hook that exits 0 when it cannot run is worse than no hook, because it looks
installed. `git commit --no-verify` is the single, visible bypass.

**Worktree coverage depends on which rule applies.** The git common dir and an
**absolute** `core.hooksPath` are shared by every worktree of the clone, so one
install covers all of them. A **relative** `core.hooksPath` is not: git resolves
it against *each worktree's own top level*, so every linked worktree gets its
own `<worktree>/<path>` and needs its own install — a worktree nobody installed
into commits unguarded. The installer prints a NOTE when it sees a relative
value; set an absolute path if you want one shared hooks dir.

A **global or system** `core.hooksPath` makes the installer **refuse and exit
non-zero**. That directory is shared by every **repository** on the machine, and
this wrapper fails closed, so installing there would block commits in unrelated
repos with a remediation command that cannot be run from them — and installing
into this repo's own hooks dir instead is no better, because git obeys the
inherited value and would never run it (installed-looking, enforcing nothing:
exactly the failure this guard exists to prevent). Give the repo its own hooks
dir first — the installer prints the ready-to-paste
`git config --local core.hooksPath "<absolute hooks dir of this clone>"`
command, with the **absolute** path filled in — then re-run the installer, or
unset the machine-wide value (`git config --global --unset core.hooksPath`).
The value must be absolute: a relative one is re-resolved inside every linked
worktree, where it names a path that is not a hooks directory at all.

A **per-worktree** value (`git config --worktree core.hooksPath …`) is a
legitimate override and is honoured. Scope is read explicitly, so it is never
mistaken for a machine-wide one.

If a **foreign `pre-commit` hook already exists**, the managed block is
**prepended** to it, never appended: a hook that ends in `exit 0` (husky's
classic shim, most hand-written hooks) would otherwise make the appended block
unreachable — present, executable, enforcing nothing. Your existing hook still
runs, after the boundary lint passes. If an **older install appended** the block
behind your hook, re-running the installer moves it back to the front (reported
as `re-prepended`) rather than rewriting it where it sits.

A foreign hook whose shebang names a **non-shell interpreter** (`python3`,
`node`, …) is **refused**, not rewritten: the managed block is `/bin/sh` code,
so prepending it would leave a file that is a syntax error for its own
interpreter. The same refusal covers a hook that is **not UTF-8 text** (a
compiled binary, or Latin-1 text whose `#!/bin/sh` line passes every other
check) — reading it as UTF-8 and writing it back would replace every
undecodable byte with `U+FFFD` — and a **symlinked** `pre-commit`, because
writing through a symlink writes to its target, possibly outside the hooks dir.
In every case the installer exits non-zero, leaves the file byte-identical and
prints the remedies (move it aside and chain it from the generated wrapper,
point the repository at another hooks dir with
`git config --local core.hooksPath`, or delete it if obsolete).

Writes are **atomic**: the new hook is written to a sibling temp file, made
executable there, and renamed into place. A failed install therefore leaves the
previous hook working rather than a truncated or non-executable one — which git
would either ignore outright or run as garbage.

If an **earlier generation** of this installer left a trailing bare `exit 0`
below the managed block, upgrading drops it. Your own hook body is never
trimmed: only blank, comment and `exit 0` lines qualify.
