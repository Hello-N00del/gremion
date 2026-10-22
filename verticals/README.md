# verticals/

A vertical is DATA: one directory per vertical holding

| file | content |
|---|---|
| `vertical.json` | `{schema_version, id, name, blueprint, wording, roles}` (file names fixed) |
| `blueprint.json` | the org-unit tree (`orgUnits`), the offices (`seats`), optional custom kinds (`orgSchema`) |
| `wording.de.json` | flat `terms` record merged into the tenant config (an operator's own term wins) |
| `roles.json` | the roles a member list may name, the membership each becomes, their capability ids |

The loader (`@gremion/member-import`, `loadVertical`) is id-generic and refuses a vertical that
points back into code (`blueprintRef`). The open core ships NO vertical: a distribution drops its
directories here (the tenant-create image copies this directory to `/repo/verticals`; override with
`GREMION_VERTICALS_DIR`). The test fixture vertical lives in `packages/member-import/test/fixtures/`.

Container verbs (the engine of the executor's `import_members` and `seed_vertical` requests):
`tenant-create import-validate|import-apply|seed-vertical <slug> --vertical <id>`.
