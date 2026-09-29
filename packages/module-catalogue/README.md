# @gremion/module-catalogue

The one `module.json` validator (spec D D.1.2) and the ops facts derived from
the module catalogue (TASK-021, PRD-PLAT-012, TRD-424, TRD-089).

Every `modules/<id>/module.json` carries:

```jsonc
{
  "schemaVersion": 1,
  "id": "calendar",
  "extractionSource": "<docs/ops/extraction-source.md>",
  "runtime": {
    "version": "1.0.0",                                              // semver
    "database": { "postgresService": "calendar-postgres", "migrations": "migrations" } | null,
    "export": { "kind": "pg_dump", "retentionProfile": "rp-cal-module-data" } | null,
    "timedJobs": [{ "id": "caldav-sync", "activeColourOnly": true }],
    "platformServer": { "postgresService": "messaging-postgres", "databases": ["synapse"] } | null
  }
}
```

Every runtime key is required (null or `[]` where it does not apply). The
validator judges the declaration against the tree and the compose file:

- `migrations/manifest.json` on disk with `database: null` is refused
  (under-declaration); `database` without `export` is refused;
- a declared server must be a compose service labelled
  `org.gremion.postgres=module:*`; every such service is claimed by exactly one
  module, through `database` or `platformServer` (`checkClaims`);
- the id satisfies `names.ts` MODULE_ID, SCHEMA `module_module_key_check` and
  is at most 27 bytes (so `t_<hex32>__<id>` fits 63);
- `extractionSource` is checked by the imported
  `scripts/lib/extraction-source.mjs` helper, a `contracts` block by TASK-030's
  `validateModuleContracts`; neither is re-implemented here.

Derived, never hand-kept: `deriveBackupServices` (kernel `postgres` first, then
each database server, then each platform server), `deriveColourGatedJobs`, and
`platformDatabases(service)`, a closed list per server (never a `t_` prefix
filter) that `@gremion/tenant-store/lifecycle`'s `inspectTenantDatabases` uses.

```sh
node packages/module-catalogue/bin/check.mjs --check modules
node packages/module-catalogue/bin/check.mjs --check modules --emit-ops <file>
pnpm --filter @gremion/module-catalogue test
```

`src/runtime.ts` has no relative import: `@gremion/tenant-store` imports it as
`@gremion/module-catalogue/runtime`. The package is private for now: it imports
the extraction-source helper from `scripts/lib/`, which a tarball would not
carry (named residual in the TASK-021 ledger).
