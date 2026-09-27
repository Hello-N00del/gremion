-- fixture module, 001: carries its own wrapper, like calendar's 001_init.sql,
-- and a DO body whose plpgsql BEGIN must survive stripOuterTransaction.
BEGIN;

CREATE TABLE item (
  id   uuid PRIMARY KEY DEFAULT uuidv7(),
  note text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'item_state') THEN
    CREATE TYPE item_state AS ENUM ('open', 'done');
  END IF;
END
$$;

COMMIT;
