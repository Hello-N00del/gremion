# @gremion/db

Postgres client factory (`createDb`) and the shared row/entity types used across
the [Gremion](https://github.com/Hello-N00del/gremion) governance kernel.

```ts
import { createDb, type DbProfile } from '@gremion/db'
import type { PublicCommittee } from '@gremion/db/public-types'

const sql = createDb({ url: process.env.DATABASE_URL!, max: 3, prepare: false })
```

## Status: 0.x, and the contract is not frozen

This package is published at `0.1.0` deliberately. Gremion does not claim a
frozen runtime-registry or data contract yet, and a `1.0.0` would promise a
semver stability the project has not earned. Expect breaking changes in minor
versions until that is stated otherwise.

## What ships

The tarball contains `dist/` (compiled ESM, `.d.ts` declarations and maps),
`src/*.ts` minus the specs, `README.md` and `LICENSE` — that is the `files`
allowlist in `package.json`.

**What a consumer LOADS is `dist/`, never `src/`.** Publishing raw `./src/*.ts`
as the entry point was considered and rejected: a consumer running plain `node`
cannot load it (the relative imports resolve to `.js` paths that do not exist in
a `.ts`-only tree, and on runtimes without type stripping the entry point fails
with `ERR_UNKNOWN_FILE_EXTENSION`), and it exports no types at all, so
TypeScript consumers get `any`. It works inside this repository only because the
workspace links the package and Vite compiles it — a monorepo affordance, not a
package contract. The `exports` map in `package.json` points at `src/` for the
workspace, and `publishConfig.exports` overrides it to `dist/` at pack time.

`src/` is nevertheless IN the tarball, for two reasons, and the second is the
load-bearing one. It makes the emitted declaration maps resolve, so a consumer's
"go to definition" lands on real TypeScript rather than a dead path; and `files`
is also what pnpm applies when it packs a workspace dependency for
`pnpm deploy`, which is how both runtime Dockerfiles build `/app/node_modules`.
A `dist`-only allowlist put EMPTY packages in the shipped images — see
`scripts/check-shipped-package-files.mjs`, which guards exactly that.

## Testing

The specs in `src/*.test.ts` are collected by `gremion-ui`'s vitest run (see
`gremion-ui/vite.config.ts`), not by a suite of this package's own — this
package has no `vitest` dependency. `pnpm --filter @gremion/db typecheck` is
its standalone gate.

## Licence

AGPL-3.0-only. The full text is in `LICENSE`, beside this file.
