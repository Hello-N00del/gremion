# Runbook — the operator control panel on its own host

How an install makes the operator control panel reachable at
`https://control.<PLATFORM_DOMAIN>` (or at a host name of its own choosing, see
"Choosing the host name") behind a **TLS client-certificate gate** at
the edge, and how the operator keeps that gate working: issuing a device
certificate, losing a device, rotating the CA, turning it off.

Throughout, `example.org` is the platform domain and `control.example.org` the
panel host. They are placeholders.

## Choosing the host name

By default the panel is served at `control.<PLATFORM_DOMAIN>`. An install whose
platform domain is a sub-domain (say `platform.example.com`) may want the panel on
a name beside it instead, such as `panel.example.com`, outside the platform domain.
That is one more key in `etc/env/state.env` (not in the app envs, which carry the
origin):

```
CONTROL_PANEL_HOST=panel.example.com
CONTROL_PANEL_ORIGIN=https://panel.example.com
```

- **Empty or absent means the default**, `control.<PLATFORM_DOMAIN>`: every install
  that never set it, and every step below, is exactly as described for
  `control.example.org`.
- **It must be a lowercase DNS host name**: at least two labels, letters, digits
  and hyphens. `gremion-render`, `gremion-verify` and the ops render refuse (exit 2,
  with the reason) a wildcard, a port, a scheme, a path, a trailing dot, an IP
  address, upper case, the platform domain itself, a platform host (`www`,
  `sales`, `mail`, `rs1`, `mta-sts`, `autoconfig`, `autodiscover` under the platform
  domain), `PILOT_TENANT_HOST`, and any line of `etc/tenant-hosts.txt`. A key that
  is set is checked even before the install opts in.
- **`CONTROL_PANEL_ORIGIN` must then be exactly `https://` followed by that name.**
  The render's existing equality refusal compares against it: the origin of the
  default name is refused as soon as a different host is configured, and the other
  way round. The panel still answers one host name only, so the key in `state.env`
  and both app envs must agree.
- **Fixed at the ops realm's creation, like the origin.** The ops realm's
  `control-panel` client is made exact to the origin (redirect URI and web origin),
  so the host name cannot be changed on an install whose realm exists: changing it
  needs a new ops realm (see "What the ops realm sets"). Choose it before the first
  `gremion-tenant init`.
- **The DNS record it needs** is the one the default name needs: an A (and AAAA)
  record for the name at the edge address, like the platform host. A name outside
  the platform domain is not covered by any record the platform's zone has, so
  create it by hand. `gremion-dns-check` still checks `control.<PLATFORM_DOMAIN>`
  (a reserved platform name); it does not know a custom host.
- **Do not give the name to a customer later.** The checks above can only see the
  names that exist when they run. A customer host equal to the control host would
  put the customer on the control router's rule. `control.<PLATFORM_DOMAIN>` stays
  reserved in the tenant registry whatever this key says; a name outside the
  platform domain is not, so the operator keeps it out of `etc/tenant-hosts.txt`
  and out of every customer's domains.
- **HSTS.** The router keeps the platform's HSTS policy, `includeSubDomains`
  included. A browser applies that to the host that sent it and the names below it,
  never to its parent or its siblings: on `panel.example.com` it covers
  `panel.example.com` and its own sub-names, not `example.com` and not a customer
  host.
- **Recreate Traefik after setting or changing the key.** The host pin the router
  chains (`edge-hostpin-control`) is a label on the Traefik container, and a label is
  read when the container is created; the deploy does not recreate the state
  project's services. On an install that set the key after Traefik was created, the
  live pin still stamps `control.<PLATFORM_DOMAIN>` and `gremion-verify` fails the
  control router for it. Recreate it from the release tree, the way upgrade step 7
  recreates PgBouncer (the edge is interrupted for the few seconds that takes):
  `docker compose --env-file /opt/gremion/etc/env/state.env up -d --force-recreate --no-deps traefik`,
  then `gremion-verify`. Do it before the deploy that opts in, on a fresh install it
  is not needed (Traefik is created with the key already in `state.env`).
