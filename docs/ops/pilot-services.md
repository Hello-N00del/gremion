# Pilot services

The services a single-customer host install runs beside the kernel: files
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
issuer at boot, so `gremion-services wire` adds the profile once the
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
   and `/versions` answers regardless);
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
branch. The shared chat service stays bound to the primary customer's realm and
the primary customer's Nextcloud provider `Keycloak` is never set, so:

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

## A secondary customer host (canary or test customer)

The install has ONE customer host, `PILOT_TENANT_HOST`: Collabora, the call and
office URLs, the video relay, the leaves' public base URL, and the shared Synapse
and Nextcloud (bound by `wire` to that customer's realm) all carry it. The
operator may allow further hosts for customers that knowingly run **core-only**,
for example a canary or test customer beside the real one.

**Switch it on.** Add `SECONDARY_TENANT_HOSTS=canary.example.org` (comma-separated
lowercase DNS names, no scheme, port, path or wildcard) to `etc/env/state.env`, and
the same line to both `app-<colour>.env` so that "Neuer Mandant" shows it (the
panel only displays the list; the host-side create reads `state.env` and nothing
the request says). `gremion-validate-env` refuses a malformed list, a duplicate,
the platform domain, a platform host, the control panel host, `PILOT_TENANT_HOST`
and its `turn.` relay host. Empty or absent means exactly one customer host, as
before. Redeploy, create the customer from the panel with that host, add the host
to `etc/tenant-hosts.txt` (certificate and DNS checks), and point `CD_PROBE_HOST`
at it if it is to be the CD canary: the canary is the customer that owns the probe
host, and the public probe asks only `/readyz` and the login page.

**What it gives.** Login, board and calendar pages, each on the customer's own
host, realm, and databases. The calendar's own data is the customer's; only its
optional CalDAV mirror into the shared Nextcloud needs the customer's own
collection, which `gremion-services wire <slug>` creates for it (the leaf cannot
create one itself; a push that finds no collection fails and is given up after
three attempts per entry). Until `wire` has run for the customer, nothing is
written to the shared service. `wire` also gives the customer its own Nextcloud
login provider and, under `MAIL_TRANSPORT=relay`, its mail login: see "A
customer on a secondary host" under the wire steps above.

**What it does not give.** Chat, files, office editing, video (all on the shared
Synapse and Nextcloud), votes (they run on the shared Nextcloud Polls), the
newsletter (its unsubscribe links carry `PILOT_TENANT_HOST`) and content pages:
the content leaf builds the unsubscribe link of its e-mail channel from the one
process-wide public base URL, so a secondary customer's subscribers would be
sent to the primary host, where their token is unknown, and its news editor
keeps drafts in the shared Nextcloud and opens them in the shared Collabora.
Content may be allowed for a secondary host only after the leaf builds that link
base from the customer's own host and the editor is isolated. The host side
enforces all of this instead of leaving it to the operator:

- the create accepts `PILOT_TENANT_HOST` and a listed host and refuses every other
  host, naming what is allowed; on a secondary host it refuses, before anything is
  created, any module outside `board` and `calendar` (default deny:
  `SECONDARY_HOST_MODULES` in `infra/host/lib/common.sh`);
- the customer's tenant config is created with every other module switched off
  (`SECONDARY_HOST_MODULES_OFF`), because a config reads a module as on until it
  says otherwise, and with those ids listed as `pinned_off_modules`. The app pins
  every listed module off on each read and write of the module switches, exactly
  like the held-off set, and the list is not part of any settings update: neither
  a settings change nor "Konfiguration zurücksetzen" by the customer's own IT
  admin can switch such a module back on, and the provisioning worker and the
  route gate read the pinned value;
- the protocol routes (create, editor URL, publish, public PDF, detail) are governance
  and always on, so they read the current customer's files switch instead of the
  build-wide document port: with it off, minutes live in the app only (the in-app
  text), and the shared Nextcloud and Collabora are not called for that customer;
- the module enable (executor, council admin and break-glass alike) refuses the
  same modules for a customer registered on a secondary host;
- `gremion-services wire <slug>` takes a customer registered on a listed secondary
  host through its own, narrower branch (see "A customer on a secondary host"
  under the wire steps), and refuses a customer whose registered host is neither
  `PILOT_TENANT_HOST` nor an entry of `SECONDARY_TENANT_HOSTS`, before it copies
  a secret, writes a key or starts a container: the shared chat and file
  services stay bound to the primary customer.

**Evidence still owed.** Isolation evidence for two customers on the shared
Nextcloud and Synapse has not been produced, which is why those modules stay off
for a secondary host. Until it exists, do not lift the refusals. Also owed after
the deploy that first uses it: the realm's discovery document at the secondary
host names that host as issuer; a login on it; the customer's edge router listed
and enabled in `gremion-verify`; a CD run with `CD_PROBE_HOST` set to it.
Decommission a secondary-host customer before removing its host from the list.

**Operating notes.**

- A secondary-host customer's tenant config file carries its `pinned_off_modules`
  list: back it up and restore it as a whole.
- The CD canary: with `CD_PROBE_HOST` set to the secondary host, the public probe
  asks only that core-only customer's `/readyz` and login page. A canary on this
  host cannot catch a regression in chat, files, office editing or video, which
  stay bound to the primary customer; those still need the primary host's own
  checks.

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
  backends this install runs. Board's recorded case is the in-process one over
  the kernel tables; a customer whose board lives in its own database is served
  by the leaf, so the case through the router and the leaf is owed before a
  second customer relies on that path. Votes, files and messaging are proven at
  the app layer against a shared Nextcloud and Synapse.
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
shows the relay as configured without a hand edit.
