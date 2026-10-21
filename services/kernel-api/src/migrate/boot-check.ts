// services/kernel-api/src/migrate/boot-check.ts — TRD-353 (Q18), the boot half:
// the migration files this image ships must equal the chain's union manifest
// (every file listed, every entry present, every sha256), or the process
// refuses to boot. The applied half is per customer (no tenant at boot): the
// gate answers 503 for a customer whose applied sha256 differs (diverged), and
// the migrate job refuses it (LEDGER_HASH_MISMATCH). Named deviation: one
// customer's drift never refuses the boot.
import { readVerifiedUnion } from '@gremion/tenant-store'

export class ShippedMigrationsError extends Error {
  override name = 'ShippedMigrationsError'
}

/** Returns the verified file count; throws (refusing the boot) on any mismatch. */
export function assertShippedMigrations(dirs: readonly string[]): number {
  try {
    return readVerifiedUnion(dirs).length
  } catch (err) {
    throw new ShippedMigrationsError(`kernel-api refuses to boot: the shipped kernel-api migrations do not match their manifest (TRD-353): ${(err as Error).message}`, { cause: err })
  }
}
