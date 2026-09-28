-- services/vault/migrations/001_init.sql
-- Vault leaf schema — a password/secret vault. Modeled on the services/board leaf
-- pattern. Each vault_item stores its secret ONLY as an AES-256-GCM ciphertext blob
-- (encrypted by the leaf process with VAULT_ENCRYPTION_KEY — the key never touches
-- this database); the metadata columns are queried on the list/get surface, and the
-- ciphertext leaves only through the explicit reveal path, which appends an
-- access_log row.
--
-- CROSS-DB FK OMITTED (design §8): org_unit_id logically references the
-- GOVERNANCE-OWNED kernel table org_units(id), which DOES NOT exist in this leaf's
-- own database. A leaf may never FK across the process/DB boundary, so org_unit_id
-- is a plain UUID here (no REFERENCES). Referential integrity for it is enforced
-- application-side (the kernel resolves the org-unit scope BEFORE the leaf is
-- called). The INTRA-leaf FK (access_log.item_id -> vault_item.id) is KEPT — it
-- stays within this database.
--
-- Idempotent (CREATE ... IF NOT EXISTS) so re-running the manifest against an
-- already-migrated DB is a safe no-op.
-- Inverse: DROP TABLE access_log; DROP TABLE vault_item;

CREATE TABLE IF NOT EXISTS vault_item (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id       UUID NOT NULL,
  name              TEXT NOT NULL,
  username          TEXT,
  url               TEXT,
  notes             TEXT,
  secret_ciphertext TEXT NOT NULL,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per secret reveal — a complete audit record: WHO revealed (accessed_by,
-- a required caller user-id from x-vault-user-id), WHICH item (item_id), in WHICH
-- collection/org-unit (org_unit_id, snapshotted from the item), for WHICH tenant
-- (tenant_id, from the guard-validated x-tenant-id header), and WHEN (accessed_at).
-- accessed_by / org_unit_id / tenant_id are NOT NULL: the reveal endpoint rejects a
-- caller with no user-id, so an incomplete audit row can never be written.
CREATE TABLE IF NOT EXISTS access_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID NOT NULL REFERENCES vault_item(id) ON DELETE CASCADE,
  org_unit_id UUID NOT NULL,
  tenant_id   TEXT NOT NULL,
  accessed_by TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_item_org_unit_idx ON vault_item(org_unit_id);
CREATE INDEX IF NOT EXISTS access_log_item_idx     ON access_log(item_id);