- **Where the name is used** (all from the one key): the router's `Host` rule and
  the certificate order, the host pin the router chains
  (`edge-hostpin-control`, from the same key in the Traefik container's labels), the
  host list, the certificate SAN check and the handshake check of `gremion-verify`,
  the control probe target of the ops stack, the staging `extra_hosts` fragment, and
  the origin every tool compares.

## The model

Two locks, in this order:

1. **The edge asks for a client certificate** on `control.<domain>` and nowhere
   else. A connection without one, or with one the operator CA did not sign, is
   refused during the TLS handshake: no HTTP response, nothing of the panel is
   visible.
2. **The panel's own sign-in**: the ops realm (`platform`), password and TOTP,
   ACR `loa2`. Exactly as it was behind the tunnel.

It is **opt-in** per install. Without it nothing changes: the panel has no
route, and `gremion-tenant panel` prints the `ssh -L` line as before.

What the gate does **not** do: per-device revocation (revoking is rotating the
CA, below), WebAuthn, IP allow-lists. No page of the platform links to the
control host.

Two paths of the panel are never reachable through the edge: `/healthz` and
`/api/internal/` (the colour switch's evict call). The router's rule leaves them
out, so Traefik answers 404 for them, in every spelling it normalises to them.

## Where each piece runs

| Piece | Where | Holds |
|---|---|---|
| `gremion-operator-ca create`, `issue` | **your own machine** | the CA's private key (encrypted), the device keys |
| `gremion-operator-ca install`, `status` | the host | the CA **certificate** only |
| `etc/edge/mtls/operator-ca.pem` | the host | the CA certificate; refused if a private key is in it |
| `etc/edge/control-panel.yml` | the host, **rendered** by `gremion-render` | the router and the TLS option; never edited by hand |
| `docker-compose.control-public.yml` | named in `COMPOSE_FILE` of both app envs, **only on an opted-in install** | one network attachment: the panel joins the edge network under its colour alias, which Traefik dials. Without it the panel is on the app and state networks alone and is not a peer of the services that share the edge network |

The CA's key must never be on the host. `create` and `issue` refuse to run on
one. `gremion-render` and `gremion-verify` refuse a CA file that contains a key.

`gremion-operator-ca` needs **bash 4.4 or newer and OpenSSL 3**, and says so up
front when either is missing. Linux has both. macOS ships bash 3.2 and LibreSSL:
`brew install bash openssl@3` and put the Homebrew directories first on `PATH`.
On Windows run it in Git Bash (the OpenSSL of Git for Windows is enough: `create`,
`issue` and `verify` were run there) or in WSL.

## Turning it on (a fresh install)

1. **DNS.** `control.example.org` points at the edge, like the platform host
   (the DNS table already lists it). A host chosen with `CONTROL_PANEL_HOST` needs
   its own record at the edge address (see "Choosing the host name").
2. **The CA, on your machine.**
   ```sh
   gremion-operator-ca create --passfile <file holding a passphrase>   # or answer the prompt
   ```
   It writes `~/.gremion-operator-ca/ca.key` (encrypted) and `ca.pem`. Back the
   key up offline. The certificate is valid 1095 days by default.
3. **Your device's certificate.**
   ```sh
   gremion-operator-ca issue --name alices-laptop
   ```
   One PKCS#12 bundle per device, valid **90 days**, protected by a passphrase.
   At a terminal it asks for the bundle passphrase (twice) and for the CA
   passphrase; `--passfile` and `--p12-passfile` replace the prompts. It reads the
   finished bundle back against the CA and removes it, logging nothing, if that
   fails. Import it into the browser or the system store, then delete the file.
   `--compat` writes the older 3DES/SHA1 encryption for devices that cannot read
   the default.
4. **The CA certificate to the host** (`ca.pem` only, never `ca.key`):
   ```sh
   gremion-operator-ca install --ca ca.pem          # on the host
   ```
5. **The opt-in key**, the same value in `etc/env/state.env` and in **both**
   `etc/env/app-blue.env` and `app-green.env`, and the edge-network layer named in
   the `COMPOSE_FILE` of **both** app envs, right after `docker-compose.app.yml`:
   ```
   CONTROL_PANEL_ORIGIN=https://control.example.org
   COMPOSE_FILE=docker-compose.app.yml:docker-compose.control-public.yml:docker-compose.pins.yml
   ```
   (the second line is the app env's existing one with the overlay added; a host
   built by hand has no pins entry). With `CONTROL_PANEL_HOST` set (see "Choosing
   the host name") the origin is `https://` and that name, in all three files, and
   the host key itself goes in `state.env` only. Empty or absent means off. Anything else, the
   key without the CA file, the key without the overlay in an app env, or the
   overlay without the key, is refused by `gremion-render` (exit 2) and **leaves
   no router behind**. The panel answers one host name only (its `ORIGIN`), so
   there is no second origin and no mixed mode: the key must match in all three
   files. The same refusal catches **turning the key off in `state.env` alone**: an
   app env that still carries the key (or the overlay) is refused, because that
   colour would keep answering the public origin with nothing in front of it.
6. **Deploy.** `gremion-deploy` starts the panel with the new `ORIGIN`, joined to
   the edge network under its colour alias (through the overlay). Step 4
   (`gremion-render --defer-control-panel`) only **checks** the opt-in (the exact
   origin, the CA file, both app envs and their `COMPOSE_FILE`, the resolver) and
   refuses a half-configured one; it writes nothing. Step 9 verifies the new
   colour **before the switch** with `gremion-verify --control-after-switch`: an
   absent router is expected then, an existing one is still held to every check,
   and the panel being judged is the **new colour's** (its `ORIGIN` must be the
   opted-in one), because that is the panel the switch is about to make live. The
   router file is written right after the switch (step 10,
   `gremion-render --control-panel-only`), because it routes to the service
   `panel`, which only the switch writes into `active.yml`: a router earlier than
   its service is a disabled router and a red verify. The switch is handed this
   release's own `active.yml` template for the same reason (`current` still points
   at the previous release until step 12). Step 11 then verifies with no flag:
   the whole control path, against the live colour. Traefik reads the router file
   without a restart, and the control host's certificate is ordered then;
   `gremion-verify` waits for it (up to `CONTROL_CERT_WAIT_SECONDS`, 90 by
   default).

   **On a host built by hand** (`docs/ops/pilot-services.md`: no `gremion-deploy`)
   nothing runs step 10 for you, so `gremion-switch <colour>` renders the router
   itself when the key is set and the router file is missing (from the release
   `current` points at, or from the release whose template `gremion-deploy` hands
   it). A render that refuses (no CA certificate, an app env that disagrees with
   the key) does not undo the switch: the switch says so and prints
   `gremion-render --release <release dir> --control-panel-only`, which you run
   once what it names is fixed. `gremion-operator-ca install` says the same when
   it finds no router.
7. **Create the ops realm with the same origin.** On a fresh install
   `gremion-tenant init` takes the origin from the key; a `--panel-origin` that
   disagrees with it is refused. Then add the operators with
   `gremion-tenant operator add <email>`.
8. **Verify.** `gremion-verify` holds the whole path: the rendered file, its
   shape (the strict client-auth mode, once), the router Traefik reports, the
   chain, the CA file, and a TLS 1.2 connection **without** a certificate, which
   must end in a handshake alert. That refusal is the expected result for the
   control host.

## Turning it on for an install that is already running

The key is read at the **next deploy**, not by a render on its own. After you
set the three keys, the overlay and the CA, `gremion-deploy` does the right
thing in this order, even when the host has already switched once on this very
release: step 4 checks, step 6 and 8 recreate the colour with the new `ORIGIN`
and the overlay, step 9 verifies that colour (its `ORIGIN` is the opted-in one),
step 10 switches and writes the router, step 11 verifies the live path.

Do not run a bare `gremion-render` on such a host and expect the control host to
work. It would write the router at once, pointing at the colour that is **live**,
whose panel still carries the previous `ORIGIN` and is not on the edge network:
Traefik would report the router, `gremion-verify` fails with "the running panel's
ORIGIN is not CONTROL_PANEL_ORIGIN", and the panel answers 421 until the next
deploy recreates that colour. Nothing is made unsafe by it (the client-certificate
gate stands), but the host is not usable until the deploy.

There is no live migration of the ops realm: the origin it holds is the one it
was created with (see "What the ops realm sets", below).

**Rolling back across the opt-in.** `gremion-rollback` class (a) is a bare
`gremion-switch` back to the previous colour, and it does not render or verify the
control router. If that colour was started before the opt-in, its panel has the
loopback `ORIGIN` and is not on the edge network: the router (which stays) then
points at a panel Traefik cannot reach, so the control host does not work, and the
next `gremion-verify` names it. The client-certificate gate is untouched by this.
Roll forward (deploy again) to get the control host back, or turn the key off in all
three env files and deploy, as in "Turning it off".

## Using it

Open `https://control.example.org`. The browser offers the imported certificate
(choose it), then the ops realm asks for the password and the TOTP code.

## A device is lost, or someone leaves: rotate the CA

There is no per-device revocation list. A certificate the CA signed works until
it expires, so **revoking is replacing the CA**.

Replacing the CA ends the lost device's access on **every new connection**. It
does not reach what the device already has: a TLS connection that is open, or a
session it could resume, is not asked again. So also:

- **restart Traefik** (`docker compose --env-file etc/env/state.env restart
  traefik`, from the release tree): it drops every open connection and every
  resumption ticket, and
- **end the operator's sessions in the ops realm** (Keycloak admin console, realm
  `platform`, Sessions: sign out the affected operator, or all of them), so that
  the sign-in the device already holds is gone, not only its certificate.

