# Host tooling (`/opt/gremion`)

Everything a Gremion distribution host needs to be brought up, deployed to,
verified, backed up, restored and rolled back. The tooling is generic: it
carries no address, hostname or credential of any particular deployment.
Those live in two places and nowhere else — the env files under
`/opt/gremion/etc/env/` on the host, and the operator's own private runbook.

The sources are `infra/host/` in this repository; the tests are
`test/host/*.bats` and run with `make test-unit`.

## 1. Layout

One owner (`gremion`), one tree, `etc/` mode 0700:

```
/opt/gremion/
  etc/
    env/            state.env, app-blue.env, app-green.env, mail.env, ops.env
    secrets/        platform secrets, tenants/, ipcrypt, mail/ (DKIM keys)
    edge/active.yml the Traefik switch file
    gremion.dist.json   the distribution manifest
    tenant-hosts.txt    the tenant FQDN list (see below)
  releases/<tag>/   the config tree checked out at the release tag
  current -> releases/<tag>
  bin/              the gremion-* programs of section 4
  backups/          restic repository + staging area
  runtime/          active-colour, previous-tag, current-tag,
                    last-verify.json, last-backup.json, last-restore.json,
                    evict-targets.json, deploy.log
  logs/             hostd.log and rotated program logs
```

Override the root with `GREMION_ROOT` when running the tooling anywhere other
than a real host (the test suite does exactly this).

**`etc/tenant-hosts.txt`** is the one input several programs share and none of
them writes: it is owned by the **control plane**, which appends a tenant's
FQDN when it provisions that tenant and removes it on erasure — and, until the
control plane exists, by **the operator, by hand**.
Format: **one FQDN per line**; a `#` begins a comment; blank lines are
ignored. Three readers depend on it — `gremion-render --staging`
(the `extra_hosts` fragment),
`gremion-verify` (the default host list) and the ops project's blackbox
targets — so a host missing from this file is a host nothing probes and
nothing certifies.

## 2. The env contract

**One env file per compose project, and `--env-file` is the only flag any host
command may pass to `docker compose`:**

```
docker compose --env-file /opt/gremion/etc/env/state.env ps
docker compose --env-file /opt/gremion/etc/env/app-blue.env up -d
```

No `-f`, no `--profile`, no `-p`. Composition is written in the env file, not
on the command line: each file sets its own `COMPOSE_PROJECT_NAME`,
`COMPOSE_FILE` and `COMPOSE_PROFILES`. A command line that carries the file
list is a command line that can differ between two operators on the same host,
which is how an image and its config skew apart.

Project names are stack-scoped: `${STACK}-state`, `${STACK}-app-blue`,
`${STACK}-app-green`, `${STACK}-mail`, `${STACK}-ops`. Exactly five resources
are shared, declared `external: true` and created by `bootstrap.sh networks`:
networks `${STACK}_edge` and `${STACK}_state`, volumes
`${STACK}_traefik_acme`, `${STACK}_tenant_secrets`, `${STACK}_mail_data`.
Nothing else carries a `name:` key, so two stacks can share one machine
without touching each other.

### Keys the operator fills in

`gremion-init-secrets` renders the four templates, generates every secret and
leaves every operator-owned value as a `CHANGE_ME_` sentinel, then prints the
list of keys still to fill. The non-secret set, with generic examples:

| Key | Example | Meaning |
|---|---|---|
| `STACK` | `gremion` | prefix for every project and shared resource |
| `PLATFORM_DOMAIN` | `example.org` | the platform's own domain |
| `ACME_EMAIL` | `hostmaster@example.org` | ACME contact |
| `TRAEFIK_CERT_RESOLVER` | `le-http` | empty means the internal CA (staging) |
| `CONTROL_ALLOWLIST_CIDRS` | `203.0.113.0/24,2001:db8::/32` | control-plane allowlist; fail-closed when empty |
| `EDGE_BIND_IP` / `EDGE_BIND_IP6` | `203.0.113.10` / `2001:db8::a` | the edge listener; nothing binds `0.0.0.0` |
| `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` | `80` / `443` | edge ports |
| `MAIL_BIND_IP` / `MAIL_BIND_IP6` | `203.0.113.25` / `2001:db8::25` | the mail listener and SNAT source |
| `EDGE_V4_SUBNET` … `OPS_V6_SUBNET` | `10.90.0.0/24`, `fd5a:90::/64`, … | pinned Docker subnets, dual-stack |
| `IMAGE_TAG` | `dist-v1.4.0` | the release the composition names |
| `GREMION_DIST_MANIFEST` | `/opt/gremion/etc/gremion.dist.json` | the assembler manifest path |
| `RESTIC_REPOSITORY` | `/opt/gremion/backups/repo` | local restic repository |
| `RCLONE_REMOTE` / `RCLONE_BUCKET` / `RCLONE_REMOTE_PATH` | `backup` / `<bucket>` / `gremion-restic` | the off-site copy; a missing off-site copy is a failure |
| `BACKUP_RETENTION_DAILY/WEEKLY/MONTHLY` | `14` / `8` / `6` | restic retention classes |
| `ALERT_WEBHOOK_URL` / `ALERT_EMAIL_TO` | — | the two alert sinks |
| `SOAK_MINUTES` | `30` | how long both colours run after a switch |
| `HEALTH_EXEMPT_SERVICES` | `minio-mc` | one-shot containers asserted `exited 0`, not healthy |
| `RESERVED_HOSTS` | `www control rs1 mail mta-sts autoconfig autodiscover _dmarc` | names no tenant may claim |

