-- 049_org_unit_event_outbox.sql
-- #383 Lane E1 — the KERNEL side of the org-unit mirror resync. The kernel owns the
-- governance `org_units` table; the finance leaf keeps a read-only projection (its
-- own leaf-DB org_unit_mirror table — this migration does NOT touch the finance
-- schema). This transactional outbox is the publisher's durable
-- hand-off: every org_units DML at the choke point (governance/org-units-db.ts)
-- co-commits ONE row here in the SAME transaction (never a phantom/missed publish),
-- and org-unit-event-relay.ts drains due rows → NATS (<subject-prefix>.<t>.org-unit.<event>).
--
-- occurred_at is the LOGICAL event time (the DML instant), carried onto the envelope
-- occurredAt so the leaf consumer's per-aggregate ordering guard is driven by DML
-- order, NOT relay-publish order. event_id is STABLE per row so a retry re-publishes
-- the SAME id — the leaf event_consumption dedups it (exactly-once apply).
--
-- Enqueue is gated on NATS_URL at the app layer (org-unit-event-outbox.ts): with NATS
-- off (staging default) the choke point is a pure no-op and this table stays empty.
--
-- No file-level BEGIN/COMMIT (README rule 3): the runner wraps each file + its
-- schema_migrations bookkeeping in one tx. Idempotent DDL (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS org_unit_event_outbox (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        UUID        NOT NULL DEFAULT gen_random_uuid(),
  event_type      TEXT        NOT NULL CHECK (event_type IN ('upserted', 'deleted')),
  aggregate_id    UUID        NOT NULL,
  payload         JSONB       NOT NULL,
  correlation_id  TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'ok', 'failed')),
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  first_failed_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The relay's due-row scan: pending first, then failed rows whose backoff elapsed.
CREATE INDEX IF NOT EXISTS org_unit_event_outbox_due_idx
  ON org_unit_event_outbox (status, next_attempt_at);