1. On your machine, make a new CA in a new directory:
   `gremion-operator-ca create --dir ~/.gremion-operator-ca-2 --passfile ...`
2. On the host, replace the old one: `gremion-operator-ca install --ca ca.pem`
   (the plain form **replaces**). Every certificate the old CA signed stops
   working within seconds.
3. Issue fresh certificates for the devices that stay:
   `gremion-operator-ca issue --dir ~/.gremion-operator-ca-2 --name ...`

For a staged rotation, `install --ca new.pem --add` keeps the old CA beside the
new one. Once every device has a new certificate, run the plain `install` again.

How it takes effect (measured against the pinned Traefik, not assumed): Traefik
reads the CA file when it builds the TLS option and does **not** watch that file.
Replacing the file alone changes nothing. `install` rewrites the timestamp of the
router file, which makes Traefik rebuild the option and read the CA again. Do not
swap `operator-ca.pem` by hand without that.

## Expiry

- A device certificate: 90 days. Issue a new one before then; a device whose
  certificate ran out is refused like a stranger.
- The CA certificate: `gremion-verify` fails when it expires within
  `CERT_MIN_DAYS` (20). Make a new CA and rotate as above.
- `gremion-operator-ca status` (host) lists the installed CA certificate(s) and
  their expiry; `gremion-operator-ca verify FILE` checks a bundle or a PEM
  against a CA.

