# `infra/host` — host-side tooling for a Gremion distribution host

Generic tooling for the machine a Gremion distribution runs on. It contains no
address, hostname or credential of any particular host: those exist only in
`/opt/gremion/etc/env/*.env` on the host itself. `test/host/no-host-literals.bats`
enforces that across the whole tree, and it is the only file that scans for
literals — every other test stays out of that business so the guard file remains
the single place those strings could ever appear.

## Layout

```
infra/host/
  lib/common.sh          primitives every gremion-* program sources
  bin/gremion-*          the host programs
  templates/env/*.tmpl   one template per compose project
```

Installed on a host as:

```
/opt/gremion/
  lib/common.sh          real file, copied — never a symlink
  bin/gremion-*          real files, copied — never symlinks
  etc/env/               state.env app-blue.env app-green.env mail.env ops.env
  etc/secrets/  etc/edge/  releases/  current -> releases/<tag>
  backups/  runtime/  logs/
```

`lib/` is the one directory beyond the spec's list, and it exists for one
reason: every program locates its library as
`"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/common.sh"`.
`${BASH_SOURCE[0]}` is the *invoked* path, so a symlinked `bin/` would resolve
`../lib` to a directory that does not exist. Copy both, never link.

Every program opens with exactly these three lines, the middle one standalone so
`shellcheck -x` can follow the source and the repo guard can find the directive:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
```

## The env contract

One env file per compose project, and exactly one permitted flag:

```
docker compose --env-file /opt/gremion/etc/env/<project>.env <verb>
```

No `-f`, no `--profile`, no `-p`. Each env file sets its own
`COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and `COMPOSE_PROFILES`, which is what
makes that one flag sufficient.

| File | Project |
|---|---|
| `state.env` | `${STACK}-state` |
| `app-blue.env` / `app-green.env` | `${STACK}-app-blue` / `${STACK}-app-green` |
| `mail.env` | `${STACK}-mail` |
| `ops.env` | `${STACK}-ops` |

`STACK` is `gremion` on the production host and `staging` anywhere else. It is
the prefix of every shared external network and volume, so two units on one
machine never touch each other's resources.

A key is declared in exactly one template per project. `load_env` refuses a file
that declares any key twice rather than resolving the duplicate, so a second
spelling of a key added by a later change disables that project's tooling
immediately and visibly.

## Sentinels

Templates carry two placeholder shapes. Both begin `CHANGE_ME_`, so one grep —
and `load_env`'s own refusal — covers both:

| Shape | Filled by |
|---|---|
| `CHANGE_ME_GEN_hex32_<group>` | `gremion-init-secrets`, `openssl rand -hex 32` |
| `CHANGE_ME_GEN_alnum32_<group>` | `gremion-init-secrets`, 32 alphanumeric chars |
| `CHANGE_ME_OPERATOR_<name>` | the operator, by hand, before the first `up` |

No other placeholder shape exists. A shape outside this grammar is never
generated, never listed as operator-pending and never caught by the render's own
post-conditions — it would ship to production unfilled and silently.

Every key that names the same `<group>` gets the same generated value, in every
template. That is how the aliased OIDC secrets, the Stalwart API key shared by
`state.env`, `mail.env` and `ops.env`, the platform SMTP password shared by four
files, and the password embedded inside `GREMION_PUBLIC_DB_URL` stay equal
without a reconciliation step.

`load_env` refuses to load any file that still holds a `CHANGE_ME_` value unless
`ALLOW_SENTINELS=1`.

## First run

```bash
/opt/gremion/bin/gremion-init-secrets --stack gremion
```

It renders the five files, generates every secret, refuses to overwrite an
existing file without `--force`, asserts its own post-conditions (non-empty, no
surviving generated sentinel, no unsubstituted placeholder, no duplicated key,
mode 600, `etc/` **and every directory under it** mode 700) and prints the list
of keys you must still fill in, ending with:

```
INIT-SECRETS: files=5 generated=<n> operator-pending=<m>
```

Fill every listed key, then confirm the file is loadable:

```bash
bash -c '. /opt/gremion/lib/common.sh; load_env /opt/gremion/etc/env/state.env; echo OK'
```

A non-zero exit here means a key is still unfilled or duplicated. That check is
the gate before any `docker compose up`.

**Staging note.** `TRAEFIK_CERT_RESOLVER` ships non-empty. A staging unit must
blank it before its first `gremion-render --staging`, which refuses to run while
the resolver is set (the certificate rule is all-or-nothing per render).

## Exit codes

Every `gremion-*` program uses the same four:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | an assertion or post-condition failed |
| 2 | usage, or a missing precondition (file, env key, tool) |
| 3 | blocked on an external step; the message begins `BLOCKED: ` |

## Tests

```bash
bats test/host/*.bats
```

Unit tests never touch a real `docker`, `nft`, `ssh` or `/opt/gremion`: they put
a recording shim first on `PATH` (`test/host/test_helper/host.bash`) and assert
on what the program tried to do. Anything needing a real daemon lives in
`test/host/integration/` and is not collected by the unit run.

`HOST_SRC` may be set in the environment to point the suite at a copy of
`infra/host` — that is how a guard is watched RED against a deliberately broken
tree without editing the working tree.

One class of assertion is skipped on Windows and only there: Git Bash on NTFS
does not store POSIX permission bits, so a `chmod 600` reads back as 644. Those
tests `skip` with a reason, and the same post-condition is asserted for real on
the Debian host.

The probe behind that skip — `fs_carries_modes` in both `lib/common.sh` and
`test/host/test_helper/host.bash` — asks one question: does this filesystem
*persist* a mode it was given? Only a `chmod` that **succeeds** and does not
stick answers "no modes". A `chmod` that **fails** is fatal (`exit 1` naming
`chmod`, a test FAILURE rather than a skip), because reading it as "no modes"
would silently switch off every 0600/0700 post-condition on a host that does
carry them — the guard still installed, still green, enforcing nothing.

When a post-condition does not hold, `assert` reproduces the wrapped command's
stdout and stderr (prefixed, last 40 lines) before the `FAIL` line, so the
failure carries its own diagnosis instead of costing a second trip to the host.
