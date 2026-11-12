# Runbook — the public portal on the customer's own host

How to serve the read-only public portal (`gremion-public`) of a pooled,
single-customer install under one extra host name of the customer's, reading
the customer's database and linking back to the customer's app host.

Throughout, `portal.customer.example` is the portal host, `app.customer.example`
the customer's app host (the install's `PILOT_TENANT_HOST`) and `example.org`
the platform domain. They are placeholders. Substitute your own.

## What this sets up, and what it does not

- One extra host name carries **the portal only**. The app, Keycloak and the
  platform stay on the hosts they already have.
- The portal host is **never** a `tenant_domain` row. A `tenant_domain` row
  makes the edge route the *app* to that host. The portal host gets its router
  from one hand-placed file instead (step 3).
- The portal is not tenant-aware. It reads the one database named in its
  environment. This runbook is for an install with one customer.
- It assumes the portal is mounted at `/` (`PUBLIC_BASE_PATH` empty in
  `state.env`, the default).

Three things change, and each is one key or one file:

| Goal | What you set |
|---|---|
| The portal reads the customer's database | `PUBLIC_PORTAL_DB_NAME` |
| Login and protocol PDFs go to the customer's app host | nothing, when `PILOT_TENANT_HOST` is set; `PUBLIC_MAIN_APP_URL` to override |
| The edge serves the portal under the extra host | `PUBLIC_PORTAL_HOST` and `etc/edge/public-host.yml` |

## 1. DNS (the customer's zone)

The customer publishes **one** of:

- `portal.customer.example. CNAME app.customer.example.`, or
- `A` and `AAAA` records for `portal.customer.example` that point at the
  edge's addresses (the same addresses the app host has).

Two limits:

- **A subdomain only.** A zone apex cannot carry a CNAME, and this setup does
  not serve an apex.
- **CAA.** If the customer's zone publishes CAA records, they must allow the
  certificate authority this install's ACME resolver uses (Let's Encrypt unless
  the install changed it: `0 issue "letsencrypt.org"`). A CAA record that
  forbids it makes every certificate order for the host fail.

Wait until the name resolves to the edge from outside before step 3. The
certificate is ordered over HTTP-01 the moment the router is loaded, and a
certificate authority limits how often a failed order may be repeated.

## 2. The three keys (`app-blue.env` and `app-green.env`)

`gremion-public` belongs to the app tier, which reads
`/opt/gremion/etc/env/app-<colour>.env`. Set the keys in **both** files with the
same values: the colour that takes over at the next switch reads its own file,
and a key set in one file only is silently gone after that switch.

| Key | Value | When absent or empty |
|---|---|---|
| `PUBLIC_PORTAL_HOST` | `portal.customer.example` (a host name, no scheme) | `public.<PLATFORM_DOMAIN>` |
| `PUBLIC_PORTAL_DB_NAME` | the customer's database, `t_<tenant id>__kernel` | `GREMION_DB_NAME`, then `gremion` |
| `PUBLIC_MAIN_APP_URL` | leave unset; or an origin such as `https://app.customer.example` | `https://<PILOT_TENANT_HOST>`, then `https://<PLATFORM_DOMAIN>` |

The template (`infra/host/templates/env/app.env.tmpl`) carries the three keys
commented out. A file rendered before they existed does not have those lines:
add them. Declare each key once. The env reader refuses a file that declares a
key twice. Edit as `gremion`, the owner of the files; they hold secrets.

**The database name contains the tenant id, so it exists only after the tenant
was created.** Set `PUBLIC_PORTAL_DB_NAME` after the customer is created, and
set it **again after any re-create** of the tenant: a new tenant has a new id
and therefore a new database name, and the portal would keep reading a
database that no longer exists. Read the name from the running server:

```bash
cd /opt/gremion/current
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname ~ '^t_[0-9a-f]{32}__kernel\$'"
```

On an install with one customer this prints one line. More than one line means
more than one customer database: stop, this runbook does not apply.

Apply the keys to the running portal (the active colour):

```bash
cd /opt/gremion/current
colour="$(cat /opt/gremion/runtime/active-colour)"
/opt/gremion/bin/gremion-validate-env --env-file "/opt/gremion/etc/env/app-${colour}.env"
docker compose --env-file "/opt/gremion/etc/env/app-${colour}.env" up -d --no-deps gremion-public
```

The portal restarts once. `up -d` alone is enough: the changed environment
makes compose replace the container.

## 3. The router file (`etc/edge/public-host.yml`)

