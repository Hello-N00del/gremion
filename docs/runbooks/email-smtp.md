# Outgoing Email / SMTP Runbook

How the Gremion governance kernel sends mail, how to read it in dev/staging,
and the exact steps to switch a tenant over to a real outbound relay for
production.

> For the kernel's overall architecture, multi-tenancy model, and governance
> charter, see [About Gremion](../about-gremion.md). This runbook is the
> operational layer for one concern: outgoing email.

The kernel has exactly **one** mail producer: the **gremion-ui** app shell. It
sends transactional, **per-tenant** governance notifications — for example
password resets, and protocol / resolution (Beschluss) and committee
notifications. Mail is resolved per tenant through a single seam,
`gremion-ui/src/lib/server/mail/tenant-mail.ts`.

## Platform mail transport: relay or bundled Stalwart

This section is about the mail the **platform** sends (Keycloak password
resets of every realm, the operator realm, Grafana alert mail). It is
independent of the per-tenant application mail above and of any feature module.

One deploy-time switch, `MAIL_TRANSPORT` in `mail.env` and `ops.env`, with **no
default** (an unset value is a named failure, never a silent guess):

- `relay`: an external authenticated SMTP relay (the default keys in the
  templates are the Google Workspace SMTP relay: STARTTLS on port 587, SMTP AUTH
  with an app password). Every realm sends through the ONE relay credential,
  as `system@` (operator realms), `no-reply@` (customer realms) and `alerts@`
  (Grafana) of the platform domain; the relay must DKIM-sign that domain
  (DMARC stays `p=reject`). **Accepted loss:** one shared credential means no
  per-tenant sender isolation. No mail project runs, Prometheus has no `stalwart`
  target and no mail probe target, and the `MailQueueOldest1h` alert is not
  rendered. `gremion-mail-bringup --assert relay --external-to <mailbox>
  [--results-file <headers>]` is the relay's go-live check: r1 the relay
  answers, r2 STARTTLS is offered and the certificate is trusted for the relay
  host, r3 an authenticated test message from `system@` is accepted (the
  password rides a pipe into `curl -K -`, never an argv), r4 the delivered
  message's headers show the relay DKIM-signed the platform domain with DMARC
  pass (`check-received --relay`). The bundled-server asserts 1-6b are refused
  by name in this mode; a skipped check is not a pass.
- `stalwart`: the bundled Stalwart; each customer realm sends as its own
  `kc-<token>@` principal (unchanged).

Relay keys (`mail.env`; `ops.env` repeats the four non-secret ones and
`render-ops.sh` requires `ALERT_SMTP_HOST/PORT/USER` to equal them):
`RELAY_SMTP_HOST`, `RELAY_SMTP_PORT` (465 = implicit TLS), `RELAY_SMTP_USER`
(empty = an IP-allow-listed relay without authentication),
`RELAY_SMTP_PASSWORD_REF` and `RELAY_FROM_DOMAIN` (empty = the platform domain).

**The password is never a value in an env file.** `RELAY_SMTP_PASSWORD_REF` is
`secret:<name>` (= `<root>/etc/secrets/<name>`, mode 0600) or `file:<absolute
path>`; it reaches kcadm on stdin and Grafana as a file, never an env value or an
argv, and a file readable by "other" is refused.

