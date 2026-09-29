-- 040_event_consumption.sql
-- T15 (P1): idempotency table for monolith-side event consumers + correlation_id
-- on audit_log.
--
-- event_consumption: per-consumer, per-event deduplication ledger. The primary key
-- (consumer, event_id) makes INSERT … ON CONFLICT DO NOTHING a true idempotency
-- gate — if 0 rows are inserted the message has already been processed and the
-- consumer acks+skips without re-writing the audit row.
--
-- audit_log.correlation_id: thread the event envelope's correlationId so ops can
-- correlate an audit entry back to the originating outbox event (D-P1-7).

CREATE TABLE event_consumption (
  consumer    TEXT        NOT NULL,
  event_id    UUID        NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

ALTER TABLE audit_log
  ADD COLUMN correlation_id TEXT;
