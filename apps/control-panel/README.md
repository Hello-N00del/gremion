# control-panel — the Gremion ops shell (TASK-043)

SvelteKit 2 (R29-I5), adapter-node, Auth.js, Bits UI. The panel lists the
customers of the control registry, shows each customer's provisioning ledger
(`plt.provisioning_step`, in EXECUTION_ORDER) and offers "Neuer Mandant". It
**mutates nothing itself**: every change is `gremion-tenant`'s (Q6).

## Who may use it (TRD-048)

First, the host (R29-I11): every request whose `Host` is not the host of
`ORIGIN` is refused with **421** before Auth.js or the gate run (only
`/healthz` and the bearer-checked `/api/internal/evict` answer on any Host).
Every HTML response carries gremion-ui's Content-Security-Policy, verbatim.

Then `hooks.server.ts` runs the gate (`src/lib/server/gate.ts`) on **every**
request except `/healthz`, `/api/internal/evict` and Auth.js's own `/auth/*`,
before SvelteKit resolves a page, a form action or a `+server` endpoint:

| Request | Answer |
|---|---|
| anonymous GET | 302 to the ops realm's authorization endpoint, `acr_values=loa2` |
| a session of any issuer but `PANEL_OIDC_ISSUER` (a customer realm) | 403 |
| a session cookie that does not decode (forged or stale) | 403, cookie cleared |
| any `Authorization` header (the panel takes no bearer token) | 403 |
| an ops session without the `operator` realm role | 403 |
| an ops session at `loa1` | GET: 302 to a fresh login at `loa2` (step-up); otherwise 403 |
| an ops session at `loa2` with `operator` | served |

The ops realm is `platform` (`docker/keycloak/realm-export.ops.json`): OTP,
brute-force detection, one confidential `control-panel` client with exact
redirect URIs, no users. Operators are added with
`gremion-tenant operator add <email>` (execute-actions mail) or, on a host
without vendor mail, `--no-mail` (a temporary password printed once; Q23).

## Environment contract (section 11 (c))

| Variable | Required | Meaning |
|---|---|---|
| `ORIGIN` | yes | the browser origin: `https://<PANEL_HOST>` behind an edge (the standalone file sets it), or `http://127.0.0.1:<p>` behind `ssh -L`. Its host is the ONLY `Host` the panel answers on (421 otherwise), and SvelteKit's CSRF check answers **403** to a form POST from any other origin |
| `PANEL_OIDC_ISSUER` | yes | the ops realm's PUBLIC issuer, exact (`https://<platform domain>/auth/realms/platform`); any other realm is refused at startup |
| `PANEL_OIDC_INTERNAL_BASE` | yes | Keycloak's internal `/auth` base for the token, userinfo and JWKS calls |
| `NODE_EXTRA_CA_CERTS` | when the internal base is https with an internal CA | the CA bundle |
| `PANEL_OIDC_CLIENT_ID` | yes | `control-panel` |
| `PANEL_OIDC_CLIENT_SECRET_FILE` | yes | a 0600 file (written by `gremion-tenant init`) |
| `AUTH_SECRET_FILE` | yes | a 0600 file, the Auth.js session key |
| `PANEL_REQUIRED_ACR` | yes | `loa2` (nothing else is accepted) |
| `CONTROL_DATABASE_URL` | yes | the control registry, a least-privilege read role |
| `PLATFORM_DATABASE_URL` | no | gremion_platform; absent: no ledger view and "Neuer Mandant" is disabled with the reason |
| `PANEL_EXECUTOR` | no | `gremion-tenant` or `none` (default); `none` disables "Neuer Mandant" with the reason |
| `INTERNAL_PUSH_SECRET` | no | the switch's evict bearer; absent, `/api/internal/evict` refuses everything |

`/healthz` answers 200 when the process runs and the contract is valid, 503
naming the problems (never a value) otherwise. It never reaches Keycloak or a
database, so the panel is healthy before `gremion-tenant init`.

## Where it runs

- **Pooled stack** (`docker-compose.app.yml`, one per colour, Q12): no
  published port, no Traefik route; `gremion-tenant panel` prints the
  `ssh -L 127.0.0.1:<p>:<ip>:3000` line.
- **A host without the pooled stack** (`compose/control-panel/standalone.yml`,
  section 11, [D R29-I11]): routed by the host's existing edge Traefik on ONE
  operator-supplied host name (`PANEL_HOST`, env only), TLS by the named
  resolver (`PANEL_CERT_RESOLVER`), gremion-ui's HSTS; `ORIGIN` is
  `https://<PANEL_HOST>`. The ops realm's `control-panel` client must name
  that origin exactly: `gremion-tenant init --realm-only --panel-origin
  https://<PANEL_HOST>`. A loopback port (`127.0.0.1:${PANEL_PORT}`) stays for
  on-host diagnostics; a request there still needs `Host: <PANEL_HOST>`.

Verify either with `test/host/integration/panel-verify.sh <base-url>`.

### Rollout on a host without the pooled stack (section 11, R29-I11)

The commands the scratch proof (`test/host/integration/customer-provision-proof.sh
panel-*`) runs, in the order a host needs them; `<kc>` is the host's Keycloak
container, `<host>` the operator's panel host name:

1. The host's edge already routes `/auth/realms/platform` to that Keycloak
   (the issuer is `https://<platform domain>/auth/realms/platform`).
2. `KEYCLOAK_ADMIN=... KEYCLOAK_ADMIN_PASSWORD=... gremion-tenant init --realm-only
   --keycloak-container <kc> --panel-origin https://<host>` -- the ops realm, its
   client exact to the origin, the client secret in
   `etc/secrets/control-panel/client_secret` (0600). A rerun is a no-op; a realm
   that differs is refused, never overwritten.
3. `gremion-tenant operator add <email> --no-mail --keycloak-container <kc>` --
   prints `TEMPORARY-PASSWORD:` once; the operator changes it and enrols TOTP at
   the first sign-in (Q23).
4. `openssl rand -hex 32 > etc/secrets/control-panel/auth_secret` (0600); the env
   file from `compose/control-panel/standalone.env.tmpl`; then
   `docker compose -p gremion-panel -f compose/control-panel/standalone.yml --env-file <env> up -d`.
5. `panel-verify.sh https://<host>` (adds the HSTS check on https), then a real
   browser: operator + TOTP -> 200, a customer-realm user -> 403.

## Develop

```sh
pnpm --filter control-panel check
pnpm --filter control-panel test
pnpm --filter control-panel build
```
