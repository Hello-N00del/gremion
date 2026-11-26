# Pilot services

The services a host install runs beside the kernel, for one customer by default
(a second customer is an opt-in: see "Two customers on one install"): files
(Nextcloud, Collabora), chat and video (Matrix, LiveKit, Element Call) and the
three module leaves (calendar, content, newsletter). They are compose services
in the state and app projects, switched on by profile, so a host that does not
want one never starts it. This page is the contract between the compose files,
the env templates, `gremion-init-secrets`, `gremion-render` and
`gremion-services`.

## Services

| Service | Project | Profile | Networks | Reachable by | Secrets it holds |
|---|---|---|---|---|---|
| `nextcloud-postgres` | state | `nextcloud` | `state` | `nextcloud` only | `NEXTCLOUD_DB_PASSWORD` |
| `nextcloud-redis` | state | `nextcloud` | `state` | `nextcloud` only | `REDIS_PASSWORD` |
| `nextcloud` | state | `nextcloud` | `state` | gremion-ui and the calendar leaf as `http://nextcloud`; no router | `NEXTCLOUD_ADMIN_PASSWORD` |
| `collabora` | state | `collabora` | `edge`, `state` | Nextcloud over `state`; browsers through a `/office` router on the tenant host | none |
| `livekit` | state | `video` | `edge` | signalling at `/livekit-sfu` on the platform host; RTC ports below | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `element-call` | state | `video` | `state` | gremion-ui proxies `/element-call`; no router | none |
| `messaging-postgres`, `matrix` | state | `messaging` (post-realm) | `matrix`: `edge`, `state` | `/_matrix` on the platform host | see Synapse below |
| `calendar-service`, `content-service`, `newsletter-service` | app (per colour) | `calendar`, `content`, `newsletter` | `app`, `state` | `<leaf>-<colour>` alias only: no edge network, no port, no router | `INTERNAL_<ID>_SECRET`, `<ID>_PG_PASSWORD` |

The leaves' database servers are the state project's `calendar-postgres`,
`content-postgres` and `newsletter-postgres`, which share their profile name
with the leaf. A leaf connects as that server's admin and creates one database
per customer itself.

Nextcloud, Collabora, Element Call and the leaves run as first-party images
built from this repository (`ghcr.io/hello-n00del/gremion-*`, tagged
`IMAGE_TAG`); every upstream base is pinned by digest in its Dockerfile.

## Profiles

`infra/host/module-profiles.json` states, per catalogue module, which compose
profiles it needs and why. `gremion-init-secrets` renders
`COMPOSE_PROFILES=production,<the profiles of every pilot module>` into
`state.env` and both `app-<colour>.env`; the env templates keep the bare
`production`. The pilot set today:

