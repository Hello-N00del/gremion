-- gremion:phase expand
-- gremion_platform, 0015 (TASK-084-a): the ninth provisioning step kind,
-- governance_database_created (step_order 9).
--
-- SCHEMA DB-PLT-PROVISIONING-STEP gains kind 9; answers O-15 as two steps
-- (TASK-084-a): database_created keeps the kernel database only, the new kind
-- creates, migrates and binds the customer's governance database.
-- step_order is SCHEMA's generated column; it is not the execution order
-- (@gremion/provisioning EXECUTION_ORDER runs 7 and 8 before 6, and 9 right
-- after 2). "Completed" = all nine kinds done.
--
-- The ledger is append-only (row triggers refuse UPDATE and DELETE). The CHECK
-- is dropped and re-added NOT VALID, then validated; the generated column is
-- widened with SET EXPRESSION (PostgreSQL 17+), which rewrites no row trigger
-- and keeps the existing step_order values and the step_order index.
SET lock_timeout = '5s';

ALTER TABLE plt.provisioning_step DROP CONSTRAINT provisioning_step_step_kind_check;
ALTER TABLE plt.provisioning_step ADD CONSTRAINT provisioning_step_step_kind_check CHECK (step_kind IN ('realm_created', 'database_created',
    'domain_bound', 'storage_prefix_reserved', 'first_body_created', 'first_accounts_created',
    'broker_account_created', 'mail_principal_issued', 'governance_database_created')) NOT VALID;
ALTER TABLE plt.provisioning_step VALIDATE CONSTRAINT provisioning_step_step_kind_check;
ALTER TABLE plt.provisioning_step ALTER COLUMN step_order SET EXPRESSION AS (CASE step_kind
    WHEN 'realm_created' THEN 1 WHEN 'database_created' THEN 2
    WHEN 'domain_bound' THEN 3 WHEN 'storage_prefix_reserved' THEN 4
    WHEN 'first_body_created' THEN 5 WHEN 'first_accounts_created' THEN 6
    WHEN 'broker_account_created' THEN 7 WHEN 'mail_principal_issued' THEN 8
    WHEN 'governance_database_created' THEN 9
  END);