Secret keys are every `CHANGE_ME_` key of `.env.example` plus
`RESTIC_PASSWORD`, `RCLONE_CONFIG_BACKUP_*`, `INTERNAL_PUSH_SECRET`,
`STALWART_ADMIN_PASSWORD`, `STALWART_API_KEY` and `PLATFORM_SMTP_PASSWORD`.
`app-blue.env` and `app-green.env` additionally set `COLOUR` and the
colour-suffixed service URLs (`INTERNAL_BASE_URL`, `KERNEL_BASE_URL`,
`<LEAF>_SERVICE_URL`); no app-tier URL names a bare service name.

## 3. Exit codes

Every `gremion-*` program uses the same four:

| Code | Meaning |
|---|---|
| `0` | success; the post-condition was observed |
| `1` | an assertion or post-condition failed |
| `2` | usage error or a missing precondition (a file, an env key, a tool) |
| `3` | blocked on something outside the program — printed as `BLOCKED: <what>` |

`3` is never a failure of the host: it is the program refusing to guess. It is
what a deploy returns when a contract the release must supply is not there.

## 4. The commands

All under `/opt/gremion/bin`, all `bash`, all asserting post-conditions rather
than exit codes.

| Command | Purpose |
|---|---|
| `gremion-init-secrets [--root DIR] [--stack NAME] [--force]` | render `etc/env/*.env` from the templates, generate every secret, chmod 600, refuse to overwrite; prints the keys the operator must still fill |
| `gremion-render [--release DIR] [--staging]` | produce the host-rendered files (pgbouncer userlist, Keycloak internal CA and cert, ipcrypt key, LiveKit and Element Call config; with `--staging` the `extra_hosts` fragment) and assert each output exists, is a file and is non-empty |
| `gremion-fw-proof` | the firewall drill: egress TCP/25 refused off the mail subnet, allowed on it, the observed source address after SNAT, and Docker's own NAT table still present |
| `gremion-hostd --socket \| --ssh` | the restricted agent of section 5 |
| `gremion-dns-check --domain D --edge-ip A --mail-ip B [--edit N]` | verify the published record set for one edit of the DNS table, one line per record |
| `gremion-mail-bringup [--assert N\|all]` | the mail asserts in their required order, refusing to run out of order |
| `gremion-verify [--colour c] [--hosts FILE]` | the verification contract: enumerate every router from the Traefik API, classify it, assert certificates, health, the host pin and the ACME path; writes `runtime/last-verify.json` |
| `gremion-switch <colour> [--no-evict]` | fan the eviction out, rewrite `etc/edge/active.yml` atomically, wait for Traefik to serve the new target, record `runtime/active-colour` |
| `gremion-deploy <tag>` | the release procedure, twelve steps, token on stdin; logs `STEP n <name> ok\|fail` to `runtime/deploy.log` |
| `gremion-rollback [--to-tag T]` | switch back while the old colour is up, otherwise redeploy the previous tag |
| `gremion-backup [--label L] [--class daily\|snapshot]` | enumerate from the running system, archive, restic, off-site, report; writes `runtime/last-backup.json` |
| `gremion-snapshot <tag>` | `gremion-backup --label <tag> --class snapshot`, plus the artefact-class floor |
| `gremion-restore-into --stack S --snapshot ID\|latest [--rto]` | restore a snapshot into a *different* stack, never into `etc/`, then neuter and prove by content |
| `gremion-neuter --stack S` | point every SMTP host at a null sink and blank the publish tokens in stack `S`, asserted through `docker exec … env` |

## 5. The deploy channel

```
deploy.yml (workflow_dispatch, environment production)
    │  ssh, forced command, key-only, no pty
    ▼
gremion-hostd --ssh          allow-list + argument validation
    │
    ▼
gremion-deploy <tag>         token on stdin, docker logout in a trap
```

