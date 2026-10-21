-- gremion:phase expand
-- kernel-api chain, 0001 (TASK-077): the kernel API's own schema `idt` in a
-- customer's kernel database t_<hex32>__kernel (SCHEMA §0.1), and its shared
-- append-only trigger function. Applied per customer by `kernel-api migrate`
-- (ledger idt.schema_migration, SCHEMA §0.6), as k_<hex32>_owner.
--
-- Deliberately NOT here (TASK-080 Q2 amendment, lane note C8):
--   idt.touch_row()  -- TASK-080's plumbingSql('idt') prefix creates it;
--   UTC, REVOKE CREATE ON SCHEMA public FROM PUBLIC -- ensureKernelDatabase
--                       (TASK-043 Q3) does both when it creates the database.
-- No DO block, no ALTER DATABASE, no REVOKE (expand-contract lint).
SET lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS idt;

CREATE FUNCTION idt.refuse_update() RETURNS trigger
  LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;

COMMENT ON SCHEMA idt IS 'kernel API (TASK-077): identity and tenancy context of one customer; ledger idt.schema_migration';
