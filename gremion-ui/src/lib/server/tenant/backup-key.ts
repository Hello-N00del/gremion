// src/lib/server/tenant/backup-key.ts
// P2.1c T16 (§8.7 mechanics) — the per-tenant backup-key canonical-location
// resolver, shared by the §8.7 automatable assertion (backup-key.test.ts) and
// the operator backup script (scripts/tenant-backup.sh, via tenantSecretHostPath).
//
// §7.9 / §8.7 posture (design `2026-06-08-pillar2-tenancy-design.md` §3-step-9,
// R8): the per-tenant `backup_key_ref` is a crypto-shred key — it MUST exist in
// EXACTLY ONE canonical location, and the registry's OWN backup MUST NOT contain
// any tenant key (or a tenant-delete crypto-shred is void). The crypto-shred
// CHAIN itself is operational acceptance (manual audit); this module supplies the
// ONE automatable invariant: ref -> exactly-one location, and a
// registry-backup-set excludes every tenant key target.
import { tenantSecretHostPath } from './secrets'

/**
 * The single canonical location a `backup_key_ref` resolves to.
 * - `file`: a host filesystem path (per-tenant secret under the D-SECMOUNT mount)
 *   — the crypto-shred target. `path` is the exactly-one location.
 * - `env`: the DEFAULT tenant's `env:BACKUP_KEY` — key material lives in the
 *   operator root secret (`.env`/KMS), NOT in any tenant-keyed file. There is
 *   therefore NO per-tenant file to crypto-shred (and nothing for the registry
 *   backup to leak): the default tenant's key is the bootstrap root key, backed
 *   up independently of any tenant lifecycle (design §3 bootstrap caveat).
 */
export type BackupKeyLocation =
  | { readonly kind: 'file'; readonly hostPath: string }
  | { readonly kind: 'env'; readonly envVar: string }

/**
 * Resolve a `backup_key_ref` to its EXACTLY ONE canonical location.
 * Fail-closed: any unknown scheme, or a `file:` ref outside the per-tenant
 * D-SECMOUNT subdir (`tenantSecretHostPath` enforces this incl. traversal),
 * throws — never returns an ambiguous or empty location.
 */
export function backupKeyLocation(ref: string): BackupKeyLocation {
  if (ref.startsWith('file:')) {
    // tenantSecretHostPath is the SINGLE host-path derivation (D-SECMOUNT) and
    // already fail-closes on non-tenant prefixes + traversal — reuse it so the
    // "exactly one location" is the same path the backup script writes/shreds.
    return { kind: 'file', hostPath: tenantSecretHostPath(ref) }
  }
  if (ref.startsWith('env:')) {
    return { kind: 'env', envVar: ref.slice('env:'.length) }
  }
  throw new Error(`backupKeyLocation: unsupported backup_key_ref scheme: ${ref.split(':', 1)[0]}:`)
}

/**
 * §7.9 invariant — the registry's OWN backup file set MUST exclude every
 * per-tenant backup key. Returns the subset of `registryBackupPaths` that
 * collide with a tenant key's canonical file location (i.e. the violations);
 * an empty array means the registry backup is clean. `env:` refs contribute no
 * file path (their key is the operator root secret, not a tenant-keyed file).
 *
 * Path comparison is exact-string on the canonical host paths both sides derive
 * from `tenantSecretHostPath`, so a leak shows up as an equal string.
 */
export function registryBackupKeyLeaks(
  registryBackupPaths: readonly string[],
  tenantKeyRefs: readonly string[],
): readonly string[] {
  const keyFilePaths = new Set(
    tenantKeyRefs
      .map(backupKeyLocation)
      .filter((loc): loc is Extract<BackupKeyLocation, { kind: 'file' }> => loc.kind === 'file')
      .map((loc) => loc.hostPath),
  )
  return registryBackupPaths.filter((p) => keyFilePaths.has(p))
}
