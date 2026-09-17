-- stura-ui/migrations/034_deck_board.sql
-- WI-6: native Deck-style task board. A card's status = the stack it sits in.
-- Boards are scoped to one org-unit; a card may LINK a protocol action item
-- (promote-from-protocol) — the action item stays canonical in protocols.
-- Spec: docs/planning/2026-05-31-v6-design-coupled-spec.md §7.
-- Inverse: DROP TABLE card; DROP TABLE stack; DROP TABLE board;

CREATE TABLE board (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stack (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   UUID NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INT  NOT NULL DEFAULT 0
);

CREATE TABLE card (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stack_id                 UUID NOT NULL REFERENCES stack(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  assignee_keycloak_id     TEXT,
  due_date                 DATE,
  label                    TEXT,
  sort_order               INT  NOT NULL DEFAULT 0,
  protocol_action_item_id  UUID REFERENCES protocol_action_items(id) ON DELETE SET NULL,
  created_by               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stack_board_idx ON stack(board_id);
CREATE INDEX card_stack_idx  ON card(stack_id);
CREATE INDEX board_org_unit_idx ON board(org_unit_id);
-- one card per promoted action item (idempotent promote)
CREATE UNIQUE INDEX card_action_item_unique ON card(protocol_action_item_id)
  WHERE protocol_action_item_id IS NOT NULL;
