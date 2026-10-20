// gremion-ui/src/lib/server/vault/backend/port.ts
// The vault subsystem's branch-by-abstraction seam.
//
// VaultBackendPort is the interface every consumer of the vault subsystem calls
// (the three /api/vault routes + the /vault page load). The vault is the KERNEL
// half of a two-part subsystem: the data plane (secret storage + reveal-audit)
// lives ENTIRELY in the vault leaf service, so there is no in-process
// implementation — the only port implementation is ServiceVaultClient (HTTP ACL
// to VAULT_SERVICE_URL).
//
// A VaultItem carries only NON-SECRET metadata. The secret value never travels
// on the item DTO (nor on list/get responses); it is fetched separately through
// revealSecret(), which the leaf audits by the acting user id.
//
// This file has NO runtime dependencies — it is a pure TypeScript interface.
// DO NOT import from any server module here.

// ── Domain transfer types ─────────────────────────────────────────────────────

/** Non-secret metadata for a stored vault entry. The secret is NEVER on this
 *  shape — reveal it separately via revealSecret(). */
export interface VaultItem {
  readonly id: string
  readonly org_unit_id: string
  readonly name: string
  readonly username: string | null
  readonly url: string | null
  readonly notes: string | null
  readonly created_by: string | null
  readonly created_at: Date
}

export interface CreateVaultItemInput {
  orgUnitId: string
  name: string
  /** The secret value — stored by the leaf, never echoed back on the item DTO. */
  secret: string
  username?: string | null
  url?: string | null
  notes?: string | null
  createdBy?: string | null
}

/** Patch for updateItem() (#405 design v11). Per-field semantics: absent = keep,
 *  null = clear (nullable fields only). A provided `secret` is re-encrypted by
 *  the leaf and replaces the stored ciphertext — it is never echoed back. */
export interface UpdateVaultItemInput {
  orgUnitId?: string
  name?: string
  secret?: string
  username?: string | null
  url?: string | null
  notes?: string | null
}

/** One reveal-audit row as returned by listAccessLog() — the Zugriffsprotokoll
 *  read surface (#405 design v11). item_name is the leaf's reveal-time snapshot
 *  (vault mig 002), so rows survive item deletion (append-only promise). */
export interface VaultAccessLogEntry {
  readonly id: string
  readonly item_id: string
  readonly item_name: string
  readonly org_unit_id: string
  readonly accessed_by: string
  readonly accessed_at: Date
}

/** The revealed secret value for one item. Returned ONLY by revealSecret(), and
 *  ONLY after the caller has passed the org-unit scope gate. */
export interface RevealedSecret {
  readonly secret: string
}

// ── Port interface ────────────────────────────────────────────────────────────

export interface VaultBackendPort {
  /**
   * Discriminant identifying which implementation is in use. The vault has only
   * a 'service' backend (the data plane lives in the vault leaf).
   */
  readonly kind: 'service'

  /** Vault items (metadata only) for the given org-unit scope. Empty scope → []. */
  listItemsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly VaultItem[]>
  /** One item's metadata by id, or null when it does not exist. NO secret. */
  getItem(id: string): Promise<VaultItem | null>
  /** Reveal one item's secret. `userId` is the acting user — the leaf records it
   *  for reveal-audit (forwarded as x-vault-user-id). Callers MUST pass the
   *  org-unit scope gate before invoking this. */
  revealSecret(id: string, userId: string): Promise<RevealedSecret>
  /** Create a vault item in an org-unit. Returns the created item's metadata. */
  createItem(data: CreateVaultItemInput): Promise<VaultItem>
  /** Update an item's metadata (and re-encrypt when `secret` is provided).
   *  Returns the updated metadata, or null when the item does not exist.
   *  Callers MUST scope-gate the item's org-unit AND — when moving the item —
   *  the target org-unit before invoking this. */
  updateItem(id: string, data: UpdateVaultItemInput): Promise<VaultItem | null>
  /** Delete an item by id. Returns false when the item did not exist. */
  deleteItem(id: string): Promise<boolean>
  /** Reveal-audit rows for the given org-unit scope, newest first, limit/offset
   *  paginated. Empty scope → []. Callers MUST pass the resolved org-unit scope
   *  (resolveVaultOrgUnitScope) — the leaf trusts it, the kernel enforces it. */
  listAccessLog(
    orgUnitIds: readonly string[],
    opts: { limit: number; offset: number },
  ): Promise<readonly VaultAccessLogEntry[]>
}
