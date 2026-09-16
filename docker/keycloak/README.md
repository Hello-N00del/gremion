# Keycloak realm template

`realm-export.base.json` is the **per-tenant realm TEMPLATE**. It is a tracked,
hand-maintained file and the single copy in this repository (enforced by check
`e5` in `scripts/kernel-hygiene-check.mjs`).

## B-01: nothing imports a realm at boot

A Keycloak started by this kernel comes up with **`master` only**. There is no
`--import-realm` argument, no `/opt/keycloak/data/import` mount, no entrypoint
wrapper and no secret-substitution script — compose, the k8s base and the
`gremion-mail-bringup` probe all assume a realm-less Keycloak.

Every tenant realm is composed at **provisioning time** by `buildTenantRealmDoc`
(`gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts`) and created through
the master bootstrap admin. That function is the only consumer of
`realm-export.base.json` **on the deploy path** — the offline generator below
(`gen-realm-export.ts`) reads the same file, and so do its vitest suites, but
nothing reads it at boot or at run time. It:

- overwrites the `"realm": "__REALM_NAME__"` sentinel with the tenant's realm
  name (which defaults to the tenant slug);
- stamps `sslRequired: "all"`;
- swaps the `__APEX_DOMAIN__` authority for the tenant host across redirect URIs,
  web origins and post-logout attributes;
- substitutes the `__GREMION_UI_OIDC_CLIENT_SECRET__` /
  `__GREMION_ADMIN_OIDC_CLIENT_SECRET__` placeholders with per-tenant generated
  secrets.

To change which realm objects a module owns, edit that module's manifest fragment
(`gremion-ui/src/lib/modules/manifests/*.ts`), not the JSON.

## `realm-export.json` is a generator OUTPUT

`gremion-ui/scripts/gen-realm-export.ts` writes the module-composed realm to
`docker/keycloak/realm-export.json` — the **same, unchanged path**, now
`.gitignore`d. It is never committed and never imported. It is composed from:

- `realm-export.base.json` — the module-neutral base realm (platform
  groups/roles, clients, flows, placeholders), and
- each **enabled** module's realm fragment (groups + realm-roles) declared in its
  manifest.

A module that is disabled in the target vertical's `config.json`
(`modules.<id> = false`) contributes no groups/roles. The governance-only kernel
enables no feature modules, so its output carries only the `gremion-ui` and
`gremion-admin` clients.

### Regenerate

`make gen-realm` **requires** a config: it reads `CONFIG_PATH` if set, else
`./config/config.json`. With neither present it errors out (it does **not** no-op).

```sh
# Target a specific vertical by pointing CONFIG_PATH at its config.json:
CONFIG_PATH=/path/to/config.json make gen-realm

# Or place the config at ./config/config.json, then:
make gen-realm
```

There is no need to run it before `docker compose up` any more — nothing reads
the output at container start. The assembler invokes the generator explicitly
inside an assembled tree.

## Login-theme realm attributes (opt-in, v12 apex topology)

The login theme reads **realm attributes**. Every one is optional and strictly
validated; a realm that does not set an attribute renders byte-identically to a
realm from before the feature existed. The attributes are set on the realm (Realm
settings → Attributes, or the tenant provisioner's realm doc), not on a client.

| Attribute | Read by | Effect when set | Effect when absent/invalid |
| --- | --- | --- | --- |
| `gremion.portal-url` | `login/portal-back.ftl` (all four auth states) | "← Zurück zum öffentlichen Portal" link | no link rendered |

`gremion.portal-url` is validated by `login/url-guard.ftl`: the value must be
**either** a same-origin absolute path (a single leading `/`, never `//`) **or** a
lowercase `https://` absolute URL, ≤200 chars, drawn from a URL-safe character
allow-list. Anything else — other schemes, protocol-relative `//host`, `@` in the
authority, whitespace, quotes, angle brackets, control characters — is rejected
and **nothing at all is emitted**. See the comment block at the top of
`url-guard.ftl` for the full rule.

There is no default that turns the link on: a kernel deployment that runs no
public portal simply leaves the attribute unset.

### Not carried in the kernel

Two neighbours of this mechanism live in the product vertical only:

- `instance-accent.ftl` (`gremion.i-h` / `gremion.i-c`, per-realm OKLCH accent) —
  part of the deferred instance-engine parity gap, see `KNOWN_ISSUES.md`.
- `demo-hint.ftl` (`gremion.demo-url`) — a demo affordance is an instance
  decision, not kernel behaviour.

An RP-initiated logout that wants to land on a portal mounted under a path also
needs that exact path in the client's `post.logout.redirect.uris` — Keycloak
matches those entries **exactly**, so a bare-origin entry does not cover
`<origin>/portal`. The kernel's default topology serves the portal on its own
host, so no such entry is committed here.
