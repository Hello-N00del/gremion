# @gremion/storage

The one storage seam of the [Gremion](https://github.com/Hello-N00del/gremion)
governance kernel: every tenant file, draft and media object is resolved
through `getStorageFor(tenantId)`.

```ts
import { configureStorage, getStorageFor } from '@gremion/storage'

configureStorage({ backend: 'local', root: '/data/storage' }) // once per process
const handle = await getStorageFor(tenantId).put('branding/logo.svg', bytes)
// handle === `${tenantId}/branding/logo.svg`
const bytesAgain = await getStorageFor(tenantId).read(handle)
```

## Contract

- **Explicit tenant, fail-closed.** `getStorageFor(tenantId)` takes the tenant
  as an argument. A missing, empty or malformed id throws synchronously, before
  any I/O. Accepted ids: a lowercase canonical UUID, or the legacy literal
  `'default'`. There is no zero-argument accessor and no ambient-context read.
- **Tenant-prefixed handles.** Every handle is `<tenantId>/<relPath>`. A
  backend refuses (before any I/O) a handle that is not a canonical key under
  its own tenant's segment — including another tenant's handle and any `..`
  walk out of it. Handles are opaque: persist them and pass them back.
- **`list(prefix?)`** is read-only and returns only the calling tenant's handles.
- **Memoised per tenant** in an unbounded per-process map (pilot sizing).
- **No symlinks are followed** by the local backend: a link anywhere between
  `<root>/<tenantId>` and the object refuses the call, and `list()` neither
  returns nor descends into links.
- **The memory double is opt-in**: `configureStorage({ backend: 'memory' })`
  is refused unless `allowTestDouble: true` is also passed.

## Backends

Selected by configuration alone (`backend`, i.e. `STORAGE_BACKEND`):

| name     | what it is |
|----------|------------|
| `local`  | Filesystem, objects at `<root>/<tenantId>/<relPath>`. The pilot backend. |
| `memory` | In-memory test double. Proves selectability (TRD-066); not durable. |

The same contract suite (`src/contract.test.ts`) runs against both.

### The local root must be a mount point

The `local` backend refuses to construct when its root is not listed as a mount
point in `/proc/self/mountinfo` (`storage(local): <root> is not a mount point`).
It also refuses `/` and memory-backed filesystems (tmpfs, ramfs, …). The check
runs in `configureStorage()` and again when each tenant's backend is built.
A directory on a container's writable layer is ephemeral and invisible to
backups, and a `stat()` cannot tell it from a mounted volume — only the mount
table can. On a non-Linux host with no mount table (Windows/macOS development)
the check is skipped and the skip is logged with its reason; on Linux a
missing table fails closed.

### Live proof

`bash packages/storage/scripts/mount-proof.sh` builds the package, bakes
`dist/` into a `node:26-alpine` image and runs it twice with plain
`docker run`: without a volume at the root (must exit non-zero with the
refusal above) and with a named volume there (must succeed and pass a
concurrent two-tenant write check — both tenants put the same relative path;
the handles must be distinct, tenant-prefixed and each readable only by its
own tenant). Every container, volume and image is removed by name.

## Recorded gaps and residuals

- **Legacy objects (B-13).** Decision B-13 records no boot scan and no data
  migration: zero legacy tenant-blind objects (including the four news-draft
  files an earlier plan named) exist to move. A "files under tenant-prefixed
  keys with checksums matching a pre-migration record" check therefore has no
  subject, and is not demonstrated; the concurrency half of that criterion is
  shown by the live proof above.
- **Memoisation (Q1).** The per-tenant map is unbounded, with no eviction —
  revisit at the object-store cutover (TRD-223).
- **The `'default'` tenant id (Q5)** is accepted as a literal until zero-tenant
  boot retires it; until then one tenant can have objects under both
  `default/` and its registry UUID.
- **Scope of the bypass scan (Q3, Q7).** `scripts/check-storage-seam.mjs`
  covers this repository only. Duplicated, tenant-blind storage code in the
  downstream deployment repository is not scanned. The council-owned file
  server integration is out of scope (PRD-PLAT-004) and not present here. The
  scan is a regex tripwire: runtime-computed module names, shell-outs and raw
  reads are not covered.
- **Symlink TOCTOU.** Links are refused by an `lstat` walk before each
  operation; a link swapped in between the check and the I/O is not covered.
  Only this seam writes under the root.
- **Boot-time failure.** An unmounted root fails at `configureStorage()`, which
  gremion-ui's adapter calls lazily on first use; calling it at server start is
  left to the app's init code.

## Status: 0.x

Published at `0.1.0`; the contract is not frozen. Same packaging shape as
`@gremion/db`: the workspace resolves `src/`, a published tarball `dist/`.

## License

AGPL-3.0-only.