## Turning it off

Empty `CONTROL_PANEL_ORIGIN` in all three env files, take
`docker-compose.control-public.yml` out of the `COMPOSE_FILE` of both app envs,
and deploy. `gremion-render` deletes the router file; the recreated colour has the
loopback `ORIGIN` again and leaves the edge network; the panel is reachable through
`gremion-tenant panel` again. Turning the key off in `state.env` alone is refused
(an app env that still carries the key or the overlay), and `gremion-verify` fails
a running panel whose `ORIGIN` is not the loopback default on an install that has
not opted in. A realm already created for the control origin has to be recreated
for the loopback origin (a fresh init, below).

## What the ops realm sets for the control panel

Checked on the pinned Keycloak (`test/host/fixtures/executor/kc-ops-factor-probe.mjs`,
run against a scratch Keycloak that imports `realm-export.ops.json`):

- A password-only sign-in (ACR `loa1`) cannot delete the operator's authenticator
  through the account API (403), and cannot enrol another one without answering
  the existing one first.
- The ops realm has **no self-service password reset**: `resetPasswordAllowed` is
  `false`, the sign-in page carries no link and the endpoint answers 400.
  **Recovery of an operator's password is the host administrator's**: set a
  temporary password with `kcadm.sh set-password -r platform --username <email>
  --temporary ...` inside the Keycloak container; the operator changes it at the
  next sign-in. This is an operator decision recorded here, not a Keycloak default.
- The `control-panel` client carries `default.acr.values` and `minimum.acr.value`
  `loa2`, like the `grafana` client, so a token below `loa2` is never issued for it.

