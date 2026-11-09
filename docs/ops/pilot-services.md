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
| calendar | `calendar` | leaf (`CALENDAR_BACKEND=service`) |
| content | `content` | leaf (`CONTENT_BACKEND=service`) |
| publishing | `newsletter` | leaf (`NEWSLETTER_BACKEND=service`, its only backend) |
| votes | `nextcloud` | in-process (the Polls client) |
| files | `nextcloud`, `collabora` | in-process (WebDAV with the user's own bearer) |
| messaging | `video`; post-realm `messaging` | in-process |

Board runs in-process on kernel tables and is not started as a service;
finance, vault, elections and handover render no profile. `messaging`
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
commit, state and app up, `gremion-switch <colour>`, `gremion-tenant init`,
the isolation evidence (`gremion-isolation run`, then `record`), the create
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
   directory fails here);
7. recreates `gremion-ui` and reads the bot token back from the running
   container.

Post-conditions are read from the running system (container environment, the
edge's answers, `occ`), never from an exit code. No secret is on a host argv:
the client secret reaches `docker exec` by name (`-e NAME`), and the bot token
only through files and shell variables. The one named exception is `occ`'s own
argument vector inside the `nextcloud` container, which carries the client
secret for the length of the call because `occ` has no other input.

## Video: TURN

TURN is off. Media reaches LiveKit on `45000-45100/udp` or, from a network that
blocks UDP, on `7881/tcp`. A client that can reach neither (a network that
allows only 443) cannot join a call. TURN over TLS on 443 would need an L4
route on a public entrypoint, which the edge verification refuses by design
(`gremion-verify` rejects a TCP or UDP router on `web` or `websecure`), so it is
not offered for the pilot.

## Named residuals

- **Leaf events.** The kernel NATS admits only the keys tenant-create holds,
  so the three leaves run with `NATS_URL` unset (relay off): their outbox rows
  accumulate and no event from these leaves reaches the kernel in this install.
- **Leaf databases.** A leaf creates its own `calendar_<slug>`-style database;
  the module enable gate creates a different, empty `t_<hex>__<module>` one.
  Do not disable calendar, content or publishing until the two are reconciled.
- **Isolation evidence.** The case table behind the enable gate covers the
  backends this install runs; board runs in-process and has no evidence row, so
  a second customer needs it first. Votes, files and messaging are proven at the
  app layer against a shared Nextcloud and Synapse.
- **Router names.** `gremion-verify` expects emitted router names of the form
  `tenant-<slug>[-<i>]`; the realm router (`.kc`) and the Collabora router
  (`.office`) carry a dot suffix and are not yet recognised by that check.
  The `.office` router is also emitted for every routed host whether or not
  Collabora runs; on a host without it traefik lists that router as not
  enabled. Making it conditional on the collabora profile, and teaching the
  check both names, is one follow-up (`gremion-verify` and the router input),
  owed with the post-deploy verification.
- **Platform pins.** Only the apex host pin is declared on the `traefik`
  service; the `www`, `control` and `sales` pins belong to the static routers
  that are not part of this install.

## Owed after deploy

`docker compose ps` shows each pilot service healthy; `gremion-verify`; the JWT
login flow listed and `/livekit-sfu` through the edge; one file opened in
Collabora and one poll created from the running app in a browser; one calendar
event, one content post and one newsletter draft saved and read back through
the leaves; a video call between two accounts, with the TCP fallback checked
from a network that blocks UDP.