Copy the template, replace the placeholder host in **both** places it stands
(the rule and the pin), and move the result into place under exactly this name. Run this as `gremion`, the
owner of `etc/edge`:

```bash
host=portal.customer.example
tmp="$(mktemp /opt/gremion/etc/edge/.public-host.XXXXXX.tmp)"
sed "s/portal\.customer\.example/${host}/g" \
  /opt/gremion/current/infra/host/templates/edge/public-host.example.yml > "$tmp"
grep -c "$host" "$tmp"            # 2: the rule and the pin
chmod 0644 "$tmp"
mv -f "$tmp" /opt/gremion/etc/edge/public-host.yml
```

The temporary name does not end in `.yml`, so Traefik never loads a half-written
file. Change nothing else in the file: `gremion-verify` holds it to the
template's shape (one router `public-host` on `public@file`, the chain host
pin, `edge-hsts-custom`, `edge-ratelimit-portal`, and no other name). If the
install's `TRAEFIK_CERT_RESOLVER` is not `le-http`, set `certResolver` to that
value.

**This file is placed by hand, and no program rewrites or restores it.** After
a re-install of the host (a fresh `etc/`), place it again.

Then list the host in `/opt/gremion/etc/tenant-hosts.txt` (one name per line).
That file is what makes `gremion-verify` check the host's certificate and
response, and what the ops project probes; a host that is not in it is a host
nothing certifies. Re-run `infra/host/ops/render-ops.sh` afterwards, as after
any change to that file.

## 4. Live checks

Run all of them; each reads the running system.

1. **The portal runs with the values you set.** No secret is printed: the
   last line prints only what follows the final `/` of the connection string,
   which is the database name.

   ```bash
   c="$(docker compose --env-file "/opt/gremion/etc/env/app-${colour}.env" ps -q gremion-public)"
   docker exec "$c" printenv ORIGIN PUBLIC_MAIN_APP_URL
   # https://portal.customer.example
   # https://app.customer.example
   docker exec "$c" sh -c 'printf "%s\n" "${GREMION_PUBLIC_DB_URL##*/}"'
   # t_<tenant id>__kernel
   ```

2. **The read-only role may connect to that database and read the two tables
   the portal shows.** `<db>` is the name from step 2. This proves the role's
   privileges; that the portal logs in with its password is proven by check 4,
   whose pages are read from this database.

   ```bash
   docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
     psql -U postgres -d "<db>" -v ON_ERROR_STOP=1 -tA \
     -c "SELECT has_database_privilege('gremion_public_reader', current_database(), 'CONNECT')" \
     -c "SET ROLE gremion_public_reader" \
     -c "SELECT count(*) FROM org_units" -c "SELECT count(*) FROM protocols"
   # t, SET, then two counts; any "permission denied" is a failure
   ```

3. **The edge serves the host, with its own certificate.**

   ```bash
   /opt/gremion/bin/gremion-verify
   # all checks passed; runtime/last-verify.json lists public-host@file
   ```

4. **The pages render the customer's data** (from outside the host):

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://portal.customer.example/             # 200
   curl -sS -o /dev/null -w '%{http_code}\n' https://portal.customer.example/protokolle   # 200
   ```

   Open both in a browser: the committees and the published protocols are the
   customer's. A page that renders but lists nothing while the customer has
   published protocols means the portal reads another database: go back to
   step 2.

5. **Login and the PDF go to the app host, not the platform.** The Login link
   in the portal's header points at `https://app.customer.example`. For a
   published protocol with a PDF:

   ```bash
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     "https://portal.customer.example/api/public/protocols/<protocol id>/pdf"
   # 302 https://app.customer.example/api/public/protocols/<protocol id>/pdf
   ```

6. **The app is not on the portal host.** `https://portal.customer.example/login`
   answers 404 from the portal, not the app's sign-in page.

## 5. When to repeat a step

| Event | Repeat |
|---|---|
| The tenant was created again | step 2 (`PUBLIC_PORTAL_DB_NAME`, both files), then the checks |
| The host was re-installed | steps 2 and 3 (both env files, the router file, `tenant-hosts.txt`) |
| An upgrade (`gremion-deploy`) | nothing, if both colour files carry the keys; run check 1 against the new colour |
| The portal host changes | step 1 for the new name, then steps 2 and 3 with it |

## 6. Taking it back out

Remove `/opt/gremion/etc/edge/public-host.yml` and the host's line in
`tenant-hosts.txt`, remove or comment `PUBLIC_PORTAL_HOST` in both colour files
and apply as in step 2. `PUBLIC_PORTAL_DB_NAME` stays: without it the portal
reads the platform's default database again.
