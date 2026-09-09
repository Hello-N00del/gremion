-- docker/pgbouncer/pgbouncer-auth.sql — P2.1b T11 (#202)
-- auth_query support for PgBouncer (docker/pgbouncer/pgbouncer.ini).
--
-- PgBouncer logs in to Postgres as the low-privilege `pgbouncer_auth` role
-- and resolves every OTHER role's stored SCRAM verifier through the
-- SECURITY DEFINER function below (pg_shadow is superuser-only, so the
-- function must be created BY a superuser, e.g. `postgres`).
--
-- Apply at the S4 deploy (see docs/runbooks/pgbouncer.md):
--   1. ONCE per cluster — create the login role with the password that
--      docker/pgbouncer/userlist.txt carries (.env PGBOUNCER_AUTH_PASSWORD):
--
--        CREATE ROLE pgbouncer_auth LOGIN PASSWORD 'CHANGE_ME_pgbouncer_auth';
--
--      (kept commented here so re-running this file stays idempotent and no
--      placeholder password can ever be created by accident)
--
--   2. In EVERY database PgBouncer routes to (today: gremion; later: each
--      per-tenant database on this instance), run the rest of this file:
--
--        docker compose -f docker-compose.yml -f docker-compose.prod.yml \
--          exec -T postgres psql -U postgres -d gremion \
--          -f - < docker/pgbouncer/pgbouncer-auth.sql

CREATE SCHEMA IF NOT EXISTS pgbouncer;

CREATE OR REPLACE FUNCTION pgbouncer.get_auth(uname text)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT usename, passwd FROM pg_catalog.pg_shadow WHERE usename = uname
$$;

-- Lock the lookup down to the auth user only.
REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;
