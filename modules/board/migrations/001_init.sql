-- services/board/migrations/001_init.sql
-- Board leaf schema — squashed from gremion-ui/migrations/034_deck_board.sql for
-- the services/board extraction (T1). A card's status = the stack it sits in.
--
-- CROSS-DB FKs OMITTED (design §8): the kernel migration 034 declares
--   board.org_unit_id           REFERENCES org_units(id)            ON DELETE CASCADE
--   card.protocol_action_item_id REFERENCES protocol_action_items(id) ON DELETE SET NULL
-- Both target GOVERNANCE-OWNED KERNEL tables that DO NOT exist in this leaf's
-- own database. A leaf may never FK across the process/DB boundary, so those two
-- columns are plain UUID here (no REFERENCES). The INTRA-leaf FKs (stack→board,
-- card→stack) are KEPT — they stay within this database. Referential integrity
-- for the two dropped FKs is enforced application-side (the kernel resolves the
-- org-unit scope + the action item BEFORE the leaf is called).
--
-- Idempotent (CREATE … IF NOT EXISTS) so re-running the manifest against an
-- already-migrated DB is a safe no-op.
-- Inverse: DROP TABLE card; DROP TABLE stack; DROP TABLE board;

CREATE TABLE IF NOT EXISTS board (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id UUID NOT NULL,
  name        TEXT NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stack (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   UUID NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INT  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS card (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stack_id                 UUID NOT NULL REFERENCES stack(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  assignee_keycloak_id     TEXT,
  due_date                 DATE,
  label                    TEXT,
  sort_order               INT  NOT NULL DEFAULT 0,
  protocol_action_item_id  UUID,
  created_by               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stack_board_idx ON stack(board_id);
CREATE INDEX IF NOT EXISTS card_stack_idx  ON card(stack_id);
CREATE INDEX IF NOT EXISTS board_org_unit_idx ON board(org_unit_id);
-- one card per promoted action item (idempotent promote)
CREATE UNIQUE INDEX IF NOT EXISTS card_action_item_unique ON card(protocol_action_item_id)
  WHERE protocol_action_item_id IS NOT NULL;
