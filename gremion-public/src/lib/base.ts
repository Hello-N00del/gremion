// TASK-032 (TRD-410 [D R20-D5]): kit 3 removed `base` (and `assets`,
// `resolveRoute`) from `$app/paths` entirely (upstream CHANGELOG.md,
// "breaking: remove base, assets, and resolveRoute from $app/paths"), in
// favour of a `resolve()` helper that resolves a known, statically-typed
// route ID plus params. That is not a fit for how this app uses `base`: hash
// fragments that are not routes at all (`{base}/#protokolle`), and a
// database-supplied `pdf_url` string concatenated at runtime
// (`{base}${protocol.pdf_url}`, from public-db.ts) rather than a route ID
// `resolve()` could type-check against.
//
// This module reinstates the same build-time-constant contract `base` used
// to have: a single string, baked into both the server and client bundles at
// build time from the `BASE_PATH` build ARG (see kit.config.js and this
// app's Dockerfile), safe to import from universal (server + browser) code.
// `__BASE_PATH__` is a Vite `define` replacement (vite.config.ts) sourced
// from the exact same `kit.config.js` value SvelteKit itself uses for
// `paths.base` — one computation, not two env-var reads that could drift.
declare const __BASE_PATH__: string

export const base = __BASE_PATH__