| Module | Profiles | Backend |
|---|---|---|
| board | `board` | leaf for a board in its own database `t_<tenant>__board` on `board-postgres` (`BOARD_BACKEND=auto` follows each customer's location flag) |
| calendar | `calendar` | leaf (`CALENDAR_BACKEND=service`) |
| content | `content` | leaf (`CONTENT_BACKEND=service`) |
| publishing | `newsletter` | leaf (`NEWSLETTER_BACKEND=service`, its only backend) |
| votes | `nextcloud` | in-process (the Polls client) |
| files | `nextcloud`, `collabora` | in-process (WebDAV with the user's own bearer) |
| messaging | `video`; post-realm `messaging` | in-process |

Board has a database of its own on `board-postgres`, created and exported by the module lifecycle.
Finance, vault, elections and handover render no profile. `messaging`
(`messaging-postgres` and `matrix`) is post-realm: Synapse refuses a blank
issuer at boot (unless `SYNAPSE_JWT_LOGIN=off`), so `gremion-services wire` adds the profile once the
customer's realm exists. The messaging module has no database of its own, so a
create with messaging ticked never connects to `messaging-postgres`.
`scripts/check-module-profiles.test.mjs` pins the map against
`modules/*/module.json` and the compose files.

## Ports and routing

- Nothing binds `0.0.0.0`. LiveKit publishes `7881/tcp` and
  `45000-45100/udp` on `EDGE_BIND_IP` and `[EDGE_BIND_IP6]` only; the
  nftables template already opens exactly those on the edge addresses
  (`infra/host/templates/nftables/gremion.nft.tmpl`). Nextcloud, Collabora,
  Matrix and Element Call need no other inbound port.
- Routers on the platform host, by docker label on the container: `/_matrix`
  to `matrix` and `/livekit-sfu` (prefix stripped) to `livekit`. Each carries
  `org.gremion.stack`, `traefik.docker.network=${STACK}_edge`, an explicit
  `tls.certresolver`, and a chain whose members the `traefik` service itself
  declares (`edge-hostpin-apex`, `edge-hsts-platform`, `edge-ratelimit-app`,
  `livekit-sfu-strip`). `/_synapse` (the admin API) is never routed.
- Collabora is routed per tenant host: `@gremion/edge-routers` emits a
  `tenant-<slug>.office` router (`Host(...) && PathPrefix(/office)`, service
  `collabora@docker`) beside each host's app router, with the same chain minus
  the proxy-trust stamp. The `collabora` container declares the service and a
  loopback-only anchor router on a reserved `.invalid` host, so Traefik
  generates no default router for it.
- Nextcloud and Element Call get no router: gremion-ui reaches Nextcloud
  directly and proxies `/element-call` so the call frame is same-origin with
  the tenant host (the CSP `frame-src` is `self`).

## Secrets and the pilot host key

All secrets are generated on the host by `gremion-init-secrets` and never
committed (see the table in [../ENVIRONMENT.md](../ENVIRONMENT.md#pilot-services-host-install)).
`PILOT_TENANT_HOST` is the one operator key the services add: the host of the
single pilot customer, permanent for the install. `gremion-render` renders
`docker/element-call/config.json` from its template (platform domain and
`PILOT_TENANT_HOST`; the output is gitignored, so a render never dirties the
release tree) and compose binds it at both paths Element Call reads it from.

`SYNAPSE_ADMIN_TOKEN` is not a free secret. It is the admin bot's access
token, printed once by `modules/messaging/synapse/bootstrap.sh`; the template
value is a placeholder that `gremion-services wire` replaces.

`TENANT_SECRETS_DIR` is rendered as `/opt/gremion/etc/secrets/tenants`,
outside the release tree (compose's default, `./secrets/tenants`, lies inside
it). `gremion-tenant` creates it `0700` for the deploy user before every run of
the tenant-create container and refuses a value that is absent, relative,
inside the release tree, or not a leaf apart from `etc/secrets/tenant-create`
and `etc/secrets/governance`.

## Host build

A host that builds the images from a git checkout has no release pins layers
(`docker-compose.state-pins.yml`, `docker-compose.pins.yml`: only the release
workflow writes them), and `gremion-validate-env` fails an absent
`COMPOSE_FILE` entry. `gremion-init-secrets --host-build` renders `COMPOSE_FILE`
without them. `IMAGE_TAG` then names the commit that was built.

## Wiring a customer: `gremion-services wire <slug>`

Run after the create request succeeded, once per install (it is idempotent).
Order of the whole install: `bootstrap.sh`, `gremion-init-secrets`, operator
keys filled, `gremion-render`, `nats-auth init`, images built from the pinned
commit, state and app up, `gremion-switch <colour>` (on an install that opted in
to the public control panel the switch also renders the control router, from
`current`: the router can only be written once the switch has written the panel
service; if the switch says it did not, run `gremion-render --release <dir>
--control-panel-only` and read what it refuses), `gremion-tenant init`, the isolation evidence (`gremion-isolation run`, then `record`), the create
request from the panel, `gremion-services wire <slug>`, then the vertical seed
and the member import.

`wire`:

1. checks that the customer's realm answers through the edge with the issuer
   `https://<PILOT_TENANT_HOST>/auth/realms/<slug>`, before it writes anything;
2. copies the realm's `synapse` client secret to
   `etc/secrets/synapse/oidc_client_secret` (`0600`; matrix mounts the
   directory read-only);
3. writes `SYNAPSE_KEYCLOAK_ISSUER_URL` and `SYNAPSE_KEYCLOAK_FETCH_URL` (the
   public issuer: the realm is `sslRequired=all`, which refuses a plain-http
   fetch of `keycloak:8080`; `GREMION_WIRE_FETCH_URL` overrides it) and adds
   the post-realm profile to `COMPOSE_PROFILES`;
4. starts `matrix` in a boot with `SYNAPSE_BOOTSTRAP_MODE=1` handed from the
   shell and runs the bot bootstrap unless the bot's token is already recorded
   and verified (`whoami`); the token is captured without being echoed or
   logged and written into `state.env` and both `app-<colour>.env`. A failure
   from here to step 5 recreates `matrix` without bootstrap mode on the way
   out (shared-secret registration is not left open), and the bootstrap's own
   error is shown;
5. boots `matrix` again without bootstrap mode (that closes shared-secret
   registration) and asserts `GET /_matrix/client/versions` and
   `GET /_matrix/client/v3/login` through the edge, the latter listing
   `org.matrix.login.jwt` (a failed realm key fetch boots Synapse without it,
   and `/versions` answers regardless). With `SYNAPSE_JWT_LOGIN=off` in
   `state.env` (default on; see "Chat switch-over runbook") steps 2 to 5 change:
   no synapse client secret is copied, no issuer or fetch URL is written (the
   profiles still are), the running `matrix` must carry `SYNAPSE_JWT_LOGIN=off`
   and the login flows must be exactly `m.login.application_service`. A value
   other than `on` or `off` is refused before anything is written;
6. registers Nextcloud's `user_oidc` provider (`--clientid=nextcloud`,
   bearer validation, `--unique-uid=0`), runs `occ richdocuments:activate-config`
   and reads back that `polls`, `user_oidc`, `richdocuments` and `groupfolders`
   are enabled (the image's install hooks warn instead of failing), that
   richdocuments has both `wopi_url` and `public_wopi_url` set, and that
   the provider has `settings.checkBearer` true and id 1, which
   `NEXTCLOUD_OIDC_PROVIDER_ID` defaults to; it also fetches the discovery URI
   from inside the `nextcloud` container (a certificate from an ACME staging
   directory fails here). When the calendar leaf runs it then creates the
   customer's CalDAV collection by `occ dav:create-calendar`, for the leaf's
   shared account, named by the `CALDAV_CALENDAR_TEMPLATE` the running leaf
   carries (`gremion-{slug}`), and reads it back; the leaf has no way to create
   the collection, and without a per-tenant target its CalDAV drain refuses
   every customer; under `MAIL_TRANSPORT=relay` it also wires the customer's
   mail login (step 6c below);
7. recreates `gremion-ui` and reads the bot token back from the running
   container;
8. the creation order (below): marks the customer wired and retries the unit
   resources that failed before the wiring.

### A customer on a secondary host

`wire <slug>` for a customer registered on a host listed in
`SECONDARY_TENANT_HOSTS` (see "A secondary customer host" below) runs a narrower
branch. The shared chat service is not touched (a secondary customer's chat, when
it is opted in, needs no wire step: the app makes the accounts and provisioning
the rooms) and the primary customer's Nextcloud provider `Keycloak` is never
set, so:

- step 1 checks the realm on the customer's registered host (issuer
  `https://<registered host>/auth/realms/<slug>`);
- steps 2 to 5 do not run: no synapse secret copy, no `state.env` write, no
  `matrix` start or recreate, no bot;
- before anything is written, the primary customer must be wired: the provider
  `Keycloak` must read back (read only) with `checkBearer` true and id 1, and the
  bot token the running `gremion-ui` carries must be the one in `state.env`.
  On an install whose primary wire never ran, the secondary wire stops here
  instead of taking provider id 1, which the primary's provider needs
  (`NEXTCLOUD_OIDC_PROVIDER_ID` defaults to 1);
- step 6 registers the provider `Keycloak-<slug>` with the realm's `nextcloud`
  client secret and `--unique-uid=1` (the primary's `Keycloak` uses raw Keycloak
  ids; a secondary realm's ids are hashed with its provider id, so it can never
  name an existing account of the primary customer), reads it back by that
  identifier (`checkBearer` true, unique-uid not off, the customer's discovery
  URI), prints its numeric id, and keeps the app and office
  checks (read only; `richdocuments:activate-config` and the callback URL stay
  the primary wire's); 6a runs only with `NC_PROVIDER_PER_CUSTOMER=on` in
  `state.env` (absent, empty or `off`, the default: the step does not exist and
  nothing is recorded; any other value is refused before anything is written).
  It records that id in the customer's registry row (`nc_target.providerId`,
  merged, read back), which the app then uses instead of
  `NEXTCLOUD_OIDC_PROVIDER_ID` for this customer's Nextcloud accounts. The
  primary customer keeps the env value in every case, and switching the key off
  again does not remove an id already recorded. Accounts under such a provider
  carry the ids user_oidc derives for it (see `--unique-uid=1` above), not the
  raw Keycloak id, and the app does not address them that way yet (group
  membership, file access and erasure use the raw Keycloak id). The switch is
  NOT YET SAFE: leave it off until the app addresses derived ids; 6b creates the customer's CalDAV collection and 6c
  the mail login;
- step 7 does not recreate `gremion-ui`: the mail login writes the customer's
  registry row and `config.json`, which the app re-reads within about a minute,
  so no other customer's app restarts;
- step 8, the creation order, runs as for any customer.

A registered host that is neither `PILOT_TENANT_HOST` nor listed is refused
before anything is written. This is a host program (a CD state-tier hold): it
reaches the install through the operator's apply.

### Step 8: the creation order (create, wire, seed)

The order is create, then `wire`, then the vertical seed. Nothing forbids the
other order, and a vertical seeded before `wire` leaves every unit's chat room
failed, because the app had no bot token yet; the app's own retry backs off for
up to an hour and gives up after a day. So `wire` ends with two things, both
after `gremion-ui` is recreated with the token:

- it merges `servicesWiredAt` into the customer's registry row
  (`domain_profile`; the keys it holds stay). The control panel reads it: the
  customer page warns before a vertical is seeded for a customer that is not
  wired yet, names the order, and still queues the seed;
- it puts every `failed` row of the customer's provisioning ledger back to
  `pending` and due now (attempts and the give-up clock cleared), waits for the
  app's worker (a tick a minute; `GREMION_SERVICES_RETRY_WAIT_S`, default 150 s)
  and reports how many org units it repaired. Rows that fail again, or that
  the worker has not reached in time, are reported as warnings and do not fail
  the wire: the wiring is done, and the committee page's "Erneut provisionieren"
  retries a single unit.

With nothing failed the step says so and changes nothing. A customer wired
before this step existed is recognised by the relay `smtp` entry the same wire
wrote; under another mail transport it shows the panel's warning until `wire`
has run once more (it is idempotent).

`wire` takes the host lock (`runtime/hostd.lock`, non-blocking: another host
operation holding it is `busy`, exit 3), and when run under `sudo` it hands each
file it rewrites back to the owner it had.

Post-conditions are read from the running system (container environment, the
edge's answers, `occ`), never from an exit code. No secret is on a host argv:
the client secret reaches `docker exec` by name (`-e NAME`), and the bot token
only through files and shell variables. The one named exception is `occ`'s own
argument vector inside the `nextcloud` container, which carries the client
secret for the length of the call because `occ` has no other input.

### Step 6c: the customer's mail login (relay transport only)

With `MAIL_TRANSPORT=relay` (`etc/env/mail.env`) every mail of the app, the
invitations and the newsletter included, goes through the one relay login.
`wire` sets it up after the calendar collection and before the `gremion-ui`
recreate, so no separate restart and no hand step remain. Under any other
transport it does nothing and says so.

Preconditions, checked with the other facts before anything is written: the
password file named by `RELAY_SMTP_PASSWORD_REF` (default
`etc/secrets/mail/relay-password`) exists, is not empty, belongs to the owner of
`etc/secrets` and is mode `0600`; `RELAY_SMTP_HOST`, `RELAY_SMTP_PORT`,
`RELAY_SMTP_USER` and `RELAY_FROM_DOMAIN` (the domain the relay signs; it
defaults to `PLATFORM_DOMAIN`) are read from `mail.env`, none is hardcoded. An
empty `RELAY_SMTP_USER` is a relay that allows the host by address: no password
is copied and the entry carries no login.

1. copies the password file to `<TENANT_SECRETS_DIR>/relay-smtp-password`
   (`0600`, the directory's owner), on every run, so a rotated password
   propagates. It goes through a pipe: it is in no variable, no argv and no
   output;
2. merges `smtp` into `tenant.domain_profile` of the control database
   (`domain_profile || jsonb_build_object('smtp', ...)`, so `residencyZone` and
   every other key stay): `host`, `port`, `from` (`"Gremion"
   <no-reply@<from domain>>`), `user` and `passwordRef`
   (`file:/run/secrets/tenants/relay-smtp-password`). The values are psql
   variables, never part of the SQL text; the row is read back and every other
   key must be unchanged;
3. writes `smtp.configured: true`, `host`, `port` and `from_address` into the
   tenant's `config.json` from inside the `gremion-ui` container that owns the
   volume (a temporary file, then a rename, owner and mode of the old file
   kept) and reads the file back. Without `configured` every app mail throws
   `SmtpUnconfiguredError`, even though the registry entry is set. This replaces
   the hand edit of the Settings page's mail step;
4. reads from the running container, before and after the recreate, that
   `/run/secrets/tenants/relay-smtp-password` is readable and not empty.

A restored copy of the instance does not keep this login: `gremion-neuter`
points the row's `smtp` entry (`host`, `port`) at the sink, removes its `user`
and `passwordRef`, and empties `<TENANT_SECRETS_DIR>/relay-smtp-password`,
beside the env files, the `config.json` files and the realms.

Not done by `wire`: one test mail to the operator's address (named residual
below), and the first Settings save, which is not needed any more.

## Video: relay over TLS on 443

Media reaches LiveKit on `45000-45100/udp` or, from a network that blocks UDP, on
`7881/tcp`. A client behind a network that allows only 443 uses LiveKit's TURN
relay over TLS instead: it connects to `turn.<PILOT_TENANT_HOST>` on 443,
Traefik terminates TLS there (an ACME certificate from the same resolver as the
HTTP routers) and hands the plain stream to LiveKit's TURN port `5349`. LiveKit
gives its ICE servers to the client, so no client change is involved.

- **Where it is configured.** `PILOT_TENANT_HOST` in `state.env` reaches both
  halves. `gremion-render` renders `docker/livekit/livekit.yaml` from
  `docker/livekit/livekit.yaml.tmpl` (gitignored, bound read-only; a config that
  was not rendered refuses `up`) with `turn.enabled: true` and
  `domain: turn.<PILOT_TENANT_HOST>`. `docker compose --env-file state.env` reads
  the same key for the Traefik labels of the `livekit` service in
  `docker-compose.prod.yml`: one TCP router `livekit-turn`, rule
  ``HostSNI(`turn.<PILOT_TENANT_HOST>`)`` on `websecure`, `tls=true`, the
  `TRAEFIK_CERT_RESOLVER` resolver, never passthrough, to port `5349`.
- **Port split.** The published block is unchanged: `45000-45100/udp`. Media
  takes `45000-45050`, the relay's allocations `45051-45100`. `3478/udp` is not
  published. `7881/tcp` stays the media fallback. Nothing in the firewall
  template or the edge guard changes.
- **Capacity.** The relay has 50 ports, about 25 relayed participants at once (a
  relayed participant uses a port to send and one to receive). A call between
  clients that reach the media ports directly does not use them. LiveKit has one
  CPU core (and 512 MiB) for the relay's crypto and the media it forwards.
- **Install prerequisite.** A DNS record `turn.<customer host>` pointing at the
  host's edge address, in place before the first `up` of the video profile:
  without it the certificate cannot be issued and relayed clients cannot connect
  (direct media is unaffected).
- **Without `PILOT_TENANT_HOST`** the relay is off exactly as before: no TCP
  router label is read by Traefik, no certificate is ordered, and LiveKit keeps
  the whole `45000-45100` block for media. `gremion-render` refuses a value that
  is not a lower-case host name.
- **Verification.** `gremion-verify` still refuses every TCP or UDP router on
  `web` or `websecure`, with one exception: the TCP router named exactly
  `livekit-turn@docker` on `websecure` alone, rule exactly
  ``HostSNI(`turn.<PILOT_TENANT_HOST>`)``, a non-empty `tls.certResolver`, not
  passthrough. A second TCP router next to it, a UDP router, and any router when
  `PILOT_TENANT_HOST` is unset stay failures.

## Two customers on one install

An install has one customer, and that is the default. Everything above this
section describes it, and nothing in this section changes it: every switch below
is **off by default** (absent or empty means off, or the old behaviour), and an
install with one customer renders, starts and answers exactly as it does without
them. This section is for an operator who adds a second customer on a host of its
own, for example a canary or test customer beside the real one. It says what that
customer gets, in which order to set it up, how to switch chat over, and what
stays shared.

The second customer has its own host, realm, kernel database, module databases
and tenant config. It shares the install's one Nextcloud (with Collabora), one
Synapse (with LiveKit and Element Call), one Keycloak, one Postgres server per
service and one edge. What a module gives it therefore depends on where that
module's data lives: in the customer's own database (board, calendar) or on a
shared service (files, votes, messaging and video).

### The switches

Read from the code that acts on them, not from a plan.

| Switch | File | Default | Read by | Applying it recreates |
|---|---|---|---|---|
| `SECONDARY_TENANT_HOSTS` | `state.env`; the same line in both `app-<colour>.env` | empty: one customer host | the host-side create, the module guard, `gremion-services wire`, `gremion-validate-env`; the state compose reads it for Nextcloud's trusted editor hosts and Collabora's `server_name`; the app compose passes it to the control panel for the note on "Neuer Mandant" only | with a value, `nextcloud` and `collabora` of the state project (their environment changes: the first customer's files and office restart once) and, on the next deploy, the control panel |
| `SECONDARY_TENANT_MODULES` | `state.env`; the same line in both `app-<colour>.env` | empty: only `board` and `calendar` | the create and the module guard (through `secondary_optin_load`), `gremion-validate-env` | nothing: it is read when a customer is created or a module is enabled. The app compose does not pass it to the control panel, so the note on "Neuer Mandant" stays the core-only one |
| `SYNAPSE_JWT_LOGIN` | `state.env` | `on` (absent counts as on) | the `matrix` container (render, entrypoint, health check), `gremion-services wire`, `gremion-validate-env` | `matrix` (chat restarts for every customer) |
| `MATRIX_IDENTITY` | both `app-<colour>.env` | `legacy` (absent counts as legacy) | the chat code of `gremion-ui` on every call; the validator, for the messaging opt-in | `gremion-ui` of that colour: the active one when `wire` step 7 or a deploy recreates it, the other when it is next switched to |
| `NC_PROVIDER_PER_CUSTOMER` | `state.env` | `off` | `gremion-services wire`, secondary branch, step 6a | nothing; read when a secondary customer is wired. NOT YET SAFE: see the operating limits below |

`gremion-validate-env` accepts only `on` or `off` for `SYNAPSE_JWT_LOGIN` and
`NC_PROVIDER_PER_CUSTOMER`, judges `SECONDARY_TENANT_MODULES` (a space-separated
list of the fixed opt-in ids, refused without `SECONDARY_TENANT_HOSTS`), and reads
`MATRIX_IDENTITY` only for the messaging opt-in. The app judges `MATRIX_IDENTITY`
itself: an unknown value is not read as `legacy`, chat refuses with the German
503, so a typo can never fall back to the shared-username identity.

### A secondary customer host

`PILOT_TENANT_HOST` stays the first customer's host. These stay bound to it: the
video relay's name (`turn.<PILOT_TENANT_HOST>`), the Element Call config file the
install renders, the leaves' `PUBLIC_BASE_URL` setting (the links of a mail no
longer use it), `COLLABORA_PUBLIC_URL`
as Nextcloud's installer reads it, the first customer's Nextcloud login provider
`Keycloak`, and the Synapse issuer while `SYNAPSE_JWT_LOGIN` is `on`. What the
code makes per request host is described per module below.

**Switch it on.** Add `SECONDARY_TENANT_HOSTS=canary.example.org` (comma-separated
lowercase DNS names, no scheme, port, path or wildcard) to `etc/env/state.env`, and
the same line to both `app-<colour>.env` so that "Neuer Mandant" shows it (the
panel only displays the list; the host-side create reads `state.env` and nothing
the request says). `gremion-validate-env` refuses a malformed list, a duplicate,
the platform domain, a platform host, the control panel host, `PILOT_TENANT_HOST`
and its `turn.` relay host. Empty or absent means exactly one customer host, as
before, with the state compose rendering unchanged. With a value, Nextcloud's
trusted editor hosts (`NEXTCLOUD_PUBLIC_HOSTS`) grow by the listed hosts, and
Collabora's `server_name` is left empty so that it names the host of each request
(Traefik keeps it): with one fixed name a page on the second host would be told
to use the first.

**The default is core-only.** A customer on a secondary host gets login, board
and calendar, each on its own host, realm and databases. The calendar's own data
is the customer's; only its optional CalDAV mirror into the shared Nextcloud
needs the customer's own collection, which `gremion-services wire <slug>` creates
for it (the leaf cannot create one itself; a push that finds no collection fails
and is given up after three attempts per entry). Until `wire` has run for the
customer, nothing is written to the shared service. Every other module is refused
by default (default deny: `SECONDARY_HOST_MODULES` in `infra/host/lib/common.sh`).

**The host side enforces it** instead of leaving it to the operator:

- the create accepts `PILOT_TENANT_HOST` and a listed host and refuses every other
  host, naming what is allowed; on a secondary host it refuses, before anything is
  created, any module that is neither `board`, `calendar` nor opted in below;
- the customer's tenant config is created with every other module switched off
  (`SECONDARY_HOST_MODULES_OFF`, less the opted-in ids), because a config reads a
  module as on until it says otherwise, and with those ids listed as
  `pinned_off_modules`. The app pins every listed module off on each read and
  write of the module switches, and the list is not part of any settings update:
  neither a settings change nor "Konfiguration zurücksetzen" by the customer's own
  IT admin can switch such a module back on, and the provisioning worker and the
  route gate read the pinned value;
- the protocol routes (create, editor URL, publish, public PDF, detail) are
  governance and always on, so they read the current customer's files switch
  instead of the build-wide document port: with it off, minutes live in the app
  only (the in-app text), and the shared Nextcloud and Collabora are not called
  for that customer;
- the module enable (executor, council admin and break-glass alike) refuses the
  same modules for a customer registered on a secondary host;
- `gremion-services wire <slug>` takes a customer registered on a listed secondary
  host through its own, narrower branch (see "A customer on a secondary host"
  under the wire steps), and refuses a customer whose registered host is neither
  `PILOT_TENANT_HOST` nor an entry of `SECONDARY_TENANT_HOSTS`, before it copies a
  secret, writes a key or starts a container.

### What a secondary customer gets per opted-in module

`SECONDARY_TENANT_MODULES` is a space-separated list of catalogue ids from a
**fixed set**: `files`, `votes`, `messaging`. An id outside the set is refused by
`gremion-validate-env` and never allowed, whatever the key says; so is a
duplicate. `publishing` and `content` are outside the set (see the table). The
list is read from `state.env` when a customer is created and when a module is
enabled for it: the create leaves the listed modules out of the customer's
switches and out of `pinned_off_modules`, and the module guard lets them through.
A refused list is handled differently by its two readers. The **create** of a
customer on a secondary host stops at once with "nothing was created", even for a
customer that wants board only, because the list is judged before anything is
made. The **module enable** (the guard in the host's customer operations) opts
nothing in: a refused list leaves the core modules and lets a first customer's
enable through unchanged, and a refusal for a secondary customer then names the
list. The create of the first customer never reads the list.

| Module | What the customer gets | What stays shared or is not given |
|---|---|---|
| board (core) | its own board, in its own kernel or board database as its location flag says (`t_<hex32>__board` once the board lives in the board module's database) | nothing shared |
| calendar (core) | its own calendar leaf database; the CalDAV mirror goes to the customer's own collection (`gremion-<slug>`) of the leaf's shared Nextcloud account, created by `wire` step 6b | the Nextcloud account that owns the collections is the one install-wide account |
| files | one group folder per org unit on the shared Nextcloud, with its own group `ou-<unit id>`; a folder is adopted on a retry only when it carries that unit's own group (the mount point alone proves nothing on a shared instance); the editor URL is built on the request's own host, which Nextcloud trusts and Collabora names; the retained-records folder and its groups are named per tenant | one Nextcloud, one Collabora, one `richdocuments` configuration; the Nextcloud accounts are the open point named in the operating limits |
| votes | polls on the shared Nextcloud Polls: every poll is created by the install's one Nextcloud admin account and bound to the customer by a leading marker `[gt:<tenant id>]` in its title; every list and by-id read checks it, and another customer's poll answers 404; the poll pages and routes read and vote with the acting member's own bearer when the request has one (Karenz and retained copies use the admin account) | the Polls app and its database are shared; the binding is the app's marker, not a Nextcloud group |
| messaging | its own Matrix accounts `<slug>.<escaped username>`, its own unit rooms (alias `#stura.<slug>.<unit>`), archive aliases (`#stura-archiv.<slug>.<unit>-<time>`) and meeting rooms (`#meeting.<slug>.<event>`); every room carries a tenant marker state event written by the admin bot, and a room found behind an alias is adopted only when that marker names the customer; video calls: the call frame's config names the requesting host's own token service, and the participants' names drop the customer prefix | one Synapse and one LiveKit; the alias directory is global; see the switch-over below, the three switches it needs, and the operating limits |
| publishing, content | refused for a secondary host: the module id is not in the fixed set | the leaves now ask the kernel for the sending customer's own link base on every send (`/api/internal/newsletter/link-base`, `/api/internal/content/link-base`), but the set is fixed in `infra/host/lib/common.sh`: widening it is a code change, not a key. The refusal text of `gremion-validate-env` for `publishing` still gives the older reason (the mail links), and the content news editor still keeps its drafts in the shared Nextcloud and opens them in the shared Collabora |

`messaging` needs three switches before the list is accepted, and the validator
names only the ones that are missing: `SYNAPSE_JWT_LOGIN=off` in `state.env` and
`MATRIX_IDENTITY=namespaced` in `app-blue.env` and in `app-green.env`. They are the
chat switch-over below. The check reads those env files and nothing else: neither
the create nor `gremion-validate-env` asks the running `matrix` or `gremion-ui`. So
the three lines being written is not the switch-over being done. With the lines
written but not applied, the create passes while `matrix` still offers the JWT
login and the running `gremion-ui` is still on the legacy identity, which builds
chat without the namespaced accounts. Apply the switch-over and read it back first
(the login flows read back from the running `matrix`, then the wire of the first
customer, which recreates `gremion-ui`), and only then list `messaging`.

### Order for a second customer

1. DNS for the second host, pointing at the host's edge address. The realm must
   answer publicly on it, with a certificate the install trusts: the secondary
   wire stops at its first step otherwise (an ACME staging certificate fails
   there).
2. `SECONDARY_TENANT_HOSTS` in `state.env` and both app files; `gremion-validate-env`;
   apply it (Nextcloud and Collabora recreate, see the switches).
3. Only for messaging: steps 1 to 5 of the chat switch-over below, applied and read
   back from the running services (the next step's check reads only the env files),
   before the next step.
4. `SECONDARY_TENANT_MODULES` in `state.env` and both app files (`gremion-validate-env`
   again; it names a missing chat switch).
5. Create the customer from the panel with the secondary host. Add the host to
   `etc/tenant-hosts.txt` (certificate and DNS checks), and point `CD_PROBE_HOST` at
   it if it is to be the CD canary. A customer that exists already keeps the pins
   it was created with (there is no unpin verb): to give it a module that was
   outside the list at its creation, it is deleted and a new customer is created
   under a new slug (a deleted slug stays reserved).
6. The first customer must be wired before the second: `gremion-services wire <primary
   slug>`, then `gremion-services wire <slug>` for the second (its secondary branch).
   The secondary wire reads the first customer's provider and the bot token the
   running app carries, and stops before writing anything when either is missing.
7. The probe's fixture, made by hand in both customers (header of
   `infra/host/bin/gremion-isolation-live`): an org unit named `isoprobe` with its
   chat room and files folder, a member `isoprobe` in it, a file
   `isoprobe-<slug>.odt` in the folder, a poll and a calendar event titled
   `isoprobe-<slug>`.
8. `gremion-isolation-live <slugA> <slugB>`, and read every section. It is
   report-only and does not feed the enable gate; what its verdicts prove is on
   [isolation-evidence.md](isolation-evidence.md). A customer that opted in only to
   files and votes has no chat: the chat and call sections read NOT-ENABLED and the
   run exits 3, which is not a pass.

Decommission a secondary-host customer before removing its host from the list, and
remove its objects on the shared services by hand
([../runbooks/tenant-lifecycle.md](../runbooks/tenant-lifecycle.md), "A customer on
the shared Nextcloud and Synapse").

### Chat switch-over runbook

Chat on a homeserver that several customers share needs the chat service to offer
no login of its own and the app to name every account by customer. Both are
deployment switches, and they are one change: chat is down for every customer,
the first included, between the first step and the last. Plan a window.

- With `SYNAPSE_JWT_LOGIN=off` and `MATRIX_IDENTITY=legacy`, the app's login (by
  JWT) has no flow to use and chat is broken.
- With `MATRIX_IDENTITY=namespaced` and the JWT or single sign-on login still
  offered, chat refuses with the German 503 (the app asks the homeserver's login
  flows and remembers a clean answer for a minute): in that mode the app is the
  only party that decides which Matrix account a login is.
- `MATRIX_IDENTITY=namespaced` renames every chat identity: `@max:<server>` becomes
  `@<slug>.max:<server>`, and new unit rooms get `#stura.<slug>.<unit>` aliases.
  Existing legacy accounts are not renamed or merged: members get new accounts.

**The decision.** The operator decides, and records it, between two ways:

- **a wipe**, only while chat holds test data. It removes every account, room,
  message and media file of every customer on that homeserver, and the admin
  bot's registration. The data is two volumes of the state project:
  `messaging-pg-data` (the Synapse database) and `synapse-data` (media and the
  homeserver's signing key), which compose names `<project>_<volume>`: read the
  full names from `docker volume ls`. Stop `matrix` and `messaging-postgres`, remove
  those two containers by name (`docker volume rm` refuses a volume that even a
  stopped container still references), then remove the two volumes by name. Never
  the project's other volumes and never with `down -v`. Applying the state project
  in step 3 creates the containers and empty volumes again;
- **a migration of the existing accounts** to the namespaced names. It is **not
  built**: nothing in this repository renames accounts or moves rooms. A homeserver
  that holds a real customer's chat is not wiped, and until a migration exists it
  does not take the switch-over.

One more fact belongs to the decision. A unit whose chat room was provisioned
before keeps its room id in the customer's provisioning ledger as a finished
resource, and the app reuses a finished row as it is. After a wipe those room ids
no longer exist, and the committee page's "Erneut provisionieren" and the retry in
`wire` step 8 (which only puts failed rows back) do not create the room again. No
verb in this repository clears those rows: settle how before wiping, or the
first customer's existing units stay without a room.

**The steps.**

1. Stop chat: announce the window and stop `matrix` (state project).
2. Wipe or migrate, as decided above. A migration has no step here.
3. `SYNAPSE_JWT_LOGIN=off` in `etc/env/state.env`; `gremion-validate-env`. Applying
   it recreates `matrix`: the render then has no JWT login and no single sign-on
   provider (no realm key fetch, no issuer needed), and the container's health
   check reads unhealthy while either flow is offered. Read the flows back from the
   running service: `GET /_matrix/client/v3/login` through the edge lists exactly
   `m.login.application_service`.
4. `MATRIX_IDENTITY=namespaced` in **both** `app-blue.env` and `app-green.env`. With
   `SYNAPSE_JWT_LOGIN=off` a colour left on `legacy` has no login flow to use, so
   chat is broken as soon as that colour is switched to (the first bullet above),
   and it would provision accounts under the legacy identity. Applying it recreates `gremion-ui` of the colour: `wire` step 7 recreates the
   active one in the next step, the other colour carries it when it is next
   deployed or switched to.
5. Re-wire the first customer: `gremion-services wire <primary slug>`. With the
   switch off it copies no Synapse client secret, writes no issuer or fetch URL,
   recreates `matrix` out of bootstrap mode, registers the admin bot again if its
   token no longer verifies (after a wipe it is registered afresh), asserts the
   login flows are exactly the expected set, and recreates `gremion-ui`.
6. For a second customer with chat: list `messaging` in `SECONDARY_TENANT_MODULES`
   (the validator now accepts it), create the customer, and `gremion-services wire
   <slug>`. The secondary wire does not touch `matrix`: that customer's accounts are
   made by the app on first use and its rooms by provisioning.
7. Probe: log in as a member of each customer and open a room (the app mints the
   token itself), then `gremion-isolation-live`. Both customers need messaging
   for the chat and call sections to judge anything.

### Operating limits of two customers on one install

What is shared or not available, named so that nobody reads more into the setup
than it gives:

- **One TURN relay name.** The video relay on 443 is `turn.<PILOT_TENANT_HOST>`
  with one certificate, one LiveKit key pair and one signalling endpoint
  (`/livekit-sfu` on the platform host) for every customer; its 50 relay ports are
  shared. A second customer's calls use the first customer's relay name.
- **Shared Synapse and Nextcloud databases and backups.** All customers' chat is
  in one Synapse database and media volume and all customers' files and polls in
  one Nextcloud database and data volume. The install's backups of them are
  per install: there is no per-customer restore, and a deleted customer's data
  stays in those backups until they rotate out. Teardown on the shared services
  is manual.
- **No unpin verb.** A secondary customer keeps the `pinned_off_modules` it was
  created with. Changing the opt-in does not change an existing customer; a
  customer that needs another module is created again under a new slug.
- **Device continuity is lost under app-minted Matrix logins.** The login the app
  mints for a namespaced account belongs to no device and ends at a time the app
  sets; a device id the client presents is ignored. Clients that keep device-bound
  keys start a new device on each login.
- **`MESSAGES_BACKEND=service` is held.** The service backend still logs in by JWT.
  With `MATRIX_IDENTITY=namespaced` chat refuses (the German 503) in that mode;
  the pilot compose sets no such key.
- **Nextcloud account addressing (open).** The secondary wire registers the
  customer's provider `Keycloak-<slug>` with `--unique-uid=1`, so an account
  created for its members by a bearer carries an id that `user_oidc` derives from
  the provider and the Keycloak id. The files module creates the accounts it
  provisions under the provider named by `NEXTCLOUD_OIDC_PROVIDER_ID` (the first
  customer's, raw Keycloak ids), or, with `NC_PROVIDER_PER_CUSTOMER=on`, under the
  customer's own provider id, and in both cases names the account by the raw
  Keycloak id in group, file and erasure calls. Whether a secondary customer's
  member then reaches its group folders is not shown by anything in this
  repository. The switch is **off** and says it is not safe: leave it off and treat
  files for a secondary customer as unproven. The probe's files section does not
  settle it: it addresses the fixture user's Nextcloud account by the Keycloak
  subject (WebDAV path and `occ user:info`), so for accounts under derived ids it
  does not PASS (a failed positive control reads FAIL, a missing account
  NOT-READY): read that as a finding about the setup. The votes code does not name
  Nextcloud accounts by id: it acts with the member's bearer or the admin account.
- **Content and publishing** are not available to a secondary customer (table above).

### Evidence for two customers

What exists: the recorded cross-customer cases at the app layer against recording
fakes of one shared Nextcloud and one shared Synapse, including two customers on
one homeserver in the namespaced identity (see
[isolation-evidence.md](isolation-evidence.md)); and `gremion-isolation-live`, the
host program that probes the running stack in both directions. What is owed:
one host run of that program on the install that uses this, with its output kept
beside the run; nothing in this repository records one. Do not cite the app-layer
cases as a statement about Nextcloud's or Synapse's own authorisation.

Also owed after the deploy that first uses it: the realm's discovery document at
the secondary host names that host as issuer; a login on it; the customer's edge
router listed and enabled in `gremion-verify`; a CD run with `CD_PROBE_HOST` set to
it; a document of each customer opened by hand on its own host, with save and
close (the probe leaves them unproven); with messaging, one message and one call
between two members of each customer.

**Operating notes.**

- A secondary-host customer's tenant config file carries its `pinned_off_modules`
  list: back it up and restore it as a whole.
- The CD canary: with `CD_PROBE_HOST` set to the secondary host, the public probe
  asks only that customer's `/readyz` and login page. It catches nothing about
  chat, files, office editing or video, which run on the shared services whatever
  the canary's modules; those need their own checks.


## Named residuals

- **Leaf events.** The kernel NATS admits only the keys tenant-create holds,
  so the three leaves run with `NATS_URL` unset (relay off): their outbox rows
  accumulate and no event from these leaves reaches the kernel in this install.
- **Leaf databases.** A leaf creates its own `calendar_<slug>`-style database;
  the module enable gate creates a different, empty `t_<hex>__<module>` one.
  Do not disable calendar, content or publishing until the two are reconciled.
  The council switch refuses a calendar switch-off while `CALENDAR_BACKEND` names the
  leaf (a switch-off guard); content and publishing are not council-switchable at all.
  The panel refuses `disable_module` for these three (`DISABLE_LOCKED`); only the
  host break-glass request is not refused by code, so that stays an operator rule.
- **Isolation evidence.** The case table behind the enable gate covers the
  backends this install runs, at the app layer: votes, files and messaging
  against recording fakes of a shared Nextcloud and Synapse, board through the
  router and the board service. For two customers on one install the app-layer
  cases are not enough: `gremion-isolation-live` probes the running stack, and one
  host run of it, kept with the install's records, is owed (nothing in this
  repository records one). See "Evidence for two customers" and
  [isolation-evidence.md](isolation-evidence.md).
- **Office router.** The `.office` router is emitted for every routed host
  whether or not Collabora runs; on a host without it traefik lists that router
  as not enabled, and `gremion-verify` reports it as not live. Making it
  conditional on the collabora profile is one follow-up (the router input),
  owed with the post-deploy verification.
- **Mail login proof.** Step 6c reads its writes back (row, config file, the
  password file inside the container) but sends no message: whether the relay
  accepts the login is proven by one real mail from the running app (owed after
  deploy, below). A reset removes the copied password file and the control
  database, so `wire` is part of every install that follows one.
- **Install checklist for the mail login.** The control panel's install steps
  do not yet list step 6c, and no verify yet fails when the tenant row has no
  `smtp` entry or the tenant's `config.json` is not `smtp.configured`. Both live
  outside this repository's host tooling and are a named follow-up.
- **Two customers on one install.** The shared TURN relay name, the shared
  Synapse and Nextcloud databases and backups (no per-customer restore), the
  missing unpin verb, the device continuity lost under app-minted Matrix logins,
  the held `MESSAGES_BACKEND=service`, and the open Nextcloud account addressing
  are named under "Operating limits of two customers on one install"; the
  control panel's note on "Neuer Mandant" stays the core-only one because the app
  compose does not pass `SECONDARY_TENANT_MODULES` on.
- **Platform pins.** Only the apex host pin is declared on the `traefik`
  service; the `www`, `control` and `sales` pins belong to the static routers
  that are not part of this install.

## Owed after deploy

`docker compose ps` shows each pilot service healthy; `gremion-verify`; the JWT
login flow listed and `/livekit-sfu` through the edge; one file opened in
Collabora and one poll created from the running app in a browser; one calendar
event, one content post and one newsletter draft saved and read back through
the leaves, and that event listed in the customer's CalDAV collection of
Nextcloud (the collection step of `wire` reads `occ dav:list-calendars`, whose
table layout is not yet seen against a running Nextcloud); a video call between two accounts, with the TCP fallback checked
from a network that blocks UDP. With the relay transport: after `wire`, one
invitation or newsletter test mail sent from the running app arrives (the relay
accepts the login and signs the From domain), and the Settings page's mail step
shows the relay as configured without a hand edit. On an install with a second
customer: the items under "Evidence for two customers", and, after a chat
switch-over, the login flows read back from the running `matrix`.