The host's `authorized_keys` entry for the deploy key is
`command="/opt/gremion/bin/gremion-hostd --ssh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty`,
so the key can do nothing but talk to the agent. The agent accepts exactly
`noop`, `deploy <tag>`, `switch <colour>`, `rollback`, `snapshot <label>`,
`verify [--colour c]` and `backup`; a tag must match
`dist-vX.Y.Z`, a colour must be `blue` or `green`, and anything else is
answered `EXIT 2`. Every invocation is appended to
`/opt/gremion/logs/hostd.log`.

**The wire format.** The client writes lines and reads lines; the response
always ends with an `EXIT <code>` trailer:

```
→ TOKEN ghs_xxxxxxxxxxxxxxxxxxxx
→ deploy dist-v1.4.0
← STEP 1 login ok
← …
← EXIT 0
```

**The agent's `EXIT` trailer, not the ssh exit status, is the verdict:**
`deploy.yml` reads the last `EXIT <code>` line, fails the run on any non-zero
code, and fails the run when the response carries no `EXIT` trailer at all —
a connection dropped just after a success line must never read as a green
deploy. A zero trailer together with a non-zero ssh status also fails.

The registry token is passed on stdin, never as an argument and never to
disk. `gremion-deploy` runs `docker login ghcr.io -u x-access-token
--password-stdin`, logs out in a trap on every exit path, and then asserts
that no `auths` entry survives in either Docker config. The host therefore
holds no standing registry credential between deploys.

`deploy.yml` itself is dispatch-only, read-only on the repository token,
single-flight per target, and runs in a GitHub environment that requires a
reviewer. Before it opens SSH it proves the tag is annotated, matches
`dist-vX.Y.Z`, and carries a `release.json` naming that same tag with an
explicit boolean `overlap`, an array of `migrations` and a `sha256:` manifest
digest, plus a `docker-compose.pins.yml`, at its tree root.

### What the operator must create before the first dispatch

`deploy.yml` cannot run until these exist. None of them is in this repository,
and none of them can be created by the tooling:

1. **Actions enabled on the repository.** They are administratively disabled
   on all Gremion repositories by operator directive over usage cost:
   `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true`.
2. **A GitHub environment named exactly `production`** — Settings →
   Environments → New environment → `production` — with a **required
   reviewer** so an unreviewed dispatch waits there and never reaches SSH.
3. **Three environment secrets on that environment** (Settings →
   Environments → `production` → Environment secrets → Add secret). They are
   environment secrets, not repository secrets: a repository secret would be
   readable by every workflow in the repository.

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | the host's FQDN or address, used as `gremion@<value>` |
   | `DEPLOY_SSH_KEY` | the deploy key's **private** half, whole file including the `BEGIN`/`END` lines |
   | `DEPLOY_HOST_KEY` | one `known_hosts` line for that host, taken from the host itself (`ssh-keyscan -t ed25519 <host>` run **on** the host, or read from `/etc/ssh/ssh_host_ed25519_key.pub`), never from the client's cache |

4. **The deploy key's public half installed on the host**, as the forced
   command line of section 5, rendered by `bootstrap.sh` (`authorized_keys_line`).

Prove the channel with the `noop` of section 6 before the first real dispatch.

## 6. The noop dry-run

Before the first real deploy, prove the whole channel with the one command
that changes nothing. From a machine holding the deploy key:

```
printf 'noop\n' | ssh -T \
    -o StrictHostKeyChecking=yes \
    -o BatchMode=yes \
    gremion@<host>
```

Expected output — the agent's own reply, then the trailer:

```
noop ok
EXIT 0
```

Then read the post-condition from the host rather than from the exit code —
the agent must have logged the call:

```
ssh gremion@<host> 'tail -n 1 /opt/gremion/logs/hostd.log'
```

And prove the allow-list by asking for something that is not on it. This must
answer `EXIT 2` and must not run anything:

```
printf 'shutdown now\n' | ssh -T -o BatchMode=yes gremion@<host>
```

## 7. Running the tests

```
make test-unit       # every test/host/*.bats file, no Docker, no host
make lint-sh         # shellcheck over infra/host/**
```

The unit tests never touch a real `docker`, `nft` or `ssh`: they put recording
shims first on `PATH` through `test/host/test_helper/host.bash` and assert on
what the program tried to do. The steps that need Docker or a host are
separate scripts under `test/host/integration/`, and they assert from the
running system — `docker inspect`, `docker exec … env`, `nft list ruleset`,
`openssl s_client`, the served asset — never from an exit code.

## 8. What is deliberately not here

Addresses, hostnames, PTR records, registrar procedure, the cloud-firewall
toggles and the operator's account details. They belong to one deployment, not
to the distribution, and they live in that operator's private runbook and in
the host's own `etc/env/*.env`. `test/host/no-host-literals.bats` fails the
build if any of them appears in this repository.
