-- gremion:phase expand
-- gremion_platform, 0006 (TASK-044, brief Q10): SCHEMA-gremion.md §1.1
-- restricted to schema ops, as 0001_plt_setup.sql did for plt: the ops schema,
-- its two shared trigger functions (ops.touch_row, ops.refuse_update) and
-- ops.freeze_terminal. SCHEMA §1.1 creates the per-schema pair in one DO loop;
-- the expand lint (TASK-075, SCHEMA §0.10) refuses a DO block, so the loop is
-- unrolled for ops with the same bodies. Every later DB-OPS table (TASK-033,
-- TASK-086, ...) uses these; none of them creates the ops setup again.
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS ops;

CREATE FUNCTION ops.touch_row() RETURNS trigger
  LANGUAGE plpgsql AS $body$
BEGIN
  IF (to_jsonb(NEW) -> 'customer_id') IS DISTINCT FROM (to_jsonb(OLD) -> 'customer_id')
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer_id and created_at are immutable (%)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END
$body$;

CREATE FUNCTION ops.refuse_update() RETURNS trigger
  LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;

CREATE FUNCTION ops.freeze_terminal() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v text := to_jsonb(OLD) ->> TG_ARGV[0];
BEGIN
  IF v IS NOT NULL AND (TG_NARGS = 1 OR v = ANY (TG_ARGV[1:TG_NARGS - 1])) THEN
    RAISE EXCEPTION '%.% is frozen once % is set (%)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0], v
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
