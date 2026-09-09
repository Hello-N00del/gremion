# Keycloak realm export (generated)

`realm-export.json` is **generated** — do not hand-edit it.

It is composed by `gremion-ui/scripts/gen-realm-export.ts` from:

- `realm-export.base.json` — the module-neutral base realm (platform groups/roles,
  clients, flows, placeholders), and
- each **enabled** module's realm fragment (groups + realm-roles) declared in its
  manifest (`gremion-ui/src/lib/modules/manifests/*.ts`).

A module that is disabled in the target vertical's `config.json`
(`modules.<id> = false`) contributes no groups/roles.

The committed `realm-export.json` is the **governance-only kernel** realm: it carries
only the `gremion-ui` and `gremion-admin` clients (no feature-module clients). Feature
modules add their own clients/groups/roles via their manifest fragments when enabled.

## Regenerate

`make gen-realm` **requires** a config: it reads `CONFIG_PATH` if set, else
`./config/config.json`. With neither present it errors out (it does **not** no-op).

```sh
# Target a specific vertical by pointing CONFIG_PATH at its config.json:
CONFIG_PATH=/path/to/config.json make gen-realm

# Or place the config at ./config/config.json, then:
make gen-realm
```

Run this **before** `docker compose up` — Keycloak imports `realm-export.json` at
container start. `scripts/setup.sh` does this automatically: it regenerates when a
`config.json` is supplied (via `CONFIG_PATH` or `./config/config.json`), and
**otherwise keeps the committed governance-only file in place** — that no-config
keep-the-committed-file behavior lives in `setup.sh`, not in the `make gen-realm`
target.

To change which realm objects a module owns, edit that module's manifest fragment
(not the JSON), then regenerate.

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
