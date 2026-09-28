-- gremion_platform, 0001: SCHEMA-gremion.md §1.1 restricted to schema plt
-- (TASK-021 Q2): no public CREATE, the plt schema, and its two shared trigger
-- functions. The tnt/oac/ops schemas and the §0.6 plumbing tables arrive with
-- their owners; this chain is the control plane's one migration folder
-- (SCHEMA §1 item 8), run by @gremion/tenant-store's runMigrations.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS plt;

CREATE FUNCTION plt.touch_row() RETURNS trigger
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

CREATE FUNCTION plt.refuse_update() RETURNS trigger
  LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;
