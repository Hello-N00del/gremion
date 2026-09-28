-- 005_unwrap_double_encoded_jsonb.sql
-- TASK-009 fix round 5 — repair JSONB values that were stored DOUBLE-ENCODED.
--
-- The pre-fix backfill (scripts/backfill.ts#bindValue) bound each JSONB value as
-- a JSON *string* into a jsonb parameter. postgres-js serialises a jsonb
-- parameter with JSON.stringify, so the value was encoded twice and stored as a
-- jsonb STRING scalar ('"[{...}]"') instead of an array/object. The pre-fix
-- closeBudget wrote budget_plan.statement the same way. Read back, such a value
-- is a JS string: the live leaf served "signerStages": "[{...}]" and
-- /finance/finanzordnung 500'd ("data.signerStages.map is not a function").
--
-- This unwraps exactly one string layer, and ONLY where the inner text is the
-- expected JSON kind (IS JSON ARRAY / IS JSON OBJECT, Postgres 16+), so a
-- genuine string value or any other shape is left untouched. Idempotent: a
-- repaired row is no longer a string scalar and is skipped on re-run.
BEGIN;

UPDATE finance.finanzordnung_profile
   SET signer_stages = (signer_stages #>> '{}')::jsonb
 WHERE jsonb_typeof(signer_stages) = 'string'
   AND (signer_stages #>> '{}') IS JSON ARRAY;

UPDATE finance.finanzordnung_profile
   SET decision_authority_tiers = (decision_authority_tiers #>> '{}')::jsonb
 WHERE jsonb_typeof(decision_authority_tiers) = 'string'
   AND (decision_authority_tiers #>> '{}') IS JSON ARRAY;

UPDATE finance.csv_import_profile
   SET column_mapping = (column_mapping #>> '{}')::jsonb
 WHERE jsonb_typeof(column_mapping) = 'string'
   AND (column_mapping #>> '{}') IS JSON OBJECT;

UPDATE finance.budget_plan
   SET statement = (statement #>> '{}')::jsonb
 WHERE statement IS NOT NULL
   AND jsonb_typeof(statement) = 'string'
   AND (statement #>> '{}') IS JSON OBJECT;

COMMIT;
