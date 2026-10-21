-- gremion:phase expand
SET lock_timeout = '5s';
-- The statements of SCHEMA §0.6 that the house lint refuses (excerpt, as printed there).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS gov;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox', 'inbox', 'applied_aggregate_version', 'job'] LOOP
    EXECUTE format('ALTER TABLE gov.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
