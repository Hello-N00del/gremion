-- 002_org_unit_mirror.sql
-- #383 Lane E1 — the leaf-local org-unit MIRROR + governance sub_org_type catalog
-- + the consumer idempotency ledger. Together these let the project (R1) and
-- sub-org-read/sub_org_type (R2) ops resolve entirely LEAF-LOCAL: the native oracle
-- JOINs the KERNEL `org_units` table for the org NAME/KIND (services/read/{project,
-- sub-org}.ts) and writes the governance `sub_org_type` catalog (services/write/
-- sub-org.ts) — both cross the boundary the leaf DB cannot. The kernel now PUBLISHES
-- org-unit change events (gremion-ui migration 049 outbox + relay) which the leaf
-- consumer (src/org-unit-consumer.ts) applies here, and the id-preserving backfill
-- (scripts/backfill.ts) seeds the initial snapshot from public.org_units + sub_org_type.
--
-- Idempotent DDL (CREATE ... IF NOT EXISTS) so the manifest-verified leaf migration
-- runner re-applies it safely.

-- ── org_unit_mirror ──────────────────────────────────────────────────────────
-- A read-only projection of the kernel `org_units` rows the leaf's finance data
-- references. The reads INNER JOIN this on id (exactly as the native oracle JOINs
-- org_units) for ou.name / ou.kind. Kept eventually-consistent by the consumer with
-- a per-aggregate ORDERING guard: `source_occurred_at` is the occurredAt of the last
-- applied event; an out-of-order (stale) event whose occurredAt is NOT strictly
-- greater is dropped. `deleted` tombstones a removed org unit (so a stale upsert
-- delivered AFTER a delete cannot resurrect it). The backfill seeds source_occurred_at
-- = now() (the snapshot instant) so an in-flight event that PRE-dates the cutover
-- snapshot is dropped, not replayed over fresher data.
CREATE TABLE IF NOT EXISTS finance.org_unit_mirror (
  id                 UUID        PRIMARY KEY,
  name               TEXT        NOT NULL DEFAULT '',
  kind               TEXT        NOT NULL DEFAULT '',
  parent_id          UUID,
  deleted            BOOLEAN     NOT NULL DEFAULT false,
  source_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_org_unit_mirror_kind_idx
  ON finance.org_unit_mirror (kind);

-- ── sub_org_type (governance catalog mirror) ─────────────────────────────────
-- Structural copy of the kernel `sub_org_type` catalog (gremion-ui migration 018).
-- Post-cutover the leaf OWNS this table: createSubOrgType inserts, deleteSubOrgType
-- deletes. NB the native `listSubOrgTypes` read does NOT read this catalog — it
-- derives the types from DISTINCT org_unit.kind (a legacy StuFis quirk faithfully
-- reproduced against org_unit_mirror). This table exists for the WRITE ops + backfill
-- row-count/checksum parity. BIGINT IDENTITY + OVERRIDING SYSTEM VALUE on backfill
-- preserves the kernel ids (mirrors the finance.* identity tables).
CREATE TABLE IF NOT EXISTS finance.sub_org_type (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── event_consumption (leaf consumer idempotency ledger) ─────────────────────
-- Per-consumer, per-event dedup — mirror of the kernel's migration 040. The
-- (consumer, event_id) PK makes INSERT ... ON CONFLICT DO NOTHING a true idempotency
-- gate: 0 rows inserted → the event was already applied → the consumer ack-skips.
-- event_id is TEXT (not UUID): the EventEnvelope.eventId the consumer dedups on is
-- typed as an opaque string, so the leaf ledger does not couple to a UUID format.
CREATE TABLE IF NOT EXISTS finance.event_consumption (
  consumer    TEXT        NOT NULL,
  event_id    TEXT        NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
