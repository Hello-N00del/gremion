#!/bin/bash
# messaging-postgres, first initialisation only (docker-entrypoint-initdb.d):
# the Synapse role and database (TASK-198; Q4 default).
#
# Synapse requires a database whose collation and ctype are C ("Using
# Postgres" in its docs): anything else sorts room and event ids differently
# and IncorrectDatabaseSetup stops it -- but only once it has started. So the
# database is created here, per database, with LOCALE 'C' from template0 (the
# cluster's own locale is left alone), and db-preflight.py re-checks it on
# every boot. The owner is a plain role (BSI APP.4.3): LOGIN, never superuser,
# never CREATEDB or CREATEROLE.
#
# LOCALE_PROVIDER libc is explicit: a cluster initialised with the ICU
# provider would otherwise hand it down, and an ICU database reports
# datcollate C while sorting linguistically.
#
# The password travels as a psql variable into format(... %L) -- never
# spliced into SQL text by the shell (the same idiom as the kernel's
# init-databases.sh). An unset or empty SYNAPSE_DB_PASSWORD aborts the
# FIRST initialisation loudly -- but the image's entrypoint skips
# docker-entrypoint-initdb.d on every later start (PGDATA exists), so a
# failed first run would leave a server without the role or the database.
# Two things keep that visible and recoverable: messaging-postgres'
# healthcheck (docker-compose.yml) reads healthy only once the synapse
# database exists, so matrix never starts against it; and this script is
# idempotent (role and database only when missing), so after fixing the env
# it can be re-run in place:
#   docker compose exec messaging-postgres bash /docker-entrypoint-initdb.d/10-synapse-db.sh
# (it creates nothing that already exists; a changed SYNAPSE_DB_PASSWORD is
# NOT applied to an existing role -- rotate with ALTER ROLE synapse PASSWORD).
set -euo pipefail

: "${SYNAPSE_DB_PASSWORD:?SYNAPSE_DB_PASSWORD is required to create the synapse role}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

echo "[10-synapse-db] Creating role 'synapse' and database 'synapse' (libc LOCALE C, template0) where missing..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
     -v _password="$SYNAPSE_DB_PASSWORD" <<-'SQL'
	SELECT format('CREATE ROLE synapse LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'_password')
	WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'synapse') \gexec
	SELECT 'CREATE DATABASE synapse OWNER synapse TEMPLATE template0 ENCODING ''UTF8'' LOCALE_PROVIDER libc LOCALE ''C'''
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'synapse') \gexec
SQL

echo "[10-synapse-db] Done: 'synapse' owned by 'synapse', datcollate/datctype C."
