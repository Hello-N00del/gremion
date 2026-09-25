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
A directory on a container's writable layer is ephemeral and invisible to
backups, and a `stat()` cannot tell it from a mounted volume — only the mount
table can. On a host with no `/proc/self/mountinfo` (Windows/macOS development)
the check is skipped and the skip is logged with its reason.

## Status: 0.x

Published at `0.1.0`; the contract is not frozen. Same packaging shape as
`@gremion/db`: the workspace resolves `src/`, a published tarball `dist/`.

## License

AGPL-3.0-only.
