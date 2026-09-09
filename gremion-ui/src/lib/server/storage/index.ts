// src/lib/server/storage/index.ts
// Singleton storage adapter — selected at module-load time from env.
//
// STORAGE_BACKEND=local      -> LocalStorageBackend (default, dev-friendly)
//   RECEIPT_STORAGE_DIR      -> root dir (default ./var/storage)
//
// The governance-only kernel ships only the local backend; the Nextcloud
// backend rides with the (carved-out) files feature module.
//
// Construction is lazy via getStorage() so module-import order and
// SvelteKit's $env/dynamic/private timing don't matter; the `storage`
// proxy below keeps the ergonomic `import { storage } from ...` shape
// the plan asks for.

import { env } from '$env/dynamic/private'
import type { StorageBackend } from './types'
import { LocalStorageBackend } from './local'

export type { StorageBackend } from './types'

let cached: StorageBackend | null = null

/** Read a value from SvelteKit's dynamic env first, then process.env. The
 *  dynamic env is populated by the SvelteKit server at boot — in vitest it
 *  stays empty (`set_private_env` is never called), so the process.env
 *  fallback is what makes the integration tests actually see test-only
 *  overrides set via `process.env.X = ...` in test setup. */
function readEnv(name: string): string | undefined {
  return env[name] ?? process.env[name]
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
