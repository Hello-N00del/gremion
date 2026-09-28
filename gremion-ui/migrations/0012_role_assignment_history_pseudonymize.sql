-- 012_role_assignment_history_pseudonymize.sql
--
-- Supports GDPR pseudonymization on hard user erasure (right to erasure, Art. 17 GDPR).
-- History rows are governance records (who held which office and when) and are retained,
-- but the personal identifier (user_keycloak_id) must be blankable so that erased users
-- cannot be re-identified from archived role data.
--
-- removeUserEverywhere() in orchestrator.ts NULLs this column for the erased user
-- immediately after deleting their live role_assignments rows.

ALTER TABLE role_assignment_history
  ALTER COLUMN user_keycloak_id DROP NOT NULL;
