-- 008_public_portal.sql
-- Public Portal additions (governance-only kernel).
-- Adds the protocol PDF path + grants the read-only DB role used by the
-- gremion-public container. (The calendar is_public flag + news_posts table this
-- migration originally also created moved out with the calendar/news modules
-- during the Civitas kernel carve.)

-- Add PDF path to protocols (populated on publish via the ProtocolDocumentPort)
ALTER TABLE protocols
  ADD COLUMN IF NOT EXISTS pdf_nextcloud_path TEXT;

-- Read-only PostgreSQL role for gremion-public container.
-- The role itself is created by docker/postgres/init-databases.sh (with
-- the password from $PUBLIC_DB_PASSWORD) because the gremion user that
-- runs migrations lacks CREATEROLE. This migration only grants SELECTs
-- to that role, idempotently skipping if the role doesn't exist yet
-- (e.g. in environments that haven't provisioned it).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    GRANT CONNECT ON DATABASE gremion TO gremion_public_reader;
    GRANT USAGE ON SCHEMA public TO gremion_public_reader;
    GRANT SELECT ON
      protocols,
      protocol_attendance,
      protocol_resolutions,
      protocol_action_items,
      committees
    TO gremion_public_reader;
  ELSE
    RAISE NOTICE 'gremion_public_reader role not found — skipping GRANTs. Create it via docker/postgres/init-databases.sh and re-run this migration, or grant manually.';
  END IF;
END
$$;
