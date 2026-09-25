// packages/db/src/index.ts
// TASK-032 (TRD-410 [D R20-D5]): `export type *` (not a bare `export *`) —
// types.ts is 100% interfaces, no runtime code, but kit 3's new mandatory
// build-time "Analysing routes" step does a REAL Node import() of the
// already-vite-built server output (analyse.js: `await
// import(pathToFileURL('.../server/index.js'))`) to read each route's
// exports. Under gremion-ui's build (unlike gremion-public's, which only
// ever imports `@gremion/db/public-types` type-only) that step failed with
// `ERR_MODULE_NOT_FOUND: .../packages/db/src/types.js` — a bare `export *`
// left an unresolved runtime import to a chunk the bundler apparently didn't
// keep, for a module with nothing but types to export in the first place.
// Marking the whole re-export type-only guarantees it is erased at compile
// time, matching what it always semantically was. Confirmed necessary: the
// plain `pnpm build` (kit 2.70.2) baseline never hit this, since kit 2 has no
// equivalent build-time analysis step.
export type * from './types.js';
// TASK-032: extension changed .js -> .ts for the same reason as the type-only
// export above — kit 3's own generated tsconfig now sets
// `allowImportingTsExtensions: true`, and Node 22.18+/26 natively executes
// .ts files (type-stripping), so this is the forward-compatible specifier
// once a real runtime import needs the raw source resolved outside Vite's
// own transform pipeline (as kit 3's build-time "Analysing routes" step
// does). See index.ts's header comment for the full diagnosis.
export { createDb } from './client.ts';
export type { Sql, DbProfile } from './client.ts';