These apply to the realm **at its creation**. `gremion-tenant init` refuses an
existing ops realm whose template or origin differs from the one it is given
("differs from realm-export.ops.json"), **opted in or not**, so on any host
whose ops realm was made from the previous template `init` is refused until the
realm is brought up to this one. A clean install makes the realm from the new
template and needs nothing. For a host that keeps its realm there is no program,
but a short by-hand upgrade: `docs/ops/runbook/upgrade.md`, step 8a (the
password reset off, the unused required actions off, the client's two ACR
attributes and its description, then the re-stamp of the fingerprint), which the
refusal names when the **template** is what differs. That step starts with a
precondition: the realm's stored fingerprint must be the previous template's for
this origin, or the step stops. It does not change the origin: a realm made for
another origin is refused as an **origin** mismatch (the refusal says so and does
not offer step 8a), because the origin cannot be changed in place; the install
then needs a new ops realm.

The ops realm enables only the required actions it uses: the password, the
authenticator and the profile and e-mail ones. `realm-export.ops.json` lists the
server's whole default set (importing it yields exactly that list, measured) and
switches off the actions the realm has no use for.

The ops realm's sign-in paths (`/auth/realms/platform/`) sit behind their own
router with the auth rate limit (30 requests a minute, burst 10 per connection
address); before this nothing throttled them. This is where the password and the
second factor are checked, and where a guessing attack would land.

**The control host itself takes the portal tier** (100 requests a minute, burst 50
per connection address), not the auth tier. It serves the panel's pages, and one
first load of a page is the document plus about a dozen scripts, styles and data
requests sent at once from one address: measured against the pinned Traefik, the
auth tier let ten of thirty such requests through and answered the other twenty
with 429; the portal tier lets all thirty through and still answers a flood of 150
with 429 after the burst (`control-panel-mtls-proof.sh`, check 10).

## When something is wrong

| What you see | Cause |
|---|---|
| The browser shows no certificate prompt and the connection fails | no device certificate imported, or it is signed by a CA that is no longer installed (rotated), or expired |
| Connection closed, no TLS error from the server | traefik cannot build the option: `etc/edge/mtls/operator-ca.pem` is missing or not PEM. `gremion-verify` says so; traefik logs an error |
| `421` | the request's Host is not the host it was connected to (a proxy or a hand-made request) |
| `404` on `/healthz` or `/api/internal/...` | by design |
| `421` from the panel itself | `ORIGIN` differs from the host name used: the key must be the same in all three env files |
| `gremion-render` exits 2 naming `CONTROL_PANEL_ORIGIN` or `docker-compose.control-public.yml` | the key and what goes with it disagree: the exact origin, the CA file, a resolver, the same key in all three env files, the overlay in the `COMPOSE_FILE` of both app envs (and only with the key). No router is rendered |
| `gremion-verify`: "the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN" | the live colour was started before the key was set: deploy (the colour is recreated), do not just render |
| Traefik logs an unhealthy `panel` server on an install without the opt-in | expected: the service exists for every install, but only the opt-in overlay puts the panel on the edge network, and no router uses it otherwise |
| `gremion-verify` on an install without the opt-in: "not the loopback default" | the key was turned off but a colour still runs with the public `ORIGIN`: recreate it from its app env |
| `gremion-verify`: "the client-certificate gate is open" | the control host answered HTTP without a certificate: the rendered file was changed or another router names the host |

## Proof

`bash test/host/integration/control-panel-mtls-proof.sh` runs a throwaway Traefik
of the pinned image, file provider only, with certificates made by
`gremion-operator-ca` itself, and checks: no certificate and a foreign CA's
certificate are refused; a valid one reaches the backend, with the host pin and
HSTS; `/healthz` and `/api/internal/...` are 404 in thirteen spellings; other
hosts on the same entrypoint are not asked for a certificate; a request whose
SNI names another host (or none) gets 421; a missing or garbage CA closes the
host and nothing else; rotation behaves as written above; the rate limit admits
a first load of the panel and bites a flood.
The router file, the render and the verifier are covered by
`test/host/render.bats`, `verify.bats`, `operator-ca.bats`, `tenant.bats` and
`scripts/check-control-panel-access.test.mjs`; the compose overlay by
`scripts/check-pooled-stack.mjs`. The render and the verifier are also run
**together**, on one root, for the first opted-in deploy, for a host that has
already switched, and for a routine redeploy (`verify.bats`).