Switching mode on an initialised host is a procedure, not a hot toggle: set the
keys, then re-stamp every realm through `gremion-mail realm-smtp` (customer
realms: the host-side reconcile run, whose `smtp-server` check fails
loudly while a realm still carries the other mode's stamp).

## Default: the Mailpit catcher (local dev / staging)

Out of the box the dev stack does **not** relay mail to the internet. A
`mailpit` service (`axllent/mailpit`, pinned by tag and digest) runs on the state
network (`${STACK}_state`) and **captures** every message sent to it. It carries
`profiles: [dev]`: `.env.example` sets `COMPOSE_PROFILES=dev`, while a host
renders with `COMPOSE_PROFILES=production`, so no catcher exists there:

- **SMTP** listens on `mailpit:1025` (internal network only — no host port, no
  auth, no TLS). Mailpit is configured to accept any/no SMTP auth
  (`MP_SMTP_AUTH_ACCEPT_ANY`, `MP_SMTP_AUTH_ALLOW_INSECURE`) so a tenant
  configured with empty credentials still hands off cleanly; nothing leaves the
  host regardless.
- **Web UI** is mapped to `http://localhost:8026` by
  `docker-compose.override.yml` (bound to `127.0.0.1` / `[::1]` only).

Nothing sends to the catcher by default: on the local stack a tenant's SMTP
settings start out unconfigured, and no compose default names a mail host. (On
a host with `MAIL_TRANSPORT=relay`, `gremion-services wire` writes the tenant's
SMTP settings for the relay, see [ops/pilot-services.md](../ops/pilot-services.md).) A tenant whose SMTP
config points at `host=mailpit port=1025` with no auth
sends to the catcher with **zero** real credentials. Captured mail persists
across restarts in the `mailpit-data` named volume (project-scoped, so
`dev-state_mailpit-data` for `make up`).

To point a tenant at the catcher, set host `mailpit`, port `1025` in
**Settings → E-Mail** (leave the test user/password blank), then mark SMTP
configured. `gremion-ui` has to run with `SMTP_TEST_ALLOW_PRIVATE=1` for this:
without it the SMTP target guard refuses port 1025 and a private address when
the settings are saved, in the test below and on every send
([docs/security/test-smtp-guard.md](../security/test-smtp-guard.md)). A tenant with no registry override takes its host/port/from straight from its
`config.json` and `auth` is undefined — byte-identical to the auth-less Mailpit
transport.

## Reading trapped mail

1. Open `http://localhost:8026` in a browser on the dev/staging host.
2. Every message a tenant sent to the catcher appears in the inbox — subject,
   sender, recipients, raw source, and an HTML preview.
3. Nothing is delivered to real mailboxes, so it is safe to trigger password
   resets, committee/protocol notifications, etc.

## Sending a test mail

**Via the UI (gremion-ui):** Settings → E-Mail → set the SMTP host and port and
an Absender-Adresse, then click **Test-E-Mail senden**. The test mail goes to
your own address; with the catcher as the target it shows up in Mailpit at
`http://localhost:8026`. The button calls the endpoint below, so the same rules
apply.

**Via the test-smtp endpoint** (TASK-042 Q1: a signed-in session with the
IT-admin role; there is no setup token any more). The endpoint is rate-limited,
target-guarded (docs/security/test-smtp-guard.md) and opens an outbound connection to the body-supplied
`host:port`, so the cap also bounds its use as an SSRF/port-probe oracle. Send
the session cookie of an IT admin to the tenant's own host, with an `Origin`
header naming that host (the CSRF guard refuses a cookie-authenticated `POST`
without a matching one):

```bash
curl -X POST https://<tenant host>/api/setup/test-smtp \
  -H "Origin: https://<tenant host>" \
  -H "Content-Type: application/json" \
  -H "Cookie: $IT_ADMIN_SESSION_COOKIE" \
  -d '{"host":"<relay host>","port":587,"user":"","password":"",
       "from_address":"noreply@example.org"}'
```

`host` and `port` name the transport under test. The endpoint accepts the ports
25, 465, 587 and 2525 and a host that resolves to a public address, and
`from_address` must be a full address (`name@domain.tld`); anything else is
answered with `400`. The Settings form applies the same port and host check when
it saves.

The catcher is not such a target: `mailpit` resolves to a private address on the
container network and listens on port 1025, and both are refused unless
`gremion-ui` runs with `SMTP_TEST_ALLOW_PRIVATE=1` (set it in `.env`, then
recreate the container; a restart does not read `.env` again). With it set,
`"host":"mailpit","port":1025` is accepted and the message shows up in Mailpit.
The rules are in [docs/security/test-smtp-guard.md](../security/test-smtp-guard.md).

The test mail goes to the signed-in admin's own address; the endpoint takes no
recipient. Leave `user` and `password` empty to authenticate with the tenant's
stored relay login (the same one real sending uses; it is attached only when
`host`/`port` name the relay the operator registered, never a host typed in
Settings). Fill both to try other credentials instead; a password without a
user is refused.

A success returns `{"success":true,"data":{"success":true}}`; an SMTP failure
returns `success:false` with an error text.

Both ways need a signed-in IT-admin session on a tenant host. The local dev stack
as shipped offers no browser session on port 3001
([LOCAL_TESTING.md](../LOCAL_TESTING.md#quick-start)), so they apply to a
deployment that serves the tenant through an edge; the Mailpit values and its web
UI apply only where that deployment runs the `dev` profile.

## Per-tenant SMTP resolution

gremion-ui mail is resolved **per tenant** through `tenant-mail.ts`, with two
entry points:

- `getTenantMailContext()` — returns a nodemailer transport bound to the
  **current ALS tenant**. Fail-closed: called outside a `runWithTenant` scope,
  `getTenant()` throws (no ambient default).
- `sendMailForTenant(msg)` — the single send-in-kernel wrapper. SMTP
  credentials never leave the kernel. Throws `SmtpUnconfiguredError` when the
  tenant's SMTP is not marked configured.

**Where each field comes from:**

| Field | Source | Notes |
|---|---|---|
| host / port / from | the tenant's `config.json` `smtp` block (Settings → E-Mail) | an optional registry override (below) wins when present |
| credential (user + password) | the registry row's `domain_profile.smtp` secret **ref** | NEVER in `config.json`; resolved via `resolveSecret` |
| on/off | `config.smtp.configured` | `false` ⇒ `sendMailForTenant` throws `SmtpUnconfiguredError` |

An optional per-tenant credential lives in the control-DB registry row:

```jsonc
// tenant.domain_profile
"smtp": {
  "host": "smtp.example.org",            // optional override of config.json
  "port": 587,                           // optional
  "from": "StuRa <noreply@t2.example>",  // optional RFC-5322 override
  "user": "t2-mailer",
  "passwordRef": "file:/run/secrets/tenants/t2-smtp-pass"
}
```

- `passwordRef` MUST be a `file:/run/secrets/tenants/<name>` ref (the host
  bind-mount source is `${TENANT_SECRETS_DIR:-./secrets/tenants}/<name>`) or an
  `env:VAR` ref. `resolveSecret` fail-closes on a bad scheme / missing file /
  path escape — a misconfigured ref throws loudly, it never silently sends
  unauthenticated.
- A `passwordRef` without a `user` is rejected (it would otherwise authenticate
  with an empty username) — the pair is required.
- TLS is implicit on port 465 (`secure: port === 465`). On every other port
  nodemailer upgrades with STARTTLS; when the tenant has a login (`user` +
  `passwordRef`) the upgrade is mandatory (`requireTLS`), so a session that does
  not offer STARTTLS fails before AUTH and the login never goes out in plaintext.
  A transport without a login (a local mail catcher) keeps the opportunistic
  upgrade.
- A refused login (`EAUTH`) stops a send loop at the first attempt: the content
  publish and the newsletter send fail with a clear status instead of presenting
  the same login once per recipient (mail servers lock the account after a few
  refused logins). Recipients after the refused one are not claimed, and the
  claim on the refused one itself is released (nothing was transmitted), so the
  next send after the login is corrected reaches all of them at once.
- The built transport is cached per `tenant.id` for `RESOLUTION_CACHE_TTL_MS`.
  A `config.json` SMTP edit becomes visible within that window; a lifecycle
  change (suspend / delete / re-provision) drops it **immediately** via
  `evictTenantRuntime → evictTenantMail`, which also `transport.close()`s
  pooled sockets — so a suspended tenant cannot keep an open SMTP connection,
  and a re-provisioned tenant picks up a rotated password on the next
  resolution.

> **Note:** `EMAIL_HOST_PASSWORD` appears in `.env.example` for historical
> reasons but is **not** read by any kernel code path. gremion-ui resolves the
> SMTP credential exclusively from the registry `passwordRef`. Per-tenant SMTP
> is the headline gate for any live second tenant — never provision a real
> additional tenant without writing its secret and `passwordRef` first.

## Switching a tenant to a real outbound relay (production)

Real SMTP credentials are an **operator action** (a long-lead external
dependency). Until they exist, a tenant sends no mail to the outside (on the
local stack it can use the catcher above) — nothing here blocks on them. When you have a relay (host, port, user, password) for a
tenant:

1. **Write the tenant's SMTP password** to the per-tenant secrets directory on
   the host, e.g.:

   ```bash
   printf '%s' "<the real password>" \
     > "${TENANT_SECRETS_DIR:-./secrets/tenants}/<slug>-smtp-pass"
   ```

   The directory is bind-mounted read-only into gremion-ui at
   `/run/secrets/tenants`. Bind mounts are live: a newly written secret file
   appears in the running container without a compose edit or recreate.

2. **Set the registry override** in the tenant's `domain_profile.smtp`
   (`host`, `port`, `user`, and
   `passwordRef: file:/run/secrets/tenants/<slug>-smtp-pass`) **before** the
   tenant is flipped `active`.

3. **Set host / port / from** in **Settings → E-Mail** to
   the relay values, and mark SMTP configured. (The registry override wins over
   `config.json` for host/port/from when present, but keeping them in sync keeps
   the UI honest.)

4. **Verify** before declaring it live. A `config.json` edit is picked up within
   `RESOLUTION_CACHE_TTL_MS`; a registry/secret rotation should be paired with a
   tenant evict so the transport is rebuilt. Then send a real test mail to your
   own address. A host runs no Mailpit (it is `profiles: [dev]` and a host
   renders with `COMPOSE_PROFILES=production`), so confirm by checking the
   recipient mailbox (and the relay's send logs), not the Mailpit UI. A tenant
   that still points at `mailpit:1025` on a host has nowhere to send.

## Bumping the Mailpit image

The image is pinned in `docker-compose.yml` by tag and digest
(`axllent/mailpit:v1.30.1@sha256:…`). Bump it deliberately: change the tag and
the digest together, then recreate it in the dev state project
(`STACK=dev IMAGE_TAG=dev docker compose -p dev-state up -d --force-recreate mailpit`)
and confirm the web UI still loads at `http://localhost:8026`. Do not use
`:latest` — tags drift (`make lint-image-digests` and `make lint-compose-latest`
refuse it).

## Files

- `docker-compose.yml` — `mailpit` service (`profiles: [dev]`) + `mailpit-data`
  volume; the `${STACK}_state` network.
- `docker-compose.override.yml` — Mailpit web-UI host-port mapping
  (`8026:8025`, loopback-only).
- `gremion-ui/src/lib/server/mail/tenant-mail.ts` — the single per-tenant mail
  seam (`getTenantMailContext`, `sendMailForTenant`, `evictTenantMail`).
- `gremion-ui/src/routes/api/setup/test-smtp/+server.ts` — the IT-admin
  test-mail endpoint (session + `Role.ITAdmin`, TASK-042 Q1).
- `.env.example` — `Outgoing Email / SMTP` section.
