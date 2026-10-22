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
  rendered (`gremion-mail-bringup` refuses with the reason).
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

Out of the box the stack does **not** relay mail to the internet. A `mailpit`
service (`axllent/mailpit`, pinned) runs on the internal `gremion_net` network
and **captures** every message instead:

- **SMTP** listens on `mailpit:1025` (internal network only — no host port, no
  auth, no TLS). Mailpit is configured to accept any/no SMTP auth
  (`MP_SMTP_AUTH_ACCEPT_ANY`, `MP_SMTP_AUTH_ALLOW_INSECURE`) so a tenant
  configured with empty credentials still hands off cleanly; nothing leaves the
  host regardless.
- **Web UI** is mapped to `http://localhost:8026` by
  `docker-compose.override.yml` (bound to `127.0.0.1` / `[::1]` only).

A tenant whose SMTP config points at `host=mailpit port=1025` with no auth
sends to the catcher with **zero** real credentials. Captured mail persists
across restarts in the `gremion_mailpit_data` named volume.

To point a tenant at the catcher, set host `mailpit`, port `1025` in
**Settings → E-Mail** (leave the test user/password blank), then mark SMTP
configured. The `default` tenant carries no registry override, so its
host/port/from come straight from its `config.json` and `auth` is undefined —
byte-identical to the auth-less Mailpit transport.

## Reading trapped mail

1. Open `http://localhost:8026` in a browser on the dev/staging host.
2. Every message any tenant sent appears in the inbox — subject, sender,
   recipients, raw source, and an HTML preview.
3. Nothing is delivered to real mailboxes, so it is safe to trigger password
   resets, committee/protocol notifications, etc.

## Sending a test mail

**Via the UI (gremion-ui):** Settings → E-Mail → set host `mailpit`, port `1025`,
an Absender-Adresse, then click **Test-E-Mail senden**. The message shows up in
Mailpit at `http://localhost:8026`.

**Via the test-smtp endpoint** (TASK-042 Q1: a signed-in session with the
IT-admin role; there is no setup token any more). The endpoint is rate-limited,
target-guarded (docs/security/test-smtp-guard.md) and opens an outbound connection to the body-supplied
`host:port`, so the cap also bounds its use as an SSRF/port-probe oracle. Send
the session cookie of an IT admin:

```bash
curl -X POST http://localhost:3001/api/setup/test-smtp \
  -H "Content-Type: application/json" \
  -H "Cookie: $IT_ADMIN_SESSION_COOKIE" \
  -d '{"host":"mailpit","port":1025,"user":"","password":"",
       "from_address":"noreply@localhost","to_address":"test@example.org"}'
```

A success returns `{"success":true,"data":{"success":true}}`; an SMTP failure
returns `success:false` with the transport error message.

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
- TLS is implicit only on port 465 (`secure: port === 465`); nodemailer
  auto-STARTTLSes on 587.
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
dependency). Until they exist, the stack keeps using Mailpit — nothing here
blocks on them. When you have a relay (host, port, user, password) for a
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

3. **Set host / port / from** in **Settings → E-Mail** (or the setup wizard) to
   the relay values, and mark SMTP configured. (The registry override wins over
   `config.json` for host/port/from when present, but keeping them in sync keeps
   the UI honest.)

4. **Verify** before declaring it live. A `config.json` edit is picked up within
   `RESOLUTION_CACHE_TTL_MS`; a registry/secret rotation should be paired with a
   tenant evict so the transport is rebuilt. Then send a real test mail to your
   own address. In production Mailpit is not exposed, so confirm by checking the
   recipient mailbox (and the relay's send logs), not the Mailpit UI.

> You may drop the `mailpit` service entirely in production by adding a
> `profiles:` guard or simply not relying on it — once every active tenant
> points at a real relay, no producer points at `mailpit` anymore. Keeping it
> running is harmless (internal-only) and useful for catching stray mail during
> a cutover.

## Bumping the Mailpit image

The image is pinned in `docker-compose.yml` (`axllent/mailpit:v1.30.1`). Bump
it deliberately: change the tag, then
`docker compose up -d --force-recreate mailpit` and confirm the web UI still
loads at `http://localhost:8026`. Do not use `:latest` — tags drift.

## Files

- `docker-compose.yml` — `mailpit` service + `mailpit-data` volume
  (`gremion_mailpit_data`); internal `gremion_net` network.
- `docker-compose.override.yml` — Mailpit web-UI host-port mapping
  (`8026:8025`, loopback-only).
- `gremion-ui/src/lib/server/mail/tenant-mail.ts` — the single per-tenant mail
  seam (`getTenantMailContext`, `sendMailForTenant`, `evictTenantMail`).
- `gremion-ui/src/routes/api/setup/test-smtp/+server.ts` — the IT-admin
  test-mail endpoint (session + `Role.ITAdmin`, TASK-042 Q1).
- `.env.example` — `Outgoing Email / SMTP` section.
