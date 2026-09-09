// Manifest barrel (WP2-1): the SINGLE source of the registered module set and
// its order. registry.ts (and via it db.ts, the provisioner, realm.ts) read
// MODULE_MANIFESTS from here instead of hand-assembling the array.
//
// This file no longer carries a hand-written array literal naming each module.
// MODULE_MANIFESTS is produced by scripts/build-module-manifest.mjs, which SCANS
// manifests/*.ts and emits index.generated.ts sorted by each manifest's `order`
// field — so adding/removing a manifest file (e.g. deleting finance.ts) and
// re-running the codegen updates the registry with ZERO edit here. The committed
// generated barrel is byte-pinned by registry.test.ts's staleness guard.
//
// Order is irrelevant for PAGE_ACCESS (segments are unique) but DOES define
// moduleRoutePrefixes() ordering — pinned by registry.test.ts.
export { MODULE_MANIFESTS } from './index.generated'
