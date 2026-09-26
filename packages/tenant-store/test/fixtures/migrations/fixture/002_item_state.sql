-- fixture module, 002: deliberately NOT idempotent, so a second apply fails.
ALTER TABLE item ADD COLUMN state item_state NOT NULL DEFAULT 'open';
