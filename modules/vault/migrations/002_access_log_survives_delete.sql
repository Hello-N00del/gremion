-- services/vault/migrations/002_access_log_survives_delete.sql
-- Design-v11 review: the /vault surface sells the Zugriffsprotokoll as
-- "access_log · append-only" and the delete dialog promises "Das
-- Zugriffsprotokoll bleibt erhalten" — but 001's access_log.item_id FK was
-- ON DELETE CASCADE, so deleting an item silently erased the audit rows of its
-- own reveals (an in-scope member could reveal a secret, delete the item, and
-- leave no trace). Make the promise true:
--   1. snapshot the item name onto each access_log row (the read surface no
--      longer depends on the item row existing),
--   2. backfill the snapshot for existing rows (every pre-002 row still has a
--      live item — the CASCADE guaranteed it),
--   3. drop the FK: access_log rows now OUTLIVE their item. item_id stays a
--      plain UUID for correlation (mirrors the deliberate no-cross-boundary-FK
--      posture of org_unit_id in 001).
-- revealSecret writes item_name on every new row from 002 on; listAccessLog
-- reads COALESCE(snapshot, live name) via LEFT JOIN.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / NULL-guarded backfill / DROP CONSTRAINT
-- IF EXISTS all re-run as no-ops.
-- Inverse (destroys orphaned audit rows): DELETE FROM access_log al WHERE NOT
--   EXISTS (SELECT 1 FROM vault_item vi WHERE vi.id = al.item_id);
--   ALTER TABLE access_log ADD CONSTRAINT access_log_item_id_fkey
--     FOREIGN KEY (item_id) REFERENCES vault_item(id) ON DELETE CASCADE;
--   ALTER TABLE access_log DROP COLUMN IF EXISTS item_name;

ALTER TABLE access_log ADD COLUMN IF NOT EXISTS item_name TEXT;

UPDATE access_log al
   SET item_name = vi.name
  FROM vault_item vi
 WHERE al.item_id = vi.id
   AND al.item_name IS NULL;

ALTER TABLE access_log DROP CONSTRAINT IF EXISTS access_log_item_id_fkey;
