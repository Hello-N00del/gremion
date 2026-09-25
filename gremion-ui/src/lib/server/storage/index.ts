// src/lib/server/storage/index.ts
// Singleton storage adapter — selected at module-load time from env.
//
// STORAGE_BACKEND=local      -> LocalStorageBackend (default, dev-friendly)
//   RECEIPT_STORAGE_DIR      -> root dir (default ./var/storage)
//
// The governance-only kernel ships only the local backend; the Nextcloud
// backend rides with the (carved-out) files feature module.
//
// Construction is lazy via getStorage() so module-import order doesn't
// matter; the `storage` proxy below keeps the ergonomic
// `import { storage } from ...` shape the plan asks for.
//
// TASK-032 (TRD-410 [D R20-D5]): reads process.env directly rather than
// SvelteKit's dynamic-private-env module. Kit 3 made that module's values
// come only from vars explicitly declared via `defineEnvVars` (nothing here
// is), so an undeclared read now silently resolves to `undefined` instead of
// the live process value — a correctness/security regression for a
// singleton selected at module-load time. adapter-node's dynamic env was
// itself backed by `process.env` at runtime, so this is behavior-preserving
// for this deployment target, and it keeps the `process.env.X = ...`
// test-setup overrides working exactly as before (that was already the
// fallback half of the old `env[name] ?? process.env[name]` read).

import type { StorageBackend } from './types'
import { LocalStorageBackend } from './local'

export type { StorageBackend } from './types'

let cached: StorageBackend | null = null

function readEnv(name: string): string | undefined {
  return process.env[name]
}

function build(): StorageBackend {
  const backend = (readEnv('STORAGE_BACKEND') ?? 'local').toLowerCase()
  if (backend !== 'local') {
    throw new Error(
      `storage: unknown STORAGE_BACKEND='${backend}' (expected 'local')`
    )
  }
  return new LocalStorageBackend(readEnv('RECEIPT_STORAGE_DIR'))
}

/** Lazily build & cache the storage backend. Exposed for tests that need
 *  to reset between cases (use `resetStorageForTest()`). */
export function getStorage(): StorageBackend {
  if (cached === null) cached = build()
  return cached
}

/** Test-only: drop the cached singleton so the next access reads env afresh. */
export function resetStorageForTest(): void {
  cached = null
}

/** Ergonomic proxy: `storage.put(...)` forwards to the cached singleton.
 *  Matches the plan's `import { storage } from '$lib/server/storage'`. */
export const storage: StorageBackend = {
  put: (relPath, bytes) => getStorage().put(relPath, bytes),
  read: (handle) => getStorage().read(handle),
  delete: (handle) => getStorage().delete(handle)
}
